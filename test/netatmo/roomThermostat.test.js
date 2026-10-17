// -----------------------------------------------------------------------------
// Heated room features for the Gladys Thermostat service and widget (issue
// #77): one device per room carries the room's heating state and mode (off /
// heating), every thermostat and valve its open window (0 open / 1 closed,
// the Gladys opening sensor convention); the mode command (setroomthermpoint `off` /
// `home`, skipped when already in that mode), the setpoint left unsent on an
// off room, and the stop / start sequences the Thermostat service writes
// (Gladys spec thermostat.md C.0: the mode first, then the setpoint).
// Payloads modelled on the pyatmo homestatus rooms (`heating_power_request`,
// `open_window`, `therm_setpoint_mode`).
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import { markRoomThermostats } from '../../src/netatmo/discovery.js';
import { convertDevice } from '../../src/netatmo/convert.js';
import { setDeviceValue } from '../../src/netatmo/setValue.js';
import { UPDATE_MAPPINGS } from '../../src/netatmo/updateMappings.js';
import { thermostatModeToSetpointMode } from '../../src/netatmo/deviceMapping.js';
import { startFakeNetatmo } from '../helpers/fakeNetatmo.js';

const ENERGY_ONLY = normalizeConfig({ weather_api: false });
const THERM = 'ext:netatmo:therm-1';
const VALVE = 'ext:netatmo:valve-1';
const VALVE_OFF = 'ext:netatmo:valve-2';
const ROOM_SUFFIXES = ['room_operating_state', 'room_mode'];

let netatmo;
let client;
let gladys;
let telemetry;

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
  gladys = {
    published: [],
    devices: [],
    externalId: (suffix) => `ext:netatmo:${suffix}`,
    async publishStates(states) {
      this.published.push(...states);
    },
    async publishDiscoveredDevices() {},
    async publishTransports() {},
    async publishCameraImage() {},
  };
  telemetry = createTelemetry({ gladys, client, loadTtlMs: 0 });
});

afterEach(async () => {
  telemetry.stop();
  await netatmo.close();
});

const roomStatus = (roomId) =>
  netatmo.state.homeStatuses['home-1'].home.rooms.find((room) => room.id === roomId);
const deviceOf = (externalId) => gladys.devices.find((d) => d.external_id === externalId);
const featureOf = (device, suffix) =>
  device.features.find((f) => f.external_id === `${device.external_id}:${suffix}`);
const suffixesOf = (device) =>
  device.features.map((f) => f.external_id.replace(`${device.external_id}:`, ''));
const stateOf = (featureExternalId) =>
  gladys.published
    .filter((s) => s.device_feature_external_id === featureExternalId)
    .map((s) => s.state);

/** setDeviceValue wired like index.js (raw payloads and room patch). */
function command(device, suffix, value) {
  return setDeviceValue(
    {
      gladys,
      client,
      getRawDevice: (id) => telemetry.getRawDevice(id),
      patchRoom: (homeId, roomId, patch) => telemetry.patchRoom(homeId, roomId, patch),
    },
    { device, feature: featureOf(device, suffix), value },
  );
}

async function discover() {
  gladys.devices = await telemetry.syncDiscovery(ENERGY_ONLY);
  await telemetry.refreshValues(ENERGY_ONLY);
}

// --- One carrier per room ----------------------------------------------------

test('markRoomThermostats: the thermostat of the room, else its valve with the smallest id', () => {
  const devices = markRoomThermostats([
    { id: 'valve-b', type: 'NRV', room: { id: 'room-1' } },
    { id: 'therm-1', type: 'NATherm1', room: { id: 'room-1' } },
    { id: 'valve-z', type: 'NRV', room: { id: 'room-2' } },
    // Powered off (rebuilt from homesdata): still in the election, so the
    // features do not move when it goes offline.
    { id: 'valve-a', type: 'NRV', room: { id: 'room-2' }, reachable: false },
    { id: 'otm-1', type: 'OTM', room: { id: 'room-3' } },
    { id: 'bns-1', type: 'BNS', room: { id: 'room-4' } },
    { id: 'valve-c', type: 'NRV', room: { id: 'room-4' } },
    // No room, or not a heating module: never elected.
    { id: 'valve-x', type: 'NRV', room: {} },
    { id: 'station-1', type: 'NAMain', room: { id: 'room-5' } },
  ]);
  assert.deepEqual(
    devices.filter((device) => device.room_thermostat).map((device) => device.id),
    ['therm-1', 'valve-a', 'otm-1', 'bns-1'],
  );
});

test('discovery: the room features ride on one device per room, named after the room', async () => {
  await discover();
  // Salon: the NATherm1. Chambre: two valves, the first by id carries them.
  for (const externalId of [THERM, VALVE]) {
    const device = deviceOf(externalId);
    assert.deepEqual(suffixesOf(device).slice(-2), ROOM_SUFFIXES, externalId);
  }
  assert.ok(!suffixesOf(deviceOf(VALVE_OFF)).some((suffix) => ROOM_SUFFIXES.includes(suffix)));

  const valve = deviceOf(VALVE);
  const state = featureOf(valve, 'room_operating_state');
  assert.equal(state.name, 'Heating state - Chambre');
  assert.equal(state.category, 'thermostat');
  assert.equal(state.type, 'operating-state');
  assert.equal(state.read_only, true);
  assert.equal(state.min, 0);
  assert.equal(state.max, 2);

  const mode = featureOf(valve, 'room_mode');
  assert.equal(mode.name, 'Thermostat mode - Chambre');
  assert.equal(mode.category, 'thermostat');
  assert.equal(mode.type, 'mode');
  assert.equal(mode.read_only, false);
  // Heating only: the Thermostat service clamps a mode to `max`.
  assert.equal(mode.min, 0);
  assert.equal(mode.max, 1);
  assert.deepEqual(mode.supported_options, [
    { value: 0, label: 'Off', sort_order: 0 },
    { value: 1, label: 'Heating', sort_order: 1 },
  ]);

  // The window sensor of the widget is the existing open_window feature, on
  // every thermostat and valve of the room (no room-level duplicate).
  for (const device of [deviceOf(THERM), valve, deviceOf(VALVE_OFF)]) {
    const window = featureOf(device, 'open_window');
    assert.equal(window.category, 'opening-sensor', device.external_id);
    assert.equal(window.type, 'binary');
    assert.equal(window.read_only, true);
    assert.ok(!suffixesOf(device).includes('room_window'));
  }

  // Each room keeps a writable setpoint on the elected device.
  assert.equal(featureOf(deviceOf(THERM), 'therm_setpoint_temperature').read_only, false);
  assert.equal(featureOf(valve, 'therm_setpoint_temperature').read_only, false);
});

test('convert: no room features without the election, nor without a commandable room', () => {
  const ext = { externalId: (suffix) => `ext:netatmo:${suffix}` };
  const base = { id: 'therm-1', type: 'NATherm1', name: 'Thermostat', home: 'home-1' };
  const room = { id: 'room-1', name: 'Salon' };
  const plain = convertDevice(ext, { ...base, room });
  assert.ok(!suffixesOf(plain).includes('room_mode'));
  const elected = convertDevice(ext, { ...base, room, room_thermostat: true });
  assert.deepEqual(suffixesOf(elected).slice(-2), ROOM_SUFFIXES);
  // Legacy-only thermostat: no home, no room — nothing to command.
  const legacy = convertDevice(ext, { _id: 'therm-2', type: 'NATherm1', room_thermostat: true });
  assert.ok(!suffixesOf(legacy).includes('room_mode'));
});

// --- Telemetry ---------------------------------------------------------------

test('telemetry: heating state, mode and window from the room (pyatmo homestatus rooms)', async () => {
  await discover();
  // Salon: heating_power_request 0 but the boiler runs (NATherm1), schedule,
  // window closed (1).
  assert.deepEqual(stateOf(`${THERM}:room_operating_state`), [1]);
  assert.deepEqual(stateOf(`${THERM}:room_mode`), [1]);
  assert.deepEqual(stateOf(`${THERM}:open_window`), [1]);
  // Chambre: heating_power_request 42, manual setpoint, window open (0), on
  // both valves of the room.
  assert.deepEqual(stateOf(`${VALVE}:room_operating_state`), [1]);
  assert.deepEqual(stateOf(`${VALVE}:room_mode`), [1]);
  assert.deepEqual(stateOf(`${VALVE}:open_window`), [0]);
  assert.deepEqual(stateOf(`${VALVE_OFF}:open_window`), [0]);

  // The boiler stops, the window closes, the room is switched off.
  netatmo.state.homeStatuses['home-1'].home.modules.find((m) => m.id === 'therm-1').boiler_status =
    false;
  Object.assign(roomStatus('room-2'), {
    heating_power_request: 0,
    open_window: false,
    therm_setpoint_mode: 'off',
    therm_setpoint_temperature: 7,
  });
  await telemetry.refreshValues(ENERGY_ONLY);
  assert.deepEqual(stateOf(`${THERM}:room_operating_state`), [1, 0]);
  assert.deepEqual(stateOf(`${VALVE}:room_operating_state`), [1, 0]);
  assert.deepEqual(stateOf(`${VALVE}:room_mode`), [1, 0]);
  assert.deepEqual(stateOf(`${VALVE}:open_window`), [0, 1]);
  assert.deepEqual(stateOf(`${VALVE_OFF}:open_window`), [0, 1]);
  // An off room aims at no temperature: its setpoint is not published, on
  // any device of the room.
  assert.deepEqual(stateOf(`${VALVE}:therm_setpoint_temperature`), [19]);
  assert.deepEqual(stateOf(`${VALVE_OFF}:therm_setpoint_temperature`), [19]);

  // Fields homestatus no longer reports: nothing published.
  const before = gladys.published.length;
  for (const field of ['heating_power_request', 'open_window', 'therm_setpoint_mode']) {
    delete roomStatus('room-1')[field];
  }
  delete netatmo.state.homeStatuses['home-1'].home.modules.find((m) => m.id === 'therm-1')
    .boiler_status;
  telemetry.resetDedup();
  await telemetry.refreshValues(ENERGY_ONLY);
  const republished = gladys.published.slice(before).map((s) => s.device_feature_external_id);
  for (const suffix of [...ROOM_SUFFIXES, 'open_window']) {
    assert.ok(!republished.includes(`${THERM}:${suffix}`), suffix);
  }
});

test('opening sensors follow the Gladys convention: 0 open, 1 closed, nothing when unknown', () => {
  // open_window of every thermostat and valve (room `open_window`).
  for (const type of ['NATherm1', 'OTM', 'BNS', 'NRV']) {
    const extract = UPDATE_MAPPINGS[type].open_window;
    assert.equal(extract({ room: { open_window: true } }), 0, type);
    assert.equal(extract({ room: { open_window: false } }), 1, type);
    assert.equal(extract({ room: {} }), undefined, type);
    assert.equal(extract({ room: { open_window: null } }), undefined, type);
    assert.equal(extract({}), undefined, type);
  }
  // opening of the door / window tag (homestatus `status`).
  const opening = UPDATE_MAPPINGS.NACamDoorTag.opening;
  assert.equal(opening({ status: 'open' }), 0);
  assert.equal(opening({ status: 'closed' }), 1);
  for (const status of ['no_news', 'calibrating', 'undefined', undefined, null]) {
    assert.equal(opening({ status }), undefined, String(status));
  }
});

test('operating state: room request, boiler, cooler; stale module states ignored', () => {
  const extract = UPDATE_MAPPINGS.BNS.room_operating_state;
  assert.equal(extract({ room: { heating_power_request: 30 } }), 1);
  assert.equal(extract({ room: { heating_power_request: 0 }, boiler_status: true }), 1);
  assert.equal(extract({ room: { heating_power_request: 0 }, boiler_status: false }), 0);
  assert.equal(extract({ room: {}, boiler_status: false, cooler_status: true }), 2);
  assert.equal(extract({ room: {} }), undefined);
  // An unreachable module replays its last-known boiler status: the room's
  // own request still counts.
  assert.equal(extract({ room: {}, boiler_status: true, reachable: false }), undefined);
  assert.equal(
    extract({ room: { heating_power_request: 0 }, boiler_status: true, reachable: false }),
    0,
  );
  const mode = UPDATE_MAPPINGS.NRV.room_mode;
  for (const setpointMode of ['schedule', 'manual', 'max', 'away', 'hg', 'home']) {
    assert.equal(mode({ room: { therm_setpoint_mode: setpointMode } }), 1, setpointMode);
  }
  assert.equal(mode({ room: { therm_setpoint_mode: 'off' } }), 0);
  assert.equal(mode({ room: {} }), undefined);
});

// --- Commands ----------------------------------------------------------------

test('mode command: off / back to the schedule, skipped when already in that mode', async () => {
  await discover();
  const therm = deviceOf(THERM);
  // Salon follows its schedule: HEATING is already the case.
  await command(therm, 'room_mode', 1);
  assert.deepEqual(netatmo.state.setpointRequests, []);

  await command(therm, 'room_mode', 0);
  assert.deepEqual(netatmo.state.setpointRequests, [
    { home_id: 'home-1', room_id: 'room-1', mode: 'off' },
  ]);
  // The Thermostat service may write the mode on every pass: no second call.
  await command(therm, 'room_mode', 0);
  assert.equal(netatmo.state.setpointRequests.length, 1);

  await command(therm, 'room_mode', 1);
  assert.deepEqual(netatmo.state.setpointRequests.at(-1), {
    home_id: 'home-1',
    room_id: 'room-1',
    mode: 'home',
  });

  // A manual setpoint is heating too: HEATING does not reset it.
  const valve = deviceOf(VALVE);
  await command(valve, 'room_mode', 1);
  assert.equal(netatmo.state.setpointRequests.length, 2);

  // Cooling / auto: not a mode of a Netatmo room.
  await assert.rejects(command(therm, 'room_mode', 2), /no thermostat mode 2/);
  assert.throws(() => thermostatModeToSetpointMode(3), /no thermostat mode 3/);
  // The heating state is read-only.
  await assert.rejects(command(therm, 'room_operating_state', 1), /not writable/);
});

test('mode command: a token without the write scope asks to reconnect', async () => {
  await discover();
  netatmo.state.failSetpointWith = { status: 403, body: { error: { code: 13, message: 'scope' } } };
  await assert.rejects(
    command(deviceOf(THERM), 'room_mode', 0),
    /missing scope rights.*reconnect your Netatmo account/,
  );
  // Refused: the room is still seen as heating, the next attempt is sent.
  netatmo.state.failSetpointWith = null;
  await command(deviceOf(THERM), 'room_mode', 0);
  assert.equal(netatmo.state.setpointRequests.length, 2);
});

test('stop then start as the Thermostat service writes them: the room stays off, then heats', async () => {
  await discover();
  const valve = deviceOf(VALVE);
  // Stop (window open, `off` slot): OFF first, then the frost setpoint. The
  // setpoint must not switch the room back on (`manual`).
  await command(valve, 'room_mode', 0);
  await command(valve, 'therm_setpoint_temperature', 7);
  assert.deepEqual(netatmo.state.setpointRequests, [
    { home_id: 'home-1', room_id: 'room-2', mode: 'off' },
  ]);
  // The other valve of the room knows the room is off too.
  await command(deviceOf(VALVE_OFF), 'therm_setpoint_temperature', 7);
  assert.equal(netatmo.state.setpointRequests.length, 1);

  // Next cycle: the room reads off, its setpoint is left alone.
  await telemetry.refreshValues(ENERGY_ONLY);
  assert.deepEqual(stateOf(`${VALVE}:room_mode`), [1, 0]);
  assert.deepEqual(stateOf(`${VALVE}:therm_setpoint_temperature`), [19]);

  // Start: HEATING first (back to the schedule), then the Gladys setpoint.
  await command(valve, 'room_mode', 1);
  await command(valve, 'therm_setpoint_temperature', 21);
  assert.deepEqual(netatmo.state.setpointRequests.slice(1), [
    { home_id: 'home-1', room_id: 'room-2', mode: 'home' },
    { home_id: 'home-1', room_id: 'room-2', mode: 'manual', temp: '21' },
  ]);
  await telemetry.refreshValues(ENERGY_ONLY);
  assert.deepEqual(stateOf(`${VALVE}:room_mode`), [1, 0, 1]);
  assert.deepEqual(stateOf(`${VALVE}:therm_setpoint_temperature`), [19, 21]);
});

test('a room switched off in the Netatmo app: the setpoint is not sent until it is back on', async () => {
  roomStatus('room-1').therm_setpoint_mode = 'off';
  await discover();
  await command(deviceOf(THERM), 'therm_setpoint_temperature', 20);
  assert.deepEqual(netatmo.state.setpointRequests, []);
});

test('forgetPublished: the next cycle re-publishes a value Gladys overwrote with a command', async () => {
  await discover();
  // Gladys saved OFF (the command) but Netatmo still reports the room heating.
  await telemetry.refreshValues(ENERGY_ONLY);
  assert.deepEqual(stateOf(`${THERM}:room_mode`), [1]);
  telemetry.forgetPublished(`${THERM}:room_mode`);
  await telemetry.refreshValues(ENERGY_ONLY);
  assert.deepEqual(stateOf(`${THERM}:room_mode`), [1, 1]);
});
