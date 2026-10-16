// -----------------------------------------------------------------------------
// Unit tests of the raw device loading (homesdata + homestatus + legacy
// thermostat + weather stations merge), against the fake Netatmo cloud:
// unreachable rebuild (core PR #2620), id/_id merges, modules_bridged, the
// energy/weather API toggles, and the homesdata / homestatus failure fallbacks.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { loadAccount, loadDevices, netatmoId } from '../../src/netatmo/discovery.js';
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
    'co-1',
    'doortag-1',
    'noc-1',
    'outdoor-1',
    'plug-1',
    'siren-1',
    'smoke-1',
    'station-1',
    'therm-1',
    'valve-1',
    'valve-2',
    'wind-1',
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
  assert.deepEqual(station.modules_bridged, ['outdoor-1', 'wind-1']);
  const outdoor = byId(devices, 'outdoor-1');
  assert.equal(outdoor.plug._id, 'station-1');
  // The dead anemometer keeps the reachability flag from getstationsdata.
  assert.equal(byId(devices, 'wind-1').reachable, false);

  // The cameras are supported (Security) but their API is off by default.
  const camera = byId(devices, 'camera-1');
  assert.equal(camera.categoryAPI, 'Security');
  assert.equal(camera.apiNotConfigured, true);
  assert.equal(camera.not_handled, undefined);

  // The camera-bridged security accessories are supported too (issue #9).
  assert.equal(byId(devices, 'siren-1').categoryAPI, 'Security');
  assert.equal(byId(devices, 'siren-1').not_handled, undefined);
  assert.equal(byId(devices, 'doortag-1').not_handled, undefined);
  assert.equal(byId(devices, 'smoke-1').not_handled, undefined);
  // The carbon monoxide alarm rides along (issue #36).
  assert.equal(byId(devices, 'co-1').categoryAPI, 'Security');
  assert.equal(byId(devices, 'co-1').not_handled, undefined);
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

test('the energy_api toggle skips the legacy Energy load, Energy modules ride along disabled', async () => {
  const devices = await loadDevices(client, normalizeConfig({ energy_api: 'false' }));
  const ids = devices
    .filter((device) => !device.apiNotConfigured)
    .map((device) => netatmoId(device))
    .sort();
  assert.deepEqual(ids, ['outdoor-1', 'station-1', 'wind-1']);
  assert.equal(byId(devices, 'therm-1').apiNotConfigured, true);
  const paths = netatmo.state.apiRequests.map((r) => r.path);
  assert.ok(!paths.some((p) => p.startsWith('/api/getthermostatsdata')));
});

/** The weather station in homesdata/homestatus, as Netatmo returns it. */
function addStationToHome(state) {
  state.homes[0].modules.push(
    { id: 'station-1', type: 'NAMain', name: 'Station', modules_bridged: ['outdoor-1'] },
    { id: 'outdoor-1', type: 'NAModule1', name: 'Extérieur', bridge: 'station-1' },
  );
  state.homeStatuses['home-1'].home.modules.push(
    { id: 'station-1', type: 'NAMain', wifi_strength: 45, temperature: 22.5, co2: 610 },
    {
      id: 'outdoor-1',
      type: 'NAModule1',
      battery_state: 'full',
      rf_strength: 42,
      reachable: true,
      bridge: 'station-1',
      temperature: 5.8,
      humidity: 65,
    },
  );
}

test('weather-only config loads the home status too: it carries the weather measures (issue #33)', async () => {
  addStationToHome(netatmo.state);
  const weatherOnly = normalizeConfig({ energy_api: 'false', weather_api: 'true' });
  const { devices, partial, failed } = await loadAccount(client, weatherOnly);

  assert.equal(partial, false);
  assert.deepEqual(failed, []);
  const station = byId(devices, 'station-1');
  assert.equal(station.temperature, 22.5); // homestatus
  assert.equal(station.dashboard_data.Temperature, 21.2); // getstationsdata merge
  assert.equal(station.homestatus, true);
  assert.equal(station.categoryAPI, 'Weather');
  assert.equal(station.apiNotConfigured, false);
  const paths = netatmo.state.apiRequests.map((r) => r.path);
  assert.ok(paths.some((p) => p.startsWith('/api/homesdata')));
  assert.ok(paths.some((p) => p.startsWith('/api/homestatus')));
  assert.ok(paths.some((p) => p.startsWith('/api/getstationsdata')));
  assert.ok(!paths.some((p) => p.startsWith('/api/getthermostatsdata')));
});

test('a getstationsdata outage keeps the homestatus weather measures and names the failed family', async () => {
  addStationToHome(netatmo.state);
  netatmo.state.failStationsWith = 503;
  const weatherOnly = normalizeConfig({ energy_api: 'false', weather_api: 'true' });
  const { devices, partial, failed } = await loadAccount(client, weatherOnly);

  assert.equal(partial, true);
  assert.deepEqual(failed, ['weather']);
  assert.equal(byId(devices, 'station-1').temperature, 22.5);
  assert.equal(byId(devices, 'outdoor-1').temperature, 5.8);
  // Only getstationsdata knows the anemometer: it is missing from this load.
  assert.equal(byId(devices, 'wind-1'), undefined);
});

test('a station and its module listed in homesdata are merged with getstationsdata, not appended', async () => {
  addStationToHome(netatmo.state);
  const devices = await loadDevices(client, normalizeConfig());

  // Merged in place: one entry each, still carrying the homesdata home.
  assert.equal(devices.filter((device) => netatmoId(device) === 'station-1').length, 1);
  assert.equal(devices.filter((device) => netatmoId(device) === 'outdoor-1').length, 1);
  const station = byId(devices, 'station-1');
  assert.equal(station.home, 'home-1');
  assert.equal(station.homestatus, true);
  assert.equal(station.co2, 610); // homestatus
  assert.deepEqual(station.dashboard_data, netatmo.state.stationDevices[0].dashboard_data);
  // homesdata modules_bridged wins over the getstationsdata module list.
  assert.deepEqual(station.modules_bridged, ['outdoor-1']);

  // The module: homestatus values + getstationsdata dashboard_data, and its
  // plug = the homestatus station merged with the getstationsdata station.
  const outdoor = byId(devices, 'outdoor-1');
  assert.equal(outdoor.home, 'home-1');
  assert.equal(outdoor.temperature, 5.8); // homestatus
  assert.equal(outdoor.dashboard_data.min_temp, -2.5); // getstationsdata
  assert.equal(outdoor.module_name, 'Extérieur');
  assert.equal(outdoor.plug.id, 'station-1');
  assert.equal(outdoor.plug.wifi_strength, 45); // homestatus side of the plug
  assert.equal(outdoor.plug._id, 'station-1'); // getstationsdata side of the plug
  assert.equal(outdoor.plug.station_name, 'Station');
  assert.equal(outdoor.plug.dashboard_data.Temperature, 21.2);
  assert.equal(outdoor.plug.modules, undefined); // stripped from the merged plug
  // The anemometer, unknown to homesdata, is still appended.
  assert.equal(byId(devices, 'wind-1').plug._id, 'station-1');
});

test('a homesdata failure falls back to the legacy Energy and Weather devices', async () => {
  netatmo.state.failHomesWith = 503;
  const { devices, partial, failed, homes } = await loadAccount(client, normalizeConfig());

  assert.equal(partial, true);
  assert.deepEqual(failed, ['homes']);
  assert.deepEqual(homes, []);
  // listDevices = [...plugs, ...thermostats], then the weather devices.
  assert.deepEqual(
    devices.map((device) => netatmoId(device)),
    ['plug-1', 'therm-1', 'station-1', 'outdoor-1', 'wind-1'],
  );
  const plug = byId(devices, 'plug-1');
  assert.equal(plug.categoryAPI, 'Energy');
  assert.equal(plug.apiNotConfigured, false);
  assert.deepEqual(plug.modules_bridged, ['therm-1']);
  const therm = byId(devices, 'therm-1');
  assert.equal(therm.plug._id, 'plug-1');
  assert.equal(therm.plug.modules, undefined);
  assert.equal(therm.measured.temperature, 19.4);
  // No homesdata, no home: the thermostat carries none.
  assert.equal(therm.home, undefined);
});

test('an empty homesdata (energy only) takes the legacy Energy fallback without flagging the load', async () => {
  netatmo.state.homes = [];
  const energyOnly = normalizeConfig({ energy_api: 'true', weather_api: 'false' });
  const { devices, partial, failed } = await loadAccount(client, energyOnly);

  assert.equal(partial, false);
  assert.deepEqual(failed, []);
  assert.deepEqual(
    devices.map((device) => netatmoId(device)),
    ['plug-1', 'therm-1'],
  );
  assert.deepEqual(byId(devices, 'plug-1').modules_bridged, ['therm-1']);
});

test('a homestatus without home flags the load partial, the legacy families still load', async () => {
  // HTTP 200, status ok, but no `home` in the body: loadDeviceDetails → null.
  netatmo.state.homeStatuses['home-1'] = {};
  const { devices, partial, failed, homes } = await loadAccount(client, normalizeConfig());

  assert.equal(partial, true);
  assert.deepEqual(failed, ['homes']);
  // The home summary survives (homesdata answered), without any device.
  assert.equal(homes.length, 1);
  assert.equal(homes[0].id, 'home-1');
  assert.deepEqual(homes[0].rooms, []);
  // None of the homesdata-only modules made it, the legacy ones did.
  assert.equal(byId(devices, 'valve-1'), undefined);
  assert.equal(byId(devices, 'camera-1'), undefined);
  assert.ok(byId(devices, 'plug-1'));
  assert.ok(byId(devices, 'therm-1'));
  assert.ok(byId(devices, 'station-1'));
});

test('every failed API family is named', async () => {
  netatmo.state.rejectAccessToken = 'seeded-token';
  const { devices, partial, failed } = await loadAccount(client, normalizeConfig());
  assert.deepEqual(devices, []);
  assert.equal(partial, true);
  assert.deepEqual(failed, ['homes', 'energy', 'weather']);
});

test('the weather_api toggle skips the station load entirely', async () => {
  const devices = await loadDevices(client, normalizeConfig({ weather_api: 'false' }));
  assert.ok(!devices.some((device) => netatmoId(device) === 'station-1'));
  const paths = netatmo.state.apiRequests.map((r) => r.path);
  assert.ok(!paths.some((p) => p.startsWith('/api/getstationsdata')));
});

test('the aircare_api toggle loads the Home Coach devices as an Aircare family (issue #37)', async () => {
  const { devices, partial } = await loadAccount(client, normalizeConfig({ aircare_api: 'true' }));
  assert.equal(partial, false);
  const coach = byId(devices, '12:34:56:3e:c5:46');
  assert.equal(coach.type, 'NHC');
  assert.equal(coach.categoryAPI, 'Aircare');
  assert.equal(coach.apiNotConfigured, false);
  assert.equal(coach.dashboard_data.health_idx, 1);
  // The unreachable one keeps its flag (no stale values downstream).
  assert.equal(byId(devices, '12:34:56:26:69:0c').reachable, false);
  // The other families are still there.
  assert.ok(byId(devices, 'station-1'));
  assert.ok(byId(devices, 'therm-1'));
  const paths = netatmo.state.apiRequests.map((r) => r.path);
  assert.ok(paths.includes('/api/gethomecoachsdata'));
});

test('Home Coach is opt-in: gethomecoachsdata is never called by default', async () => {
  const devices = await loadDevices(client, normalizeConfig());
  assert.ok(!devices.some((device) => device.type === 'NHC'));
  const paths = netatmo.state.apiRequests.map((r) => r.path);
  assert.ok(!paths.some((p) => p.startsWith('/api/gethomecoachsdata')));
});

test('a failing gethomecoachsdata flags the load partial without blocking the others', async () => {
  netatmo.state.failHomeCoachsWith = {
    status: 500,
    body: { error: { code: 500, message: 'server error' } },
  };
  const { devices, partial } = await loadAccount(client, normalizeConfig({ aircare_api: 'true' }));
  assert.equal(partial, true);
  assert.ok(!devices.some((device) => device.type === 'NHC'));
  assert.ok(byId(devices, 'station-1'));
  assert.ok(byId(devices, 'therm-1'));
});

test('a missing read_homecoach scope (403 code 13) does not freeze the discovery', async () => {
  netatmo.state.failHomeCoachsWith = {
    status: 403,
    body: { error: { code: 13, message: 'Application does not have the good scope rights' } },
  };
  const { devices, partial } = await loadAccount(client, normalizeConfig({ aircare_api: 'true' }));
  // Durable condition, not a hiccup: the other families keep publishing.
  assert.equal(partial, false);
  assert.ok(!devices.some((device) => device.type === 'NHC'));
  assert.ok(byId(devices, 'station-1'));
});

test('a Home Coach also listed in homesdata is merged, not duplicated', async () => {
  netatmo.state.homes[0].modules.push({ id: '12:34:56:3e:c5:46', type: 'NHC', name: 'Coach' });
  const devices = await loadDevices(client, normalizeConfig({ aircare_api: 'true' }));
  const coaches = devices.filter((device) => netatmoId(device) === '12:34:56:3e:c5:46');
  assert.equal(coaches.length, 1);
  assert.equal(coaches[0].categoryAPI, 'Aircare');
  assert.equal(coaches[0].home, 'home-1');
  assert.equal(coaches[0].dashboard_data.CO2, 494);
});
