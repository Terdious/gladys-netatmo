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
  const cameraImages = [];
  gladys = {
    published,
    transports,
    discovered,
    cameraImages,
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
    async publishCameraImage(deviceExternalId, image) {
      cameraImages.push({ deviceExternalId, image });
    },
  };
  // loadTtlMs 0: these tests mutate the fixtures between refreshes and expect
  // every call to reload; the burst cache has its own dedicated test.
  telemetry = createTelemetry({ gladys, client, now: () => clock, loadTtlMs: 0 });
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
  // 7 supported devices (the cameras are skipped by default).
  assert.equal(devices.length, 7);
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

test('a reachable:false module never republishes its last-known values (issue #10)', async () => {
  gladys.devices = await telemetry.syncDiscovery(config);
  await telemetry.refreshValues(config);

  // The dead anemometer (bench payload): Netatmo still returns battery 9%,
  // rf and stale wind measures with reachable:false — none is published.
  assert.deepEqual(stateOf('ext:netatmo:wind-1:battery_percent'), []);
  assert.deepEqual(stateOf('ext:netatmo:wind-1:wind_strength'), []);
  assert.deepEqual(stateOf('ext:netatmo:wind-1:rf_strength'), []);
  // And its transport badge says unreachable.
  const badge = Object.fromEntries(gladys.transports.map((t) => [t.external_id, t.transport]));
  assert.equal(badge['ext:netatmo:wind-1'], 'unreachable');

  // The module comes back to life: values flow again.
  const wind = netatmo.state.stationDevices[0].modules.find((m) => m._id === 'wind-1');
  wind.reachable = true;
  await telemetry.refreshValues(config);
  assert.deepEqual(stateOf('ext:netatmo:wind-1:battery_percent'), [9]);
  assert.deepEqual(stateOf('ext:netatmo:wind-1:wind_strength'), [5]);
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

test('cameras are discovered and updated when security_api is enabled (core #2621)', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true' });
  gladys.devices = await telemetry.syncDiscovery(configSecurity);
  // 7 Energy/Weather devices + 2 cameras (the NIS siren stays unsupported).
  assert.equal(gladys.devices.length, 9);

  await telemetry.refreshValues(configSecurity);
  // monitoring 'off'/'on' → binary, wifi_status fallback (core mapping).
  assert.deepEqual(stateOf('ext:netatmo:camera-1:monitoring'), [0]);
  assert.deepEqual(stateOf('ext:netatmo:camera-1:wifi_strength'), [55]);
  assert.deepEqual(stateOf('ext:netatmo:noc-1:monitoring'), [1]);
  assert.deepEqual(stateOf('ext:netatmo:noc-1:wifi_strength'), [72]);

  const badge = Object.fromEntries(gladys.transports.map((t) => [t.external_id, t.transport]));
  assert.equal(badge['ext:netatmo:camera-1'], 'cloud');

  // The dashboard image of each created camera was refreshed with the cycle.
  const imagesById = Object.fromEntries(
    gladys.cameraImages.map((c) => [c.deviceExternalId, c.image]),
  );
  assert.match(imagesById['ext:netatmo:camera-1'], /^image\/jpg;base64,/);
  assert.match(imagesById['ext:netatmo:noc-1'], /^image\/jpg;base64,/);
  // camera-1 is_local: resolved through /command/ping then fetched on the LAN side.
  assert.ok(
    netatmo.state.cameraRequests.some(
      (r) => r.side === 'local' && r.camId === 'camera-1' && r.path === '/live/snapshot_720.jpg',
    ),
  );
  // noc-1 is VPN-only: snapshot straight from the VPN URL, no ping.
  assert.ok(
    netatmo.state.cameraRequests.some(
      (r) => r.side === 'vpn' && r.camId === 'noc-1' && r.path === '/live/snapshot_720.jpg',
    ),
  );
  assert.ok(
    !netatmo.state.cameraRequests.some((r) => r.camId === 'noc-1' && r.path === '/command/ping'),
  );
});

test('cameras carry a local-first CAMERA_URL and the camera_quality param (core #2625)', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true' });
  const devices = await telemetry.syncDiscovery(configSecurity);

  const paramOf = (id, name) =>
    devices.find((d) => d.external_id === `ext:netatmo:${id}`).params.find((p) => p.name === name)
      ?.value;

  // camera-1 is locally reachable: the live stream MUST use the LAN URL.
  assert.equal(
    paramOf('camera-1', 'CAMERA_URL'),
    `${netatmo.url}/local/camera-1/live/files/high/index.m3u8`,
  );
  // noc-1 is VPN-only: the live stream uses the VPN URL.
  assert.equal(
    paramOf('noc-1', 'CAMERA_URL'),
    `${netatmo.url}/vpn/noc-1/live/files/high/index.m3u8`,
  );
  assert.equal(paramOf('camera-1', 'camera_quality'), 'high');
});

test('the camera_quality configuration select drives the live URL (no device param)', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true', camera_quality: 'medium' });
  const devices = await telemetry.syncDiscovery(configSecurity);
  const camera = devices.find((d) => d.external_id === 'ext:netatmo:camera-1');
  assert.equal(
    camera.params.find((p) => p.name === 'CAMERA_URL').value,
    `${netatmo.url}/local/camera-1/live/files/medium/index.m3u8`,
  );
  assert.equal(camera.params.find((p) => p.name === 'camera_quality').value, 'medium');
});

test('a failing LOCAL snapshot arms a cooldown: next cycles go straight to the VPN', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true' });
  gladys.devices = await telemetry.syncDiscovery(configSecurity);
  netatmo.state.failLocalSnapshot = true;

  await telemetry.refreshValues(configSecurity); // local fails once, VPN succeeds
  netatmo.state.cameraRequests.length = 0;
  clock += 2 * 60 * 1000; // within the 30-min cooldown
  await telemetry.refreshValues(configSecurity);

  // No local snapshot retry, no re-ping churn: straight to the VPN, and the
  // cached local base URL is KEPT for the live stream.
  const camera1Requests = netatmo.state.cameraRequests.filter((r) => r.camId === 'camera-1');
  assert.ok(
    !camera1Requests.some((r) => r.side === 'local' && r.path === '/live/snapshot_720.jpg'),
  );
  assert.ok(!camera1Requests.some((r) => r.path === '/command/ping'));
  assert.ok(camera1Requests.some((r) => r.side === 'vpn' && r.path === '/live/snapshot_720.jpg'));
  const republished = gladys.discovered
    .at(-1)
    .find((d) => d.external_id === 'ext:netatmo:camera-1');
  assert.match(
    republished.params.find((p) => p.name === 'CAMERA_URL').value,
    /\/local\/camera-1\//,
  );
});

test('a user-edited camera_quality is respected, never overwritten', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true' });
  // The user set the quality to 'low' on the device page.
  gladys.devices = [
    {
      external_id: 'ext:netatmo:camera-1',
      params: [{ name: 'camera_quality', value: 'low' }],
    },
  ];
  const devices = await telemetry.syncDiscovery(configSecurity);
  const camera = devices.find((d) => d.external_id === 'ext:netatmo:camera-1');
  assert.equal(
    camera.params.find((p) => p.name === 'CAMERA_URL').value,
    `${netatmo.url}/local/camera-1/live/files/low/index.m3u8`,
  );
  assert.equal(camera.params.find((p) => p.name === 'camera_quality').value, 'low');
});

test('a VPN URL rotation re-publishes the discovery to refresh CAMERA_URL', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true' });
  gladys.devices = await telemetry.syncDiscovery(configSecurity);
  assert.equal(gladys.discovered.length, 1);

  // Stable cycle: no gratuitous re-publish.
  await telemetry.refreshValues(configSecurity);
  assert.equal(gladys.discovered.length, 1);

  // Netatmo rotates the VPN URL of the outdoor camera.
  const noc = netatmo.state.homeStatuses['home-1'].home.modules.find((m) => m.id === 'noc-1');
  noc.vpn_url = `${netatmo.url}/vpn/noc-1-rotated`;
  await telemetry.refreshValues(configSecurity);
  assert.equal(gladys.discovered.length, 2);
  const republished = gladys.discovered.at(-1).find((d) => d.external_id === 'ext:netatmo:noc-1');
  assert.equal(
    republished.params.find((p) => p.name === 'CAMERA_URL').value,
    `${netatmo.url}/vpn/noc-1-rotated/live/files/high/index.m3u8`,
  );
});

test('a stale local URL cache falls back to the VPN snapshot (core #2623)', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true' });
  gladys.devices = await telemetry.syncDiscovery(configSecurity);
  await telemetry.refreshValues(configSecurity);
  assert.equal(gladys.cameraImages.length, 2); // local URL now cached for camera-1

  // The LAN side dies: the cached local URL is stale.
  netatmo.state.failLocalSnapshot = true;
  netatmo.state.cameraRequests.length = 0;
  clock += 31 * 60 * 1000; // past the state keep-alive, irrelevant for images
  await telemetry.refreshValues(configSecurity);

  // camera-1 still got an image, through the VPN fallback.
  const vpnFallback = netatmo.state.cameraRequests.some(
    (r) => r.side === 'vpn' && r.camId === 'camera-1' && r.path === '/live/snapshot_720.jpg',
  );
  assert.ok(vpnFallback);
  assert.equal(gladys.cameraImages.length, 4);
});

test('getCameraSnapshot serves the on-demand image, loading the account when needed', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true' });
  gladys.devices = [
    {
      external_id: 'ext:netatmo:camera-1',
      features: [{ external_id: 'ext:netatmo:camera-1:camera' }],
    },
  ];
  // Fresh engine: no refresh ran yet, the camera is unknown until the load.
  const image = await telemetry.getCameraSnapshot(configSecurity, {
    external_id: 'ext:netatmo:camera-1',
  });
  assert.match(image, /^image\/jpg;base64,/);

  await assert.rejects(
    telemetry.getCameraSnapshot(configSecurity, { external_id: 'ext:netatmo:unknown-cam' }),
    /unknown to the Netatmo account/,
  );
});

test('setDeviceValue switches the camera monitoring through /api/setstate', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true' });
  gladys.devices = await telemetry.syncDiscovery(configSecurity);
  const camera = gladys.devices.find((d) => d.external_id === 'ext:netatmo:camera-1');
  const monitoring = camera.features.find((f) => f.external_id.endsWith(':monitoring'));

  await setDeviceValue({ gladys, client }, { device: camera, feature: monitoring, value: 1 });
  await setDeviceValue({ gladys, client }, { device: camera, feature: monitoring, value: 0 });
  assert.deepEqual(netatmo.state.setStateRequests, [
    { home: { id: 'home-1', modules: [{ id: 'camera-1', monitoring: 'on' }] } },
    { home: { id: 'home-1', modules: [{ id: 'camera-1', monitoring: 'off' }] } },
  ]);
});

test('cameras stay absent with the default (opt-in) configuration', async () => {
  const devices = await telemetry.syncDiscovery(config);
  assert.equal(devices.length, 7);
  assert.ok(!devices.some((device) => device.external_id.includes('camera-1')));
  // No badge either: an undiscovered device must not get a transport entry.
  assert.ok(!gladys.transports.some((t) => t.external_id === 'ext:netatmo:camera-1'));
});

test('bursty callers share one account load (single-flight + TTL cache)', async () => {
  const cached = createTelemetry({ gladys, client, now: () => clock, loadTtlMs: 60 * 1000 });
  gladys.devices = await cached.syncDiscovery(config);
  await cached.refreshValues(config);
  // One load for the burst: homesdata was hit exactly once.
  const homesdataCalls = netatmo.state.apiRequests.filter((r) =>
    r.path.startsWith('/api/homesdata'),
  );
  assert.equal(homesdataCalls.length, 1);
  cached.stop();
});

test('a partial load never replaces the published discovery list', async () => {
  gladys.devices = await telemetry.syncDiscovery(config);
  assert.equal(gladys.discovered.length, 1);

  // The Weather API family fails: the load is partial.
  netatmo.state.failStationsWith = 500;
  await telemetry.syncDiscovery(config);
  // No replace published (devices would vanish), transports still flowed.
  assert.equal(gladys.discovered.length, 1);
  assert.ok(gladys.transports.length > 0);

  // The outage ends: the next sync publishes a full list again.
  netatmo.state.failStationsWith = null;
  await telemetry.syncDiscovery(config);
  assert.equal(gladys.discovered.length, 2);
});

test('the on-demand snapshot serves the last published image when the camera dies', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true' });
  gladys.devices = await telemetry.syncDiscovery(configSecurity);
  await telemetry.refreshValues(configSecurity); // publishes + caches the images

  netatmo.state.failAllSnapshots = true;
  const image = await telemetry.getCameraSnapshot(configSecurity, {
    external_id: 'ext:netatmo:camera-1',
  });
  assert.match(image, /^image\/jpg;base64,/);
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

  // home_id present but room_id missing: the room-specific message.
  const noRoom = { ...device, params: [{ name: 'home_id', value: 'home-1' }] };
  await assert.rejects(
    setDeviceValue({ client }, { device: noRoom, feature: setpoint, value: 21 }),
    /room_id/,
  );
});

test('the camera monitoring command surfaces the missing-scope error too', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true' });
  gladys.devices = await telemetry.syncDiscovery(configSecurity);
  const camera = gladys.devices.find((d) => d.external_id === 'ext:netatmo:camera-1');
  const monitoring = camera.features.find((f) => f.external_id.endsWith(':monitoring'));
  netatmo.state.failSetStateWith = { status: 403, body: { error: { code: 13, message: 'scope' } } };
  await assert.rejects(
    setDeviceValue({ gladys, client }, { device: camera, feature: monitoring, value: 1 }),
    /reconnect your Netatmo/,
  );
  // The scope refusal must NOT be retried: one setstate call only.
  assert.equal(netatmo.state.setStateRequests.length, 1);
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
