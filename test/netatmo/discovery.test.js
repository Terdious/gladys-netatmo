// -----------------------------------------------------------------------------
// Unit tests of the raw device loading (homesdata + homestatus + legacy
// thermostat + weather stations merge), against the fake Netatmo cloud:
// unreachable rebuild (core PR #2620), id/_id merges, modules_bridged, and
// the energy/weather API toggles.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { loadDevices, netatmoId } from '../../src/netatmo/discovery.js';
import { startFakeNetatmo } from '../helpers/fakeNetatmo.js';

let netatmo;
let client;

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
});

afterEach(async () => {
  await netatmo.close();
});

function byId(devices, id) {
  return devices.find((device) => netatmoId(device) === id);
}

test('loadDevices merges the three API families', async () => {
  const devices = await loadDevices(client, normalizeConfig());

  // Energy home: plug + thermostat + 2 valves + cameras + siren, Weather: station + outdoor.
  const ids = devices.map((device) => netatmoId(device)).sort();
  assert.deepEqual(ids, [
    'camera-1',
    'noc-1',
    'outdoor-1',
    'plug-1',
    'siren-1',
    'station-1',
    'therm-1',
    'valve-1',
    'valve-2',
  ]);

  // The relay plug got the legacy merge: plug_connected_boiler + modules_bridged.
  const plug = byId(devices, 'plug-1');
  assert.equal(plug.plug_connected_boiler, true);
  assert.deepEqual(plug.modules_bridged, ['therm-1']);
  assert.equal(plug.categoryAPI, 'Energy');

  // The thermostat got the legacy `measured` data and its homestatus room.
  const therm = byId(devices, 'therm-1');
  assert.equal(therm.measured.temperature, 19.4);
  assert.equal(therm.room.therm_measured_temperature, 19.5);
  assert.equal(therm.boiler_status, true);

  // The weather station and its module are appended with their category.
  const station = byId(devices, 'station-1');
  assert.equal(station.categoryAPI, 'Weather');
  assert.deepEqual(station.modules_bridged, ['outdoor-1']);
  const outdoor = byId(devices, 'outdoor-1');
  assert.equal(outdoor.plug._id, 'station-1');

  // The cameras are supported (Security) but their API is off by default.
  const camera = byId(devices, 'camera-1');
  assert.equal(camera.categoryAPI, 'Security');
  assert.equal(camera.apiNotConfigured, true);
  assert.equal(camera.not_handled, undefined);

  // The siren is a genuinely unsupported module type.
  assert.equal(byId(devices, 'siren-1').not_handled, true);
});

test('security-only config still loads homesdata and exposes the cameras (core #2621)', async () => {
  const devices = await loadDevices(
    client,
    normalizeConfig({ energy_api: 'false', security_api: 'true' }),
  );

  // Cameras are there, with their API enabled.
  const camera = byId(devices, 'camera-1');
  assert.equal(camera.apiNotConfigured, false);
  assert.equal(camera.monitoring, 'off');
  const noc = byId(devices, 'noc-1');
  assert.equal(noc.apiNotConfigured, false);
  assert.equal(noc.monitoring, 'on');

  // Energy modules ride along but their API is off; legacy Energy API untouched.
  assert.equal(byId(devices, 'therm-1').apiNotConfigured, true);
  const paths = netatmo.state.apiRequests.map((r) => r.path);
  assert.ok(paths.some((p) => p.startsWith('/api/homesdata')));
  assert.ok(!paths.some((p) => p.startsWith('/api/getthermostatsdata')));
});

test('a module missing from homestatus is rebuilt as unreachable (core #2620)', async () => {
  const devices = await loadDevices(client, normalizeConfig());
  const poweredOff = byId(devices, 'valve-2');
  assert.equal(poweredOff.reachable, false);
  assert.equal(poweredOff.apiErrorCode, 6);
  // Rebuilt from homesdata: name and room are preserved.
  assert.equal(poweredOff.name, 'Vanne éteinte');
  assert.equal(poweredOff.room.id, 'room-2');
  assert.equal(poweredOff.room.therm_measured_temperature, 17);
});

test('the energy_api toggle skips the Energy loads entirely', async () => {
  const devices = await loadDevices(client, normalizeConfig({ energy_api: 'false' }));
  const ids = devices.map((device) => netatmoId(device)).sort();
  assert.deepEqual(ids, ['outdoor-1', 'station-1']);
  const paths = netatmo.state.apiRequests.map((r) => r.path);
  assert.ok(!paths.some((p) => p.startsWith('/api/homesdata')));
  assert.ok(!paths.some((p) => p.startsWith('/api/getthermostatsdata')));
});

test('the weather_api toggle skips the station load entirely', async () => {
  const devices = await loadDevices(client, normalizeConfig({ weather_api: 'false' }));
  assert.ok(!devices.some((device) => netatmoId(device) === 'station-1'));
  const paths = netatmo.state.apiRequests.map((r) => r.path);
  assert.ok(!paths.some((p) => p.startsWith('/api/getstationsdata')));
});
