// -----------------------------------------------------------------------------
// Gladys feature builders (port of the core netatmo.buildFeatures* modules).
//
// Every builder produces the exact same feature as the core service — same
// suffix, category, type, unit, bounds — so the two implementations stay easy
// to diff. Feature external_ids are `<deviceExternalId>:<suffix>` and the
// suffixes are FROZEN once shipped.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

function feature(overrides) {
  return {
    read_only: true,
    keep_history: true,
    has_feedback: false,
    ...overrides,
  };
}

export function buildFeatureBattery(name, externalId) {
  return feature({
    name: `Battery - ${name}`,
    external_id: `${externalId}:battery_percent`,
    selector: `${externalId}:battery_percent`,
    category: DEVICE_FEATURE_CATEGORIES.BATTERY,
    type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    min: 0,
    max: 100,
  });
}

export function buildFeatureRfStrength(name, externalId) {
  return feature({
    name: `Link RF quality - ${name}`,
    external_id: `${externalId}:rf_strength`,
    selector: `${externalId}:rf_strength`,
    category: DEVICE_FEATURE_CATEGORIES.SIGNAL,
    type: DEVICE_FEATURE_TYPES.SIGNAL.QUALITY,
    min: 0,
    max: 100,
  });
}

export function buildFeatureWifiStrength(name, externalId) {
  return feature({
    name: `Link Wifi quality - ${name}`,
    external_id: `${externalId}:wifi_strength`,
    selector: `${externalId}:wifi_strength`,
    category: DEVICE_FEATURE_CATEGORIES.SIGNAL,
    type: DEVICE_FEATURE_TYPES.SIGNAL.QUALITY,
    min: 0,
    max: 100,
  });
}

export function buildFeatureTemperature(
  name,
  externalId,
  featureName,
  type = DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
) {
  return feature({
    name: `Temperature - ${name}`,
    external_id: `${externalId}:${featureName}`,
    selector: `${externalId}:${featureName}`,
    category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
    type,
    unit: DEVICE_FEATURE_UNITS.CELSIUS,
    min: -10,
    max: 50,
  });
}

export function buildFeatureThermSetpointTemperature(name, externalId) {
  return feature({
    name: `Setpoint temperature - ${name}`,
    external_id: `${externalId}:therm_setpoint_temperature`,
    selector: `${externalId}:therm_setpoint_temperature`,
    category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
    type: DEVICE_FEATURE_TYPES.THERMOSTAT.TARGET_TEMPERATURE,
    unit: DEVICE_FEATURE_UNITS.CELSIUS,
    read_only: false,
    min: 5,
    max: 30,
  });
}

export function buildFeatureBoilerStatus(name, externalId) {
  return feature({
    name: `Boiler status - ${name}`,
    external_id: `${externalId}:boiler_status`,
    selector: `${externalId}:boiler_status`,
    category: DEVICE_FEATURE_CATEGORIES.SWITCH,
    type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
    min: 0,
    max: 1,
  });
}

export function buildFeatureHeatingPowerRequest(name, externalId) {
  return feature({
    name: `Heating power request - ${name}`,
    external_id: `${externalId}:heating_power_request`,
    selector: `${externalId}:heating_power_request`,
    category: DEVICE_FEATURE_CATEGORIES.SWITCH,
    type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
    min: 0,
    max: 1,
  });
}

export function buildFeaturePlugConnectedBoiler(name, externalId) {
  return feature({
    name: `${name} connected boiler`,
    external_id: `${externalId}:plug_connected_boiler`,
    selector: `${externalId}:plug_connected_boiler`,
    category: DEVICE_FEATURE_CATEGORIES.SWITCH,
    type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
    min: 0,
    max: 1,
  });
}

// Camera monitoring switch (core PR #2621, made writable by core PR #2623:
// the command goes through /api/setstate).
export function buildFeatureMonitoring(name, externalId) {
  return feature({
    name: `Monitoring - ${name}`,
    external_id: `${externalId}:monitoring`,
    selector: `${externalId}:monitoring`,
    category: DEVICE_FEATURE_CATEGORIES.SWITCH,
    type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
    read_only: false,
    min: 0,
    max: 1,
  });
}

// Camera image shown in the Gladys camera dashboard (core PR #2623).
export function buildFeatureCamera(name, externalId) {
  return feature({
    name: `Camera - ${name}`,
    external_id: `${externalId}:camera`,
    selector: `${externalId}:camera`,
    category: DEVICE_FEATURE_CATEGORIES.CAMERA,
    type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
    keep_history: false,
    min: 0,
    max: 0,
  });
}

export function buildFeatureOpenWindow(name, externalId) {
  return feature({
    name: `Detecting open window - ${name}`,
    external_id: `${externalId}:open_window`,
    selector: `${externalId}:open_window`,
    category: DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
  });
}

export function buildFeatureCo2(name, externalId) {
  return feature({
    name: `CO2 - ${name}`,
    external_id: `${externalId}:co2`,
    selector: `${externalId}:co2`,
    category: DEVICE_FEATURE_CATEGORIES.CO2_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    unit: DEVICE_FEATURE_UNITS.PPM,
    min: 0,
    max: 5000,
  });
}

export function buildFeatureHumidity(name, externalId) {
  return feature({
    name: `Humidity - ${name}`,
    external_id: `${externalId}:humidity`,
    selector: `${externalId}:humidity`,
    category: DEVICE_FEATURE_CATEGORIES.HUMIDITY_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    min: 0,
    max: 100,
  });
}

export function buildFeatureNoise(name, externalId) {
  return feature({
    name: `Noise - ${name}`,
    external_id: `${externalId}:noise`,
    selector: `${externalId}:noise`,
    category: DEVICE_FEATURE_CATEGORIES.NOISE_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    unit: DEVICE_FEATURE_UNITS.DECIBEL,
    min: 0,
    max: 250,
  });
}

export function buildFeaturePressure(name, externalId, featureName) {
  return feature({
    name,
    external_id: `${externalId}:${featureName}`,
    selector: `${externalId}:${featureName}`,
    category: DEVICE_FEATURE_CATEGORIES.PRESSURE_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    unit: DEVICE_FEATURE_UNITS.MILLIBAR,
    min: -1000,
    max: 2000,
  });
}

export function buildFeatureWindStrength(name, externalId, featureName) {
  return feature({
    name,
    external_id: `${externalId}:${featureName}`,
    selector: `${externalId}:${featureName}`,
    category: DEVICE_FEATURE_CATEGORIES.SPEED_SENSOR,
    type: DEVICE_FEATURE_TYPES.SPEED_SENSOR.INTEGER,
    unit: DEVICE_FEATURE_UNITS.KILOMETER_PER_HOUR,
    min: 0,
    max: 300,
  });
}

export function buildFeatureWindAngle(name, externalId, featureName) {
  return feature({
    name,
    external_id: `${externalId}:${featureName}`,
    selector: `${externalId}:${featureName}`,
    category: DEVICE_FEATURE_CATEGORIES.ANGLE_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    unit: DEVICE_FEATURE_UNITS.DEGREE,
    min: 0,
    max: 360,
  });
}

export function buildFeatureRain(name, externalId, featureName, unit) {
  return feature({
    name,
    external_id: `${externalId}:${featureName}`,
    selector: `${externalId}:${featureName}`,
    category: DEVICE_FEATURE_CATEGORIES.PRECIPITATION_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit,
    min: 0,
    max: 100,
  });
}
