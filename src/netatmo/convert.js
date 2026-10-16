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

import {
  createLogger,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

import {
  SUPPORTED_MODULE_TYPE,
  CAMERA_MODULE_TYPES,
  HLS_CAMERA_MODULE_TYPES,
  SHUTTER_MODULE_TYPES,
  VIRTUAL_DEVICE_TYPE,
  PARAMS,
} from './constants.js';
import { netatmoId } from './discovery.js';
import {
  buildFeatureBattery,
  buildFeatureRfStrength,
  buildFeatureWifiStrength,
  buildFeatureTemperature,
  buildFeatureThermSetpointTemperature,
  buildFeatureThermPreset,
  buildFeatureBoilerStatus,
  buildFeatureBoilerFault,
  buildFeatureCoolerStatus,
  buildFeatureComfortBoost,
  buildFeatureHeatingPowerRequest,
  buildFeaturePlugConnectedBoiler,
  buildFeatureOpenWindow,
  buildFeatureOpeningSensor,
  buildFeatureSiren,
  buildFeatureMotion,
  buildFeatureHuman,
  buildFeatureAnimal,
  buildFeatureVehicle,
  buildFeatureSmoke,
  buildFeatureCarbonMonoxide,
  buildFeatureMonitoring,
  buildFeatureCamera,
  buildFeatureDoorbellRing,
  buildFeatureCo2,
  buildFeatureHumidity,
  buildFeatureNoise,
  buildFeaturePressure,
  buildFeatureWindStrength,
  buildFeatureWindAngle,
  buildFeatureRain,
  buildFeatureShutterState,
  buildFeatureShutterPosition,
  buildFeatureHealthIndex,
  buildFeatureHealthLevel,
  buildFeaturePersonPresence,
} from './features.js';

const logger = createLogger({ name: 'netatmo-convert' });

const BATTERY_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.THERMOSTAT,
  SUPPORTED_MODULE_TYPE.NRV,
  SUPPORTED_MODULE_TYPE.NAMODULE1,
  SUPPORTED_MODULE_TYPE.NAMODULE2,
  SUPPORTED_MODULE_TYPE.NAMODULE3,
  SUPPORTED_MODULE_TYPE.NAMODULE4,
  // Camera-bridged security accessories carry battery + RF, like the modules
  // above; their "plug" is the bridging camera (issue #9).
  SUPPORTED_MODULE_TYPE.NACAMDOORTAG,
  SUPPORTED_MODULE_TYPE.NIS,
  // Modulating thermostat (issue #53): radio module bridged by its OTH relay.
  SUPPORTED_MODULE_TYPE.OTM,
];

const BRIDGE_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.PLUG,
  SUPPORTED_MODULE_TYPE.NAMAIN,
  // OpenTherm relay (issue #53): wifi bridge of the OTM thermostat.
  SUPPORTED_MODULE_TYPE.OTH,
];

/** plug_id / plug_name params of a bridged module (its bridge = "plug"). */
function bridgeParams(plug) {
  const plugId = netatmoId(plug ?? {});
  if (!plugId) {
    return [];
  }
  return [
    { name: PARAMS.PLUG_ID, value: plugId },
    { name: PARAMS.PLUG_NAME, value: plug.name || plug.module_name || plug.station_name },
  ];
}

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
 * Append the heating mode feature (issue #38) — only when the device belongs
 * to a homesdata home: setthermmode needs the home id, and a legacy-only
 * thermostat has none.
 */
function pushThermPreset(features, homeId, nameDevice, externalId) {
  if (homeId) {
    features.push(buildFeatureThermPreset(nameDevice, externalId));
  }
}

/**
 * Convert one raw Netatmo device to a Gladys discovery payload.
 * @param {object} gladys SDK instance (external_id builder)
 * @param {object} netatmoDevice raw device from loadDevices()
 * @param {Map<string, {liveUrl: string, quality: string}>} [cameraEnrichments]
 * per-camera live stream data (id → CAMERA_URL/camera_quality params)
 * @returns {object|null} Gladys device payload, or null when not supported
 */
export function convertDevice(gladys, netatmoDevice, cameraEnrichments) {
  const { home, name, type: model, room = {}, plug = {} } = netatmoDevice;
  const id = netatmoId(netatmoDevice);
  const homeId = home || netatmoDevice.home_id;
  // A module present in homestatus but missing from homesdata has no name:
  // fall back to its id rather than shipping the string "undefined".
  // A Home Coach carries a generic `module_name` ("Indoor") next to the name
  // the user gave it (`station_name`, e.g. "Bedroom"): the latter wins.
  const homeCoachName =
    model === SUPPORTED_MODULE_TYPE.NHC ? netatmoDevice.station_name : undefined;
  const nameDevice =
    name || homeCoachName || netatmoDevice.module_name || netatmoDevice.station_name || id;
  if (netatmoDevice.not_handled || !id) {
    logger.debug(`Skipping unsupported Netatmo device "${nameDevice ?? id}" (${model})`);
    return null;
  }
  // Legacy-only thermostats (getthermostatsdata without a homesdata home)
  // carry no home_id: setroomthermpoint cannot work — expose the setpoint
  // read-only instead of publishing a command doomed to fail.
  const setpointWritable = Boolean(homeId && room.id);
  if (netatmoDevice.apiNotConfigured) {
    // The API covering this module is disabled in the configuration (e.g.
    // cameras with security_api off): the device stays out of the discovery.
    logger.debug(`Skipping Netatmo device "${nameDevice}" (${model}): its API is disabled`);
    return null;
  }
  const externalId = gladys.externalId(id);
  const features = [];
  let params = [];
  // Display name of the room in the room-scoped feature names ("Minimum in
  // …", "Temperature - room …"): the device name when the module has no
  // (named) room, never the string "undefined". External ids are untouched.
  let roomName = nameDevice;

  if (BATTERY_MODULE_TYPES.includes(model)) {
    features.push(
      buildFeatureBattery(nameDevice, externalId),
      buildFeatureRfStrength(nameDevice, externalId),
    );
    params = bridgeParams(plug);
  }
  if (SHUTTER_MODULE_TYPES.includes(model)) {
    // Roller shutter (issue #34): its "plug" is the iDiamant gateway (NBG),
    // whose id must ride along with every /api/setstate command.
    features.push(
      buildFeatureShutterState(nameDevice, externalId),
      buildFeatureShutterPosition(nameDevice, externalId),
      buildFeatureRfStrength(nameDevice, externalId),
    );
    params = bridgeParams(netatmoId(plug ?? {}) ? plug : { id: netatmoDevice.bridge });
  }
  if (BRIDGE_MODULE_TYPES.includes(model) || CAMERA_MODULE_TYPES.includes(model)) {
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
    roomName = room.name || nameDevice;
    params.push(
      { name: PARAMS.ROOM_ID, value: room.id },
      { name: PARAMS.ROOM_NAME, value: room.name },
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
        buildFeatureThermSetpointTemperature(nameDevice, externalId, {
          writable: setpointWritable,
        }),
        buildFeatureOpenWindow(nameDevice, externalId),
        buildFeatureBoilerStatus(nameDevice, externalId),
      );
      pushThermPreset(features, homeId, nameDevice, externalId);
      break;
    case SUPPORTED_MODULE_TYPE.PLUG:
      features.push(buildFeaturePlugConnectedBoiler(nameDevice, externalId));
      break;
    case SUPPORTED_MODULE_TYPE.OTM:
      // Modulating / OpenTherm thermostat (issue #53): battery + RF built
      // above; the room carries the measured temperature and the setpoint
      // (setroomthermpoint), the home the heating mode, like the NATherm1.
      if (room.id) {
        features.push(
          buildFeatureTemperature(`room ${roomName}`, externalId, 'therm_measured_temperature'),
        );
      }
      features.push(
        buildFeatureThermSetpointTemperature(nameDevice, externalId, {
          writable: setpointWritable,
        }),
        buildFeatureBoilerStatus(nameDevice, externalId),
      );
      pushThermPreset(features, homeId, nameDevice, externalId);
      break;
    case SUPPORTED_MODULE_TYPE.BNS:
      // BTicino Smarther with Netatmo (issue #54): a wifi thermostat of its
      // own (no relay, no battery); room temperature, setpoint and heating
      // mode like the NATherm1, plus its heating / cooling states.
      features.push(buildFeatureWifiStrength(nameDevice, externalId));
      if (room.id) {
        features.push(
          buildFeatureTemperature(`room ${roomName}`, externalId, 'therm_measured_temperature'),
        );
      }
      features.push(
        buildFeatureThermSetpointTemperature(nameDevice, externalId, {
          writable: setpointWritable,
        }),
        buildFeatureBoilerStatus(nameDevice, externalId),
        buildFeatureCoolerStatus(nameDevice, externalId),
        buildFeatureComfortBoost(nameDevice, externalId),
      );
      pushThermPreset(features, homeId, nameDevice, externalId);
      break;
    case SUPPORTED_MODULE_TYPE.OTH:
      // OpenTherm relay (issue #53): WiFi quality built above, plus the
      // outdoor temperature it modulates on and the boiler fault.
      features.push(
        buildFeatureTemperature(`outdoor ${nameDevice}`, externalId, 'outdoor_temperature'),
        buildFeatureBoilerFault(nameDevice, externalId),
      );
      break;
    case SUPPORTED_MODULE_TYPE.NRV:
      if (room.id) {
        features.push(
          buildFeatureTemperature(`room ${roomName}`, externalId, 'therm_measured_temperature'),
        );
      }
      features.push(
        buildFeatureThermSetpointTemperature(nameDevice, externalId, {
          writable: setpointWritable,
        }),
        buildFeatureOpenWindow(nameDevice, externalId),
        buildFeatureHeatingPowerRequest(nameDevice, externalId),
      );
      pushThermPreset(features, homeId, nameDevice, externalId);
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
    case SUPPORTED_MODULE_TYPE.NACAMDOORTAG:
      features.push(buildFeatureOpeningSensor(nameDevice, externalId));
      break;
    case SUPPORTED_MODULE_TYPE.NIS:
      features.push(buildFeatureSiren(nameDevice, externalId));
      break;
    case SUPPORTED_MODULE_TYPE.NSD:
      // Smoke alarm: battery + signal are pollable, the SMOKE state only
      // exists in the webhook event stream (issue #5).
      features.push(
        buildFeatureBattery(nameDevice, externalId),
        buildFeatureWifiStrength(nameDevice, externalId),
        buildFeatureSmoke(nameDevice, externalId),
      );
      break;
    case SUPPORTED_MODULE_TYPE.NCO:
      // Carbon monoxide alarm (issue #36), modelled on the smoke alarm:
      // battery + signal are pollable when homestatus carries them, the CO
      // state only exists in the webhook event stream (`co_detected`).
      features.push(
        buildFeatureBattery(nameDevice, externalId),
        buildFeatureWifiStrength(nameDevice, externalId),
        buildFeatureCarbonMonoxide(nameDevice, externalId),
      );
      break;
    case SUPPORTED_MODULE_TYPE.NDB:
      // Video doorbell (issue #35): dashboard image (VPN snapshot) + the ring,
      // fed by the webhook event stream. No monitoring switch (the API offers
      // none for the doorbell) and no CAMERA_URL: it streams over WebRTC only,
      // which the core rtsp-camera service cannot play.
      features.push(
        buildFeatureCamera(nameDevice, externalId),
        buildFeatureDoorbellRing(nameDevice, externalId),
      );
      break;
    case SUPPORTED_MODULE_TYPE.NACAMERA:
    case SUPPORTED_MODULE_TYPE.NOC:
    case SUPPORTED_MODULE_TYPE.NPC: {
      // The Indoor Camera Advance (issue #55) gets the NACamera feature set.
      // It streams over WebRTC only: no live-stream params (HLS only, below).
      features.push(buildFeatureMonitoring(nameDevice, externalId));
      features.push(buildFeatureCamera(nameDevice, externalId));
      // Momentary detections, fed by the webhook event stream (issue #5) —
      // this is what makes "camera detects motion -> scene" possible.
      features.push(
        buildFeatureMotion(nameDevice, externalId),
        buildFeatureHuman(nameDevice, externalId),
      );
      if (model === SUPPORTED_MODULE_TYPE.NOC) {
        // The outdoor Presence classifies what it sees.
        features.push(
          buildFeatureAnimal(nameDevice, externalId),
          buildFeatureVehicle(nameDevice, externalId),
        );
      }
      // Live stream (core PR #2625): the rtsp-camera service reads CAMERA_URL.
      // The framework silently upserts the params of an already-created device
      // on every discovery re-publish, so refreshing the URL is just
      // re-publishing. camera_quality carries the CURRENT device value so the
      // upsert never overwrites a user edit.
      const enrichment = HLS_CAMERA_MODULE_TYPES.includes(model)
        ? cameraEnrichments?.get(id)
        : undefined;
      if (enrichment) {
        params.push(
          { name: PARAMS.CAMERA_URL, value: enrichment.liveUrl },
          { name: PARAMS.CAMERA_QUALITY, value: enrichment.quality },
        );
      }
      break;
    }
    case SUPPORTED_MODULE_TYPE.NBR:
    case SUPPORTED_MODULE_TYPE.NBO:
    case SUPPORTED_MODULE_TYPE.NBS:
      // Features built above (state, position, RF quality).
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
    case SUPPORTED_MODULE_TYPE.NHC:
      // Home Coach / Smart Indoor Air Quality Monitor (issue #37): standalone
      // wifi device, same measures (and suffixes) as the weather indoor
      // modules, plus the health index.
      features.push(
        buildFeatureWifiStrength(nameDevice, externalId),
        buildFeatureTemperature(nameDevice, externalId, 'temperature'),
      );
      pushMinMaxTemp(features, nameDevice, externalId);
      features.push(
        buildFeatureCo2(nameDevice, externalId),
        buildFeatureHumidity(nameDevice, externalId),
        buildFeatureNoise(nameDevice, externalId),
        buildFeaturePressure(`Pressure - ${nameDevice}`, externalId, 'pressure'),
        buildFeaturePressure(`Absolute pressure - ${nameDevice}`, externalId, 'absolute_pressure'),
        buildFeatureHealthIndex(nameDevice, externalId),
        buildFeatureHealthLevel(nameDevice, externalId),
      );
      break;
    case VIRTUAL_DEVICE_TYPE.KNOWN_PERSONS:
      // Known persons of a home (issue #57): one presence feature per named
      // person, keyed by the Netatmo person id (a rename only changes the
      // feature name).
      features.push(
        ...(netatmoDevice.persons ?? []).map((person) =>
          buildFeaturePersonPresence(person.pseudo, externalId, person.id),
        ),
      );
      break;
    default:
      logger.debug(`Skipping unsupported Netatmo device "${nameDevice}" (${model})`);
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
