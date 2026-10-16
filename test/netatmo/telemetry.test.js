// -----------------------------------------------------------------------------
// Unit tests of the telemetry engine against the fake Netatmo cloud:
// discovery sync, state emission through the declarative mapping (zeros kept,
// absences skipped, battery string → percent), the dedup + 30-minute
// keep-alive (and its pruning), the transport badges, the refresh loop
// lifecycle, and the setpoint command.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import { setDeviceValue } from '../../src/netatmo/setValue.js';
import { startFakeNetatmo } from '../helpers/fakeNetatmo.js';
import { waitFor } from '../helpers/fakeGladysCore.js';
import { DEGRADED_AFTER_FAILED_LOADS, DEGRADED_MESSAGES } from '../../src/netatmo/constants.js';

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
    .map((s) => s.state ?? s.text);
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
  // 7 Energy/Weather devices + 2 cameras + siren + door tag + smoke + CO alarms.
  assert.equal(gladys.devices.length, 13);

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

test('the camera-bridged security accessories publish their states (issue #9)', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true' });
  gladys.devices = await telemetry.syncDiscovery(configSecurity);
  await telemetry.refreshValues(configSecurity);

  // Door tag: status 'open' → opening 1, battery_state 'high' → 75, rf 68.
  assert.deepEqual(stateOf('ext:netatmo:doortag-1:opening'), [1]);
  assert.deepEqual(stateOf('ext:netatmo:doortag-1:battery_percent'), [75]);
  assert.deepEqual(stateOf('ext:netatmo:doortag-1:rf_strength'), [68]);

  // Siren: status 'no_sound' → siren 0 (idle), battery 90, rf 70.
  assert.deepEqual(stateOf('ext:netatmo:siren-1:siren'), [0]);
  assert.deepEqual(stateOf('ext:netatmo:siren-1:battery_percent'), [90]);
  assert.deepEqual(stateOf('ext:netatmo:siren-1:rf_strength'), [70]);

  // Smoke alarm: battery + signal pollable today (smoke state is webhook-only).
  assert.deepEqual(stateOf('ext:netatmo:smoke-1:battery_percent'), [88]);
  assert.deepEqual(stateOf('ext:netatmo:smoke-1:wifi_strength'), [66]);

  // CO alarm (issue #36): only what homestatus carries — battery, no wifi.
  assert.deepEqual(stateOf('ext:netatmo:co-1:battery_percent'), [92]);
  assert.deepEqual(stateOf('ext:netatmo:co-1:wifi_strength'), []);
  assert.deepEqual(stateOf('ext:netatmo:co-1:carbon_monoxide'), []); // webhook-only

  // A door opening flows on the next cycle.
  const doortag = netatmo.state.homeStatuses['home-1'].home.modules.find(
    (m) => m.id === 'doortag-1',
  );
  doortag.status = 'closed';
  await telemetry.refreshValues(configSecurity);
  assert.deepEqual(stateOf('ext:netatmo:doortag-1:opening'), [1, 0]);
});

/** Add a video doorbell (pyatmo fixture shape, issue #35) to the fake account. */
function addDoorbell() {
  netatmo.state.homes[0].modules.push({
    id: 'doorbell-1',
    type: 'NDB',
    name: 'Netatmo-Doorbell',
    room_id: 'room-1',
    reachable: true,
  });
  netatmo.state.homeStatuses['home-1'].home.modules.push({
    type: 'NDB',
    id: 'doorbell-1',
    vpn_url: `${netatmo.url}/vpn/doorbell-1`,
    // Claims a LAN path: the WebRTC doorbell must still go through the VPN.
    is_local: true,
    alim_status: 2,
    connection: 'wifi',
    sd_status: 4,
    wifi_strength: 66,
    wifi_state: 'medium',
  });
}

test('the video doorbell is discovered behind security_api, with image and ring (issue #35)', async () => {
  addDoorbell();
  // Security off (default): the doorbell stays out of the discovery.
  const withoutSecurity = await telemetry.syncDiscovery(config);
  assert.ok(!withoutSecurity.some((d) => d.external_id === 'ext:netatmo:doorbell-1'));

  const configSecurity = normalizeConfig({ security_api: 'true' });
  gladys.devices = await telemetry.syncDiscovery(configSecurity);
  const doorbell = gladys.devices.find((d) => d.external_id === 'ext:netatmo:doorbell-1');
  assert.ok(doorbell);
  assert.deepEqual(
    doorbell.features.map((f) => f.external_id.replace('ext:netatmo:doorbell-1:', '')),
    ['wifi_strength', 'camera', 'ring'],
  );
  // WebRTC only: no HLS live URL for the core rtsp-camera service.
  assert.equal(
    doorbell.params.find((p) => p.name === 'CAMERA_URL'),
    undefined,
  );

  await telemetry.refreshValues(configSecurity);
  assert.deepEqual(stateOf('ext:netatmo:doorbell-1:wifi_strength'), [66]);
  assert.deepEqual(stateOf('ext:netatmo:doorbell-1:ring'), []); // webhook-only
  // Dashboard image fetched on the VPN URL, without any LAN resolution.
  const image = gladys.cameraImages.find((c) => c.deviceExternalId === 'ext:netatmo:doorbell-1');
  assert.match(image.image, /^image\/jpg;base64,/);
  const doorbellRequests = netatmo.state.cameraRequests.filter((r) => r.camId === 'doorbell-1');
  assert.ok(doorbellRequests.every((r) => r.side === 'vpn'));
  assert.ok(!doorbellRequests.some((r) => r.path === '/command/ping'));

  // A second cycle must not re-publish the discovery for a "changed" live URL.
  const discoveredCount = gladys.discovered.length;
  await telemetry.refreshValues(configSecurity);
  assert.equal(gladys.discovered.length, discoveredCount);
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

test('start() runs timer-driven cycles at refreshIntervalMs, stop() halts them', async () => {
  const looped = createTelemetry({
    gladys,
    client,
    now: () => clock,
    loadTtlMs: 0,
    refreshIntervalMs: 25,
  });
  const loads = () =>
    netatmo.state.apiRequests.filter((r) => r.path.startsWith('/api/homesdata')).length;
  try {
    looped.start(config);
    // The immediate cycle + at least two driven by the interval.
    await waitFor(() => loads() >= 3, { timeout: 2000 });
    looped.stop();
    // Drain a cycle the timer may have started just before stop().
    await looped.refreshValues(config);
    const settled = loads();
    // Several intervals later: no cycle went out on its own.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(loads(), settled);
  } finally {
    looped.stop();
  }
});

test('an older Gladys core rejecting publishTransports never breaks discovery nor refresh', async () => {
  let attempts = 0;
  gladys.publishTransports = () => {
    attempts += 1;
    throw new Error('404 no route for POST /api/integration/v1/device/transport');
  };
  const devices = await telemetry.syncDiscovery(config);
  assert.equal(devices.length, 7);
  assert.deepEqual(gladys.discovered[0], devices);
  assert.equal(attempts, 1);

  gladys.devices = devices;
  const count = await telemetry.refreshValues(config);
  assert.ok(count > 0);
  assert.deepEqual(stateOf('ext:netatmo:therm-1:temperature'), [19.4]);
  assert.equal(attempts, 2);
});

test('refreshCameraImages skips a created camera without the camera feature', async () => {
  const configSecurity = normalizeConfig({ security_api: 'true' });
  gladys.devices = await telemetry.syncDiscovery(configSecurity);
  // camera-1 was created before the camera feature shipped: no `:camera`.
  const camera = gladys.devices.find((d) => d.external_id === 'ext:netatmo:camera-1');
  camera.features = camera.features.filter((f) => !f.external_id.endsWith(':camera'));

  await telemetry.refreshValues(configSecurity);
  const imaged = gladys.cameraImages.map((c) => c.deviceExternalId);
  assert.ok(!imaged.includes('ext:netatmo:camera-1'));
  assert.ok(
    !netatmo.state.cameraRequests.some(
      (r) => r.camId === 'camera-1' && r.path === '/live/snapshot_720.jpg',
    ),
  );
  // The other camera is still refreshed, and camera-1's own states still flow.
  assert.ok(imaged.includes('ext:netatmo:noc-1'));
  assert.deepEqual(stateOf('ext:netatmo:camera-1:monitoring'), [0]);
});

test('a device leaving the account loses its dedup entries: back, its values go out at once', async () => {
  gladys.devices = await telemetry.syncDiscovery(config);
  await telemetry.refreshValues(config);
  assert.deepEqual(stateOf('ext:netatmo:station-1:co2'), [600]);

  // Deduped while it stays.
  clock += 2 * 60 * 1000;
  await telemetry.refreshValues(config);
  assert.deepEqual(stateOf('ext:netatmo:station-1:co2'), [600]);

  // The station leaves the account (complete load, not partial)...
  const stations = netatmo.state.stationDevices;
  netatmo.state.stationDevices = [];
  clock += 2 * 60 * 1000;
  await telemetry.refreshValues(config);
  // ...and comes back with the very same values, well within the keep-alive.
  netatmo.state.stationDevices = stations;
  clock += 2 * 60 * 1000;
  await telemetry.refreshValues(config);

  // Its entries were pruned: re-published instead of deduped.
  assert.deepEqual(stateOf('ext:netatmo:station-1:co2'), [600, 600]);
  assert.deepEqual(stateOf('ext:netatmo:outdoor-1:temperature'), [0, 0]);
  // A device that never left stays deduped.
  assert.deepEqual(stateOf('ext:netatmo:therm-1:temperature'), [19.4]);
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

/** The weather station in homesdata/homestatus, as Netatmo returns it. */
function addStationToHome(state) {
  state.homes[0].modules.push(
    { id: 'station-1', type: 'NAMain', name: 'Station', modules_bridged: ['outdoor-1'] },
    { id: 'outdoor-1', type: 'NAModule1', name: 'Extérieur', bridge: 'station-1' },
  );
  state.homeStatuses['home-1'].home.modules.push(
    { id: 'station-1', type: 'NAMain', wifi_strength: 45, temperature: 22.5, co2: 610 },
    { id: 'outdoor-1', type: 'NAModule1', rf_strength: 42, reachable: true, temperature: 5.8 },
  );
}

/** Latest transport entry published for one device. */
function lastTransport(externalId) {
  return gladys.transports.filter((t) => t.external_id === externalId).at(-1);
}

test('a getstationsdata outage: homestatus values keep flowing, then degraded badges and status (issue #33)', async () => {
  addStationToHome(netatmo.state);
  const weatherOnly = normalizeConfig({ energy_api: 'false', weather_api: 'true' });
  const changes = [];
  const engine = createTelemetry({
    gladys,
    client,
    now: () => clock,
    loadTtlMs: 0,
    onDegradedChange: (message) => changes.push(message),
  });
  gladys.devices = await engine.syncDiscovery(weatherOnly);
  assert.deepEqual(gladys.devices.map((device) => device.external_id).sort(), [
    'ext:netatmo:outdoor-1',
    'ext:netatmo:station-1',
    'ext:netatmo:wind-1',
  ]);
  await engine.refreshValues(weatherOnly);

  netatmo.state.failStationsWith = 503;
  netatmo.state.homeStatuses['home-1'].home.modules.find((m) => m.id === 'station-1').co2 = 640;
  for (let cycle = 1; cycle < DEGRADED_AFTER_FAILED_LOADS; cycle += 1) {
    clock += 120 * 1000;
    await engine.refreshValues(weatherOnly);
  }
  // A hiccup is not worth a badge, but the homestatus measures already flow.
  assert.deepEqual(stateOf('ext:netatmo:station-1:co2'), [610, 640]);
  assert.equal(lastTransport('ext:netatmo:wind-1').degraded, undefined);
  assert.equal(engine.getDegradedMessage(), null);

  clock += 120 * 1000;
  await engine.refreshValues(weatherOnly);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.getDegradedMessage(), DEGRADED_MESSAGES.WEATHER);
  assert.deepEqual(changes, [DEGRADED_MESSAGES.WEATHER]);
  // The station and the outdoor module are fed by homestatus: no badge.
  assert.deepEqual(lastTransport('ext:netatmo:station-1'), {
    external_id: 'ext:netatmo:station-1',
    transport: 'cloud',
  });
  assert.equal(lastTransport('ext:netatmo:outdoor-1').degraded, undefined);
  // The anemometer is only known to getstationsdata: degraded, with the reason.
  assert.deepEqual(lastTransport('ext:netatmo:wind-1'), {
    external_id: 'ext:netatmo:wind-1',
    transport: 'unreachable',
    degraded: true,
    message: DEGRADED_MESSAGES.WEATHER,
  });

  // Recovery: the first complete load clears the badge and the status.
  netatmo.state.failStationsWith = null;
  clock += 120 * 1000;
  await engine.refreshValues(weatherOnly);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(changes, [DEGRADED_MESSAGES.WEATHER, null]);
  assert.equal(lastTransport('ext:netatmo:wind-1').degraded, undefined);
  engine.stop();
});

test('a total outage marks every known device degraded with the generic reason', async () => {
  const changes = [];
  const engine = createTelemetry({
    gladys,
    client,
    now: () => clock,
    loadTtlMs: 0,
    onDegradedChange: (message) => changes.push(message),
  });
  gladys.devices = await engine.syncDiscovery(config);

  netatmo.state.rejectAccessToken = 'seeded-token';
  for (let cycle = 0; cycle < DEGRADED_AFTER_FAILED_LOADS; cycle += 1) {
    await engine.refreshValues(config);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(changes, [DEGRADED_MESSAGES.PARTIAL]);
  for (const device of gladys.devices) {
    const entry = lastTransport(device.external_id);
    assert.equal(entry.degraded, true, `${device.external_id} degraded`);
    assert.equal(entry.message, DEGRADED_MESSAGES.PARTIAL);
  }
  engine.stop();
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

test('the heating mode of the home is published as a preset on thermostats and valves', async () => {
  gladys.devices = await telemetry.syncDiscovery(config);
  await telemetry.refreshValues(config);
  // homestatus therm_mode "schedule" -> THERMOSTAT_PRESET.SCHEDULE (0).
  assert.deepEqual(stateOf('ext:netatmo:therm-1:therm_preset'), [0]);
  assert.deepEqual(stateOf('ext:netatmo:valve-1:therm_preset'), [0]);
  // The powered-off valve still reports the home's mode (home-derived value).
  assert.deepEqual(stateOf('ext:netatmo:valve-2:therm_preset'), [0]);

  netatmo.state.homeStatuses['home-1'].home.therm_mode = 'hg';
  await telemetry.refreshValues(config);
  assert.deepEqual(stateOf('ext:netatmo:therm-1:therm_preset'), [0, 1]);

  netatmo.state.homeStatuses['home-1'].home.therm_mode = 'away';
  await telemetry.refreshValues(config);
  assert.deepEqual(stateOf('ext:netatmo:therm-1:therm_preset'), [0, 1, 2]);

  // A mode Netatmo has but Gladys presets do not cover is never emitted.
  netatmo.state.homeStatuses['home-1'].home.therm_mode = 'off';
  clock += 31 * 60 * 1000; // past the keep-alive: an emission would show
  await telemetry.refreshValues(config);
  assert.deepEqual(stateOf('ext:netatmo:therm-1:therm_preset'), [0, 1, 2]);
});

test('the heating mode falls back to the homesdata snapshot when homestatus omits it', async () => {
  delete netatmo.state.homeStatuses['home-1'].home.therm_mode;
  netatmo.state.homes[0].therm_mode = 'away';
  gladys.devices = await telemetry.syncDiscovery(config);
  await telemetry.refreshValues(config);
  assert.deepEqual(stateOf('ext:netatmo:therm-1:therm_preset'), [2]);
});

test('setDeviceValue sets the heating mode of the home, then refreshes at once', async () => {
  gladys.devices = await telemetry.syncDiscovery(config);
  await telemetry.refreshValues(config);
  const device = gladys.devices.find((d) => d.external_id === 'ext:netatmo:valve-1');
  const feature = device.features.find((f) => f.external_id.endsWith(':therm_preset'));

  let refreshed;
  const refreshDone = new Promise((resolve) => {
    refreshed = resolve;
  });
  const refresh = () => telemetry.refreshNow(config).then(refreshed);
  await setDeviceValue({ gladys, client, refresh }, { device, feature, value: 2 });
  assert.deepEqual(netatmo.state.setThermModeRequests, [{ home_id: 'home-1', mode: 'away' }]);

  // The immediate refresh republishes the new mode on EVERY device of the home.
  await refreshDone;
  assert.deepEqual(stateOf('ext:netatmo:therm-1:therm_preset'), [0, 2]);
  assert.deepEqual(stateOf('ext:netatmo:valve-1:therm_preset'), [0, 2]);

  await setDeviceValue({ gladys, client }, { device, feature, value: 1 });
  await setDeviceValue({ gladys, client }, { device, feature, value: 0 });
  assert.deepEqual(
    netatmo.state.setThermModeRequests.map((form) => form.mode),
    ['away', 'hg', 'schedule'],
  );
  // A preset Netatmo does not support is refused before any API call.
  await assert.rejects(
    setDeviceValue({ gladys, client }, { device, feature, value: 3 }),
    /no heating mode for the preset 3/,
  );
  assert.equal(netatmo.state.setThermModeRequests.length, 3);
});

test('a failing refresh after the heating mode change never fails the command', async () => {
  gladys.devices = await telemetry.syncDiscovery(config);
  const device = gladys.devices.find((d) => d.external_id === 'ext:netatmo:therm-1');
  const feature = device.features.find((f) => f.external_id.endsWith(':therm_preset'));
  let called = false;
  const refresh = async () => {
    called = true;
    throw new Error('Netatmo down');
  };
  await setDeviceValue({ gladys, client, refresh }, { device, feature, value: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, true);
});

test('the heating mode command surfaces the missing-scope error', async () => {
  gladys.devices = await telemetry.syncDiscovery(config);
  const device = gladys.devices.find((d) => d.external_id === 'ext:netatmo:therm-1');
  const feature = device.features.find((f) => f.external_id.endsWith(':therm_preset'));
  netatmo.state.failSetThermModeWith = {
    status: 403,
    body: { error: { code: 13, message: 'scope' } },
  };
  await assert.rejects(
    setDeviceValue({ gladys, client }, { device, feature, value: 2 }),
    /reconnect your Netatmo/,
  );
  netatmo.state.failSetThermModeWith = { status: 500, body: { error: { code: 1 } } };
  await assert.rejects(
    setDeviceValue({ gladys, client }, { device, feature, value: 2 }),
    /setthermmode answered 500/,
  );
});

test('the Home Coach publishes its dashboard_data, never stale values (issue #37)', async () => {
  const configAircare = normalizeConfig({ aircare_api: 'true' });
  const devices = await telemetry.syncDiscovery(configAircare);
  // 7 default devices + the two Home Coach.
  assert.equal(devices.length, 9);
  gladys.devices = devices;
  await telemetry.refreshValues(configAircare);

  const coach = 'ext:netatmo:12:34:56:3e:c5:46';
  assert.deepEqual(stateOf(`${coach}:temperature`), [20.3]);
  assert.deepEqual(stateOf(`${coach}:min_temp`), [20.3]);
  assert.deepEqual(stateOf(`${coach}:max_temp`), [21.6]);
  assert.deepEqual(stateOf(`${coach}:co2`), [494]);
  assert.deepEqual(stateOf(`${coach}:humidity`), [63]);
  assert.deepEqual(stateOf(`${coach}:noise`), [42]);
  // Integer pressure features, like the station.
  assert.deepEqual(stateOf(`${coach}:pressure`), [1014]);
  assert.deepEqual(stateOf(`${coach}:absolute_pressure`), [1004]);
  // health_idx 1 ("fine") → 75, the middle of the "moderate" AQI band.
  assert.deepEqual(stateOf(`${coach}:health_idx`), [75]);
  // The same level as text: published with `text`, not `state`.
  assert.deepEqual(stateOf(`${coach}:health_level`), ['fine']);
  assert.ok(
    gladys.published.some(
      (s) => s.device_feature_external_id === `${coach}:health_level` && s.state === undefined,
    ),
  );
  assert.deepEqual(stateOf(`${coach}:wifi_strength`), [67]);

  // The unreachable Home Coach publishes nothing and is badged unreachable.
  const dead = 'ext:netatmo:12:34:56:26:69:0c';
  assert.ok(!gladys.published.some((s) => s.device_feature_external_id.startsWith(`${dead}:`)));
  const badge = Object.fromEntries(gladys.transports.map((t) => [t.external_id, t.transport]));
  assert.equal(badge[dead], 'unreachable');
  assert.equal(badge[coach], 'cloud');

  // A worse air quality goes out on the next cycle.
  netatmo.state.homeCoachDevices[1].dashboard_data.health_idx = 4;
  await telemetry.refreshValues(configAircare);
  assert.deepEqual(stateOf(`${coach}:health_idx`), [75, 250]);
  assert.deepEqual(stateOf(`${coach}:health_level`), ['fine', 'unhealthy']);
});
