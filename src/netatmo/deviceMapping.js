// -----------------------------------------------------------------------------
// Netatmo value ↔ Gladys state transforms
// (port of the core netatmo.deviceMapping.js), keyed by feature
// category/type. `readValues` turns a raw Netatmo value into a Gladys state;
// `writeValues` turns a Gladys command into the value sent to Netatmo.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

const toBinary = (valueFromDevice) => (valueFromDevice === true || valueFromDevice === 1 ? 1 : 0);
const toInteger = (valueFromDevice) => parseInt(valueFromDevice, 10);
const identity = (valueFromDevice) => valueFromDevice;

// NRV modules report a `battery_state` string instead of a percentage.
const BATTERY_LEVELS = {
  max: 100,
  full: 90,
  high: 75,
  medium: 50,
  low: 25,
  'very low': 10,
};

export const writeValues = {
  [DEVICE_FEATURE_CATEGORIES.THERMOSTAT]: {
    [DEVICE_FEATURE_TYPES.THERMOSTAT.TARGET_TEMPERATURE]: identity,
  },
};

export const readValues = {
  [DEVICE_FEATURE_CATEGORIES.THERMOSTAT]: {
    [DEVICE_FEATURE_TYPES.THERMOSTAT.TARGET_TEMPERATURE]: identity,
  },
  [DEVICE_FEATURE_CATEGORIES.SWITCH]: {
    [DEVICE_FEATURE_TYPES.SWITCH.BINARY]: toBinary,
  },
  [DEVICE_FEATURE_CATEGORIES.BATTERY]: {
    [DEVICE_FEATURE_TYPES.BATTERY.INTEGER]: (valueFromDevice) =>
      BATTERY_LEVELS[valueFromDevice] !== undefined
        ? BATTERY_LEVELS[valueFromDevice]
        : toInteger(valueFromDevice),
  },
  [DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR]: {
    [DEVICE_FEATURE_TYPES.SENSOR.DECIMAL]: identity,
    [DEVICE_FEATURE_TYPES.TEMPERATURE_SENSOR.MIN]: identity,
    [DEVICE_FEATURE_TYPES.TEMPERATURE_SENSOR.MAX]: identity,
  },
  [DEVICE_FEATURE_CATEGORIES.SIGNAL]: {
    [DEVICE_FEATURE_TYPES.SIGNAL.QUALITY]: toInteger,
  },
  [DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR]: {
    [DEVICE_FEATURE_TYPES.SENSOR.BINARY]: toBinary,
  },
  [DEVICE_FEATURE_CATEGORIES.CO2_SENSOR]: {
    [DEVICE_FEATURE_TYPES.SENSOR.INTEGER]: toInteger,
  },
  [DEVICE_FEATURE_CATEGORIES.HUMIDITY_SENSOR]: {
    [DEVICE_FEATURE_TYPES.SENSOR.DECIMAL]: identity,
  },
  [DEVICE_FEATURE_CATEGORIES.NOISE_SENSOR]: {
    [DEVICE_FEATURE_TYPES.SENSOR.INTEGER]: toInteger,
  },
  [DEVICE_FEATURE_CATEGORIES.PRESSURE_SENSOR]: {
    [DEVICE_FEATURE_TYPES.SENSOR.INTEGER]: toInteger,
  },
  [DEVICE_FEATURE_CATEGORIES.SPEED_SENSOR]: {
    [DEVICE_FEATURE_TYPES.SPEED_SENSOR.INTEGER]: toInteger,
  },
  [DEVICE_FEATURE_CATEGORIES.ANGLE_SENSOR]: {
    [DEVICE_FEATURE_TYPES.SENSOR.INTEGER]: toInteger,
  },
  [DEVICE_FEATURE_CATEGORIES.PRECIPITATION_SENSOR]: {
    [DEVICE_FEATURE_TYPES.SENSOR.DECIMAL]: identity,
  },
};
