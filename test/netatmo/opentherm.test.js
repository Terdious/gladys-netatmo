// -----------------------------------------------------------------------------
// Modulating / OpenTherm thermostat (issue #53), against the fake Netatmo
// cloud with the pyatmo-shaped fixtures (OTH relay + OTM thermostat in a
// second home): Energy family gating, feature set and params, telemetry
// (battery_state string, room values, boiler status, outdoor temperature,
// boiler fault), the unreachable badge, the setpoint / heating mode commands,
// and the OTM room in the heating widget and the heating scene action.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { loadDevices, netatmoId, summarizeHome } from '../../src/netatmo/discovery.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import { setDeviceValue } from '../../src/netatmo/setValue.js';
import { UPDATE_MAPPINGS } from '../../src/netatmo/updateMappings.js';
import { WIDGETS, WIDGET_KEYS } from '../../src/netatmo/widgets.js';
import { SCENE_ACTIONS } from '../../src/netatmo/scenes.js';
import {
  startFakeNetatmo,
  addOpenThermFixtures,
  OPENTHERM_HOME_ID,
  OTH_ID,
  OTM_ID,
} from '../helpers/fakeNetatmo.js';

const ENERGY_ONLY = normalizeConfig({ weather_api: false });
const OTH = `ext:netatmo:${OTH_ID}`;
const OTM = `ext:netatmo:${OTM_ID}`;

let netatmo;
let client;
let gladys;
let telemetry;

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  addOpenThermFixtures(netatmo.state);
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

const homeStatusModule = (id) =>
  netatmo.state.homeStatuses[OPENTHERM_HOME_ID].home.modules.find((m) => m.id === id);

function stateOf(featureExternalId) {
  return gladys.published
    .filter((s) => s.device_feature_external_id === featureExternalId)
    .map((s) => s.state);
}

const paramValue = (device, name) => device.params.find((param) => param.name === name)?.value;
const featureOf = (device, suffix) =>
  device.features.find((f) => f.external_id === `${device.external_id}:${suffix}`);
const suffixesOf = (device) =>
  device.features.map((f) => f.external_id.replace(`${device.external_id}:`, ''));

async function discover(config = ENERGY_ONLY) {
  gladys.devices = await telemetry.syncDiscovery(config);
  return {
    oth: gladys.devices.find((d) => d.external_id === OTH),
    otm: gladys.devices.find((d) => d.external_id === OTM),
  };
}

test('OTH and OTM are Energy modules, merged homesdata + homestatus', async () => {
  const devices = await loadDevices(client, ENERGY_ONLY);
  const oth = devices.find((d) => netatmoId(d) === OTH_ID);
  const otm = devices.find((d) => netatmoId(d) === OTM_ID);
  for (const device of [oth, otm]) {
    assert.equal(device.categoryAPI, 'Energy');
    assert.equal(device.apiNotConfigured, false);
    assert.equal(device.not_handled, undefined);
  }
  // The thermostat's "plug" is its relay; its room carries the live values.
  assert.equal(otm.plug.id, OTH_ID);
  assert.equal(otm.plug.name, 'Modulating Relay');
  assert.equal(otm.room.name, 'Bureau');
  assert.equal(otm.room.therm_setpoint_temperature, 20);
  assert.equal(otm.therm_mode, 'schedule');
  assert.equal(oth.boiler_error, 'water_pressure');
});

test('with the Energy toggle off, the modulating thermostat stays out of the discovery', async () => {
  const { oth, otm } = await discover(normalizeConfig({ energy_api: false }));
  assert.equal(oth, undefined);
  assert.equal(otm, undefined);
});

test('discovery: OTM like a thermostat, OTH with WiFi, outdoor temperature and boiler fault', async () => {
  const { oth, otm } = await discover();

  assert.equal(otm.name, 'Bureau Modulate');
  assert.equal(otm.model, 'OTM');
  assert.equal(otm.should_poll, false);
  assert.deepEqual(suffixesOf(otm), [
    'battery_percent',
    'rf_strength',
    'therm_measured_temperature',
    'therm_setpoint_temperature',
    // The room's window, like the NATherm1 (the Thermostat widget's window
    // sensor, issue #77).
    'open_window',
    'boiler_status',
    'therm_preset',
    // The room's thermostat features (issue #77): the OTM is the only
    // thermostat of its room.
    'room_operating_state',
    'room_mode',
  ]);
  const setpoint = featureOf(otm, 'therm_setpoint_temperature');
  assert.equal(setpoint.read_only, false);
  assert.equal(setpoint.step, 0.5);
  assert.equal(featureOf(otm, 'therm_preset').type, 'preset');
  assert.equal(featureOf(otm, 'therm_preset').read_only, false);
  assert.equal(featureOf(otm, 'therm_measured_temperature').name, 'Temperature - room Bureau');
  assert.equal(paramValue(otm, 'home_id'), OPENTHERM_HOME_ID);
  assert.equal(paramValue(otm, 'room_id'), '222452125');
  assert.equal(paramValue(otm, 'room_name'), 'Bureau');
  assert.equal(paramValue(otm, 'plug_id'), OTH_ID);
  assert.equal(paramValue(otm, 'plug_name'), 'Modulating Relay');

  assert.equal(oth.name, 'Modulating Relay');
  assert.equal(oth.model, 'OTH');
  assert.deepEqual(suffixesOf(oth), ['wifi_strength', 'outdoor_temperature', 'boiler_fault']);
  const outdoor = featureOf(oth, 'outdoor_temperature');
  assert.equal(outdoor.category, 'temperature-sensor');
  assert.equal(outdoor.type, 'decimal');
  assert.equal(outdoor.unit, 'celsius');
  assert.equal(outdoor.name, 'Temperature - outdoor Modulating Relay');
  const fault = featureOf(oth, 'boiler_fault');
  assert.equal(fault.name, 'Boiler fault - Modulating Relay');
  assert.equal(fault.category, 'switch');
  assert.equal(fault.type, 'binary');
  assert.equal(fault.read_only, true);
  assert.equal(paramValue(oth, 'modules_bridge_id'), JSON.stringify([OTM_ID]));
  assert.equal(paramValue(oth, 'home_id'), OPENTHERM_HOME_ID);

  const badge = Object.fromEntries(gladys.transports.map((t) => [t.external_id, t.transport]));
  assert.equal(badge[OTM], 'cloud');
  assert.equal(badge[OTH], 'cloud');
});

test('telemetry: battery_state, room values, boiler status, outdoor temperature, boiler fault', async () => {
  await discover();
  await telemetry.refreshValues(ENERGY_ONLY);

  assert.deepEqual(stateOf(`${OTM}:battery_percent`), [90]); // "full"
  assert.deepEqual(stateOf(`${OTM}:rf_strength`), [64]);
  assert.deepEqual(stateOf(`${OTM}:therm_measured_temperature`), [19.6]);
  assert.deepEqual(stateOf(`${OTM}:therm_setpoint_temperature`), [20]);
  assert.deepEqual(stateOf(`${OTM}:boiler_status`), [0]);
  assert.deepEqual(stateOf(`${OTM}:therm_preset`), [0]); // schedule
  assert.deepEqual(stateOf(`${OTH}:wifi_strength`), [57]);
  assert.deepEqual(stateOf(`${OTH}:outdoor_temperature`), [8.2]);
  assert.deepEqual(stateOf(`${OTH}:boiler_fault`), [1]); // "water_pressure"

  // The fault clears (no boiler_error in homestatus), the boiler heats, and
  // a 0 °C outdoor temperature is a value.
  delete homeStatusModule(OTH_ID).boiler_error;
  homeStatusModule(OTH_ID).outdoor_temperature = 0;
  homeStatusModule(OTM_ID).boiler_status = true;
  await telemetry.refreshValues(ENERGY_ONLY);
  assert.deepEqual(stateOf(`${OTH}:boiler_fault`), [1, 0]);
  assert.deepEqual(stateOf(`${OTH}:outdoor_temperature`), [8.2, 0]);
  assert.deepEqual(stateOf(`${OTM}:boiler_status`), [0, 1]);
});

test('boiler fault: only a non-empty boiler_error is a fault, nothing without homestatus', () => {
  const { boiler_fault: boilerFault } = UPDATE_MAPPINGS.OTH;
  assert.equal(boilerFault({ homestatus: true, boiler_error: 'boiler_not_responding' }), true);
  assert.equal(boilerFault({ homestatus: true }), false);
  assert.equal(boilerFault({ homestatus: true, boiler_error: '' }), false);
  assert.equal(boilerFault({ homestatus: true, boiler_error: 'none' }), false);
  // Rebuilt from homesdata (not in this homestatus): no value at all.
  assert.equal(boilerFault({ reachable: false }), undefined);
});

test('an unreachable OTM keeps its room values, not its battery, and gets the badge', async () => {
  homeStatusModule(OTM_ID).reachable = false;
  await discover();
  await telemetry.refreshValues(ENERGY_ONLY);
  const badge = Object.fromEntries(gladys.transports.map((t) => [t.external_id, t.transport]));
  assert.equal(badge[OTM], 'unreachable');
  assert.deepEqual(stateOf(`${OTM}:battery_percent`), []);
  assert.deepEqual(stateOf(`${OTM}:boiler_status`), []);
  assert.deepEqual(stateOf(`${OTM}:therm_setpoint_temperature`), [20]);
  assert.deepEqual(stateOf(`${OTM}:therm_preset`), [0]);
});

test('an OTM missing from homestatus is rebuilt unreachable from homesdata', async () => {
  const status = netatmo.state.homeStatuses[OPENTHERM_HOME_ID].home;
  status.modules = status.modules.filter((m) => m.id !== OTM_ID);
  status.errors = [{ code: 6, id: OTM_ID }];
  const devices = await loadDevices(client, ENERGY_ONLY);
  const otm = devices.find((d) => netatmoId(d) === OTM_ID);
  assert.equal(otm.reachable, false);
  assert.equal(otm.apiErrorCode, 6);
  const { otm: created } = await discover();
  assert.ok(created, 'still discovered, so it can be created');
  assert.equal(gladys.transports.find((t) => t.external_id === OTM).transport, 'unreachable');
});

test('setDeviceValue: setpoint through setroomthermpoint, heating mode through setthermmode', async () => {
  const { oth, otm } = await discover();
  await setDeviceValue(
    { gladys, client },
    { device: otm, feature: featureOf(otm, 'therm_setpoint_temperature'), value: 21.5 },
  );
  assert.deepEqual(netatmo.state.setpointRequests, [
    { home_id: OPENTHERM_HOME_ID, room_id: '222452125', mode: 'manual', temp: '21.5' },
  ]);
  await setDeviceValue(
    { gladys, client },
    { device: otm, feature: featureOf(otm, 'therm_preset'), value: 2 },
  );
  assert.deepEqual(netatmo.state.setThermModeRequests, [
    { home_id: OPENTHERM_HOME_ID, mode: 'away' },
  ]);
  // The relay values are read-only.
  for (const suffix of ['boiler_fault', 'outdoor_temperature']) {
    await assert.rejects(
      setDeviceValue(
        { gladys, client },
        { device: oth, feature: featureOf(oth, suffix), value: 1 },
      ),
      /not writable/,
    );
  }
});

test('the OTM room is a heated room of the home summary', async () => {
  await discover();
  const home = telemetry.getHomes().find((h) => h.id === OPENTHERM_HOME_ID);
  assert.deepEqual(home.rooms, [
    {
      id: '222452125',
      name: 'Bureau',
      therm_measured_temperature: 19.6,
      therm_setpoint_temperature: 20,
      heating_power_request: 30,
      open_window: false,
      therm_setpoint_mode: 'schedule',
      therm_setpoint_end_time: undefined,
    },
  ]);
  // The relay alone heats no room of its own.
  const relayOnly = summarizeHome({ id: 'h', modules: [] }, [
    { type: 'OTH', room: { id: 'r', name: 'Cellier' } },
  ]);
  assert.deepEqual(relayOnly.rooms, []);
});

test('the heating widget and the heating scene action reach the OTM home', async () => {
  await discover();
  await telemetry.refreshValues(ENERGY_ONLY);
  const content = await WIDGETS[WIDGET_KEYS.HEATING].get(
    { gladys, client, telemetry },
    { settings: { device: OTM }, language: 'en', units: 'metric' },
  );
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components[0].text, 'MYHOME');
  const [status] = content.components.filter((c) => c.type === 'status');
  assert.deepEqual(
    status.items.slice(1).map((item) => [item.label, item.value, item.color]),
    [['Bureau', '19.6 °C → 20 °C', 'warning']],
  );

  const outputs = await SCENE_ACTIONS.set_heating_mode(
    { gladys, client, telemetry, now: () => 1_800_000_000_000 },
    { device: OTM, mode: 'hg' },
  );
  assert.deepEqual(outputs, { home_name: 'MYHOME' });
  assert.deepEqual(netatmo.state.setThermModeRequests, [
    { home_id: OPENTHERM_HOME_ID, mode: 'hg' },
  ]);
});
