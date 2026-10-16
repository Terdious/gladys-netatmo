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
  ]);
  assert.equal(paramValue(device, 'room_id'), undefined);
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
