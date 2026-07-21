// -----------------------------------------------------------------------------
// Unit tests of the telemetry engine against the fake Netatmo cloud:
// discovery sync, state emission through the declarative mapping (zeros kept,
// absences skipped, battery string → percent), the dedup + 30-minute
// keep-alive, the transport badges, and the setpoint command.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import { setDeviceValue } from '../../src/netatmo/setValue.js';
import { startFakeNetatmo } from '../helpers/fakeNetatmo.js';

let netatmo;
let client;
let gladys;
let telemetry;
let clock;
const config = normalizeConfig();

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
  clock = 1_000_000_000_000;
  const published = [];
  const transports = [];
  const discovered = [];
  gladys = {
    published,
    transports,
    discovered,
    devices: [],
    externalId: (suffix) => `ext:netatmo:${suffix}`,
    async publishStates(states) {
      published.push(...states);
    },
    async publishDiscoveredDevices(devices) {
      discovered.push(devices);
    },
    async publishTransports(entries) {
      transports.push(...entries);
    },
  };
  telemetry = createTelemetry({ gladys, client, now: () => clock });
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

test('syncDiscovery publishes the supported devices and the transport badges', async () => {
  const devices = await telemetry.syncDiscovery(config);
  // 6 supported devices (the NACamera is skipped).
  assert.equal(devices.length, 6);
  assert.deepEqual(gladys.discovered[0], devices);

  const badge = Object.fromEntries(gladys.transports.map((t) => [t.external_id, t.transport]));
  assert.equal(badge['ext:netatmo:valve-2'], 'unreachable'); // powered off (core #2620)
  assert.equal(badge['ext:netatmo:therm-1'], 'cloud');
  assert.equal(badge['ext:netatmo:camera-1'], undefined); // not handled: no badge
});

test('refreshValues publishes the states of the devices created in Gladys', async () => {
  // The user created every discovered device.
  gladys.devices = await telemetry.syncDiscovery(config);
  const count = await telemetry.refreshValues(config);
  assert.ok(count > 0);

  // Zero is a value (core #2617): the outdoor temperature 0 IS published.
  assert.deepEqual(stateOf('ext:netatmo:outdoor-1:temperature'), [0]);
  // Battery string → percent (NRV reports battery_state 'medium').
  assert.deepEqual(stateOf('ext:netatmo:valve-1:battery_percent'), [50]);
  // Booleans → binary.
  assert.deepEqual(stateOf('ext:netatmo:therm-1:boiler_status'), [1]);
  assert.deepEqual(stateOf('ext:netatmo:valve-1:open_window'), [1]);
  assert.deepEqual(stateOf('ext:netatmo:valve-1:heating_power_request'), [1]); // 42 > 0
  // Legacy `measured` merge feeds the thermostat's own temperature.
  assert.deepEqual(stateOf('ext:netatmo:therm-1:temperature'), [19.4]);
  // dashboard_data fallbacks feed the station.
  assert.deepEqual(stateOf('ext:netatmo:station-1:co2'), [600]);
  assert.deepEqual(stateOf('ext:netatmo:station-1:wifi_strength'), [45]);
  // The powered-off valve has no telemetry of its own, but its room does.
  assert.deepEqual(stateOf('ext:netatmo:valve-2:battery_percent'), []);
  assert.deepEqual(stateOf('ext:netatmo:valve-2:therm_measured_temperature'), [17]);
});

test('unchanged values are deduped, then re-published after the 30-minute keep-alive', async () => {
  gladys.devices = await telemetry.syncDiscovery(config);
  const first = await telemetry.refreshValues(config);
  assert.ok(first > 0);

  // Second cycle, same payloads, 2 minutes later: nothing re-published.
  clock += 2 * 60 * 1000;
  assert.equal(await telemetry.refreshValues(config), 0);

  // A changed value goes out immediately.
  netatmo.state.homeStatuses['home-1'].home.modules.find((m) => m.id === 'therm-1').boiler_status =
    false;
  assert.equal(await telemetry.refreshValues(config), 1);
  assert.deepEqual(stateOf('ext:netatmo:therm-1:boiler_status'), [1, 0]);

  // Past the keep-alive, everything goes out again.
  clock += 31 * 60 * 1000;
  assert.equal(await telemetry.refreshValues(config), first);
});

test('setDeviceValue posts the setpoint with the device params', async () => {
  gladys.devices = await telemetry.syncDiscovery(config);
  const device = gladys.devices.find((d) => d.external_id === 'ext:netatmo:therm-1');
  const feature = device.features.find((f) =>
    f.external_id.endsWith(':therm_setpoint_temperature'),
  );

  await setDeviceValue({ client }, { device, feature, value: 21.5 });
  assert.deepEqual(netatmo.state.setpointRequests, [
    { home_id: 'home-1', room_id: 'room-1', mode: 'manual', temp: '21.5' },
  ]);
});

test('setDeviceValue rejects read-only features and missing params', async () => {
  gladys.devices = await telemetry.syncDiscovery(config);
  const device = gladys.devices.find((d) => d.external_id === 'ext:netatmo:therm-1');
  const readOnly = device.features.find((f) => f.external_id.endsWith(':boiler_status'));
  await assert.rejects(
    setDeviceValue({ client }, { device, feature: readOnly, value: 1 }),
    /not writable/,
  );

  const noParams = { ...device, params: [] };
  const setpoint = device.features.find((f) =>
    f.external_id.endsWith(':therm_setpoint_temperature'),
  );
  await assert.rejects(
    setDeviceValue({ client }, { device: noParams, feature: setpoint, value: 21 }),
    /home_id/,
  );
});

test('setDeviceValue surfaces the missing-scope error (Netatmo 403 code 13)', async () => {
  gladys.devices = await telemetry.syncDiscovery(config);
  const device = gladys.devices.find((d) => d.external_id === 'ext:netatmo:therm-1');
  const setpoint = device.features.find((f) =>
    f.external_id.endsWith(':therm_setpoint_temperature'),
  );
  netatmo.state.failSetpointWith = { status: 403, body: { error: { code: 13, message: 'scope' } } };
  await assert.rejects(
    setDeviceValue({ client }, { device, feature: setpoint, value: 21 }),
    /reconnect your Netatmo/,
  );
});
