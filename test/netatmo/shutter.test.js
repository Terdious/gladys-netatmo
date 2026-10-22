// -----------------------------------------------------------------------------
// Bubendorff / iDiamant roller shutters (issue #34), against the fake Netatmo
// cloud with the pyatmo-shaped fixtures: the `shutter_api` toggle gates the
// discovery (and alone triggers the homesdata/homestatus load), the feature
// set and params, the telemetry (position + end-stop state), the setstate
// commands routed through the iDiamant bridge, the delayed refresh and the
// missing-scope message.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { loadDevices, netatmoId } from '../../src/netatmo/discovery.js';
import { convertDevice } from '../../src/netatmo/convert.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import { setDeviceValue } from '../../src/netatmo/setValue.js';
import { CONNECTION_MESSAGES, OAUTH_SCOPES } from '../../src/netatmo/constants.js';
import { startFakeNetatmo, addShutterFixtures, SHUTTER_BRIDGE_ID } from '../helpers/fakeNetatmo.js';

const SHUTTER_ONLY = normalizeConfig({
  energy_api: false,
  weather_api: false,
  security_api: false,
  shutter_api: true,
});

let netatmo;
let client;
let gladys;
let telemetry;

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  addShutterFixtures(netatmo.state);
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
  gladys = {
    published: [],
    transports: [],
    connectionStatuses: [],
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
    async setConnectionStatus(connected, message) {
      this.connectionStatuses.push({ connected, message });
    },
  };
  telemetry = createTelemetry({ gladys, client, loadTtlMs: 0 });
});

afterEach(async () => {
  telemetry.stop();
  await netatmo.close();
});

function stateOf(featureExternalId) {
  return gladys.published
    .filter((s) => s.device_feature_external_id === featureExternalId)
    .map((s) => s.state);
}

function paramValue(device, name) {
  return device.params.find((param) => param.name === name)?.value;
}

function featureOf(device, suffix) {
  return device.features.find((f) => f.external_id === `${device.external_id}:${suffix}`);
}

async function discoverShutter(id) {
  gladys.devices = await telemetry.syncDiscovery(SHUTTER_ONLY);
  return gladys.devices.find((d) => d.external_id === `ext:netatmo:${id}`);
}

test('the shutter scopes are requested at connection', () => {
  assert.ok(OAUTH_SCOPES.includes('read_bubendorff'));
  assert.ok(OAUTH_SCOPES.includes('write_bubendorff'));
});

test('shutter_api alone runs the homesdata/homestatus load, nothing else', async () => {
  const devices = await loadDevices(client, SHUTTER_ONLY);
  const shutter = devices.find((d) => netatmoId(d) === '0009999992');
  assert.equal(shutter.categoryAPI, 'Shutter');
  assert.equal(shutter.apiNotConfigured, false);
  // Its "plug" is the iDiamant gateway (merged homesdata + homestatus).
  assert.equal(shutter.plug.id, SHUTTER_BRIDGE_ID);
  assert.equal(shutter.plug.name, 'module iDiamant');
  // The gateway itself is not a supported device.
  assert.equal(devices.find((d) => netatmoId(d) === SHUTTER_BRIDGE_ID).not_handled, true);
  // The NBS missing from homestatus is rebuilt unreachable (errors array).
  const solar = devices.find((d) => netatmoId(d) === '0009999994');
  assert.equal(solar.reachable, false);
  assert.equal(solar.apiErrorCode, 6);

  const paths = netatmo.state.apiRequests.map((r) => r.path.split('?')[0]);
  assert.ok(paths.includes('/api/homesdata'));
  assert.ok(paths.includes('/api/homestatus'));
  assert.ok(!paths.includes('/api/getthermostatsdata'));
  assert.ok(!paths.includes('/api/getstationsdata'));
});

test('with the toggle off (default), the shutters stay out of the discovery', async () => {
  const devices = await telemetry.syncDiscovery(normalizeConfig());
  assert.ok(!devices.some((d) => d.model === 'NBR' || d.model === 'NBO' || d.model === 'NBS'));
  assert.ok(!gladys.transports.some((t) => t.external_id === 'ext:netatmo:0009999992'));
});

test('discovery: state + position + RF quality, bridge params, gateway skipped', async () => {
  const devices = await telemetry.syncDiscovery(SHUTTER_ONLY);
  assert.deepEqual(devices.map((d) => d.model).sort(), ['NBO', 'NBR', 'NBS']);

  const shutter = devices.find((d) => d.external_id === 'ext:netatmo:0009999992');
  assert.equal(shutter.name, 'Entrance Blinds');
  assert.equal(shutter.should_poll, false);
  assert.deepEqual(
    shutter.features.map((f) => f.external_id.replace(`${shutter.external_id}:`, '')),
    ['state', 'position', 'rf_strength'],
  );
  const state = featureOf(shutter, 'state');
  assert.equal(state.category, 'shutter');
  assert.equal(state.type, 'state');
  assert.equal(state.read_only, false);
  assert.equal(state.min, -1);
  assert.equal(state.max, 1);
  const position = featureOf(shutter, 'position');
  assert.equal(position.category, 'shutter');
  assert.equal(position.type, 'position');
  assert.equal(position.read_only, false);
  assert.equal(position.unit, 'percent');
  assert.equal(position.min, 0);
  assert.equal(position.max, 100);

  assert.equal(paramValue(shutter, 'home_id'), 'home-1');
  assert.equal(paramValue(shutter, 'room_id'), 'room-1');
  assert.equal(paramValue(shutter, 'room_name'), 'Salon');
  assert.equal(paramValue(shutter, 'plug_id'), SHUTTER_BRIDGE_ID);
  assert.equal(paramValue(shutter, 'plug_name'), 'module iDiamant');

  const badge = Object.fromEntries(gladys.transports.map((t) => [t.external_id, t.transport]));
  assert.equal(badge['ext:netatmo:0009999992'], 'cloud');
  assert.equal(badge['ext:netatmo:0009999994'], 'unreachable');
  assert.equal(badge[`ext:netatmo:${SHUTTER_BRIDGE_ID}`], undefined);
});

test('convert falls back to the raw bridge id when the gateway is unknown', () => {
  const device = convertDevice(
    { externalId: (suffix) => `ext:netatmo:${suffix}` },
    {
      id: 'shutter-x',
      type: 'NBS',
      name: 'Volet',
      home: 'home-1',
      bridge: 'gateway-x',
      categoryAPI: 'Shutter',
      apiNotConfigured: false,
    },
  );
  assert.equal(paramValue(device, 'plug_id'), 'gateway-x');
  assert.equal(paramValue(device, 'plug_name'), undefined);
  assert.equal(paramValue(device, 'room_id'), undefined);
});

test('telemetry: position from current_position, state at the end stops only', async () => {
  gladys.devices = await telemetry.syncDiscovery(SHUTTER_ONLY);
  await telemetry.refreshValues(SHUTTER_ONLY);

  // Closed NBR: position 0 is a value, state CLOSE (-1); rf_strength 0 kept.
  assert.deepEqual(stateOf('ext:netatmo:0009999992:position'), [0]);
  assert.deepEqual(stateOf('ext:netatmo:0009999992:state'), [-1]);
  assert.deepEqual(stateOf('ext:netatmo:0009999992:rf_strength'), [0]);
  // Open NBO: state OPEN (1).
  assert.deepEqual(stateOf('ext:netatmo:0009999993:position'), [100]);
  assert.deepEqual(stateOf('ext:netatmo:0009999993:state'), [1]);
  assert.deepEqual(stateOf('ext:netatmo:0009999993:rf_strength'), [74]);
  // Unreachable NBS: nothing.
  assert.deepEqual(stateOf('ext:netatmo:0009999994:position'), []);

  // Half-way: the position moves, the state is left to the last command.
  const modules = netatmo.state.homeStatuses['home-1'].home.modules;
  modules.find((m) => m.id === '0009999992').current_position = 40;
  // 101 = "never instructed" (pyatmo): not a position, nothing published.
  modules.find((m) => m.id === '0009999993').current_position = 101;
  await telemetry.refreshValues(SHUTTER_ONLY);
  assert.deepEqual(stateOf('ext:netatmo:0009999992:position'), [0, 40]);
  assert.deepEqual(stateOf('ext:netatmo:0009999992:state'), [-1]);
  assert.deepEqual(stateOf('ext:netatmo:0009999993:position'), [100]);
  assert.deepEqual(stateOf('ext:netatmo:0009999993:state'), [1]);
});

test('setDeviceValue: open / close / stop and position go through setstate with the bridge', async () => {
  const shutter = await discoverShutter('0009999992');
  const state = featureOf(shutter, 'state');
  const position = featureOf(shutter, 'position');
  let refreshes = 0;
  const deps = { gladys, client, scheduleRefresh: () => (refreshes += 1) };

  await setDeviceValue(deps, { device: shutter, feature: state, value: 1 });
  await setDeviceValue(deps, { device: shutter, feature: state, value: -1 });
  await setDeviceValue(deps, { device: shutter, feature: state, value: 0 });
  await setDeviceValue(deps, { device: shutter, feature: position, value: 55.4 });
  await setDeviceValue(deps, { device: shutter, feature: position, value: 150 });

  const module = (target) => ({
    home: {
      id: 'home-1',
      modules: [{ id: '0009999992', target_position: target, bridge: SHUTTER_BRIDGE_ID }],
    },
  });
  assert.deepEqual(netatmo.state.setStateRequests, [
    module(100),
    module(0),
    module(-1),
    module(55),
    module(100),
  ]);
  // Every accepted command arms the delayed refresh.
  assert.equal(refreshes, 5);
});

test('setDeviceValue rejects an unknown shutter state and a missing bridge', async () => {
  const shutter = await discoverShutter('0009999992');
  const state = featureOf(shutter, 'state');
  await assert.rejects(
    setDeviceValue({ gladys, client }, { device: shutter, feature: state, value: 5 }),
    /Unknown shutter state/,
  );
  const noBridge = { ...shutter, params: shutter.params.filter((p) => p.name !== 'plug_id') };
  await assert.rejects(
    setDeviceValue({ gladys, client }, { device: noBridge, feature: state, value: 1 }),
    /plug_id/,
  );
  // The RF quality stays read-only.
  await assert.rejects(
    setDeviceValue(
      { gladys, client },
      { device: shutter, feature: featureOf(shutter, 'rf_strength'), value: 1 },
    ),
    /not writable/,
  );
  assert.equal(netatmo.state.setStateRequests.length, 0);
});

test('a module error in the setstate answer fails the shutter command, no refresh armed', async () => {
  // Forum report: Netatmo answered HTTP 200 with a module error, the shutter
  // never moved and nothing was logged.
  const shutter = await discoverShutter('0009999992');
  netatmo.state.overrides['/api/setstate'] = {
    body: { status: 'ok', body: { errors: [{ code: 6, id: SHUTTER_BRIDGE_ID }] } },
  };
  let refreshes = 0;
  await assert.rejects(
    setDeviceValue(
      { gladys, client, scheduleRefresh: () => (refreshes += 1) },
      { device: shutter, feature: featureOf(shutter, 'state'), value: -1 },
    ),
    new RegExp(
      `did not apply target_position 0 to shutter 0009999992 \\(bridge ${SHUTTER_BRIDGE_ID}, home home-1\\): error 6 on ${SHUTTER_BRIDGE_ID}`,
    ),
  );
  assert.equal(refreshes, 0);
});

test('a missing shutter scope asks to reconnect, on the command and the Configuration screen', async () => {
  const shutter = await discoverShutter('0009999992');
  netatmo.state.failSetStateWith = { status: 403, body: { error: { code: 13, message: 'scope' } } };
  let refreshes = 0;
  await assert.rejects(
    setDeviceValue(
      { gladys, client, scheduleRefresh: () => (refreshes += 1) },
      { device: shutter, feature: featureOf(shutter, 'state'), value: 1 },
    ),
    /reconnect your Netatmo account .* shutter permissions/,
  );
  // Still connected (every other device works), with the 4-language hint.
  assert.deepEqual(gladys.connectionStatuses, [
    { connected: true, message: CONNECTION_MESSAGES.SHUTTER_SCOPE_MISSING },
  ]);
  // Not retried, no refresh armed.
  assert.equal(netatmo.state.setStateRequests.length, 1);
  assert.equal(refreshes, 0);

  // Any other failure is rethrown untouched, without the scope hint.
  netatmo.state.failSetStateWith = { status: 500, body: { error: { code: 1, message: 'ko' } } };
  await assert.rejects(
    setDeviceValue(
      { gladys, client },
      { device: shutter, feature: featureOf(shutter, 'state'), value: 1 },
    ),
    /answered 500/,
  );
  assert.equal(gladys.connectionStatuses.length, 1);
});

test('scheduleRefresh coalesces commands into one delayed refresh, cancelled by stop()', async () => {
  gladys.devices = await telemetry.syncDiscovery(SHUTTER_ONLY);
  const homesdataCalls = () =>
    netatmo.state.apiRequests.filter((r) => r.path.startsWith('/api/homesdata')).length;
  const before = homesdataCalls();

  telemetry.scheduleRefresh(SHUTTER_ONLY, 20);
  telemetry.scheduleRefresh(SHUTTER_ONLY, 20);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(homesdataCalls(), before + 1);
  assert.deepEqual(stateOf('ext:netatmo:0009999992:position'), [0]);

  telemetry.scheduleRefresh(SHUTTER_ONLY, 20);
  telemetry.stop();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(homesdataCalls(), before + 1);
});
