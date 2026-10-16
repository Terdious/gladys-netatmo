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

import { THERM_MODE_PRESETS, THERM_MODE_LABELS } from './constants.js';

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

export function buildFeatureThermSetpointTemperature(name, externalId, { writable = true } = {}) {
  return feature({
    name: `Setpoint temperature - ${name}`,
    external_id: `${externalId}:therm_setpoint_temperature`,
    selector: `${externalId}:therm_setpoint_temperature`,
    category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
    type: DEVICE_FEATURE_TYPES.THERMOSTAT.TARGET_TEMPERATURE,
    unit: DEVICE_FEATURE_UNITS.CELSIUS,
    // Read-only for legacy-only thermostats without home_id/room_id: the
    // setroomthermpoint command cannot be built for them.
    read_only: !writable,
    min: 5,
    max: 30,
    // Netatmo setpoints move by half degrees (Gladys 4.86+ reads `step`).
    step: 0.5,
  });
}

// Heating mode of the home (issue #38), as a Gladys `thermostat/preset`
// (Gladys 5.2.0+). Only the three Netatmo modes are declared: the front then
// offers nothing else. `label` is a plain string by contract — the Gladys UI
// translates the preset values itself, the label is its fallback.
export function buildFeatureThermPreset(name, externalId) {
  return feature({
    name: `Heating mode - ${name}`,
    external_id: `${externalId}:therm_preset`,
    selector: `${externalId}:therm_preset`,
    category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
    type: DEVICE_FEATURE_TYPES.THERMOSTAT.PRESET,
    read_only: false,
    min: Math.min(...THERM_MODE_PRESETS.map(({ preset }) => preset)),
    max: Math.max(...THERM_MODE_PRESETS.map(({ preset }) => preset)),
    supported_options: THERM_MODE_PRESETS.map(({ mode, preset }, index) => ({
      value: preset,
      label: THERM_MODE_LABELS[mode].en,
      sort_order: index,
    })),
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

// Floodlight of the outdoor camera (NOC, issue #56). Netatmo has ONE
// three-value setting (on / off / auto) and Gladys no standard three-value
// light mode: it is split into two standard atomic controls. This one is the
// light itself (a `light` / `binary`, so the light scene actions and the
// dashboard light toggle work): 1 = forced on, 0 = not forced on.
export function buildFeatureFloodlight(name, externalId) {
  return feature({
    name: `Floodlight - ${name}`,
    external_id: `${externalId}:floodlight`,
    selector: `${externalId}:floodlight`,
    category: DEVICE_FEATURE_CATEGORIES.LIGHT,
    type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
    read_only: false,
    min: 0,
    max: 1,
  });
}

// ...and this one the automatic mode (the floodlight lights up on a
// detection): 1 = `auto`.
export function buildFeatureFloodlightAuto(name, externalId) {
  return feature({
    name: `Floodlight automatic mode - ${name}`,
    external_id: `${externalId}:floodlight_auto`,
    selector: `${externalId}:floodlight_auto`,
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

// --- Momentary event features (webhook-driven, issue #5) --------------------

// Video doorbell (NDB, issue #35): the ring (`incoming_call` event). Gladys
// renders it as "Ringing" then the time of the last ring, and its scene
// trigger fires on every 1 — a 1 -> 0 pulse like the other detections.
export function buildFeatureDoorbellRing(name, externalId) {
  return feature({
    name: `Doorbell - ${name}`,
    external_id: `${externalId}:ring`,
    selector: `${externalId}:ring`,
    category: DEVICE_FEATURE_CATEGORIES.DOORBELL,
    type: DEVICE_FEATURE_TYPES.DOORBELL.RING,
    min: 0,
    max: 1,
  });
}
// These exist only in the Netatmo event stream: no API state reports them, so
// they are published from the webhook payload and reset after EVENT_RESET_MS.

export function buildFeatureMotion(name, externalId) {
  return feature({
    name: `Motion - ${name}`,
    external_id: `${externalId}:motion`,
    selector: `${externalId}:motion`,
    category: DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
  });
}

export function buildFeatureHuman(name, externalId) {
  return feature({
    name: `Person detected - ${name}`,
    external_id: `${externalId}:human`,
    selector: `${externalId}:human`,
    category: DEVICE_FEATURE_CATEGORIES.PRESENCE_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
  });
}

// Outdoor camera (NOC) only: it classifies what it sees.
export function buildFeatureAnimal(name, externalId) {
  return feature({
    name: `Animal detected - ${name}`,
    external_id: `${externalId}:animal`,
    selector: `${externalId}:animal`,
    category: DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
  });
}

export function buildFeatureVehicle(name, externalId) {
  return feature({
    name: `Vehicle detected - ${name}`,
    external_id: `${externalId}:vehicle`,
    selector: `${externalId}:vehicle`,
    category: DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
  });
}

// Smoke alarm (NSD): the smoke state is webhook-only — the homestatus payload
// never reports it.
export function buildFeatureSmoke(name, externalId) {
  return feature({
    name: `Smoke - ${name}`,
    external_id: `${externalId}:smoke`,
    selector: `${externalId}:smoke`,
    category: DEVICE_FEATURE_CATEGORIES.SMOKE_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
  });
}

// Carbon monoxide alarm (NCO, issue #36): like the smoke alarm, the CO state
// is webhook-only (`co_detected` event) — the homestatus payload never reports it.
export function buildFeatureCarbonMonoxide(name, externalId) {
  return feature({
    name: `Carbon monoxide - ${name}`,
    external_id: `${externalId}:carbon_monoxide`,
    selector: `${externalId}:carbon_monoxide`,
    category: DEVICE_FEATURE_CATEGORIES.CO_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
  });
}

// Door/window tag (NACamDoorTag): open/closed contact, read from homestatus
// `status` (issue #9). Distinct suffix from the thermostat `open_window`.
export function buildFeatureOpeningSensor(name, externalId) {
  return feature({
    name: `Opening - ${name}`,
    external_id: `${externalId}:opening`,
    selector: `${externalId}:opening`,
    category: DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
  });
}

// Indoor siren (NIS): read-only sounding state for now (control is a later
// milestone), read from homestatus `status` (issue #9).
export function buildFeatureSiren(name, externalId) {
  return feature({
    name: `Siren - ${name}`,
    external_id: `${externalId}:siren`,
    selector: `${externalId}:siren`,
    category: DEVICE_FEATURE_CATEGORIES.SIREN,
    type: DEVICE_FEATURE_TYPES.SIREN.BINARY,
    min: 0,
    max: 1,
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

// Home Coach health index (issue #37). Netatmo reports `health_idx` on a
// 5-level scale (0 healthy, 1 fine, 2 fair, 3 poor, 4 unhealthy), while the
// Gladys `airquality-sensor`/`aqi` feature is read as a US EPA AQI (0-500) by
// the dashboard badge colours and the HomeKit bridge: the level is published
// as the middle of the matching AQI band (see HEALTH_INDEX_TO_AQI), so it is
// coloured and bridged correctly. It is NOT a measured AQI.
export function buildFeatureHealthIndex(name, externalId) {
  return feature({
    name: `Air quality - ${name}`,
    external_id: `${externalId}:health_idx`,
    selector: `${externalId}:health_idx`,
    category: DEVICE_FEATURE_CATEGORIES.AIRQUALITY_SENSOR,
    type: DEVICE_FEATURE_TYPES.AIRQUALITY_SENSOR.AQI,
    unit: DEVICE_FEATURE_UNITS.AQI,
    min: 0,
    max: 500,
  });
}

// The same health index as a named level (text / select, read-only): the
// dashboard shows the Netatmo wording ("Fine", "Unhealthy"...) next to the
// AQI-band value, which keeps the history, the colours and HomeKit. Option
// labels are plain strings in Gladys (no per-language label yet): French, the
// language of most Gladys installations. A text state keeps no history.
export const HEALTH_LEVEL_OPTIONS = [
  { value: 'healthy', label: 'Sain' },
  { value: 'fine', label: 'Correct' },
  { value: 'fair', label: 'Moyen' },
  { value: 'poor', label: 'Mauvais' },
  { value: 'unhealthy', label: 'Malsain' },
];

export function buildFeatureHealthLevel(name, externalId) {
  return feature({
    name: `Air quality level - ${name}`,
    external_id: `${externalId}:health_level`,
    selector: `${externalId}:health_level`,
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
    keep_history: false,
    min: 0,
    max: 0,
    supported_options: HEALTH_LEVEL_OPTIONS.map((option) => ({ ...option })),
  });
}

// --- Roller shutters (Bubendorff / iDiamant, issue #34) ---------------------

// Open / close / stop command (Gladys COVER_STATE: CLOSE -1, STOP 0, OPEN 1),
// sent as an /api/setstate target_position (0 / -1 / 100).
export function buildFeatureShutterState(name, externalId) {
  return feature({
    name: `Shutter - ${name}`,
    external_id: `${externalId}:state`,
    selector: `${externalId}:state`,
    category: DEVICE_FEATURE_CATEGORIES.SHUTTER,
    type: DEVICE_FEATURE_TYPES.SHUTTER.STATE,
    read_only: false,
    keep_history: false,
    min: -1,
    max: 1,
  });
}

// Position in percent (0 = closed, 100 = open), read from the homestatus
// `current_position` and writable as a target_position.
export function buildFeatureShutterPosition(name, externalId) {
  return feature({
    name: `Position - ${name}`,
    external_id: `${externalId}:position`,
    selector: `${externalId}:position`,
    category: DEVICE_FEATURE_CATEGORIES.SHUTTER,
    type: DEVICE_FEATURE_TYPES.SHUTTER.POSITION,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    read_only: false,
    min: 0,
    max: 100,
  });
}
