// -----------------------------------------------------------------------------
// Raw Netatmo device → Gladys discovery payload
// (port of the core convertDeviceEnergy / convertDeviceWeather, merged: the
// two functions shared their whole params/battery scaffolding).
//
// Device external_id: `gladys.externalId(<netatmo id>)` → `ext:netatmo:<id>`.
// The core service used `netatmo:<id>` — a user migrating from the core gets
// NEW devices (documented in the README/roadmap).
//
// Devices are created with should_poll:false: telemetry is pushed by ONE
// global 120s loop (3-4 API calls per cycle for the whole account), instead of
// per-device polls that would hammer the Netatmo rate limits.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { SUPPORTED_MODULE_TYPE, SECURITY_MODULE_TYPES, PARAMS } from './constants.js';
import { netatmoId } from './discovery.js';
import {
  buildFeatureBattery,
  buildFeatureRfStrength,
  buildFeatureWifiStrength,
  buildFeatureTemperature,
  buildFeatureThermSetpointTemperature,
  buildFeatureBoilerStatus,
  buildFeatureHeatingPowerRequest,
  buildFeaturePlugConnectedBoiler,
  buildFeatureOpenWindow,
  buildFeatureMonitoring,
  buildFeatureCamera,
  buildFeatureCo2,
  buildFeatureHumidity,
  buildFeatureNoise,
  buildFeaturePressure,
  buildFeatureWindStrength,
  buildFeatureWindAngle,
  buildFeatureRain,
} from './features.js';
import { DEVICE_FEATURE_TYPES, DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'netatmo-convert' });

const BATTERY_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.THERMOSTAT,
  SUPPORTED_MODULE_TYPE.NRV,
  SUPPORTED_MODULE_TYPE.NAMODULE1,
  SUPPORTED_MODULE_TYPE.NAMODULE2,
  SUPPORTED_MODULE_TYPE.NAMODULE3,
  SUPPORTED_MODULE_TYPE.NAMODULE4,
];

const BRIDGE_MODULE_TYPES = [SUPPORTED_MODULE_TYPE.PLUG, SUPPORTED_MODULE_TYPE.NAMAIN];

/** Append the min_temp / max_temp features shared by the indoor/outdoor modules. */
function pushMinMaxTemp(features, roomName, externalId) {
  features.push(
    buildFeatureTemperature(
      `Minimum in ${roomName}`,
      externalId,
      'min_temp',
      DEVICE_FEATURE_TYPES.TEMPERATURE_SENSOR.MIN,
    ),
    buildFeatureTemperature(
      `Maximum in ${roomName}`,
      externalId,
      'max_temp',
      DEVICE_FEATURE_TYPES.TEMPERATURE_SENSOR.MAX,
    ),
  );
}

/**
 * Convert one raw Netatmo device to a Gladys discovery payload.
 * @param {object} gladys SDK instance (external_id builder)
 * @param {object} netatmoDevice raw device from loadDevices()
 * @returns {object|null} Gladys device payload, or null when not supported
 */
export function convertDevice(gladys, netatmoDevice) {
  const { home, name, type: model, room = {}, plug = {} } = netatmoDevice;
  const id = netatmoId(netatmoDevice);
  const homeId = home || netatmoDevice.home_id;
  const nameDevice = name || netatmoDevice.module_name || netatmoDevice.station_name;
  if (netatmoDevice.not_handled || !id) {
    logger.info(`Skipping unsupported Netatmo device "${nameDevice ?? id}" (${model})`);
    return null;
  }
  if (netatmoDevice.apiNotConfigured) {
    // The API covering this module is disabled in the configuration (e.g.
    // cameras with security_api off): the device stays out of the discovery.
    logger.debug(`Skipping Netatmo device "${nameDevice}" (${model}): its API is disabled`);
    return null;
  }
  const externalId = gladys.externalId(id);
  const features = [];
  let params = [];
  let roomName = 'undefined';

  if (BATTERY_MODULE_TYPES.includes(model)) {
    features.push(
      buildFeatureBattery(nameDevice, externalId),
      buildFeatureRfStrength(nameDevice, externalId),
    );
    const plugId = netatmoId(plug ?? {});
    if (plugId) {
      const plugName = plug.name || plug.module_name || plug.station_name;
      params = [
        { name: PARAMS.PLUG_ID, value: plugId },
        { name: PARAMS.PLUG_NAME, value: plugName },
      ];
    }
  }
  if (BRIDGE_MODULE_TYPES.includes(model) || SECURITY_MODULE_TYPES.includes(model)) {
    features.push(buildFeatureWifiStrength(nameDevice, externalId));
    if (model === SUPPORTED_MODULE_TYPE.PLUG) {
      features.push(buildFeatureRfStrength(nameDevice, externalId));
    }
    params = [
      {
        name: PARAMS.MODULES_BRIDGE_ID,
        value: JSON.stringify(netatmoDevice.modules_bridged || []),
      },
    ];
  }
  params.push({ name: PARAMS.HOME_ID, value: homeId });
  if (room.id) {
    roomName = room.name;
    params.push(
      { name: PARAMS.ROOM_ID, value: room.id },
      { name: PARAMS.ROOM_NAME, value: roomName },
    );
  }

  switch (model) {
    case SUPPORTED_MODULE_TYPE.THERMOSTAT:
      features.push(buildFeatureTemperature(nameDevice, externalId, 'temperature'));
      if (room.id) {
        features.push(
          buildFeatureTemperature(`room ${roomName}`, externalId, 'therm_measured_temperature'),
        );
      }
      features.push(
        buildFeatureThermSetpointTemperature(nameDevice, externalId),
        buildFeatureOpenWindow(nameDevice, externalId),
        buildFeatureBoilerStatus(nameDevice, externalId),
      );
      break;
    case SUPPORTED_MODULE_TYPE.PLUG:
      features.push(buildFeaturePlugConnectedBoiler(nameDevice, externalId));
      break;
    case SUPPORTED_MODULE_TYPE.NRV:
      if (room.id) {
        features.push(
          buildFeatureTemperature(`room ${roomName}`, externalId, 'therm_measured_temperature'),
        );
      }
      features.push(
        buildFeatureThermSetpointTemperature(nameDevice, externalId),
        buildFeatureOpenWindow(nameDevice, externalId),
        buildFeatureHeatingPowerRequest(nameDevice, externalId),
      );
      break;
    case SUPPORTED_MODULE_TYPE.NAMAIN:
      features.push(buildFeatureTemperature(nameDevice, externalId, 'temperature'));
      if (room.id) {
        features.push(
          buildFeatureTemperature(`room ${roomName}`, externalId, 'therm_measured_temperature'),
        );
      }
      pushMinMaxTemp(features, roomName, externalId);
      features.push(
        buildFeatureCo2(nameDevice, externalId),
        buildFeatureHumidity(nameDevice, externalId),
        buildFeatureNoise(nameDevice, externalId),
        buildFeaturePressure(`Pressure - ${nameDevice}`, externalId, 'pressure'),
        buildFeaturePressure(`Absolute pressure - ${nameDevice}`, externalId, 'absolute_pressure'),
      );
      break;
    case SUPPORTED_MODULE_TYPE.NAMODULE1:
      features.push(buildFeatureTemperature(nameDevice, externalId, 'temperature'));
      pushMinMaxTemp(features, roomName, externalId);
      features.push(buildFeatureHumidity(nameDevice, externalId));
      break;
    case SUPPORTED_MODULE_TYPE.NAMODULE2:
      features.push(
        buildFeatureWindStrength(`Wind strength - ${nameDevice}`, externalId, 'wind_strength'),
        buildFeatureWindAngle(`Wind angle - ${nameDevice}`, externalId, 'wind_angle'),
        buildFeatureWindStrength(`Gust strength - ${nameDevice}`, externalId, 'wind_gust'),
        buildFeatureWindAngle(`Gust angle - ${nameDevice}`, externalId, 'wind_gust_angle'),
        buildFeatureWindStrength(
          `Maximum wind strength - ${nameDevice}`,
          externalId,
          'max_wind_str',
        ),
        buildFeatureWindAngle(`Maximum wind angle - ${nameDevice}`, externalId, 'max_wind_angle'),
      );
      break;
    case SUPPORTED_MODULE_TYPE.NAMODULE3:
      features.push(
        buildFeatureRain(
          `Current rain - ${nameDevice}`,
          externalId,
          'rain',
          DEVICE_FEATURE_UNITS.MM,
        ),
        buildFeatureRain(
          `Precipitation / 1h - ${nameDevice}`,
          externalId,
          'sum_rain_1',
          DEVICE_FEATURE_UNITS.MILLIMETER_PER_HOUR,
        ),
        buildFeatureRain(
          `Sum rain / 24h - ${nameDevice}`,
          externalId,
          'sum_rain_24',
          DEVICE_FEATURE_UNITS.MILLIMETER_PER_DAY,
        ),
      );
      break;
    case SUPPORTED_MODULE_TYPE.NACAMERA:
    case SUPPORTED_MODULE_TYPE.NOC:
      features.push(buildFeatureMonitoring(nameDevice, externalId));
      features.push(buildFeatureCamera(nameDevice, externalId));
      break;
    case SUPPORTED_MODULE_TYPE.NAMODULE4:
      features.push(buildFeatureTemperature(nameDevice, externalId, 'temperature'));
      if (room.id) {
        features.push(
          buildFeatureTemperature(`room ${roomName}`, externalId, 'therm_measured_temperature'),
        );
      }
      pushMinMaxTemp(features, roomName, externalId);
      features.push(
        buildFeatureCo2(nameDevice, externalId),
        buildFeatureHumidity(nameDevice, externalId),
      );
      break;
    default:
      logger.info(`Skipping unsupported Netatmo device "${nameDevice}" (${model})`);
      return null;
  }

  return {
    name: nameDevice,
    external_id: externalId,
    selector: externalId,
    model,
    should_poll: false,
    features: features.filter(Boolean),
    params: params.filter((param) => param && param.value !== undefined),
  };
}
