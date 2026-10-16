// -----------------------------------------------------------------------------
// Unit tests of the raw-device → Gladys payload conversion: feature sets per
// module type (same suffixes as the core service), params, writable setpoint,
// and the unsupported-device skip.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { convertDevice } from '../../src/netatmo/convert.js';
import { healthIndexToAqi } from '../../src/netatmo/deviceMapping.js';

const gladys = { externalId: (suffix) => `ext:netatmo:${suffix}` };

function suffixesOf(device) {
  return device.features.map((feature) =>
    feature.external_id.replace(`${device.external_id}:`, ''),
  );
}

function paramValue(device, name) {
  return device.params.find((param) => param.name === name)?.value;
}

test('converts a NATherm1 with the core feature set and params', () => {
  const device = convertDevice(gladys, {
    id: 'therm-1',
    type: 'NATherm1',
    name: 'Thermostat',
    home: 'home-1',
    room: { id: 'room-1', name: 'Salon' },
    plug: { id: 'plug-1', name: 'Relais' },
  });
  assert.equal(device.external_id, 'ext:netatmo:therm-1');
  assert.equal(device.model, 'NATherm1');
  assert.equal(device.should_poll, false);
  assert.deepEqual(suffixesOf(device), [
    'battery_percent',
    'rf_strength',
    'temperature',
    'therm_measured_temperature',
    'therm_setpoint_temperature',
    'open_window',
    'boiler_status',
    'therm_preset',
  ]);
  const setpoint = device.features.find((f) =>
    f.external_id.endsWith(':therm_setpoint_temperature'),
  );
  assert.equal(setpoint.read_only, false);
  assert.equal(setpoint.min, 5);
  assert.equal(setpoint.max, 30);
  assert.equal(paramValue(device, 'home_id'), 'home-1');
  assert.equal(paramValue(device, 'room_id'), 'room-1');
  assert.equal(paramValue(device, 'plug_id'), 'plug-1');
});

test('converts a NRV without room: no measured temperature feature, no room params', () => {
  const device = convertDevice(gladys, {
    id: 'valve-1',
    type: 'NRV',
    name: 'Vanne',
    home: 'home-1',
  });
  assert.deepEqual(suffixesOf(device), [
    'battery_percent',
    'rf_strength',
    'therm_setpoint_temperature',
    'open_window',
    'heating_power_request',
    'therm_preset',
  ]);
  assert.equal(paramValue(device, 'room_id'), undefined);
});

test('the heating mode is a writable thermostat preset limited to the Netatmo modes', () => {
  const device = convertDevice(gladys, {
    id: 'therm-1',
    type: 'NATherm1',
    name: 'Thermostat',
    home: 'home-1',
    room: { id: 'room-1', name: 'Salon' },
  });
  const preset = device.features.find((f) => f.external_id === 'ext:netatmo:therm-1:therm_preset');
  assert.equal(preset.category, 'thermostat');
  assert.equal(preset.type, 'preset');
  assert.equal(preset.read_only, false);
  assert.equal(preset.min, 0);
  assert.equal(preset.max, 2);
  // Gladys THERMOSTAT_PRESET values: SCHEDULE 0, FROST 1, AWAY 2 — nothing else.
  assert.deepEqual(preset.supported_options, [
    { value: 0, label: 'Schedule', sort_order: 0 },
    { value: 1, label: 'Frost protection', sort_order: 1 },
    { value: 2, label: 'Away', sort_order: 2 },
  ]);
});

test('a legacy-only thermostat (no homesdata home) gets no heating mode feature', () => {
  const device = convertDevice(gladys, {
    _id: 'therm-legacy',
    type: 'NATherm1',
    module_name: 'Thermostat',
  });
  assert.ok(!suffixesOf(device).includes('therm_preset'));
});

test('converts a NAPlug with wifi+rf and the bridged modules param', () => {
  const device = convertDevice(gladys, {
    id: 'plug-1',
    type: 'NAPlug',
    name: 'Relais',
    home: 'home-1',
    modules_bridged: ['therm-1'],
  });
  assert.deepEqual(suffixesOf(device), ['wifi_strength', 'rf_strength', 'plug_connected_boiler']);
  assert.equal(paramValue(device, 'modules_bridge_id'), JSON.stringify(['therm-1']));
});

test('converts a NAMain with the full weather feature set', () => {
  const device = convertDevice(gladys, {
    _id: 'station-1',
    type: 'NAMain',
    station_name: 'Station',
    home_id: 'home-1',
    room: {},
    modules_bridged: ['outdoor-1'],
  });
  assert.equal(device.name, 'Station');
  assert.deepEqual(suffixesOf(device), [
    'wifi_strength',
    'temperature',
    'min_temp',
    'max_temp',
    'co2',
    'humidity',
    'noise',
    'pressure',
    'absolute_pressure',
  ]);
  assert.equal(paramValue(device, 'home_id'), 'home-1');
  // No room: the min/max are named after the station.
  const minTemp = device.features.find((f) => f.external_id.endsWith(':min_temp'));
  assert.equal(minTemp.name, 'Temperature - Minimum in Station');
});

test('a weather module without room names its min/max after the device, never "undefined"', () => {
  const device = convertDevice(gladys, {
    _id: 'outdoor-1',
    type: 'NAModule1',
    module_name: 'Extérieur',
    home_id: 'home-1',
    plug: { _id: 'station-1', station_name: 'Station' },
  });
  assert.deepEqual(suffixesOf(device), [
    'battery_percent',
    'rf_strength',
    'temperature',
    'min_temp',
    'max_temp',
    'humidity',
  ]);
  const nameOf = (suffix) => device.features.find((f) => f.external_id.endsWith(`:${suffix}`)).name;
  assert.equal(nameOf('min_temp'), 'Temperature - Minimum in Extérieur');
  assert.equal(nameOf('max_temp'), 'Temperature - Maximum in Extérieur');
  // External ids are frozen: only the display names changed.
  assert.equal(
    device.features.find((f) => f.name === 'Temperature - Minimum in Extérieur').external_id,
    'ext:netatmo:outdoor-1:min_temp',
  );
  assert.ok(device.features.every((f) => !f.name.includes('undefined')));
  assert.equal(paramValue(device, 'room_name'), undefined);
});

test('the room-scoped feature names use the room name, or the device name for a nameless room', () => {
  const named = convertDevice(gladys, {
    id: 'indoor-1',
    type: 'NAModule4',
    name: 'Module chambre',
    home: 'home-1',
    room: { id: 'room-2', name: 'Chambre' },
  });
  const nameOf = (device, suffix) =>
    device.features.find((f) => f.external_id.endsWith(`:${suffix}`)).name;
  assert.equal(nameOf(named, 'therm_measured_temperature'), 'Temperature - room Chambre');
  assert.equal(nameOf(named, 'min_temp'), 'Temperature - Minimum in Chambre');
  assert.equal(paramValue(named, 'room_name'), 'Chambre');

  // A room known by id only (homestatus room missing from homesdata).
  const nameless = convertDevice(gladys, {
    id: 'indoor-1',
    type: 'NAModule4',
    name: 'Module chambre',
    home: 'home-1',
    room: { id: 'room-9' },
  });
  assert.equal(nameOf(nameless, 'therm_measured_temperature'), 'Temperature - room Module chambre');
  assert.equal(nameOf(nameless, 'max_temp'), 'Temperature - Maximum in Module chambre');
  assert.ok(nameless.features.every((f) => !f.name.includes('undefined')));
  assert.equal(paramValue(nameless, 'room_id'), 'room-9');
  assert.equal(paramValue(nameless, 'room_name'), undefined);
});

test('converts a NAModule3 with the three rain features and their units', () => {
  const device = convertDevice(gladys, {
    _id: 'rain-1',
    type: 'NAModule3',
    module_name: 'Pluie',
    home_id: 'home-1',
  });
  assert.deepEqual(suffixesOf(device), [
    'battery_percent',
    'rf_strength',
    'rain',
    'sum_rain_1',
    'sum_rain_24',
  ]);
  const units = device.features.slice(2).map((feature) => feature.unit);
  assert.deepEqual(units, ['mm', 'millimeter-per-hour', 'millimeter-per-day']);
});

test('converts cameras (NACamera/NOC) with wifi, writable monitoring and image', () => {
  for (const type of ['NACamera', 'NOC']) {
    const device = convertDevice(gladys, {
      id: `cam-${type}`,
      type,
      name: 'Caméra',
      home: 'home-1',
      room: { id: 'room-1', name: 'Salon' },
      modules_bridged: [],
    });
    assert.equal(device.model, type);
    // Momentary detections (webhook-driven, issue #5) ride along; only the
    // outdoor Presence classifies animals and vehicles.
    assert.deepEqual(
      suffixesOf(device),
      type === 'NOC'
        ? ['wifi_strength', 'monitoring', 'camera', 'motion', 'human', 'animal', 'vehicle']
        : ['wifi_strength', 'monitoring', 'camera', 'motion', 'human'],
    );
    const motion = device.features.find((f) => f.external_id.endsWith(':motion'));
    assert.equal(motion.category, 'motion-sensor');
    assert.equal(motion.type, 'binary');
    const monitoring = device.features.find((f) => f.external_id.endsWith(':monitoring'));
    assert.equal(monitoring.read_only, false); // command through /api/setstate
    const camera = device.features.find((f) => f.external_id.endsWith(':camera'));
    assert.equal(camera.category, 'camera');
    assert.equal(camera.type, 'image');
    assert.equal(camera.keep_history, false);
    assert.equal(paramValue(device, 'home_id'), 'home-1');
    assert.equal(paramValue(device, 'room_id'), 'room-1');
    assert.equal(paramValue(device, 'modules_bridge_id'), '[]');
  }
});

test('converts a smoke alarm (NSD) and a CO alarm (NCO) with battery, signal and alarm', () => {
  const smoke = convertDevice(gladys, {
    id: 'smoke-1',
    type: 'NSD',
    name: 'Fumée',
    home: 'home-1',
  });
  assert.deepEqual(suffixesOf(smoke), ['battery_percent', 'wifi_strength', 'smoke']);

  // Issue #36: same shape as the smoke alarm, the alarm being carbon monoxide.
  const co = convertDevice(gladys, {
    id: 'co-1',
    type: 'NCO',
    name: 'CO',
    home: 'home-1',
    room: { id: 'room-1', name: 'Salon' },
  });
  assert.equal(co.model, 'NCO');
  assert.deepEqual(suffixesOf(co), ['battery_percent', 'wifi_strength', 'carbon_monoxide']);
  const alarm = co.features.find((f) => f.external_id.endsWith(':carbon_monoxide'));
  assert.equal(alarm.name, 'Carbon monoxide - CO');
  assert.equal(alarm.category, 'co-sensor');
  assert.equal(alarm.type, 'binary');
  assert.equal(alarm.read_only, true);
  assert.equal(alarm.min, 0);
  assert.equal(alarm.max, 1);
  assert.equal(paramValue(co, 'home_id'), 'home-1');
  assert.equal(paramValue(co, 'room_id'), 'room-1');
});

test('converts a video doorbell (NDB): wifi, image and ring, no monitoring nor live URL', () => {
  // homesdata + homestatus shape of pyatmo's fixtures (issue #35).
  const device = convertDevice(
    gladys,
    {
      id: '12:34:56:10:f1:66',
      type: 'NDB',
      name: 'Netatmo-Doorbell',
      home: 'home-1',
      room: { id: '3688132631', name: 'Entrée' },
      reachable: true,
      vpn_url: 'https://prodvpn-eu-6.netatmo.net/10.20.30.40/1111111111111/2222222222222,,',
      is_local: false,
      wifi_strength: 66,
    },
    // Even if a live URL were resolved, the WebRTC doorbell must not get one.
    new Map([
      ['12:34:56:10:f1:66', { liveUrl: 'https://x/live/files/high/index.m3u8', quality: 'high' }],
    ]),
  );
  assert.equal(device.model, 'NDB');
  assert.deepEqual(suffixesOf(device), ['wifi_strength', 'camera', 'ring']);
  const ring = device.features.find((f) => f.external_id.endsWith(':ring'));
  assert.equal(ring.name, 'Doorbell - Netatmo-Doorbell');
  assert.equal(ring.category, 'doorbell');
  assert.equal(ring.type, 'ring');
  assert.equal(ring.read_only, true);
  assert.equal(ring.min, 0);
  assert.equal(ring.max, 1);
  const camera = device.features.find((f) => f.external_id.endsWith(':camera'));
  assert.equal(camera.category, 'camera');
  assert.equal(camera.type, 'image');
  assert.equal(paramValue(device, 'CAMERA_URL'), undefined);
  assert.equal(paramValue(device, 'camera_quality'), undefined);
  assert.equal(paramValue(device, 'home_id'), 'home-1');
  assert.equal(paramValue(device, 'room_id'), '3688132631');
});

test('skips devices whose API is disabled (apiNotConfigured)', () => {
  assert.equal(
    convertDevice(gladys, {
      id: 'cam-1',
      type: 'NACamera',
      name: 'Caméra',
      home: 'home-1',
      apiNotConfigured: true,
    }),
    null,
  );
});

test('skips not-handled and unknown module types', () => {
  assert.equal(
    convertDevice(gladys, { id: 'cam-1', type: 'NACamera', name: 'Caméra', not_handled: true }),
    null,
  );
  assert.equal(convertDevice(gladys, { id: 'x-1', type: 'NewThing', name: 'Mystère' }), null);
});

test('converts a Home Coach (NHC) with the indoor measures and the health index (issue #37)', () => {
  const device = convertDevice(gladys, {
    _id: '12:34:56:3e:c5:46',
    type: 'NHC',
    station_name: 'Parents Bedroom',
    module_name: 'Indoor',
    wifi_status: 67,
    reachable: true,
    categoryAPI: 'Aircare',
    apiNotConfigured: false,
  });
  assert.equal(device.external_id, 'ext:netatmo:12:34:56:3e:c5:46');
  assert.equal(device.model, 'NHC');
  // The user-given station_name wins over the generic module_name "Indoor".
  assert.equal(device.name, 'Parents Bedroom');
  assert.equal(device.should_poll, false);
  // Same suffixes as the weather indoor modules (NAMain / NAModule4).
  assert.deepEqual(suffixesOf(device), [
    'wifi_strength',
    'temperature',
    'min_temp',
    'max_temp',
    'co2',
    'humidity',
    'noise',
    'pressure',
    'absolute_pressure',
    'health_idx',
    'health_level',
  ]);
  const minTemp = device.features.find((f) => f.external_id.endsWith(':min_temp'));
  assert.equal(minTemp.type, 'min');
  assert.equal(minTemp.name, 'Temperature - Minimum in Parents Bedroom');
  const aqi = device.features.find((f) => f.external_id.endsWith(':health_idx'));
  assert.equal(aqi.category, 'airquality-sensor');
  assert.equal(aqi.type, 'aqi');
  assert.equal(aqi.unit, 'aqi');
  assert.equal(aqi.min, 0);
  assert.equal(aqi.max, 500);
  assert.equal(aqi.read_only, true);
  // The same index as a named level, shown with the Netatmo wording.
  const level = device.features.find((f) => f.external_id.endsWith(':health_level'));
  assert.equal(level.category, 'text');
  assert.equal(level.type, 'select');
  assert.equal(level.read_only, true);
  assert.equal(level.keep_history, false);
  assert.deepEqual(
    level.supported_options.map((option) => option.value),
    ['healthy', 'fine', 'fair', 'poor', 'unhealthy'],
  );
  assert.equal(level.supported_options[4].label, 'Malsain');
  // Standalone device: no home in the legacy payload, so no params at all.
  assert.deepEqual(device.params, []);
});

test('skips a Home Coach while the aircare_api toggle is off', () => {
  assert.equal(
    convertDevice(gladys, {
      _id: 'nhc-1',
      type: 'NHC',
      station_name: 'Bedroom',
      apiNotConfigured: true,
    }),
    null,
  );
});

test('the Home Coach health index maps to the middle of its AQI band', () => {
  // 0 healthy, 1 fine, 2 fair, 3 poor, 4 unhealthy → EPA bands good,
  // moderate, sensitive groups, unhealthy, very unhealthy.
  assert.deepEqual([0, 1, 2, 3, 4].map(healthIndexToAqi), [25, 75, 125, 175, 250]);
  assert.equal(healthIndexToAqi('2'), 125);
  for (const unknown of [undefined, null, '', 5, -1, 1.5, 'bad']) {
    assert.equal(healthIndexToAqi(unknown), undefined, `${unknown}`);
  }
});
