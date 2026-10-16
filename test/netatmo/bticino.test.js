// -----------------------------------------------------------------------------
// BTicino Classe 300X / Classe 300 EOS door entry (issue #59, step 1:
// discovery + diagnostic log), against the fake Netatmo cloud with ASSUMED
// fixtures (see addBticinoFixtures — no public payload exists): scopes,
// `bticino_api` gating, the payload-driven feature set, telemetry (signal,
// read-only staircase light, unreachable badge), and the diagnostic log
// (on-change logging, redaction, line bound, webhook matching).
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { loadAccount, netatmoId } from '../../src/netatmo/discovery.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import { setDeviceValue } from '../../src/netatmo/setValue.js';
import {
  BTICINO_DIAGNOSTIC_TAG,
  BTICINO_DIAGNOSTIC_MAX_LINE,
  BTICINO_OAUTH_SCOPES,
  OAUTH_SCOPES,
  requestedScopes,
} from '../../src/netatmo/constants.js';
import {
  bticinoEntriesOf,
  createBticinoDiagnostic,
  formatDiagnosticLine,
  isBticinoType,
  isBticinoWebhook,
  redactForDiagnostic,
} from '../../src/netatmo/bticino.js';
import {
  startFakeNetatmo,
  addBticinoFixtures,
  BNCX_ID,
  BNEU_ID,
  BNDL_ID,
  BNSL_ID,
  BNCS_ID,
} from '../helpers/fakeNetatmo.js';

// Only the BTicino family: no other module of the default fixtures is
// discovered, so every discovered device is a BTicino one.
const BTICINO_ONLY = normalizeConfig({ energy_api: false, weather_api: false, bticino_api: true });
const ext = (id) => `ext:netatmo:${id}`;

let netatmo;
let client;
let gladys;
let telemetry;
let lines;

function fakeLogger() {
  return { info: (line) => lines.push(line) };
}

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  addBticinoFixtures(netatmo.state);
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
  lines = [];
  gladys = {
    published: [],
    transports: [],
    devices: [],
    externalId: (suffix) => `ext:netatmo:${suffix}`,
    async publishStates(states) {
      this.published.push(...states);
    },
    async publishDiscoveredDevices() {},
    async publishTransports(entries) {
      this.transports.push(...entries);
    },
    async publishCameraImage() {},
    requestWidgetRefresh() {},
  };
  telemetry = createTelemetry({
    gladys,
    client,
    loadTtlMs: 0,
    bticinoDiagnostic: createBticinoDiagnostic({ logger: fakeLogger() }),
  });
});

afterEach(async () => {
  telemetry.stop();
  await netatmo.close();
});

const homeStatusModule = (id) =>
  netatmo.state.homeStatuses['home-1'].home.modules.find((m) => m.id === id);
const deviceOf = (id) => gladys.devices.find((d) => d.external_id === ext(id));
const suffixesOf = (device) =>
  device.features.map((f) => f.external_id.replace(`${device.external_id}:`, ''));
const paramValue = (device, name) => device.params.find((param) => param.name === name)?.value;
const stateOf = (featureExternalId) =>
  gladys.published
    .filter((s) => s.device_feature_external_id === featureExternalId)
    .map((s) => s.state);
const tagged = () => lines.filter((line) => line.startsWith(BTICINO_DIAGNOSTIC_TAG));

async function discover(config = BTICINO_ONLY) {
  gladys.devices = await telemetry.syncDiscovery(config);
  return gladys.devices;
}

// --- Scopes and toggle --------------------------------------------------------

test('the BTicino scopes are requested only while the toggle is on (pyatmo names, read + write)', () => {
  const bticinoScopes = ['read_bfi', 'write_bfi', 'read_mx', 'write_mx'];
  assert.deepEqual(BTICINO_OAUTH_SCOPES, bticinoScopes);
  // Toggle off (default): an account without a door entry is never asked.
  for (const scope of bticinoScopes) {
    assert.ok(!OAUTH_SCOPES.includes(scope), scope);
    assert.ok(!requestedScopes(normalizeConfig()).includes(scope), scope);
  }
  // Toggle on: the base set plus the BTicino scopes.
  assert.deepEqual(requestedScopes(normalizeConfig({ bticino_api: 'true' })), [
    ...OAUTH_SCOPES,
    ...bticinoScopes,
  ]);
  // Netatmo knows no `access_*` scope for BTicino: none is requested.
  assert.ok(!BTICINO_OAUTH_SCOPES.some((scope) => scope.startsWith('access_')));
});

test('the BTicino family is opt-in: nothing discovered, nothing logged while off', async () => {
  assert.equal(normalizeConfig().bticino_api, false);
  const config = normalizeConfig({ energy_api: false, weather_api: false, security_api: true });
  const result = await loadAccount(client, config);
  assert.equal(result.bticino, undefined);
  const bncx = result.devices.find((d) => netatmoId(d) === BNCX_ID);
  assert.equal(bncx.categoryAPI, 'BTicino');
  assert.equal(bncx.apiNotConfigured, true);
  const devices = await discover(config);
  assert.ok(!devices.some((d) => d.model.startsWith('BN')));
  assert.deepEqual(tagged(), []);
});

test('bticino_api alone runs the homesdata/homestatus load', async () => {
  const result = await loadAccount(client, BTICINO_ONLY);
  assert.equal(result.partial, false);
  const types = result.devices.filter((d) => !d.apiNotConfigured).map((d) => d.type);
  assert.deepEqual(types.sort(), ['BNCS', 'BNCX', 'BNDL', 'BNEU', 'BNSL']);
  // Raw entries for the diagnostic log, per source, before any merge.
  assert.equal(result.bticino.length, 1);
  assert.equal(result.bticino[0].home_id, 'home-1');
  assert.equal(result.bticino[0].homesdata.length, 5);
  assert.equal(result.bticino[0].homestatus.length, 4);
  assert.deepEqual(result.bticino[0].errors, [{ code: 6, id: BNCS_ID }]);
  assert.equal(result.bticino[0].homesdata[0].vpn_url, undefined);
});

// --- Discovery ----------------------------------------------------------------

test('discovery: one device per module, features only from what the payload carries', async () => {
  await discover();
  assert.deepEqual(
    gladys.devices.map((d) => d.model),
    ['BNCX', 'BNEU', 'BNDL', 'BNSL', 'BNCS'],
  );
  const bncx = deviceOf(BNCX_ID);
  assert.equal(bncx.name, 'Poste intérieur');
  assert.equal(bncx.should_poll, false);
  assert.deepEqual(suffixesOf(bncx), ['wifi_strength']);
  assert.deepEqual(JSON.parse(paramValue(bncx, 'modules_bridge_id')), [
    BNEU_ID,
    BNDL_ID,
    BNSL_ID,
    BNCS_ID,
  ]);
  assert.equal(paramValue(bncx, 'home_id'), 'home-1');
  assert.equal(paramValue(bncx, 'room_id'), 'room-1');

  // Street panel and door lock: no signal field, no command yet (step 2).
  for (const id of [BNEU_ID, BNDL_ID]) {
    const device = deviceOf(id);
    assert.deepEqual(device.features, []);
    assert.equal(paramValue(device, 'plug_id'), BNCX_ID);
    assert.equal(paramValue(device, 'plug_name'), 'Poste intérieur');
  }

  // Staircase light: homestatus carries `on` → a READ-ONLY switch.
  const bnsl = deviceOf(BNSL_ID);
  assert.deepEqual(suffixesOf(bnsl), ['on']);
  const on = bnsl.features[0];
  assert.equal(on.category, 'switch');
  assert.equal(on.type, 'binary');
  assert.equal(on.read_only, true);
  assert.equal(on.name, 'Staircase light - Éclairage escalier');

  // Controlled socket missing from homestatus: no `on` to read, no feature.
  assert.deepEqual(deviceOf(BNCS_ID).features, []);
});

test('the controlled socket gets its read-only switch once homestatus reports `on`', async () => {
  netatmo.state.homeStatuses['home-1'].home.errors = [];
  netatmo.state.homeStatuses['home-1'].home.modules.push({
    id: BNCS_ID,
    type: 'BNCS',
    bridge: BNCX_ID,
    on: true,
    rf_strength: 80,
  });
  await discover();
  const bncs = deviceOf(BNCS_ID);
  assert.deepEqual(suffixesOf(bncs), ['rf_strength', 'on']);
  assert.equal(bncs.features[1].name, 'Socket - Prise commandée');
  assert.equal(bncs.features[1].read_only, true);
});

test('a non-boolean `on` declares no switch', async () => {
  homeStatusModule(BNSL_ID).on = 'unknown';
  await discover();
  assert.deepEqual(deviceOf(BNSL_ID).features, []);
});

// --- Telemetry ----------------------------------------------------------------

test('telemetry: WiFi quality, staircase light state, unreachable badge', async () => {
  await discover();
  await telemetry.refreshValues(BTICINO_ONLY);
  assert.deepEqual(stateOf(`${ext(BNCX_ID)}:wifi_strength`), [62]);
  assert.deepEqual(stateOf(`${ext(BNSL_ID)}:on`), [0]);
  const transport = (id) => gladys.transports.filter((t) => t.external_id === ext(id)).at(-1);
  assert.equal(transport(BNCX_ID).transport, 'cloud');
  assert.equal(transport(BNCS_ID).transport, 'unreachable');

  homeStatusModule(BNSL_ID).on = true;
  await telemetry.refreshValues(BTICINO_ONLY);
  assert.deepEqual(stateOf(`${ext(BNSL_ID)}:on`), [0, 1]);
});

test('an unreachable module publishes no stale value', async () => {
  await discover();
  homeStatusModule(BNCX_ID).reachable = false;
  await telemetry.refreshValues(BTICINO_ONLY);
  assert.deepEqual(stateOf(`${ext(BNCX_ID)}:wifi_strength`), []);
});

test('the staircase light is not writable yet (step 2)', async () => {
  await discover();
  const bnsl = deviceOf(BNSL_ID);
  await assert.rejects(
    setDeviceValue({ gladys, client }, { device: bnsl, feature: bnsl.features[0], value: 1 }),
    /not writable/,
  );
  assert.deepEqual(netatmo.state.setStateRequests, []);
});

// --- Diagnostic log: loads ----------------------------------------------------

test('diagnostic: every BTicino entry is logged on the first load, tagged', async () => {
  await discover();
  const logged = tagged();
  assert.match(
    logged[0],
    /home home-1: 5 BTicino module\(s\) in homesdata \(BNCX, BNEU, BNDL, BNSL, BNCS\), 4 in homestatus, 1 in errors/,
  );
  // 5 homesdata entries + 4 homestatus entries + 1 error entry.
  assert.equal(logged.filter((line) => / homesdata BN/.test(line)).length, 5);
  assert.equal(logged.filter((line) => / homestatus BN/.test(line)).length, 4);
  assert.equal(logged.filter((line) => / homestatus-error /.test(line)).length, 1);
  const bncxStatus = logged.find((line) => line.includes(`homestatus BNCX ${BNCX_ID}`));
  // Ids kept, secrets redacted.
  assert.match(bncxStatus, /"id":"00:03:50:a1:b2:c3"/);
  assert.match(bncxStatus, /"wifi_strength":62/);
  assert.match(bncxStatus, /"vpn_url":"https:\/\/prodvpn-eu-6\.netatmo\.net\/<redacted>"/);
  assert.match(bncxStatus, /"access_token":"<redacted>"/);
  assert.ok(!logged.some((line) => line.includes('secret-bticino-token')));
  assert.ok(!logged.some((line) => line.includes('0123456789abcdef0123456789abcdef')));
});

test('diagnostic: nothing re-logged while the content is unchanged (signal drift included)', async () => {
  await discover();
  const first = tagged().length;
  await telemetry.refreshValues(BTICINO_ONLY);
  homeStatusModule(BNCX_ID).wifi_strength = 58;
  await telemetry.refreshValues(BTICINO_ONLY);
  assert.equal(tagged().length, first);

  // A state change is logged once, marked as a change.
  homeStatusModule(BNSL_ID).on = true;
  await telemetry.refreshValues(BTICINO_ONLY);
  await telemetry.refreshValues(BTICINO_ONLY);
  const added = tagged().slice(first);
  assert.equal(added.length, 1);
  assert.match(added[0], /homestatus BNSL 00:03:50:a1:b2:c6 \(home home-1\) changed: .*"on":true/);
});

test('diagnostic: a module gone from a complete load is reported, never from a partial one', () => {
  const diagnostic = createBticinoDiagnostic({ logger: fakeLogger() });
  const home = (homestatus) => ({
    home_id: 'h',
    homesdata: [{ id: 'm1', type: 'BNDL' }],
    homestatus,
    errors: [],
  });
  diagnostic.logLoad([home([{ id: 'm1', type: 'BNDL', reachable: true }])]);
  lines.length = 0;
  diagnostic.logLoad([home([])], { partial: true });
  assert.ok(!lines.some((line) => line.includes('no longer reported')));
  diagnostic.logLoad([home([])]);
  assert.ok(lines.some((line) => line.includes('homestatus m1 (home h) no longer reported')));
});

test('diagnostic: an account without any BTicino module gets a one-time hint', () => {
  const diagnostic = createBticinoDiagnostic({ logger: fakeLogger() });
  diagnostic.logLoad([], { partial: true });
  assert.deepEqual(lines, []);
  diagnostic.logLoad([]);
  diagnostic.logLoad([]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no BTicino module \(BN\*\) in homesdata — .*click Connect again/);
});

test('diagnostic: reset() logs everything again (toggle re-enabled)', () => {
  const diagnostic = createBticinoDiagnostic({ logger: fakeLogger() });
  const homes = [
    { home_id: 'h', homesdata: [{ id: 'm1', type: 'BNCX' }], homestatus: [], errors: [] },
  ];
  diagnostic.logLoad(homes);
  const first = lines.length;
  diagnostic.logLoad(homes);
  assert.equal(lines.length, first);
  diagnostic.reset();
  diagnostic.logLoad(homes);
  assert.equal(lines.length, first * 2);
});

test('bticinoEntriesOf keeps the raw BN* entries only, null for a home without any', () => {
  assert.equal(bticinoEntriesOf('h', [{ id: 'a', type: 'NATherm1' }], [], []), null);
  const entries = bticinoEntriesOf(
    'h',
    [
      { id: 'a', type: 'NATherm1' },
      { id: 'b', type: 'BNEU' },
    ],
    [{ id: 'b', type: 'BNEU', extra: 1 }],
    [
      { id: 'a', code: 6 },
      { id: 'b', code: 6 },
    ],
  );
  assert.deepEqual(entries, {
    home_id: 'h',
    homesdata: [{ id: 'b', type: 'BNEU' }],
    homestatus: [{ id: 'b', type: 'BNEU', extra: 1 }],
    errors: [{ id: 'b', code: 6 }],
  });
  assert.equal(isBticinoType('BNCX'), true);
  assert.equal(isBticinoType('NACamera'), false);
  assert.equal(isBticinoType(undefined), false);
});

// --- Diagnostic log: redaction and bound --------------------------------------

test('redaction: secrets, URLs, e-mails and opaque strings go, ids stay', () => {
  const redacted = redactForDiagnostic({
    id: '00:03:50:a1:b2:c3',
    home_id: '5e1e4c4b2e8f2f0012345678',
    event_id: '5e1e4c4b2e8f2f0012345679',
    person_id: '91827374-5678-4abc-9def-0123456789ab',
    type: 'BNEU',
    reachable: true,
    wifi_strength: 60,
    access_token: 'abc',
    refresh_token: 'def',
    snapshot_key: 'ghi',
    snapshot_url: 'https://netatmocameraimage.blob.core.windows.net/production/x?sig=abc',
    local_url: 'http://192.168.1.40/0123456789abcdef',
    url: 'not a url but a secret path',
    email: 'someone@example.com',
    note: 'reach me at someone@example.com',
    header: 'Bearer 0123456789',
    blob: 'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFy',
    nested: [{ password: 'x', module_id: '00:03:50:a1:b2:c4' }],
    user: { mail: 'a@b.co', id: 'u1' },
  });
  assert.deepEqual(redacted, {
    id: '00:03:50:a1:b2:c3',
    home_id: '5e1e4c4b2e8f2f0012345678',
    event_id: '5e1e4c4b2e8f2f0012345679',
    person_id: '91827374-5678-4abc-9def-0123456789ab',
    type: 'BNEU',
    reachable: true,
    wifi_strength: 60,
    access_token: '<redacted>',
    refresh_token: '<redacted>',
    snapshot_key: '<redacted>',
    snapshot_url: 'https://netatmocameraimage.blob.core.windows.net/<redacted>',
    local_url: 'http://192.168.1.40/<redacted>',
    url: '<redacted>',
    email: '<redacted email>',
    // Free text containing an address is not an address: kept (no such
    // field is expected in a module entry).
    note: 'reach me at someone@example.com',
    header: '<redacted>',
    blob: '<redacted>',
    nested: [{ password: '<redacted>', module_id: '00:03:50:a1:b2:c4' }],
    user: { mail: '<redacted email>', id: 'u1' },
  });
});

test('a diagnostic line is cut at the bound, with a marker', () => {
  const short = formatDiagnosticLine('webhook X', { id: 'a' });
  assert.equal(short, `${BTICINO_DIAGNOSTIC_TAG} webhook X: {"id":"a"}`);
  const long = formatDiagnosticLine('homestatus BNCX a', { text: 'word '.repeat(5000) });
  assert.ok(long.length < BTICINO_DIAGNOSTIC_MAX_LINE + 80);
  assert.match(long, /…\[truncated, \d+ characters in total\]$/);
  assert.ok(long.startsWith(`${BTICINO_DIAGNOSTIC_TAG} homestatus BNCX a: {"text":"word word`));
});

// --- Diagnostic log: webhooks -------------------------------------------------

test('webhooks: BTicino events are logged raw (redacted), the others ignored', () => {
  const diagnostic = createBticinoDiagnostic({ logger: fakeLogger() });
  // By push type (shape of the other Netatmo push events, assumed).
  assert.equal(
    diagnostic.logWebhook({
      push_type: 'BNEU-incoming_call',
      event_type: 'incoming_call',
      home_id: 'home-1',
      module_id: BNEU_ID,
      snapshot_url: 'https://example.invalid/snap?key=abcdef',
    }),
    true,
  );
  assert.match(lines[0], /^\[bticino-diagnostic\] webhook BNEU-incoming_call: /);
  assert.match(lines[0], /"module_id":"00:03:50:a1:b2:c4"/);
  assert.match(lines[0], /"snapshot_url":"https:\/\/example\.invalid\/<redacted>"/);
  // A JSON string body is parsed; an event type alone is enough.
  assert.equal(diagnostic.logWebhook(JSON.stringify({ event_type: 'BNCX-connection' })), true);
  // Other modules, non-JSON bodies and empty bodies are ignored.
  assert.equal(diagnostic.logWebhook({ push_type: 'NACamera-movement', camera_id: 'c' }), false);
  assert.equal(diagnostic.logWebhook('not json'), false);
  assert.equal(diagnostic.logWebhook(undefined), false);
  assert.equal(lines.length, 2);
});

test('webhooks: an event naming a known BTicino module id is logged whatever its type', () => {
  const diagnostic = createBticinoDiagnostic({ logger: fakeLogger() });
  const event = { push_type: 'door_opened', module_id: BNDL_ID };
  assert.equal(diagnostic.logWebhook(event), false);
  diagnostic.logLoad([
    { home_id: 'h', homesdata: [{ id: BNDL_ID, type: 'BNDL' }], homestatus: [], errors: [] },
  ]);
  assert.equal(diagnostic.logWebhook(event), true);
  assert.ok(diagnostic.knownIds().has(BNDL_ID));
  assert.equal(isBticinoWebhook({ device_id: BNDL_ID }, new Set([BNDL_ID])), true);
  assert.equal(isBticinoWebhook(null), false);
});
