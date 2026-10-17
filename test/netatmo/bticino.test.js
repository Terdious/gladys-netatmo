// -----------------------------------------------------------------------------
// BTicino Classe 300X / Classe 300 EOS door entry (issue #59), against the
// fake Netatmo cloud with the REAL payloads of the maintainer's installation
// (see addBticinoFixtures): scopes, `bticino_api` gating, ONE device per door
// entry (the bridged modules as features keyed by their own ids), telemetry
// (signal, outdoor light, reachability), the outdoor light command, the
// ring, and the diagnostic log (on-change logging, redaction, line bound,
// webhook matching).
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { loadAccount, netatmoId, groupBticinoModules } from '../../src/netatmo/discovery.js';
import { createEvents } from '../../src/netatmo/events.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import { setDeviceValue } from '../../src/netatmo/setValue.js';
import {
  BTICINO_DIAGNOSTIC_TAG,
  BTICINO_DIAGNOSTIC_MAX_LINE,
  BTICINO_OAUTH_SCOPES,
  CONNECTION_MESSAGES,
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
  addBticinoSocket,
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

test('bticino_api alone runs the homesdata/homestatus load, the door entry grouped', async () => {
  const result = await loadAccount(client, BTICINO_ONLY);
  assert.equal(result.partial, false);
  const devices = result.devices.filter((d) => !d.apiNotConfigured);
  // ONE raw device per door entry: the gateway carries its bridged modules.
  assert.deepEqual(
    devices.map((d) => d.type),
    ['BNCX'],
  );
  assert.deepEqual(
    devices[0].grouped_modules.map((m) => [m.type, m.id, m.name]),
    [
      ['BNEU', BNEU_ID, 'Platine de rue'],
      ['BNDL', BNDL_ID, 'Serrure'],
      ['BNSL', BNSL_ID, 'Eclairage extérieur'],
    ],
  );
  assert.ok(!result.devices.some((d) => [BNEU_ID, BNDL_ID, BNSL_ID].includes(netatmoId(d))));
  // Raw entries for the diagnostic log, per source, before any merge.
  assert.equal(result.bticino.length, 1);
  assert.equal(result.bticino[0].home_id, 'home-1');
  assert.equal(result.bticino[0].homesdata.length, 4);
  assert.equal(result.bticino[0].homestatus.length, 4);
  assert.deepEqual(result.bticino[0].errors, []);
  // And for the Device diagnostic action, every module of every home.
  const rawHome = result.rawHomes.find((home) => home.id === 'home-1');
  assert.ok(rawHome.homesdata.some((m) => m.id === BNSL_ID));
  assert.ok(rawHome.homestatus.some((m) => m.id === BNSL_ID));
});

test('groupBticinoModules: a module without its gateway stays a device, others untouched', () => {
  const gateway = { id: 'gw', type: 'BNCX' };
  const light = { id: 'l', type: 'BNSL', bridge: 'gw' };
  const orphan = { id: 'o', type: 'BNSL', bridge: 'elsewhere' };
  const valve = { id: 'v', type: 'NRV', bridge: 'gw' };
  const grouped = groupBticinoModules([gateway, light, orphan, valve]);
  assert.deepEqual(
    grouped.map((d) => d.id),
    ['gw', 'o', 'v'],
  );
  assert.deepEqual(grouped[0].grouped_modules, [light]);
  assert.equal(gateway.grouped_modules, undefined, 'the input is not mutated');
  const noGateway = [light, valve];
  assert.equal(groupBticinoModules(noGateway), noGateway);
});

// --- Discovery ----------------------------------------------------------------

test('discovery: ONE device per door entry, the bridged modules as features (real payload)', async () => {
  await discover();
  assert.deepEqual(
    gladys.devices.map((d) => d.model),
    ['BNCX'],
  );
  const bncx = deviceOf(BNCX_ID);
  assert.equal(bncx.name, 'Classe 300EOS with Netatmo');
  assert.equal(bncx.should_poll, false);
  assert.deepEqual(
    bncx.features.map((f) => f.external_id),
    [`${ext(BNCX_ID)}:wifi_strength`, `${ext(BNCX_ID)}:ring`, `${ext(BNSL_ID)}:light`],
  );
  const [wifi, ring, light] = bncx.features;
  assert.equal(wifi.name, 'Link Wifi quality - Classe 300EOS with Netatmo');
  assert.equal(ring.category, 'doorbell');
  assert.equal(ring.type, 'ring');
  assert.equal(ring.name, 'Doorbell - Classe 300EOS with Netatmo');
  // The outdoor light: a standard writable light, named after its module.
  assert.equal(light.name, 'Eclairage extérieur');
  assert.equal(light.category, 'light');
  assert.equal(light.type, 'binary');
  assert.equal(light.read_only, false);
  assert.deepEqual(JSON.parse(paramValue(bncx, 'modules_bridge_id')), [BNEU_ID, BNDL_ID, BNSL_ID]);
  assert.equal(paramValue(bncx, 'home_id'), 'home-1');
  // The street panel and the door lock report nothing usable: no feature,
  // and no empty device of their own.
  for (const id of [BNEU_ID, BNDL_ID, BNSL_ID]) {
    assert.equal(deviceOf(id), undefined);
    assert.ok(
      !bncx.features.some((f) => f.external_id.startsWith(`${ext(id)}:`) && id !== BNSL_ID),
    );
  }
});

test('the controlled socket adds its signal and read-only switch once homestatus reports them', async () => {
  addBticinoSocket(netatmo.state, { on: true, rf_strength: 80, reachable: true });
  await discover();
  const bncx = deviceOf(BNCX_ID);
  const socket = bncx.features.filter((f) => f.external_id.startsWith(`${ext(BNCS_ID)}:`));
  assert.deepEqual(
    socket.map((f) => [f.external_id.slice(ext(BNCS_ID).length + 1), f.name, f.read_only]),
    [
      ['rf_strength', 'Link RF quality - Prise commandée', true],
      ['on', 'Socket - Prise commandée', true],
    ],
  );
  assert.equal(deviceOf(BNCS_ID), undefined);
});

test('a non-boolean `on` declares no socket switch', async () => {
  addBticinoSocket(netatmo.state, { on: 'unknown', reachable: true });
  await discover();
  assert.ok(!deviceOf(BNCX_ID).features.some((f) => f.external_id === `${ext(BNCS_ID)}:on`));
});

test('a bridged module whose gateway is missing is its own device only with features', async () => {
  const home = netatmo.state.homes.find((h) => h.id === 'home-1');
  home.modules = home.modules.filter((m) => m.id !== BNCX_ID);
  const status = netatmo.state.homeStatuses['home-1'].home;
  status.modules = status.modules.filter((m) => m.id !== BNCX_ID);
  await discover();
  // The light keeps its command through its bridge; panel and lock: nothing.
  assert.deepEqual(
    gladys.devices.map((d) => d.model),
    ['BNSL'],
  );
  const bnsl = deviceOf(BNSL_ID);
  assert.deepEqual(suffixesOf(bnsl), ['light']);
  assert.equal(paramValue(bnsl, 'plug_id'), BNCX_ID);
});

// --- Telemetry ----------------------------------------------------------------

test('telemetry: gateway WiFi, no light state Netatmo does not report, one badge', async () => {
  await discover();
  await telemetry.refreshValues(BTICINO_ONLY);
  assert.deepEqual(stateOf(`${ext(BNCX_ID)}:wifi_strength`), [48]);
  assert.deepEqual(stateOf(`${ext(BNSL_ID)}:light`), []);
  // One device-level badge, from the gateway; none for the grouped modules.
  const transport = (id) => gladys.transports.filter((t) => t.external_id === ext(id)).at(-1);
  assert.equal(transport(BNCX_ID).transport, 'cloud');
  for (const id of [BNEU_ID, BNDL_ID, BNSL_ID]) {
    assert.equal(transport(id), undefined);
  }
  // Should homestatus ever report `on`, it wins.
  homeStatusModule(BNSL_ID).on = true;
  await telemetry.refreshValues(BTICINO_ONLY);
  assert.deepEqual(stateOf(`${ext(BNSL_ID)}:light`), [1]);
});

test('telemetry: a grouped module publishes under its own id, deduplicated across cycles', async () => {
  addBticinoSocket(netatmo.state, { on: false, rf_strength: 80, reachable: true });
  await discover();
  await telemetry.refreshValues(BTICINO_ONLY);
  await telemetry.refreshValues(BTICINO_ONLY);
  assert.deepEqual(stateOf(`${ext(BNCS_ID)}:on`), [0]);
  assert.deepEqual(stateOf(`${ext(BNCS_ID)}:rf_strength`), [80]);
  homeStatusModule(BNCS_ID).on = true;
  await telemetry.refreshValues(BTICINO_ONLY);
  assert.deepEqual(stateOf(`${ext(BNCS_ID)}:on`), [0, 1]);
});

test('telemetry: an unreachable module, or a module behind an unreachable gateway, publishes nothing', async () => {
  addBticinoSocket(netatmo.state, { on: true, rf_strength: 80, reachable: true });
  await discover();
  homeStatusModule(BNCS_ID).reachable = false;
  homeStatusModule(BNSL_ID).on = true;
  await telemetry.refreshValues(BTICINO_ONLY);
  assert.deepEqual(stateOf(`${ext(BNCS_ID)}:on`), []);
  assert.deepEqual(stateOf(`${ext(BNSL_ID)}:light`), [1]);

  gladys.published.length = 0;
  telemetry.resetDedup();
  homeStatusModule(BNCS_ID).reachable = true;
  homeStatusModule(BNCX_ID).reachable = false;
  await telemetry.refreshValues(BTICINO_ONLY);
  assert.deepEqual(gladys.published, []);
  const transport = gladys.transports.filter((t) => t.external_id === ext(BNCX_ID)).at(-1);
  assert.equal(transport.transport, 'unreachable');
});

test('a socket missing from homestatus (errors) is grouped, unreachable, silent', async () => {
  addBticinoSocket(netatmo.state);
  const result = await loadAccount(client, BTICINO_ONLY);
  const gateway = result.devices.find((d) => netatmoId(d) === BNCX_ID);
  const socket = gateway.grouped_modules.find((m) => m.id === BNCS_ID);
  assert.equal(socket.reachable, false);
  assert.equal(socket.apiErrorCode, 6);
  await discover();
  await telemetry.refreshValues(BTICINO_ONLY);
  assert.ok(!gladys.published.some((s) => s.device_feature_external_id.includes(BNCS_ID)));
});

// --- Outdoor light command ----------------------------------------------------

const lightOf = (device) => device.features.find((f) => f.external_id.endsWith(':light'));

test('the outdoor light switches through setstate {id, on, bridge}, state published at once', async () => {
  await discover();
  const bncx = deviceOf(BNCX_ID);
  await setDeviceValue({ gladys, client }, { device: bncx, feature: lightOf(bncx), value: 1 });
  assert.deepEqual(netatmo.state.setStateRequests.at(-1), {
    home: { id: 'home-1', modules: [{ id: BNSL_ID, on: true, bridge: BNCX_ID }] },
  });
  assert.deepEqual(stateOf(`${ext(BNSL_ID)}:light`), [1]);
  await setDeviceValue({ gladys, client }, { device: bncx, feature: lightOf(bncx), value: 0 });
  assert.deepEqual(netatmo.state.setStateRequests.at(-1).home.modules, [
    { id: BNSL_ID, on: false, bridge: BNCX_ID },
  ]);
  assert.deepEqual(stateOf(`${ext(BNSL_ID)}:light`), [1, 0]);
});

test('a light without its gateway device goes through its plug_id bridge', async () => {
  const home = netatmo.state.homes.find((h) => h.id === 'home-1');
  home.modules = home.modules.filter((m) => m.id !== BNCX_ID);
  const status = netatmo.state.homeStatuses['home-1'].home;
  status.modules = status.modules.filter((m) => m.id !== BNCX_ID);
  await discover();
  const bnsl = deviceOf(BNSL_ID);
  await setDeviceValue({ gladys, client }, { device: bnsl, feature: lightOf(bnsl), value: true });
  assert.deepEqual(netatmo.state.setStateRequests.at(-1).home.modules, [
    { id: BNSL_ID, on: true, bridge: BNCX_ID },
  ]);
});

test('a module error in the setstate answer fails the command, nothing published', async () => {
  await discover();
  const bncx = deviceOf(BNCX_ID);
  netatmo.state.overrides['/api/setstate'] = {
    body: { status: 'ok', body: { errors: [{ code: 6, id: BNCX_ID }] } },
  };
  await assert.rejects(
    setDeviceValue({ gladys, client }, { device: bncx, feature: lightOf(bncx), value: 1 }),
    /did not switch the light .*error 6 on 00:03:50:c0:47:74/,
  );
  assert.deepEqual(stateOf(`${ext(BNSL_ID)}:light`), []);
});

test('a missing BTicino scope is surfaced on the Configuration screen', async () => {
  await discover();
  const bncx = deviceOf(BNCX_ID);
  const statuses = [];
  gladys.setConnectionStatus = async (connected, message) => statuses.push({ connected, message });
  netatmo.state.failSetStateWith = {
    status: 403,
    body: { error: { code: 13, message: 'Application does not have the good scope rights' } },
  };
  await assert.rejects(
    setDeviceValue({ gladys, client }, { device: bncx, feature: lightOf(bncx), value: 1 }),
    /BTicino permissions/,
  );
  assert.deepEqual(statuses, [
    { connected: true, message: CONNECTION_MESSAGES.BTICINO_SCOPE_MISSING },
  ]);
  assert.deepEqual(stateOf(`${ext(BNSL_ID)}:light`), []);
});

test('the light command refuses a module the gateway does not bridge; the rest is read-only', async () => {
  await discover();
  const bncx = deviceOf(BNCX_ID);
  const foreign = { ...lightOf(bncx), external_id: `${ext('c04774-ffff-000000000000')}:light` };
  await assert.rejects(
    setDeviceValue({ gladys, client }, { device: bncx, feature: foreign, value: 1 }),
    /not bridged by/,
  );
  const wifi = bncx.features.find((f) => f.external_id.endsWith(':wifi_strength'));
  await assert.rejects(
    setDeviceValue({ gladys, client }, { device: bncx, feature: wifi, value: 1 }),
    /not writable/,
  );
  assert.deepEqual(netatmo.state.setStateRequests, []);
});

// --- Ring -----------------------------------------------------------------------

test('the door entry ring lands on the gateway device, whichever module the event names', async () => {
  await discover();
  const timers = { setTimeout: () => 1, clearTimeout: () => {} };
  const events = createEvents({ gladys, getHomes: () => telemetry.getHomes(), timers });
  const ring = `${ext(BNCX_ID)}:ring`;
  // The street panel named (its bridge is the gateway)...
  assert.equal(
    await events.handleWebhook({
      push_type: 'BNCX-incoming_call',
      home_id: 'home-1',
      module_id: BNEU_ID,
      device_id: BNCX_ID,
    }),
    ring,
  );
  // ...or only the gateway.
  assert.equal(
    await events.handleWebhook(
      JSON.stringify({ push_type: 'BNCX-incoming_call', home_id: 'home-1', device_id: BNCX_ID }),
    ),
    ring,
  );
  assert.deepEqual(stateOf(ring), [1, 1]);
  // The follow-up events of the same ring are not mapped (like the NDB).
  assert.equal(
    await events.handleWebhook({ push_type: 'BNCX-missed_call', device_id: BNCX_ID }),
    undefined,
  );
});

// --- Diagnostic log: loads ----------------------------------------------------

test('diagnostic: every BTicino entry is logged on the first load, tagged', async () => {
  // A VPN URL and a token, should Netatmo ever send them: redacted.
  Object.assign(homeStatusModule(BNCX_ID), {
    vpn_url:
      'https://prodvpn-eu-6.netatmo.net/10.255.12.34/0123456789abcdef0123456789abcdef/MTU0ODk0MTY4MDqM,,',
    access_token: 'secret-bticino-token',
  });
  await discover();
  const logged = tagged();
  assert.match(
    logged[0],
    /home home-1: 4 BTicino module\(s\) in homesdata \(BNCX, BNEU, BNDL, BNSL\), 4 in homestatus, 0 in errors/,
  );
  assert.equal(logged.filter((line) => / homesdata BN/.test(line)).length, 4);
  assert.equal(logged.filter((line) => / homestatus BN/.test(line)).length, 4);
  const bncxStatus = logged.find((line) => line.includes(`homestatus BNCX ${BNCX_ID}`));
  // Ids kept, secrets redacted.
  assert.match(bncxStatus, /"id":"00:03:50:c0:47:74"/);
  assert.match(bncxStatus, /"wifi_strength":48/);
  assert.match(bncxStatus, /"vpn_url":"https:\/\/prodvpn-eu-6\.netatmo\.net\/<redacted>"/);
  assert.match(bncxStatus, /"access_token":"<redacted>"/);
  assert.ok(!logged.some((line) => line.includes('secret-bticino-token')));
  assert.ok(!logged.some((line) => line.includes('0123456789abcdef0123456789abcdef')));
  // The non MAC-like ids of the bridged modules are kept as they are.
  assert.ok(logged.some((line) => line.includes(`"id":"${BNSL_ID}"`)));
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
  assert.match(
    added[0],
    /homestatus BNSL c04774-0060-db4f3bf1ffcf \(home home-1\) changed: .*"on":true/,
  );
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
  assert.match(lines[0], /"module_id":"c04774-a06f-db4f3bf1ff93"/);
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
