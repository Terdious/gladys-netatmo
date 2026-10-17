// -----------------------------------------------------------------------------
// BTicino Smarther with Netatmo (issue #54), against the fake Netatmo cloud
// with the pyatmo-shaped fixture (BNS in the "Corridor" room): Energy family
// gating, feature set, telemetry (WiFi, room values, heating / cooling
// states), the setpoint / heating mode commands and their missing-scope
// message, and the Smarther room in the heating widget and scene action.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { loadDevices, netatmoId } from '../../src/netatmo/discovery.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import { setDeviceValue } from '../../src/netatmo/setValue.js';
import { OAUTH_SCOPES } from '../../src/netatmo/constants.js';
import { WIDGETS, WIDGET_KEYS } from '../../src/netatmo/widgets.js';
import { SCENE_ACTIONS } from '../../src/netatmo/scenes.js';
import {
  startFakeNetatmo,
  addSmartherFixtures,
  OPENTHERM_HOME_ID,
  BNS_ID,
} from '../helpers/fakeNetatmo.js';

const ENERGY_ONLY = normalizeConfig({ weather_api: false });
const BNS = `ext:netatmo:${BNS_ID}`;

let netatmo;
let client;
let gladys;
let telemetry;

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  addSmartherFixtures(netatmo.state);
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

const homeStatusModule = () =>
  netatmo.state.homeStatuses[OPENTHERM_HOME_ID].home.modules.find((m) => m.id === BNS_ID);

function stateOf(featureExternalId) {
  return gladys.published
    .filter((s) => s.device_feature_external_id === featureExternalId)
    .map((s) => s.state);
}

const paramValue = (device, name) => device.params.find((param) => param.name === name)?.value;
const featureOf = (device, suffix) =>
  device.features.find((f) => f.external_id === `${device.external_id}:${suffix}`);

async function discover(config = ENERGY_ONLY) {
  gladys.devices = await telemetry.syncDiscovery(config);
  return gladys.devices.find((d) => d.external_id === BNS);
}

test('the Smarther scopes are requested at connection', () => {
  assert.ok(OAUTH_SCOPES.includes('read_smarther'));
  assert.ok(OAUTH_SCOPES.includes('write_smarther'));
});

test('the Smarther is an Energy module, gated by the Energy toggle', async () => {
  const devices = await loadDevices(client, ENERGY_ONLY);
  const bns = devices.find((d) => netatmoId(d) === BNS_ID);
  assert.equal(bns.categoryAPI, 'Energy');
  assert.equal(bns.not_handled, undefined);
  assert.equal(bns.room.name, 'Corridor');
  assert.equal(await discover(normalizeConfig({ energy_api: false })), undefined);
});

test('discovery: WiFi, room temperature, setpoint, heating / cooling, heating mode', async () => {
  const bns = await discover();
  assert.equal(bns.name, 'Smarther');
  assert.equal(bns.model, 'BNS');
  assert.equal(bns.should_poll, false);
  assert.deepEqual(
    bns.features.map((f) => f.external_id.replace(`${BNS}:`, '')),
    [
      'wifi_strength',
      'therm_measured_temperature',
      'therm_setpoint_temperature',
      'boiler_status',
      'cooler_status',
      'boiler_valve_comfort_boost',
      'therm_preset',
      'room_operating_state',
      'room_mode',
      'room_window',
    ],
  );
  assert.equal(featureOf(bns, 'therm_setpoint_temperature').read_only, false);
  assert.equal(featureOf(bns, 'therm_preset').read_only, false);
  for (const suffix of ['cooler_status', 'boiler_valve_comfort_boost']) {
    const feature = featureOf(bns, suffix);
    assert.equal(feature.category, 'switch');
    assert.equal(feature.type, 'binary');
    assert.equal(feature.read_only, true);
  }
  assert.equal(featureOf(bns, 'cooler_status').name, 'Cooler status - Smarther');
  assert.equal(featureOf(bns, 'boiler_valve_comfort_boost').name, 'Comfort boost - Smarther');
  // No relay, no battery: no plug params.
  assert.equal(paramValue(bns, 'plug_id'), undefined);
  assert.equal(paramValue(bns, 'home_id'), OPENTHERM_HOME_ID);
  assert.equal(paramValue(bns, 'room_id'), '1002003001');
  assert.equal(gladys.transports.find((t) => t.external_id === BNS).transport, 'cloud');
});

test('telemetry: WiFi, room values, boiler and cooler states, heating mode', async () => {
  await discover();
  await telemetry.refreshValues(ENERGY_ONLY);
  assert.deepEqual(stateOf(`${BNS}:wifi_strength`), [49]);
  assert.deepEqual(stateOf(`${BNS}:therm_measured_temperature`), [22]);
  assert.deepEqual(stateOf(`${BNS}:therm_setpoint_temperature`), [22]);
  assert.deepEqual(stateOf(`${BNS}:boiler_status`), [1]);
  assert.deepEqual(stateOf(`${BNS}:cooler_status`), [0]);
  assert.deepEqual(stateOf(`${BNS}:boiler_valve_comfort_boost`), [0]);
  assert.deepEqual(stateOf(`${BNS}:therm_preset`), [0]);

  // Summer: the air conditioning runs, the boiler stops.
  Object.assign(homeStatusModule(), { boiler_status: false, cooler_status: true });
  await telemetry.refreshValues(ENERGY_ONLY);
  assert.deepEqual(stateOf(`${BNS}:boiler_status`), [1, 0]);
  assert.deepEqual(stateOf(`${BNS}:cooler_status`), [0, 1]);

  // A field homestatus no longer carries is not published.
  delete homeStatusModule().cooler_status;
  homeStatusModule().reachable = false;
  await telemetry.refreshValues(ENERGY_ONLY);
  assert.deepEqual(stateOf(`${BNS}:cooler_status`), [0, 1]);
  assert.equal(
    gladys.transports.filter((t) => t.external_id === BNS).at(-1).transport,
    'unreachable',
  );
});

test('setDeviceValue: setpoint and heating mode, missing scope asks to reconnect', async () => {
  const bns = await discover();
  await setDeviceValue(
    { gladys, client },
    { device: bns, feature: featureOf(bns, 'therm_setpoint_temperature'), value: 19 },
  );
  await setDeviceValue(
    { gladys, client },
    { device: bns, feature: featureOf(bns, 'therm_preset'), value: 1 },
  );
  assert.deepEqual(netatmo.state.setpointRequests, [
    { home_id: OPENTHERM_HOME_ID, room_id: '1002003001', mode: 'manual', temp: '19' },
  ]);
  assert.deepEqual(netatmo.state.setThermModeRequests, [
    { home_id: OPENTHERM_HOME_ID, mode: 'hg' },
  ]);
  await assert.rejects(
    setDeviceValue(
      { gladys, client },
      { device: bns, feature: featureOf(bns, 'cooler_status'), value: 1 },
    ),
    /not writable/,
  );

  // A token granted before write_smarther: Netatmo answers 403 / code 13.
  netatmo.state.failSetpointWith = { status: 403, body: { error: { code: 13, message: 'scope' } } };
  await assert.rejects(
    setDeviceValue(
      { gladys, client },
      { device: bns, feature: featureOf(bns, 'therm_setpoint_temperature'), value: 20 },
    ),
    /missing scope rights.*reconnect your Netatmo account/,
  );
});

test('the Smarther room reaches the heating widget and the heating scene action', async () => {
  await discover();
  await telemetry.refreshValues(ENERGY_ONLY);
  const home = telemetry.getHomes().find((h) => h.id === OPENTHERM_HOME_ID);
  assert.deepEqual(
    home.rooms.map((room) => room.name),
    ['Corridor'],
  );

  const content = await WIDGETS[WIDGET_KEYS.HEATING].get(
    { gladys, client, telemetry },
    { settings: { device: BNS }, language: 'en', units: 'metric' },
  );
  assert.deepEqual(validateWidgetContent(content), []);
  const [status] = content.components.filter((c) => c.type === 'status');
  assert.deepEqual(
    status.items.slice(1).map((item) => [item.label, item.value]),
    [['Corridor', '22 °C → 22 °C']],
  );

  await SCENE_ACTIONS.set_heating_mode(
    { gladys, client, telemetry, now: () => 1_800_000_000_000 },
    { device: BNS, mode: 'schedule' },
  );
  assert.deepEqual(netatmo.state.setThermModeRequests, [
    { home_id: OPENTHERM_HOME_ID, mode: 'schedule' },
  ]);
});
