// -----------------------------------------------------------------------------
// Legrand Home + Control (issue #60): lighting modules, plugs and relays,
// against the fake Netatmo cloud with payloads copied from the pyatmo
// fixtures (see addLegrandFixtures — nobody has real Legrand payloads yet):
// scopes, `legrand_api` gating, the gateway and the double switch parent not
// exposed, one device per module (gangs included), telemetry (on, brightness,
// power, reachability and badges), the commands (on / brightness through the
// gateway, refresh after, scope and module errors) and the Device diagnostic.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { loadAccount, netatmoId, getModuleCategory } from '../../src/netatmo/discovery.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import { setDeviceValue } from '../../src/netatmo/setValue.js';
import { runDeviceDiagnostic, createWebhookHistory } from '../../src/netatmo/diagnostic.js';
import {
  CONNECTION_MESSAGES,
  LEGRAND_OAUTH_SCOPES,
  LEGRAND_REFRESH_DELAY_MS,
  BTICINO_OAUTH_SCOPES,
  OAUTH_SCOPES,
  requestedScopes,
} from '../../src/netatmo/constants.js';
import {
  isLegrandType,
  parentModuleId,
  resolveLegrandReachability,
  legrandFeatures,
} from '../../src/netatmo/legrand.js';
import {
  startFakeNetatmo,
  addLegrandFixtures,
  LEGRAND_HOME_ID,
  NLG_ID,
  NLP_ID,
  NLF_ID,
  NLFN_ID,
  NLFE_ID,
  NLL_ID,
  NLIS_ID,
  NLPT_ID,
  NLPD_ID,
  NLPO_ID,
  NLT_ID,
  NLV_ID,
  NLPC_ID,
} from '../helpers/fakeNetatmo.js';

// Only the Legrand family: every discovered device is a Legrand one.
const LEGRAND_ONLY = normalizeConfig({ energy_api: false, weather_api: false, legrand_api: true });
const ext = (id) => `ext:netatmo:${id}`;
const GANG_1 = `${NLIS_ID}#1`;
const GANG_2 = `${NLIS_ID}#2`;

let netatmo;
let client;
let gladys;
let telemetry;

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  addLegrandFixtures(netatmo.state);
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
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
  telemetry = createTelemetry({ gladys, client, loadTtlMs: 0 });
});

afterEach(async () => {
  telemetry.stop();
  await netatmo.close();
});

const statusOf = (id) =>
  netatmo.state.homeStatuses[LEGRAND_HOME_ID].home.modules.find((m) => m.id === id);
const deviceOf = (id) => gladys.devices.find((d) => d.external_id === ext(id));
const featureOf = (id, suffix) =>
  deviceOf(id).features.find((f) => f.external_id === `${ext(id)}:${suffix}`);
const suffixesOf = (device) =>
  device.features.map((f) => f.external_id.replace(`${device.external_id}:`, ''));
const paramValue = (device, name) => device.params.find((param) => param.name === name)?.value;
const stateOf = (id, suffix) =>
  gladys.published
    .filter((s) => s.device_feature_external_id === `${ext(id)}:${suffix}`)
    .map((s) => s.state);
const lastTransport = (id) => gladys.transports.filter((t) => t.external_id === ext(id)).at(-1);

async function discover(config = LEGRAND_ONLY) {
  gladys.devices = await telemetry.syncDiscovery(config);
  return gladys.devices;
}

// --- Scopes and toggle --------------------------------------------------------

test('the Legrand scopes (pyatmo names) are requested only while the toggle is on', () => {
  assert.deepEqual(LEGRAND_OAUTH_SCOPES, ['read_magellan', 'write_magellan']);
  for (const scope of LEGRAND_OAUTH_SCOPES) {
    assert.ok(!OAUTH_SCOPES.includes(scope), scope);
    assert.ok(!requestedScopes(normalizeConfig()).includes(scope), scope);
  }
  assert.deepEqual(requestedScopes(normalizeConfig({ legrand_api: 'true' })), [
    ...OAUTH_SCOPES,
    ...LEGRAND_OAUTH_SCOPES,
  ]);
  // Both opt-in families on: both sets, BTicino first (unchanged order).
  assert.deepEqual(requestedScopes(normalizeConfig({ legrand_api: true, bticino_api: true })), [
    ...OAUTH_SCOPES,
    ...BTICINO_OAUTH_SCOPES,
    ...LEGRAND_OAUTH_SCOPES,
  ]);
});

test('the Legrand family is opt-in: modules flagged off, nothing discovered', async () => {
  assert.equal(normalizeConfig().legrand_api, false);
  assert.equal(normalizeConfig({ legrand_api: 'true' }).legrand_api, true);
  const config = normalizeConfig({ energy_api: true, weather_api: false });
  const result = await loadAccount(client, config);
  const nlp = result.devices.find((d) => netatmoId(d) === NLP_ID);
  assert.equal(nlp.categoryAPI, 'Legrand');
  assert.equal(nlp.apiNotConfigured, true);
  const devices = await discover(config);
  assert.ok(!devices.some((d) => d.model.startsWith('NL')));
});

test('legrand_api alone runs the homesdata / homestatus load', async () => {
  const result = await loadAccount(client, LEGRAND_ONLY);
  assert.equal(result.partial, false);
  assert.deepEqual(result.failed, []);
  assert.ok(result.devices.some((d) => netatmoId(d) === NLP_ID));
  // The family health counts the `homes` family.
  await telemetry.refreshValues(LEGRAND_ONLY);
  assert.deepEqual(
    telemetry.getHealth().families.map((family) => family.family),
    ['homes'],
  );
});

test('module types: the supported ones, and what stays for the next groups', () => {
  for (const type of ['NLG', 'NLGS', 'NLM', 'NLL', 'NLIS', 'NLF', 'NLFN', 'NLFE', 'NLUF']) {
    assert.ok(isLegrandType(type), type);
  }
  for (const type of ['NLUO', 'NLP', 'NLPM', 'NLPBS', 'NLC', 'NLUP', 'NLUI', 'NLPO', 'NLPT']) {
    assert.ok(isLegrandType(type), type);
  }
  assert.ok(isLegrandType('NLPD'));
  // Shutters, energy meters, wireless commands, ventilation, garage door:
  // later groups of issue #60. NLDD is a remote control in pyatmo, NLV a
  // shutter: neither is a light here.
  for (const type of ['NLV', 'NLLV', 'NLLM', 'NLE', 'NLPC', 'NLY', 'NLPS', 'NLT', 'NLD']) {
    assert.equal(getModuleCategory(type, LEGRAND_ONLY).moduleSupported, false, type);
  }
  for (const type of ['NLAS', 'NLAO', 'NLDP', 'NLDD', 'NLLF', 'NLJ']) {
    assert.equal(getModuleCategory(type, LEGRAND_ONLY).moduleSupported, false, type);
  }
});

// --- Discovery ----------------------------------------------------------------

test('discovery: one device per lighting module, plug or relay; no gateway, no NLIS parent', async () => {
  await discover();
  assert.deepEqual(
    gladys.devices.map((d) => [d.model, d.external_id.slice('ext:netatmo:'.length)]),
    [
      ['NLP', NLP_ID],
      ['NLF', NLF_ID],
      ['NLL', NLL_ID],
      ['NLIS', GANG_2],
      ['NLIS', GANG_1],
      ['NLPT', NLPT_ID],
      ['NLPD', NLPD_ID],
      ['NLPO', NLPO_ID],
      ['NLFE', NLFE_ID],
      ['NLFN', NLFN_ID],
    ],
  );
  for (const id of [NLG_ID, NLIS_ID, NLT_ID, NLV_ID, NLPC_ID]) {
    assert.equal(deviceOf(id), undefined, id);
  }
});

test('discovery: lights, dimmers (brightness when reported), switches, power when reported', async () => {
  await discover();
  // Plug: a writable switch and its read-only power, bridged by the gateway.
  const nlp = deviceOf(NLP_ID);
  assert.equal(nlp.name, 'Prise');
  assert.equal(nlp.should_poll, false);
  assert.deepEqual(suffixesOf(nlp), ['on', 'power']);
  const [on, power] = nlp.features;
  assert.deepEqual(
    [on.name, on.category, on.type, on.read_only, on.min, on.max],
    ['Switch - Prise', 'switch', 'binary', false, 0, 1],
  );
  assert.deepEqual(
    [power.name, power.category, power.type, power.unit, power.read_only],
    ['Power - Prise', 'switch', 'power', 'watt', true],
  );
  assert.equal(paramValue(nlp, 'plug_id'), NLG_ID);
  assert.equal(paramValue(nlp, 'plug_name'), 'Prise Control');
  assert.equal(paramValue(nlp, 'home_id'), LEGRAND_HOME_ID);
  assert.equal(paramValue(nlp, 'room_name'), 'Salon');

  // Dimmers: light + brightness (0-100) + power. The pyatmo NLF entry has
  // no name: its id stands in.
  const nlf = deviceOf(NLF_ID);
  assert.equal(nlf.name, NLF_ID);
  assert.deepEqual(suffixesOf(nlf), ['on', 'brightness', 'power']);
  const brightness = featureOf(NLF_ID, 'brightness');
  assert.deepEqual(
    [brightness.category, brightness.type, brightness.unit, brightness.read_only],
    ['light', 'brightness', 'percent', false],
  );
  assert.deepEqual([brightness.min, brightness.max], [0, 100]);
  assert.deepEqual(suffixesOf(deviceOf(NLFE_ID)), ['on', 'brightness', 'power']);
  const light = featureOf(NLFE_ID, 'on');
  assert.deepEqual(
    [light.name, light.category, light.type, light.read_only],
    ['Light - Variateur', 'light', 'binary', false],
  );

  // On/off lighting: the Italian switch and each gang of the double switch.
  assert.deepEqual(suffixesOf(deviceOf(NLL_ID)), ['on', 'power']);
  assert.equal(featureOf(NLL_ID, 'on').category, 'light');
  for (const [gang, name] of [
    [GANG_1, 'NLIS droite'],
    [GANG_2, 'NLIS gauche'],
  ]) {
    const device = deviceOf(gang);
    assert.equal(device.name, name);
    assert.deepEqual(suffixesOf(device), ['on', 'power']);
    assert.equal(featureOf(gang, 'on').category, 'light');
    assert.equal(paramValue(device, 'plug_id'), NLG_ID);
    assert.equal(paramValue(device, 'room_name'), 'Entrada');
  }

  // Relays: latching relay, dry contact, contactor.
  for (const id of [NLPT_ID, NLPD_ID, NLPO_ID]) {
    assert.deepEqual(suffixesOf(deviceOf(id)), ['on', 'power'], id);
    assert.equal(featureOf(id, 'on').category, 'switch', id);
  }

  // A dimmer missing from homestatus (errors → unreachable): its light only,
  // nothing reported to declare a brightness or a power on.
  assert.deepEqual(suffixesOf(deviceOf(NLFN_ID)), ['on']);
});

test('legrandFeatures: a dimmer without brightness is an on/off light, a non-dimmer never gets one', () => {
  const suffixes = (module) =>
    legrandFeatures(module, 'n', 'ext:netatmo:x')?.map((f) => f.external_id.split(':').at(-1));
  assert.deepEqual(suffixes({ id: 'x', type: 'NLUO', on: true }), ['on']);
  assert.deepEqual(suffixes({ id: 'x', type: 'NLUF', on: true, brightness: 0 }), [
    'on',
    'brightness',
  ]);
  assert.deepEqual(suffixes({ id: 'x', type: 'NLM', on: true, brightness: 20 }), ['on']);
  assert.deepEqual(suffixes({ id: 'x', type: 'NLUI', on: true }), ['on']);
  assert.equal(suffixes({ id: 'x', type: 'NLGS' }), undefined);
  assert.equal(suffixes({ id: 'x', type: 'NLIS' }), undefined);
  assert.deepEqual(suffixes({ id: 'x#1', type: 'NLIS', on: false }), ['on']);
  assert.equal(parentModuleId('a:b#2'), 'a:b');
  assert.equal(parentModuleId('a:b'), null);
});

// --- Telemetry ----------------------------------------------------------------

test('telemetry: on, brightness and power from homestatus, deduplicated', async () => {
  await discover();
  await telemetry.refreshValues(LEGRAND_ONLY);
  await telemetry.refreshValues(LEGRAND_ONLY);
  assert.deepEqual(stateOf(NLP_ID, 'on'), [1]);
  assert.deepEqual(stateOf(NLP_ID, 'power'), [0]);
  assert.deepEqual(stateOf(NLF_ID, 'on'), [0]);
  assert.deepEqual(stateOf(NLF_ID, 'brightness'), [63]);
  assert.deepEqual(stateOf(NLFE_ID, 'brightness'), [61]);
  assert.deepEqual(stateOf(GANG_1, 'on'), [0]);
  assert.deepEqual(stateOf(NLPT_ID, 'on'), [1]);
  assert.deepEqual(stateOf(NLPO_ID, 'on'), [0]);
  // A physical change lands at the next cycle.
  Object.assign(statusOf(NLF_ID), { on: true, brightness: 80, power: 42 });
  await telemetry.refreshValues(LEGRAND_ONLY);
  assert.deepEqual(stateOf(NLF_ID, 'on'), [0, 1]);
  assert.deepEqual(stateOf(NLF_ID, 'brightness'), [63, 80]);
  assert.deepEqual(stateOf(NLF_ID, 'power'), [0, 42]);
  // A brightness outside 0-100 is no level: nothing published.
  statusOf(NLF_ID).brightness = 101;
  await telemetry.refreshValues(LEGRAND_ONLY);
  assert.deepEqual(stateOf(NLF_ID, 'brightness'), [63, 80]);
});

test('telemetry: badges — reachable modules cloud, the gangs follow their parent', async () => {
  await discover();
  await telemetry.refreshValues(LEGRAND_ONLY);
  for (const id of [NLP_ID, NLF_ID, GANG_1, GANG_2]) {
    assert.equal(lastTransport(id).transport, 'cloud', id);
  }
  assert.equal(lastTransport(NLFN_ID).transport, 'unreachable');

  // The double switch goes offline: its gangs (which never report
  // `reachable`) are unreachable too, and publish nothing stale.
  statusOf(NLIS_ID).reachable = false;
  statusOf(GANG_1).on = true;
  gladys.published.length = 0;
  telemetry.resetDedup();
  await telemetry.refreshValues(LEGRAND_ONLY);
  assert.equal(lastTransport(GANG_1).transport, 'unreachable');
  assert.equal(lastTransport(GANG_2).transport, 'unreachable');
  assert.deepEqual(stateOf(GANG_1, 'on'), []);
  assert.deepEqual(stateOf(NLP_ID, 'on'), [1]);
});

test('telemetry: behind an unreachable gateway, every module is unreachable and silent', async () => {
  await discover();
  statusOf(NLG_ID).reachable = false;
  await telemetry.refreshValues(LEGRAND_ONLY);
  assert.deepEqual(gladys.published, []);
  for (const id of [NLP_ID, NLF_ID, NLL_ID, GANG_1, NLPO_ID, NLFE_ID]) {
    assert.equal(lastTransport(id).transport, 'unreachable', id);
  }
});

test('resolveLegrandReachability: parent and gateway rules, other devices untouched', () => {
  const gateway = { id: 'gw', type: 'NLG', reachable: true };
  const parent = { id: 'p', type: 'NLIS', reachable: false, bridge: 'gw' };
  const gang = { id: 'p#1', type: 'NLIS', bridge: 'gw', on: true };
  const plug = { id: 'plug', type: 'NLP', reachable: true, bridge: 'gw' };
  const valve = { id: 'v', type: 'NRV', bridge: 'gw' };
  const resolved = resolveLegrandReachability([gateway, parent, gang, plug, valve]);
  assert.equal(resolved[2].reachable, false);
  assert.equal(gang.reachable, undefined, 'the input is not mutated');
  assert.equal(resolved[3], plug, 'unchanged devices are kept as they are');
  assert.equal(resolved[4], valve);
  const offline = resolveLegrandReachability([{ ...gateway, reachable: false }, plug, valve]);
  assert.equal(offline[1].reachable, false);
  assert.equal(offline[2], valve, 'a non-Legrand module never follows a Legrand gateway');
  // A gang whose parent is unknown keeps its (absent) reachability.
  assert.equal(resolveLegrandReachability([gang])[0], gang);
});

// --- Commands -----------------------------------------------------------------

function commandDeps(extra = {}) {
  const calls = { refresh: [], remembered: [] };
  return {
    calls,
    deps: {
      gladys,
      client,
      scheduleRefresh: (...args) => calls.refresh.push(args),
      rememberState: (...args) => calls.remembered.push(args),
      ...extra,
    },
  };
}

test('a light switches through setstate {id, on, bridge}, then one refresh shortly after', async () => {
  await discover();
  const { deps, calls } = commandDeps();
  const device = deviceOf(NLF_ID);
  await setDeviceValue(deps, { device, feature: featureOf(NLF_ID, 'on'), value: 1 });
  assert.deepEqual(netatmo.state.setStateRequests.at(-1), {
    home: { id: LEGRAND_HOME_ID, modules: [{ id: NLF_ID, on: true, bridge: NLG_ID }] },
  });
  assert.deepEqual(calls.remembered, [[`${ext(NLF_ID)}:on`, 1]]);
  assert.deepEqual(calls.refresh, [[LEGRAND_REFRESH_DELAY_MS, 'legrand']]);
  // Netatmo reports the state back: nothing is published optimistically.
  assert.deepEqual(gladys.published, []);

  const gang = deviceOf(GANG_2);
  await setDeviceValue(deps, { device: gang, feature: featureOf(GANG_2, 'on'), value: false });
  assert.deepEqual(netatmo.state.setStateRequests.at(-1).home.modules, [
    { id: GANG_2, on: false, bridge: NLG_ID },
  ]);
});

test('a dimmer level goes as setstate brightness 0-100, clamped and rounded', async () => {
  await discover();
  const { deps, calls } = commandDeps();
  const device = deviceOf(NLFE_ID);
  const feature = featureOf(NLFE_ID, 'brightness');
  await setDeviceValue(deps, { device, feature, value: 40 });
  assert.deepEqual(netatmo.state.setStateRequests.at(-1).home.modules, [
    { id: NLFE_ID, brightness: 40, bridge: NLG_ID },
  ]);
  await setDeviceValue(deps, { device, feature, value: 150 });
  await setDeviceValue(deps, { device, feature, value: 12.6 });
  await setDeviceValue(deps, { device, feature, value: -3 });
  assert.deepEqual(
    netatmo.state.setStateRequests.slice(-3).map((r) => r.home.modules[0].brightness),
    [100, 13, 0],
  );
  assert.deepEqual(
    calls.remembered.map(([, state]) => state),
    [40, 100, 13, 0],
  );
  await assert.rejects(setDeviceValue(deps, { device, feature, value: 'abc' }), /brightness/);
});

test('plugs and relays switch through setstate on; the power is read-only', async () => {
  await discover();
  const { deps } = commandDeps();
  for (const id of [NLP_ID, NLPT_ID, NLPD_ID, NLPO_ID]) {
    await setDeviceValue(deps, { device: deviceOf(id), feature: featureOf(id, 'on'), value: 0 });
    assert.deepEqual(netatmo.state.setStateRequests.at(-1).home.modules, [
      { id, on: false, bridge: NLG_ID },
    ]);
  }
  const count = netatmo.state.setStateRequests.length;
  await assert.rejects(
    setDeviceValue(deps, {
      device: deviceOf(NLP_ID),
      feature: featureOf(NLP_ID, 'power'),
      value: 1,
    }),
    /not writable/,
  );
  assert.equal(netatmo.state.setStateRequests.length, count);
});

test('a module without a bridge is commanded without one', async () => {
  await discover();
  const { deps } = commandDeps();
  const device = deviceOf(NLP_ID);
  const unbridged = { ...device, params: device.params.filter((p) => p.name !== 'plug_id') };
  await setDeviceValue(deps, { device: unbridged, feature: featureOf(NLP_ID, 'on'), value: 1 });
  assert.deepEqual(netatmo.state.setStateRequests.at(-1).home.modules, [{ id: NLP_ID, on: true }]);
});

test('a module error in the setstate answer fails the command, nothing remembered', async () => {
  await discover();
  const { deps, calls } = commandDeps();
  netatmo.state.overrides['/api/setstate'] = {
    body: { status: 'ok', body: { errors: [{ code: 6, id: NLG_ID }] } },
  };
  await assert.rejects(
    setDeviceValue(deps, { device: deviceOf(NLP_ID), feature: featureOf(NLP_ID, 'on'), value: 1 }),
    new RegExp(`did not apply the command to ${NLP_ID}: error 6 on ${NLG_ID}`),
  );
  assert.deepEqual(calls.remembered, []);
  assert.deepEqual(calls.refresh, []);
});

test('a missing Legrand scope is surfaced on the Configuration screen', async () => {
  await discover();
  const statuses = [];
  gladys.setConnectionStatus = async (connected, message) => statuses.push({ connected, message });
  netatmo.state.failSetStateWith = {
    status: 403,
    body: { error: { code: 13, message: 'Application does not have the good scope rights' } },
  };
  const { deps } = commandDeps();
  await assert.rejects(
    setDeviceValue(deps, { device: deviceOf(NLL_ID), feature: featureOf(NLL_ID, 'on'), value: 1 }),
    /Legrand Home \+ Control permissions/,
  );
  assert.deepEqual(statuses, [
    { connected: true, message: CONNECTION_MESSAGES.LEGRAND_SCOPE_MISSING },
  ]);
});

test('after a command, the refresh publishes what Netatmo reports — not a stale dedup', async () => {
  await discover();
  await telemetry.refreshValues(LEGRAND_ONLY);
  assert.deepEqual(stateOf(NLP_ID, 'on'), [1]);
  const deps = {
    gladys,
    client,
    scheduleRefresh: () => {},
    rememberState: (id, state) => telemetry.rememberState(id, state),
  };
  // Gladys turns the plug off (the core saves 0 itself); Netatmo applied it.
  await setDeviceValue(deps, {
    device: deviceOf(NLP_ID),
    feature: featureOf(NLP_ID, 'on'),
    value: 0,
  });
  statusOf(NLP_ID).on = false;
  await telemetry.refreshNow(LEGRAND_ONLY);
  assert.deepEqual(stateOf(NLP_ID, 'on'), [1], 'already 0 in Gladys: nothing to republish');
  // Someone turns it back on at the wall: published, although 1 was the
  // last value the telemetry itself published.
  statusOf(NLP_ID).on = true;
  await telemetry.refreshNow(LEGRAND_ONLY);
  assert.deepEqual(stateOf(NLP_ID, 'on'), [1, 1]);
  // A command Netatmo did not apply: the refresh shows the truth.
  await setDeviceValue(deps, {
    device: deviceOf(NLP_ID),
    feature: featureOf(NLP_ID, 'on'),
    value: 0,
  });
  await telemetry.refreshNow(LEGRAND_ONLY);
  assert.deepEqual(stateOf(NLP_ID, 'on'), [1, 1, 1]);
});

test('scheduleRefresh: the Legrand refresh is debounced and never cancels the shutter one', async () => {
  await discover();
  const loads = () =>
    netatmo.state.apiRequests.filter((r) => r.path.startsWith('/api/homesdata')).length;
  const before = loads();
  telemetry.scheduleRefresh(LEGRAND_ONLY, 60, 'shutter');
  telemetry.scheduleRefresh(LEGRAND_ONLY, 10, 'legrand');
  telemetry.scheduleRefresh(LEGRAND_ONLY, 10, 'legrand');
  await new Promise((resolve) => setTimeout(resolve, 150));
  // One load per key: the two Legrand commands share one refresh.
  assert.equal(loads() - before, 2);
});

// --- Device diagnostic --------------------------------------------------------

async function diagnostic(fields) {
  return runDeviceDiagnostic(
    {
      gladys,
      oauth: {
        hasTokens: () => true,
        grantedScopes: () => requestedScopes(LEGRAND_ONLY),
        missingScopes: () => [],
      },
      telemetry,
      webhooks: { isRegistered: () => false },
      webhookHistory: createWebhookHistory(),
      getConfig: () => LEGRAND_ONLY,
      logger: { info() {}, debug() {} },
    },
    fields,
  );
}

test('diagnostic: the Legrand family, a module, the gateway and the NLIS parent', async () => {
  await discover();
  const summary = await diagnostic({});
  assert.match(summary, /Enabled families: Legrand \(legrand_api\)/);
  assert.match(summary, /Scopes requested: .* read_magellan write_magellan\n/);
  assert.match(
    summary,
    new RegExp(`- NLG "Prise Control" ${NLG_ID}: supported — no Gladys device \\(Legrand gateway`),
  );
  assert.match(summary, new RegExp(`- NLP "Prise" ${NLP_ID}: supported — device "Prise"`));
  assert.match(summary, new RegExp(`- NLV "NLV" ${NLV_ID}: not supported`));

  const plug = await diagnostic({ device_ref: NLP_ID });
  assert.match(plug, /Support: supported \(Legrand family\)/);
  assert.match(plug, /Bridge: 12:34:56:80:60:40/);
  assert.match(plug, /Features: on \(switch\/binary, writable\), power \(switch\/power\)/);
  assert.match(
    plug,
    /Fields not used by the integration: firmware_revision, last_seen, offload, offload_meters, setup_date/,
  );

  const contactor = await diagnostic({ device_ref: NLPO_ID });
  assert.match(contactor, /Fields not used by the integration: .*contactor_mode/);

  const gateway = await diagnostic({ device_ref: NLG_ID });
  assert.match(gateway, /Support: supported \(Legrand family\)/);
  assert.match(
    gateway,
    /Gladys device: none \(Legrand gateway: not a Gladys device, it relays the commands of its modules\)/,
  );

  const parent = await diagnostic({ device_ref: NLIS_ID });
  assert.match(parent, /Gladys device: none \(multi-gang module: each gang/);
  const gang = await diagnostic({ device_ref: 'NLIS droite' });
  assert.match(gang, /Features: on \(light\/binary, writable\), power \(switch\/power\)/);

  const dimmer = await diagnostic({ device_ref: NLF_ID });
  assert.match(
    dimmer,
    /Features: on \(light\/binary, writable\), brightness \(light\/brightness, writable\), power \(switch\/power\)/,
  );
});
