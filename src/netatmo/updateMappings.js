// -----------------------------------------------------------------------------
// Declarative mapping of Gladys feature suffixes to Netatmo API values, per
// module type — verbatim port of the core PR #2619 table
// (server/services/netatmo/lib/update/netatmo.updateMappings.js).
//
// Key order drives the emission order of the states. A value extractor
// returning undefined/null means "no value available, skip the emission"
// (core PR #2617: legitimate zeros are values, absences are not).
//
// A device whose features depend on its own payload (the known persons of a
// home, issue #57) maps to a FUNCTION of the raw device returning that table.
// -----------------------------------------------------------------------------

import {
  SUPPORTED_MODULE_TYPE,
  COVER_STATE,
  FLOODLIGHT_MODES,
  VIRTUAL_DEVICE_TYPE,
  PERSON_PRESENCE_SUFFIX_PREFIX,
  BTICINO_LIGHT_SUFFIX,
  NETATMO_SETPOINT_MODES,
  THERMOSTAT_MODE,
  THERMOSTAT_OPERATING_STATE,
  OPENING_SENSOR_STATE,
  ROOM_OPERATING_STATE_SUFFIX,
  ROOM_MODE_SUFFIX,
} from './constants.js';
import { healthIndexToAqi, healthIndexToLevel } from './deviceMapping.js';

/**
 * Shutter position in percent from homestatus `current_position`. Anything
 * outside 0-100 is not a position: pyatmo documents 101 as "never
 * instructed" for actors that only echo the last commanded target.
 */
function shutterPosition(deviceNetatmo) {
  const position = deviceNetatmo.current_position;
  return typeof position === 'number' && position >= 0 && position <= 100 ? position : undefined;
}

/**
 * Shutter state derived from the position, at the end stops only: 100 →
 * OPEN, 0 → CLOSE. An intermediate position emits nothing, so the last
 * command saved by Gladys (STOP, or a move still in progress) is never
 * overwritten by a guess.
 */
function shutterState(deviceNetatmo) {
  const position = shutterPosition(deviceNetatmo);
  if (position === 100) return COVER_STATE.OPEN;
  if (position === 0) return COVER_STATE.CLOSE;
  return undefined;
}

/**
 * Floodlight of the outdoor camera (issue #56), split over two binaries: the
 * light (forced `on`) and the automatic mode (`auto`). Any other value
 * (absent, unknown) emits nothing.
 */
function floodlightIs(mode) {
  return (deviceNetatmo) =>
    Object.values(FLOODLIGHT_MODES).includes(deviceNetatmo.floodlight)
      ? deviceNetatmo.floodlight === mode
      : undefined;
}

// Bubendorff / iDiamant roller shutters (issue #34): radio, wired, solar.
const SHUTTER_MAPPING = {
  state: shutterState,
  position: shutterPosition,
  rf_strength: (deviceNetatmo) => deviceNetatmo.rf_strength,
};

/**
 * Boiler fault of an OpenTherm relay (issue #53): homestatus carries
 * `boiler_error` (e.g. "water_pressure") only while the boiler reports one.
 * A module present in this homestatus without it has no fault (false); a
 * module homestatus did not carry says nothing (undefined, not published).
 * "none" is read as no fault, should Netatmo ever send it.
 */
function boilerFault(deviceNetatmo) {
  const error = deviceNetatmo.boiler_error;
  if (typeof error === 'string' && error !== '' && error !== 'none') {
    return true;
  }
  return deviceNetatmo.homestatus ? false : undefined;
}

/**
 * Presence table of the known persons of a home (issue #57): one suffix per
 * named person, at home (true) when homestatus says `out_of_sight: false`,
 * away (false) when true. A person homestatus does not report has no
 * boolean there: no value, nothing published.
 */
function knownPersonsMapping(deviceNetatmo) {
  return Object.fromEntries(
    (deviceNetatmo.persons ?? []).map((person) => [
      `${PERSON_PRESENCE_SUFFIX_PREFIX}${person.id}`,
      () => (typeof person.out_of_sight === 'boolean' ? !person.out_of_sight : undefined),
    ]),
  );
}

// BTicino door entry modules (issue #59): the signal quality, emitted only
// when homestatus carries it. The modules a BNCX bridges ride on its device
// (discovery groupBticinoModules): telemetry applies THEIR table with their
// own id and reachability (a module unreachable, or behind an unreachable
// gateway, publishes nothing).
const BTICINO_MAPPING = {
  wifi_strength: (deviceNetatmo) => deviceNetatmo.wifi_strength,
  rf_strength: (deviceNetatmo) => deviceNetatmo.rf_strength,
};

/** Homestatus `on` when it is a boolean — anything else is no value. */
const homestatusOn = (deviceNetatmo) =>
  typeof deviceNetatmo.on === 'boolean' ? deviceNetatmo.on : undefined;

// Staircase / outdoor light (BNSL): Netatmo does not report its state ("ON/OFF
// light status is not retrievable"), the command publishes it (setValue);
// should homestatus ever carry `on`, it wins.
const BTICINO_LIGHT_MAPPING = {
  ...BTICINO_MAPPING,
  [BTICINO_LIGHT_SUFFIX]: homestatusOn,
};

// Controlled socket (pyatmo `Switch`): homestatus `on`, read-only.
const BTICINO_SWITCH_MAPPING = {
  on: homestatusOn,
  ...BTICINO_MAPPING,
};

/**
 * Room setpoint (homestatus `rooms[].therm_setpoint_temperature`). Nothing
 * while the room is off (issue #77): an off room aims at no temperature, and
 * whatever Netatmo reports then must not overwrite the setpoint Gladys holds —
 * the Gladys Thermostat service would take it for a change made on the
 * thermostat.
 */
function roomSetpoint(deviceNetatmo) {
  const room = deviceNetatmo.room;
  return room?.therm_setpoint_mode === NETATMO_SETPOINT_MODES.OFF
    ? undefined
    : room?.therm_setpoint_temperature;
}

/**
 * Whether the room is heating (issue #77), THERMOSTAT_OPERATING_STATE: HEATING
 * while the room requests heat (`heating_power_request` > 0) or, for a boiler
 * thermostat, while the boiler runs (`boiler_status`); COOLING while a
 * Smarther's air conditioning runs (`cooler_status`); IDLE otherwise. The
 * module's own states are ignored when it is unreachable (Netatmo then
 * replays its last-known values). Nothing when no value is known.
 */
function roomOperatingState(deviceNetatmo) {
  const request = deviceNetatmo.room?.heating_power_request;
  const reachable = deviceNetatmo.reachable !== false;
  const boiler = reachable ? deviceNetatmo.boiler_status : undefined;
  const cooler = reachable ? deviceNetatmo.cooler_status : undefined;
  if ((typeof request === 'number' && request > 0) || boiler === true) {
    return THERMOSTAT_OPERATING_STATE.HEATING;
  }
  if (cooler === true) {
    return THERMOSTAT_OPERATING_STATE.COOLING;
  }
  const known =
    typeof request === 'number' || typeof boiler === 'boolean' || typeof cooler === 'boolean';
  return known ? THERMOSTAT_OPERATING_STATE.IDLE : undefined;
}

/**
 * What the room does (issue #77), THERMOSTAT_MODE: OFF when its setpoint mode
 * is `off`, HEATING for any other one (schedule, manual, boost, away, frost
 * guard). Nothing when homestatus reports no setpoint mode.
 */
function roomMode(deviceNetatmo) {
  const mode = deviceNetatmo.room?.therm_setpoint_mode;
  if (typeof mode !== 'string' || mode === '') {
    return undefined;
  }
  return mode === NETATMO_SETPOINT_MODES.OFF ? THERMOSTAT_MODE.OFF : THERMOSTAT_MODE.HEATING;
}

/**
 * Open window detected in the room (`open_window`, thermostats and valves),
 * with the Gladys convention of an opening sensor, OPENING_SENSOR_STATE:
 * 0 open, 1 closed (it published 1 when open before, so the dashboard showed
 * an open window as closed). Nothing when homestatus does not report it.
 */
function openWindow(deviceNetatmo) {
  const open = deviceNetatmo.room?.open_window;
  if (typeof open !== 'boolean') {
    return undefined;
  }
  return open ? OPENING_SENSOR_STATE.OPEN : OPENING_SENSOR_STATE.CLOSE;
}

/**
 * Door / window tag contact (`opening`, issue #9) from homestatus `status`,
 * OPENING_SENSOR_STATE like `open_window`: "open" 0, "closed" 1. Any other
 * value ("no_news", "calibrating", "undefined") is no reliable state: nothing.
 */
function doorTagOpening(deviceNetatmo) {
  if (deviceNetatmo.status === 'open') return OPENING_SENSOR_STATE.OPEN;
  if (deviceNetatmo.status === 'closed') return OPENING_SENSOR_STATE.CLOSE;
  return undefined;
}

// The room thermostat features (issue #77): only published on the device that
// carries them (one per room), like any feature the device does not have.
const ROOM_THERMOSTAT_MAPPING = {
  [ROOM_OPERATING_STATE_SUFFIX]: roomOperatingState,
  [ROOM_MODE_SUFFIX]: roomMode,
};

export const UPDATE_MAPPINGS = {
  [SUPPORTED_MODULE_TYPE.PLUG]: {
    rf_strength: (deviceNetatmo) => deviceNetatmo.rf_strength,
    wifi_strength: (deviceNetatmo) => deviceNetatmo.wifi_strength,
    plug_connected_boiler: (deviceNetatmo) => deviceNetatmo.plug_connected_boiler ?? false,
  },
  [SUPPORTED_MODULE_TYPE.THERMOSTAT]: {
    // The `battery_state` string fallback goes beyond the core table (which
    // reads battery_percent only): homestatus reports battery_state for
    // NATherm1 when the legacy getthermostatsdata merge is unavailable.
    // Deliberate improvement, taken from the upstream camera branch.
    battery_percent: (deviceNetatmo) =>
      deviceNetatmo.battery_percent ?? deviceNetatmo.battery_state,
    temperature: (deviceNetatmo) => deviceNetatmo.measured?.temperature,
    therm_measured_temperature: (deviceNetatmo) => deviceNetatmo.room?.therm_measured_temperature,
    therm_setpoint_temperature: roomSetpoint,
    open_window: openWindow,
    rf_strength: (deviceNetatmo) => deviceNetatmo.rf_strength,
    boiler_status: (deviceNetatmo) => deviceNetatmo.boiler_status,
    // Heating mode of the home (issue #38), carried on every device of the
    // home by the discovery (homestatus `home.therm_mode`).
    therm_preset: (deviceNetatmo) => deviceNetatmo.therm_mode,
    ...ROOM_THERMOSTAT_MAPPING,
  },
  [SUPPORTED_MODULE_TYPE.NRV]: {
    battery_percent: (deviceNetatmo) => deviceNetatmo.battery_state,
    therm_measured_temperature: (deviceNetatmo) => deviceNetatmo.room?.therm_measured_temperature,
    therm_setpoint_temperature: roomSetpoint,
    open_window: openWindow,
    rf_strength: (deviceNetatmo) => deviceNetatmo.rf_strength,
    heating_power_request: (deviceNetatmo) => {
      const heatingPowerRequest = deviceNetatmo.room?.heating_power_request;
      return heatingPowerRequest === undefined || heatingPowerRequest === null
        ? undefined
        : heatingPowerRequest > 0;
    },
    therm_preset: (deviceNetatmo) => deviceNetatmo.therm_mode,
    ...ROOM_THERMOSTAT_MAPPING,
  },
  // Modulating / OpenTherm thermostat (issue #53), modelled on the NATherm1:
  // battery as a percent or the `battery_state` string (`battery_level` is in
  // millivolts, not used), room values, RF, boiler status, heating mode.
  [SUPPORTED_MODULE_TYPE.OTM]: {
    battery_percent: (deviceNetatmo) =>
      deviceNetatmo.battery_percent ?? deviceNetatmo.battery_state,
    therm_measured_temperature: (deviceNetatmo) => deviceNetatmo.room?.therm_measured_temperature,
    therm_setpoint_temperature: roomSetpoint,
    open_window: openWindow,
    rf_strength: (deviceNetatmo) => deviceNetatmo.rf_strength,
    boiler_status: (deviceNetatmo) => deviceNetatmo.boiler_status,
    therm_preset: (deviceNetatmo) => deviceNetatmo.therm_mode,
    ...ROOM_THERMOSTAT_MAPPING,
  },
  // OpenTherm relay (issue #53): WiFi, outdoor temperature, boiler fault.
  [SUPPORTED_MODULE_TYPE.OTH]: {
    wifi_strength: (deviceNetatmo) => deviceNetatmo.wifi_strength,
    outdoor_temperature: (deviceNetatmo) => deviceNetatmo.outdoor_temperature,
    boiler_fault: boilerFault,
  },
  // BTicino Smarther with Netatmo (issue #54): WiFi, room values, heating /
  // cooling states, comfort boost, heating mode.
  [SUPPORTED_MODULE_TYPE.BNS]: {
    wifi_strength: (deviceNetatmo) => deviceNetatmo.wifi_strength,
    therm_measured_temperature: (deviceNetatmo) => deviceNetatmo.room?.therm_measured_temperature,
    therm_setpoint_temperature: roomSetpoint,
    open_window: openWindow,
    boiler_status: (deviceNetatmo) => deviceNetatmo.boiler_status,
    cooler_status: (deviceNetatmo) => deviceNetatmo.cooler_status,
    boiler_valve_comfort_boost: (deviceNetatmo) => deviceNetatmo.boiler_valve_comfort_boost,
    therm_preset: (deviceNetatmo) => deviceNetatmo.therm_mode,
    ...ROOM_THERMOSTAT_MAPPING,
  },
  [SUPPORTED_MODULE_TYPE.NAMAIN]: {
    temperature: (deviceNetatmo) =>
      deviceNetatmo.temperature ?? deviceNetatmo.dashboard_data?.Temperature,
    therm_measured_temperature: (deviceNetatmo) => deviceNetatmo.room?.therm_measured_temperature,
    co2: (deviceNetatmo) => deviceNetatmo.co2 ?? deviceNetatmo.dashboard_data?.CO2,
    humidity: (deviceNetatmo) => deviceNetatmo.humidity ?? deviceNetatmo.dashboard_data?.Humidity,
    noise: (deviceNetatmo) => deviceNetatmo.noise ?? deviceNetatmo.dashboard_data?.Noise,
    pressure: (deviceNetatmo) => deviceNetatmo.pressure ?? deviceNetatmo.dashboard_data?.Pressure,
    absolute_pressure: (deviceNetatmo) =>
      deviceNetatmo.absolute_pressure ?? deviceNetatmo.dashboard_data?.AbsolutePressure,
    min_temp: (deviceNetatmo) => deviceNetatmo.dashboard_data?.min_temp,
    max_temp: (deviceNetatmo) => deviceNetatmo.dashboard_data?.max_temp,
    wifi_strength: (deviceNetatmo) => deviceNetatmo.wifi_strength ?? deviceNetatmo.wifi_status,
  },
  [SUPPORTED_MODULE_TYPE.NAMODULE1]: {
    battery_percent: (deviceNetatmo) => deviceNetatmo.battery_percent,
    temperature: (deviceNetatmo) =>
      deviceNetatmo.temperature ?? deviceNetatmo.dashboard_data?.Temperature,
    humidity: (deviceNetatmo) => deviceNetatmo.humidity ?? deviceNetatmo.dashboard_data?.Humidity,
    min_temp: (deviceNetatmo) => deviceNetatmo.dashboard_data?.min_temp,
    max_temp: (deviceNetatmo) => deviceNetatmo.dashboard_data?.max_temp,
    rf_strength: (deviceNetatmo) =>
      deviceNetatmo.rf_strength ?? deviceNetatmo.dashboard_data?.rf_status,
  },
  [SUPPORTED_MODULE_TYPE.NAMODULE2]: {
    battery_percent: (deviceNetatmo) => deviceNetatmo.battery_percent,
    wind_strength: (deviceNetatmo) =>
      deviceNetatmo.wind_strength ?? deviceNetatmo.dashboard_data?.WindStrength,
    wind_angle: (deviceNetatmo) =>
      deviceNetatmo.wind_angle ?? deviceNetatmo.dashboard_data?.WindAngle,
    wind_gust: (deviceNetatmo) =>
      deviceNetatmo.wind_gust ?? deviceNetatmo.dashboard_data?.GustStrength,
    wind_gust_angle: (deviceNetatmo) =>
      deviceNetatmo.wind_gust_angle ?? deviceNetatmo.dashboard_data?.GustAngle,
    max_wind_str: (deviceNetatmo) => deviceNetatmo.dashboard_data?.max_wind_str,
    max_wind_angle: (deviceNetatmo) => deviceNetatmo.dashboard_data?.max_wind_angle,
    rf_strength: (deviceNetatmo) =>
      deviceNetatmo.rf_strength ?? deviceNetatmo.dashboard_data?.rf_status,
  },
  [SUPPORTED_MODULE_TYPE.NAMODULE3]: {
    battery_percent: (deviceNetatmo) => deviceNetatmo.battery_percent,
    rain: (deviceNetatmo) => deviceNetatmo.rain ?? deviceNetatmo.dashboard_data?.Rain,
    sum_rain_1: (deviceNetatmo) =>
      deviceNetatmo.sum_rain_1 ?? deviceNetatmo.dashboard_data?.sum_rain_1,
    sum_rain_24: (deviceNetatmo) =>
      deviceNetatmo.sum_rain_24 ?? deviceNetatmo.dashboard_data?.sum_rain_24,
    rf_strength: (deviceNetatmo) =>
      deviceNetatmo.rf_strength ?? deviceNetatmo.dashboard_data?.rf_status,
  },
  [SUPPORTED_MODULE_TYPE.NACAMERA]: {
    monitoring: (deviceNetatmo) =>
      deviceNetatmo.monitoring === undefined || deviceNetatmo.monitoring === null
        ? undefined
        : deviceNetatmo.monitoring === 'on',
    wifi_strength: (deviceNetatmo) => deviceNetatmo.wifi_strength ?? deviceNetatmo.wifi_status,
  },
  [SUPPORTED_MODULE_TYPE.NOC]: {
    monitoring: (deviceNetatmo) =>
      deviceNetatmo.monitoring === undefined || deviceNetatmo.monitoring === null
        ? undefined
        : deviceNetatmo.monitoring === 'on',
    wifi_strength: (deviceNetatmo) => deviceNetatmo.wifi_strength ?? deviceNetatmo.wifi_status,
    floodlight: floodlightIs(FLOODLIGHT_MODES.ON),
    floodlight_auto: floodlightIs(FLOODLIGHT_MODES.AUTO),
  },
  // Indoor Camera Advance (issue #55): same homestatus fields as NACamera.
  [SUPPORTED_MODULE_TYPE.NPC]: {
    monitoring: (deviceNetatmo) =>
      deviceNetatmo.monitoring === undefined || deviceNetatmo.monitoring === null
        ? undefined
        : deviceNetatmo.monitoring === 'on',
    wifi_strength: (deviceNetatmo) => deviceNetatmo.wifi_strength ?? deviceNetatmo.wifi_status,
  },
  // Video doorbell (issue #35): only the wifi quality is pollable — the ring
  // is webhook-driven (`incoming_call`).
  [SUPPORTED_MODULE_TYPE.NDB]: {
    wifi_strength: (deviceNetatmo) => deviceNetatmo.wifi_strength ?? deviceNetatmo.wifi_status,
  },
  // Camera-bridged door/window tag (issue #9). Homestatus `status` is a string:
  // "open"/"closed" (other values — "no_news"/"calibrating"/"undefined" — mean
  // "no reliable state", skipped). Battery is a percent or the string state.
  [SUPPORTED_MODULE_TYPE.NACAMDOORTAG]: {
    opening: doorTagOpening,
    battery_percent: (deviceNetatmo) =>
      deviceNetatmo.battery_percent ?? deviceNetatmo.battery_state,
    rf_strength: (deviceNetatmo) => deviceNetatmo.rf_strength,
  },
  // Camera-bridged indoor siren (issue #9), read-only for now. Homestatus
  // `status`: "no_sound" (idle) vs a sounding state; unknown → skip.
  [SUPPORTED_MODULE_TYPE.NIS]: {
    siren: (deviceNetatmo) => {
      if (deviceNetatmo.status === undefined || deviceNetatmo.status === null) return undefined;
      if (deviceNetatmo.status === 'no_sound') return false;
      return ['sound', 'playing', 'warning', 'alarm'].includes(deviceNetatmo.status)
        ? true
        : undefined;
    },
    battery_percent: (deviceNetatmo) =>
      deviceNetatmo.battery_percent ?? deviceNetatmo.battery_state,
    rf_strength: (deviceNetatmo) => deviceNetatmo.rf_strength,
  },
  // Smart smoke alarm (issue #9): only battery + signal are pollable — emitted
  // only when the homestatus payload carries them. Smoke state is webhook-driven
  // (issue #5). Field names to confirm on a real NSD payload.
  [SUPPORTED_MODULE_TYPE.NSD]: {
    battery_percent: (deviceNetatmo) =>
      deviceNetatmo.battery_percent ?? deviceNetatmo.battery_state,
    wifi_strength: (deviceNetatmo) => deviceNetatmo.wifi_strength ?? deviceNetatmo.wifi_status,
  },
  // Carbon monoxide alarm (issue #36), same table as the smoke alarm: battery +
  // signal emitted only when homestatus carries them, CO state webhook-driven.
  // Field names to confirm on a real NCO payload.
  [SUPPORTED_MODULE_TYPE.NCO]: {
    battery_percent: (deviceNetatmo) =>
      deviceNetatmo.battery_percent ?? deviceNetatmo.battery_state,
    wifi_strength: (deviceNetatmo) => deviceNetatmo.wifi_strength ?? deviceNetatmo.wifi_status,
  },
  [SUPPORTED_MODULE_TYPE.NBR]: SHUTTER_MAPPING,
  [SUPPORTED_MODULE_TYPE.NBO]: SHUTTER_MAPPING,
  [SUPPORTED_MODULE_TYPE.NBS]: SHUTTER_MAPPING,
  [SUPPORTED_MODULE_TYPE.BNCX]: BTICINO_MAPPING,
  [SUPPORTED_MODULE_TYPE.BNEU]: BTICINO_MAPPING,
  [SUPPORTED_MODULE_TYPE.BNDL]: BTICINO_MAPPING,
  [SUPPORTED_MODULE_TYPE.BNSL]: BTICINO_LIGHT_MAPPING,
  [SUPPORTED_MODULE_TYPE.BNCS]: BTICINO_SWITCH_MAPPING,
  [SUPPORTED_MODULE_TYPE.BNXM]: BTICINO_MAPPING,
  [SUPPORTED_MODULE_TYPE.NAMODULE4]: {
    battery_percent: (deviceNetatmo) => deviceNetatmo.battery_percent,
    temperature: (deviceNetatmo) =>
      deviceNetatmo.temperature ?? deviceNetatmo.dashboard_data?.Temperature,
    therm_measured_temperature: (deviceNetatmo) => deviceNetatmo.room?.therm_measured_temperature,
    co2: (deviceNetatmo) => deviceNetatmo.co2 ?? deviceNetatmo.dashboard_data?.CO2,
    humidity: (deviceNetatmo) => deviceNetatmo.humidity ?? deviceNetatmo.dashboard_data?.Humidity,
    min_temp: (deviceNetatmo) => deviceNetatmo.dashboard_data?.min_temp,
    max_temp: (deviceNetatmo) => deviceNetatmo.dashboard_data?.max_temp,
    rf_strength: (deviceNetatmo) =>
      deviceNetatmo.rf_strength ?? deviceNetatmo.dashboard_data?.rf_status,
  },
  // Home Coach / Smart Indoor Air Quality Monitor (issue #37): every value
  // comes from the gethomecoachsdata `dashboard_data`, same suffixes as the
  // weather indoor modules, plus the health index (AQI-band value).
  [SUPPORTED_MODULE_TYPE.NHC]: {
    temperature: (deviceNetatmo) => deviceNetatmo.dashboard_data?.Temperature,
    min_temp: (deviceNetatmo) => deviceNetatmo.dashboard_data?.min_temp,
    max_temp: (deviceNetatmo) => deviceNetatmo.dashboard_data?.max_temp,
    co2: (deviceNetatmo) => deviceNetatmo.dashboard_data?.CO2,
    humidity: (deviceNetatmo) => deviceNetatmo.dashboard_data?.Humidity,
    noise: (deviceNetatmo) => deviceNetatmo.dashboard_data?.Noise,
    pressure: (deviceNetatmo) => deviceNetatmo.dashboard_data?.Pressure,
    absolute_pressure: (deviceNetatmo) => deviceNetatmo.dashboard_data?.AbsolutePressure,
    health_idx: (deviceNetatmo) => healthIndexToAqi(deviceNetatmo.dashboard_data?.health_idx),
    health_level: (deviceNetatmo) => healthIndexToLevel(deviceNetatmo.dashboard_data?.health_idx),
    wifi_strength: (deviceNetatmo) => deviceNetatmo.wifi_strength ?? deviceNetatmo.wifi_status,
  },
  [VIRTUAL_DEVICE_TYPE.KNOWN_PERSONS]: knownPersonsMapping,
};
