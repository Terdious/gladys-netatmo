// -----------------------------------------------------------------------------
// "Device diagnostic" action (Configuration screen): the webhook history,
// module resolution (picked device, typed name / id, accents ignored), the
// module report (support, Gladys mapping, raw entries redacted, unused
// fields, webhooks), the account summary (health, grouped door entry), the
// fallbacks (not connected, failed load) and the info-level log.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import { createBticinoDiagnostic } from '../../src/netatmo/bticino.js';
import { createEvents } from '../../src/netatmo/events.js';
import { createEventsPoll } from '../../src/netatmo/eventsPoll.js';
import { redactForDiagnostic as sharedRedact } from '../../src/netatmo/redact.js';
import { redactForDiagnostic } from '../../src/netatmo/bticino.js';
import {
  createWebhookHistory,
  describeWebhookBody,
  describeWebhookCheck,
  describeWebhookUrl,
  integrationVersion,
  normalizeName,
  redactedJson,
  runDeviceDiagnostic,
  unmappedFieldsOf,
  webhookModuleIds,
  ISSUES_URL,
} from '../../src/netatmo/diagnostic.js';
import { DEVICE_DIAGNOSTIC_TAG, requestedScopes } from '../../src/netatmo/constants.js';
import {
  startFakeNetatmo,
  addBticinoFixtures,
  BNCX_ID,
  BNEU_ID,
  BNDL_ID,
  BNSL_ID,
} from '../helpers/fakeNetatmo.js';

const CONFIG = normalizeConfig({ energy_api: true, weather_api: false, bticino_api: true });
const ext = (id) => `ext:netatmo:${id}`;

let netatmo;
let client;
let gladys;
let telemetry;
let history;
let logged;
let clock;
let oauth;

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  addBticinoFixtures(netatmo.state);
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
  clock = 1_800_000_000_000;
  gladys = {
    devices: [],
    externalId: (suffix) => `ext:netatmo:${suffix}`,
    getDevicesCalls: 0,
    async getDevices() {
      this.getDevicesCalls += 1;
      return this.devices;
    },
    async publishStates() {},
    async publishDiscoveredDevices() {},
    async publishTransports() {},
    async publishCameraImage() {},
    requestWidgetRefresh() {},
  };
  telemetry = createTelemetry({
    gladys,
    client,
    loadTtlMs: 0,
    now: () => clock,
    bticinoDiagnostic: createBticinoDiagnostic({ logger: { info() {} } }),
  });
  history = createWebhookHistory({ now: () => clock });
  logged = [];
  oauth = {
    hasTokens: () => true,
    grantedScopes: () => requestedScopes(CONFIG),
    missingScopes: () => [],
  };
});

afterEach(async () => {
  telemetry.stop();
  await netatmo.close();
});

function run(fields = {}, overrides = {}) {
  return runDeviceDiagnostic(
    {
      gladys,
      oauth,
      telemetry,
      webhooks: { isRegistered: () => true },
      webhookHistory: history,
      getConfig: () => CONFIG,
      logger: { info: (line) => logged.push(line), debug() {} },
      now: () => clock,
      ...overrides,
    },
    fields,
  );
}

/** Create the door entry device in Gladys, as the user would. */
async function createDoorEntry() {
  const devices = await telemetry.syncDiscovery(CONFIG);
  gladys.devices = devices.filter((d) => d.external_id === ext(BNCX_ID));
  return gladys.devices[0];
}

// --- Webhook history ----------------------------------------------------------

test('webhook history: bounded overall and per module, redacted, non-JSON ignored', () => {
  const small = createWebhookHistory({ now: () => 5, size: 3, perModule: 2, maxModules: 2 });
  assert.equal(small.record('not json'), null);
  assert.equal(small.record(undefined), null);
  for (let i = 0; i < 4; i += 1) {
    small.record({ push_type: `NACamera-movement`, camera_id: 'cam', event_id: `e${i}` });
  }
  assert.deepEqual(
    small.recent().map((e) => e.payload.event_id),
    ['e1', 'e2', 'e3'],
  );
  assert.deepEqual(
    small.forModule('cam').map((e) => e.payload.event_id),
    ['e2', 'e3'],
  );
  assert.equal(small.total(), 4);
  assert.equal(small.lastAt(), 5);
  // Least recently seen module id evicted beyond maxModules.
  small.record(JSON.stringify({ push_type: 'NSD-smoke', module_id: 'smoke' }));
  small.record({ push_type: 'BNCX-incoming_call', extra_params: { device_id: 'gw' } });
  assert.deepEqual(small.forModule('cam'), []);
  assert.equal(small.forModule('gw').length, 1);
  // Redacted on record.
  const entry = small.record({
    push_type: 'NDB-incoming_call',
    module_id: 'ndb',
    snapshot_url: 'https://netatmocameraimage.blob.core.windows.net/x?sig=secret',
  });
  assert.equal(
    entry.payload.snapshot_url,
    'https://netatmocameraimage.blob.core.windows.net/<redacted>',
  );
  assert.deepEqual(
    webhookModuleIds({ module_id: 'a', device_id: 'b', extra_params: { device_id: 'c' } }),
    ['a', 'b', 'c'],
  );
});

test('helpers: accents and case ignored, bounded redacted JSON, shared redaction, version', () => {
  assert.equal(normalizeName('  Éclairage EXTÉRIEUR '), 'eclairage exterieur');
  assert.equal(
    redactedJson({ access_token: 'x', id: 'a' }),
    '{"access_token":"<redacted>","id":"a"}',
  );
  assert.equal(redactedJson(undefined), 'none');
  assert.match(
    redactedJson({ text: 'word '.repeat(100) }, 50),
    /…\[truncated, \d+ characters in total\]$/,
  );
  assert.equal(redactForDiagnostic, sharedRedact);
  assert.match(integrationVersion(), /^\d+\.\d+\.\d+/);
});

// --- Module report ------------------------------------------------------------

test('a picked door entry: support, Gladys mapping, raw entries, unused fields, its modules', async () => {
  await createDoorEntry();
  history.record({ push_type: 'BNCX-incoming_call', device_id: BNCX_ID, home_id: 'home-1' });
  const report = await run({ device: ext(BNCX_ID) });
  assert.equal(gladys.getDevicesCalls, 1);
  assert.match(report, /^Netatmo integration — device diagnostic\nIntegration version: /);
  assert.match(report, /Enabled families: Energy \(energy_api\), BTicino \(bticino_api\)/);
  assert.match(report, /Scopes missing: none/);
  assert.match(report, /Scopes granted: .*read_bfi write_bfi read_mx write_mx/);
  assert.match(
    report,
    new RegExp(
      [
        `Module ${BNCX_ID}`,
        '  Type: BNCX',
        '  Name: Classe 300EOS with Netatmo',
        '  Home: Maison \\(home-1\\)',
        '  Bridge: none',
        '  Reachable: yes',
        '  Support: supported \\(BTicino family\\)',
      ].join('\\n'),
    ),
  );
  assert.match(
    report,
    /Gladys device: "Classe 300EOS with Netatmo" ext:netatmo:00:03:50:c0:47:74 \(BNCX\), created in Gladys/,
  );
  assert.match(report, /Features: wifi_strength \(signal\/integer\), ring \(doorbell\/ring\)\n/);
  // Netatmo fields the integration does not use: the fastest hint.
  assert.match(
    report,
    /Fields not used by the integration: firmware_revision, last_seen, offload, setup_date, use_pincode/,
  );
  assert.match(report, /homesdata: \{"id":"00:03:50:c0:47:74","type":"BNCX",/);
  assert.match(report, /homestatus: \{"id":"00:03:50:c0:47:74","type":"BNCX",.*"wifi_strength":48/);
  assert.match(
    report,
    /Recent webhook events naming it:\n {4}2027-01-15T08:00:00.000Z BNCX-incoming_call: /,
  );
  // The modules grouped on its device are detailed too.
  for (const id of [BNEU_ID, BNDL_ID, BNSL_ID]) {
    assert.match(report, new RegExp(`Module ${id}\\n`));
  }
  assert.match(
    report,
    /Module c04774-0060-db4f3bf1ffcf\n {2}Type: BNSL\n {2}Name: Eclairage extérieur\n.*\n {2}Bridge: 00:03:50:c0:47:74/,
  );
  assert.match(
    report,
    /the device of its door entry gateway, created in Gladys\n {2}Features: light \(light\/binary, writable\)/,
  );
  assert.match(report, /Module c04774-a06f-db4f3bf1ffb8[\s\S]*?Features: none for this module/);
  assert.ok(
    report.endsWith(
      `issue at ${ISSUES_URL} and paste this report. Read it first: tokens, URLs and e-mail addresses are redacted, but module, home and event ids and the names you gave your modules are kept.`,
    ),
  );
  // Logged at info level too, tagged.
  assert.equal(logged.length, 1);
  assert.ok(logged[0].startsWith(`${DEVICE_DIAGNOSTIC_TAG}\n${report.split('\n')[0]}`));
});

test('a typed module not created in Gladys: by name (accents, case) or by Netatmo id', async () => {
  const byName = await run({ device_ref: 'ECLAIRAGE exterieur' });
  assert.match(byName, new RegExp(`Module ${BNSL_ID}\\n  Type: BNSL`));
  assert.match(byName, /the device of its door entry gateway, not created in Gladys yet/);
  assert.ok(!byName.includes(`Module ${BNCX_ID}`));
  const byId = await run({ device_ref: 'THERM-1' });
  assert.match(byId, /Module therm-1\n {2}Type: NATherm1/);
  assert.match(byId, /Support: supported \(Energy family\)/);
  assert.match(byId, /Gladys device: "Thermostat" ext:netatmo:therm-1 \(NATherm1\), not created/);
  assert.match(
    byId,
    /Features: .*therm_setpoint_temperature \(thermostat\/target-temperature, writable\)/,
  );
  // The heating values read by its table are used; nothing else reported.
  assert.match(
    byId,
    /Fields not used by the integration: setup_date\n|Fields not used by the integration: none\n/,
  );
});

test('the picked device wins over the typed one; a family off and an unknown type are said', async () => {
  const both = await run({ device: ext('therm-1'), device_ref: 'Serrure' });
  assert.match(both, /Module therm-1\n/);
  assert.ok(!both.includes(`Module ${BNDL_ID}`));

  const camera = await run({ device_ref: 'Caméra salon' });
  assert.match(camera, /Support: supported, but its family is off \(security_api toggle\)/);
  assert.match(camera, /Gladys device: none \(its family is off in the configuration\)/);

  netatmo.state.homes[0].modules.push({ id: 'nlg-1', type: 'NLG', name: 'Legrand gateway' });
  netatmo.state.homeStatuses['home-1'].home.modules.push({
    id: 'nlg-1',
    type: 'NLG',
    wifi_strength: 50,
    zigbee_channel: 15,
  });
  const unknown = await run({ device_ref: 'nlg-1' });
  assert.match(unknown, /Support: not supported by the integration/);
  assert.match(unknown, /Gladys device: none \(module type not supported\)/);
  assert.match(unknown, /Fields not used by the integration: wifi_strength, zigbee_channel/);
});

test('no match: said, then the account summary', async () => {
  const report = await run({ device_ref: 'Garage door' });
  assert.match(
    report,
    /No Netatmo module matches "Garage door" \(name or Netatmo id\)\. Account summary:/,
  );
  assert.match(report, /Modules:\n {2}Home "Maison" \(home-1\):/);
});

// --- Account summary ----------------------------------------------------------

test('the summary lists every module, the door entry grouped, with the account health', async () => {
  await createDoorEntry();
  history.record({ push_type: 'NACamera-movement', camera_id: 'camera-1' });
  netatmo.state.failHomeCoachsWith = { status: 500, body: {} };
  const report = await run({}, { getConfig: () => ({ ...CONFIG, aircare_api: true }) });
  assert.match(report, /Modules:\n {2}Home "Maison" \(home-1\):/);
  assert.match(
    report,
    /- BNCX "Classe 300EOS with Netatmo" 00:03:50:c0:47:74: supported — device "Classe 300EOS with Netatmo" \(created in Gladys\)\n {6}- BNEU "Platine de rue" c04774-a06f-db4f3bf1ff93: supported — grouped into the device of its gateway 00:03:50:c0:47:74\n {6}- BNDL "Serrure" .*\n {6}- BNSL "Eclairage extérieur" /,
  );
  assert.match(
    report,
    /- NATherm1 "Thermostat" therm-1: supported — device "Thermostat" \(not created in Gladys\)/,
  );
  assert.match(
    report,
    /- NACamera "Caméra salon" camera-1: supported — no Gladys device \(its family is off in the configuration\)/,
  );
  // Health: families, failures, webhook.
  assert.match(
    report,
    /Account health:\n {2}Last load: 2027-01-15T08:00:00.000Z \(partial\) — failed: aircare/,
  );
  assert.match(
    report,
    / {2}homes: last success 2027-01-15T08:00:00.000Z, 0 consecutive failure\(s\)/,
  );
  assert.match(report, / {2}aircare: last success never, 1 consecutive failure\(s\)/);
  assert.match(
    report,
    / {2}Webhook \(Gladys Plus\): registered at Netatmo, last event received 2027-01-15T08:00:00.000Z, 1 since start/,
  );
  assert.match(
    report,
    /Last webhook events \(all modules\):\n {2}2027-01-15T08:00:00.000Z NACamera-movement: \{"push_type":"NACamera-movement","camera_id":"camera-1"\}/,
  );
});

test('nothing secret reaches the report', async () => {
  Object.assign(
    netatmo.state.homeStatuses['home-1'].home.modules.find((m) => m.id === BNCX_ID),
    {
      vpn_url: 'https://prodvpn-eu-6.netatmo.net/10.255.12.34/0123456789abcdef0123456789abcdef/x,,',
      access_token: 'secret-bticino-token',
    },
  );
  history.record({
    push_type: 'BNCX-rtc',
    device_id: BNCX_ID,
    snapshot_url: 'https://h/x?sig=leak',
  });
  const report = await run({ device_ref: BNCX_ID });
  assert.ok(!report.includes('secret-bticino-token'));
  assert.ok(!report.includes('0123456789abcdef0123456789abcdef'));
  assert.ok(!report.includes('leak'));
  assert.match(report, /"vpn_url":"https:\/\/prodvpn-eu-6\.netatmo\.net\/<redacted>"/);
  // Fields the integration consumes are not listed as unused.
  assert.doesNotMatch(report, /Fields not used by the integration: .*vpn_url/);
  assert.match(report, /Fields not used by the integration: access_token, firmware_revision/);
});

// --- Fallbacks ----------------------------------------------------------------

test('not connected: the header says so, the summary is empty', async () => {
  const report = await run(
    {},
    { oauth: { ...oauth, hasTokens: () => false, grantedScopes: () => null } },
  );
  assert.match(report, /Scopes granted: unknown until the next token refresh/);
  assert.match(report, /Account load for this report failed: the Netatmo account is not connected/);
  assert.match(report, /Modules:\n {2}none \(no account load yet\)/);
  assert.match(
    report,
    /Webhook \(Gladys Plus\): registered at Netatmo, last event received never, 0 since start/,
  );
});

test('a failed load falls back to the last one, and a missing scope is pointed out', async () => {
  await telemetry.refreshValues(CONFIG);
  const failing = {
    ...telemetry,
    getAccount: async () => {
      throw new Error('Netatmo API /api/homesdata answered 500');
    },
  };
  const report = await run(
    { device_ref: 'Serrure' },
    {
      telemetry: failing,
      oauth: { ...oauth, missingScopes: () => ['read_bfi'] },
      webhooks: { isRegistered: () => false },
    },
  );
  assert.match(
    report,
    /Account load for this report failed: Netatmo API \/api\/homesdata answered 500/,
  );
  assert.match(
    report,
    /Scopes missing: read_bfi — click Connect again on the Configuration screen/,
  );
  assert.match(report, /Webhook \(Gladys Plus\): not registered \(poll only\)/);
  assert.match(report, new RegExp(`Module ${BNDL_ID}\\n  Type: BNDL`));
});

test('unmappedFieldsOf: a legacy-only device is read from its raw payload', () => {
  const unmapped = unmappedFieldsOf({
    id: '70:ee:50:00:00:01',
    rawDevice: {
      _id: '70:ee:50:00:00:01',
      type: 'NHC',
      station_name: 'Bedroom',
      dashboard_data: { Temperature: 20 },
      firmware: 45,
      categoryAPI: 'Aircare',
      apiNotConfigured: false,
    },
  });
  assert.deepEqual(unmapped, ['firmware']);
});

// --- Webhook delivery checks --------------------------------------------------

test('webhook URLs are shown without their key, and the held URL is compared with ours', () => {
  const ours =
    'https://api.gladysgateway.com/v1/api/external-integration/SECRETKEY/ext-netatmo/events';
  const legacy = 'https://api.gladysgateway.com/v1/api/netatmo/SECRETKEY';
  assert.equal(
    describeWebhookUrl(ours),
    'https://api.gladysgateway.com/v1/api/external-integration/<redacted>',
  );
  assert.equal(
    describeWebhookUrl(legacy),
    'https://api.gladysgateway.com/v1/api/netatmo/<redacted>',
  );
  assert.equal(describeWebhookUrl('not a url'), '<redacted url>');

  const same = describeWebhookCheck({ ours, atNetatmo: [ours], matches: true, error: null });
  assert.match(
    same,
    /^the integration's URL \(https:\/\/api\.gladysgateway\.com\/v1\/api\/external-integration\/<redacted>\)$/,
  );
  const other = describeWebhookCheck({ ours, atNetatmo: [legacy], matches: false, error: null });
  assert.match(other, /v1\/api\/netatmo\/<redacted> — NOT the integration's URL/);
  assert.match(other, /save the Gladys Plus key again/);
  assert.match(describeWebhookCheck({ ours, atNetatmo: [], matches: false, error: null }), /^none/);
  assert.match(
    describeWebhookCheck({ ours, atNetatmo: null, matches: false, error: 'boom' }),
    /^could not be read \(boom\)$/,
  );
  for (const text of [same, other]) {
    assert.ok(!text.includes('SECRETKEY'));
  }
});

test('a received webhook is summarised for the log: type and module ids, never the payload', () => {
  assert.equal(
    describeWebhookBody(
      JSON.stringify({ push_type: 'NACamera-movement', camera_id: 'cam-1', snapshot_key: 'x' }),
    ),
    'NACamera-movement (cam-1)',
  );
  assert.equal(describeWebhookBody({ event_type: 'webhook_activation' }), 'webhook_activation');
  assert.equal(describeWebhookBody({}), 'no push_type');
  assert.equal(describeWebhookBody('a=1&b=2'), 'non-JSON body (7 characters) — ignored');
});

test('the report says which webhook URL Netatmo holds', async () => {
  const report = await run(
    {},
    {
      webhooks: {
        isRegistered: () => true,
        check: async () => ({
          ours: 'https://relay.example/v1/api/external-integration/K/ext-netatmo/events',
          atNetatmo: ['https://relay.example/v1/api/netatmo/K'],
          matches: false,
          error: null,
        }),
      },
    },
  );
  assert.match(
    report,
    /\n {2}Webhook URL held by Netatmo: https:\/\/relay\.example\/v1\/api\/netatmo\/<redacted> — NOT the integration's URL/,
  );
});

test('the events seen by getevents are reported next to the webhooks, per module and overall', async () => {
  const doorEntry = await createDoorEntry();
  assert.ok(doorEntry);
  const events = createEvents({ gladys, getHomes: () => telemetry.getHomes(), now: () => clock });
  const eventsPoll = createEventsPoll({
    client,
    events,
    now: () => clock,
    logger: { info() {}, warn() {}, debug() {} },
  });
  const t = Math.round(clock / 1000);
  netatmo.state.events['home-1'] = [
    { id: 'ring-old', type: 'incoming_call', time: t - 600, module_id: BNEU_ID },
  ];
  await eventsPoll.poll(CONFIG, telemetry.getHomes());
  clock += 2 * 60 * 1000;
  netatmo.state.events['home-1'].push({
    id: 'ring-new',
    type: 'incoming_call',
    time: t + 100,
    module_id: BNEU_ID,
    snapshot: { url: 'https://netatmocameraimage.blob.core.windows.net/production/secret' },
  });
  await eventsPoll.poll(CONFIG, telemetry.getHomes());
  events.stop();

  const report = await run({ device: ext(BNCX_ID) }, { eventsPoll });
  assert.match(
    report,
    / {2}Events poll \(getevents\): last poll 2027-01-15T08:02:00.000Z, 2 event\(s\) seen since start, 1 detection\(s\) published from it, newest event per home home-1: 2027-01-15T08:01:40.000Z/,
  );
  assert.match(
    report,
    /Module c04774-a06f-db4f3bf1ff93[\s\S]*Last events seen by getevents:\n {4}2027-01-15T07:50:00.000Z incoming_call \(c04774-a06f-db4f3bf1ff93, event ring-old\): already there at startup — not published\n {4}2027-01-15T08:01:40.000Z incoming_call \(c04774-a06f-db4f3bf1ff93, event ring-new\): published/,
  );
  assert.ok(!report.includes('netatmocameraimage'));

  const summary = await run({}, { eventsPoll });
  assert.match(
    summary,
    /Last events seen by getevents \(all modules\):\n {2}2027-01-15T07:50:00.000Z incoming_call/,
  );
  // Without a poll (older wiring) the sections are simply absent.
  assert.ok(!(await run({})).includes('getevents'));
});

test('the events poll line says when it has not run yet, and its last error', async () => {
  const eventsPoll = createEventsPoll({
    client,
    events: { handleEvent: async () => ({ outcome: 'published', scenes: 0 }) },
    now: () => clock,
    logger: { info() {}, warn() {}, debug() {} },
  });
  assert.match(
    await run({}, { eventsPoll }),
    /Events poll \(getevents\): not run yet \(no camera, doorbell, alarm or door entry discovered with its family on\)/,
  );
  await telemetry.syncDiscovery(CONFIG);
  netatmo.state.failGetEventsWith = { status: 503, body: {} };
  await eventsPoll.poll(CONFIG, telemetry.getHomes());
  assert.match(
    await run({}, { eventsPoll }),
    /Events poll \(getevents\): last poll .*, 0 event\(s\) seen since start, 0 detection\(s\) published from it, last error: Netatmo API \/api\/getevents\?home_id=home-1&size=30 answered 503/,
  );
});
