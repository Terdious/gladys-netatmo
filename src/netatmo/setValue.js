// -----------------------------------------------------------------------------
// User command → Netatmo (port of the core netatmo.setValue.js).
//
// Writable features:
//   - thermostat setpoint: POST /api/setroomthermpoint with the device's
//     home_id/room_id params and mode `manual`;
//   - heating mode (thermostat preset, issue #38): POST /api/setthermmode
//     with the home_id param — the mode is the HOME's, so it applies to the
//     whole home; an immediate refresh then republishes it on every device;
//   - camera monitoring: POST /api/setstate (JSON) with the home_id param and
//     the camera module id — no room required (core PR #2623);
//   - outdoor camera floodlight (issue #56): POST /api/setstate `floodlight`
//     (on / off / auto), from its light and automatic-mode features, then an
//     immediate refresh so the other of the two features follows;
//   - roller shutter state / position (issue #34): POST /api/setstate with a
//     target_position (100 open, 0 closed, -1 stop, or a percentage) and the
//     iDiamant bridge id (plug_id param), then one delayed refresh so the
//     new position lands without waiting for the next cycle.
// A 403 with the Netatmo error code 13 means the token lacks the write scope
// — surfaced as a clear "reconnect" message.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';

import {
  PARAMS,
  SUPPORTED_MODULE_TYPE,
  FLOODLIGHT_MODES,
  MONITORING_CAMERA_MODULE_TYPES,
  SHUTTER_MODULE_TYPES,
  CONNECTION_MESSAGES,
} from './constants.js';
import { writeValues } from './deviceMapping.js';

const logger = createLogger({ name: 'netatmo-set-value' });

/** Read a device param value by name. */
export function getDeviceParam(device, name) {
  return (device.params ?? []).find((param) => param.name === name)?.value;
}

function isScopeError(err) {
  return err.status === 403 && err.body?.error?.code === 13;
}

/** Rethrow a Netatmo error, a missing write scope with an actionable message. */
export function rethrowScopeError(err) {
  if (isScopeError(err)) {
    // Core behaviour: scope-rights failure gets its own actionable message.
    throw new Error(
      'Netatmo rejected the command (missing scope rights) — please reconnect your Netatmo account',
      { cause: err },
    );
  }
  throw err;
}

const FLOODLIGHT_SUFFIX = 'floodlight';
const FLOODLIGHT_AUTO_SUFFIX = 'floodlight_auto';

/**
 * Floodlight mode to send for a command on one of the two floodlight features
 * (issue #56): the light (`floodlight`: 1 = on) or the automatic mode
 * (`floodlight_auto`: 1 = auto). Turning one of them off only acts when it is
 * the CURRENT mode: a "turn off the lights" scene reaching a floodlight in
 * automatic mode must not disable the automatic lighting, and switching the
 * automatic mode off must not turn off a light forced on. An unknown current
 * mode turns the floodlight off.
 * @param {string} suffix `floodlight` or `floodlight_auto`
 * @param {boolean} on the command: on (1) or off (0)
 * @param {string|undefined} current last homestatus `floodlight` value
 * @returns {string|null} the mode to send, or null when there is nothing to do
 */
export function floodlightModeFor(suffix, on, current) {
  const target = suffix === FLOODLIGHT_AUTO_SUFFIX ? FLOODLIGHT_MODES.AUTO : FLOODLIGHT_MODES.ON;
  if (on) {
    return target;
  }
  const known = Object.values(FLOODLIGHT_MODES).includes(current);
  return !known || current === target ? FLOODLIGHT_MODES.OFF : null;
}

/** Feature suffix (after the device external id), e.g. `floodlight`. */
function suffixOf(device, feature) {
  return feature.external_id.slice(device.external_id.length + 1);
}

/** Run the post-command refresh without awaiting it (a full account load). */
function refreshSoon(refresh, what) {
  if (refresh) {
    Promise.resolve()
      .then(refresh)
      .catch((err) => logger.warn(`Refresh after the ${what} change failed: ${err.message}`));
  }
}

/**
 * Set the heating mode of a home, with the actionable scope message.
 * @param {object} client Netatmo API client
 * @param {string} homeId Netatmo home id
 * @param {string} mode `schedule` | `away` | `hg`
 * @param {number} [endtime] end of an away / frost guard period (UNIX seconds)
 * @returns {Promise<void>} resolves when Netatmo acknowledged the command
 */
export async function setHomeThermMode(client, homeId, mode, endtime) {
  try {
    await client.setThermMode(homeId, mode, endtime);
  } catch (err) {
    rethrowScopeError(err);
  }
}

/**
 * Shutter scope refusal: the token predates the Bubendorff scopes. Besides
 * the failed command, say it on the Configuration screen (in the user's
 * language) — the account stays connected for every other device.
 */
async function rethrowShutterScopeError(gladys, err) {
  if (!isScopeError(err)) {
    throw err;
  }
  try {
    await gladys.setConnectionStatus(true, CONNECTION_MESSAGES.SHUTTER_SCOPE_MISSING);
  } catch (statusErr) {
    logger.debug(`setConnectionStatus skipped (older Gladys core?): ${statusErr.message}`);
  }
  throw new Error(CONNECTION_MESSAGES.SHUTTER_SCOPE_MISSING.en, { cause: err });
}

/**
 * Apply a user command on a Netatmo device.
 * @param {object} deps `{gladys, client, refresh?, scheduleRefresh?,
 * getRawDevice?}` SDK instance, Netatmo API client, the immediate refresh
 * after a heating mode or floodlight change, the delayed refresh to arm after
 * a shutter command and the last raw Netatmo payload of a module (by id)
 * @param {object} command `{device, feature, value}` from the SDK
 * @returns {Promise<void>} resolves when Netatmo acknowledged the command
 */
export async function setDeviceValue(
  { gladys, client, refresh, scheduleRefresh, getRawDevice },
  { device, feature, value },
) {
  const transform = writeValues[feature.category]?.[feature.type];
  const isFloodlight =
    device.model === SUPPORTED_MODULE_TYPE.NOC &&
    [FLOODLIGHT_SUFFIX, FLOODLIGHT_AUTO_SUFFIX].includes(suffixOf(device, feature));
  const isCameraMonitoring =
    MONITORING_CAMERA_MODULE_TYPES.includes(device.model) &&
    feature.external_id.endsWith(':monitoring');
  const isThermostatSetpoint = feature.category === DEVICE_FEATURE_CATEGORIES.THERMOSTAT;
  const isShutter =
    SHUTTER_MODULE_TYPES.includes(device.model) &&
    feature.category === DEVICE_FEATURE_CATEGORIES.SHUTTER;
  if (!transform || (!isCameraMonitoring && !isThermostatSetpoint && !isShutter && !isFloodlight)) {
    // Every other feature (boiler status, open window...) is read-only: a
    // command reaching it is a routing error, never something to forward.
    throw new Error(`Feature ${feature.external_id} is not writable`);
  }
  const homeId = getDeviceParam(device, PARAMS.HOME_ID);
  if (!homeId) {
    throw new Error(`Missing ${PARAMS.HOME_ID} param on ${device.external_id}`);
  }

  // Roller shutter: setstate on the module, routed through its iDiamant
  // bridge (mandatory in the module entry, like pyatmo).
  if (isShutter) {
    const bridgeId = getDeviceParam(device, PARAMS.PLUG_ID);
    if (!bridgeId) {
      throw new Error(`Missing ${PARAMS.PLUG_ID} param on ${device.external_id}`);
    }
    const targetPosition = transform(value);
    const moduleId = device.external_id.replace(gladys.externalId(''), '');
    try {
      await client.setState({
        homeId,
        moduleId,
        target_position: targetPosition,
        bridge: bridgeId,
      });
    } catch (err) {
      await rethrowShutterScopeError(gladys, err);
    }
    scheduleRefresh?.();
    return;
  }

  // Outdoor camera floodlight: setstate on the module itself, then refresh at
  // once so the other floodlight feature follows the new mode.
  if (isFloodlight) {
    const moduleId = device.external_id.replace(gladys.externalId(''), '');
    const rawDevice = getRawDevice?.(moduleId);
    const current = rawDevice?.floodlight;
    const on = value === true || Number(value) === 1;
    const floodlight = floodlightModeFor(suffixOf(device, feature), on, current);
    if (!floodlight) {
      logger.debug(`Floodlight of ${moduleId} already "${current}": nothing to send`);
      return;
    }
    try {
      await client.setState({ homeId, moduleId, floodlight });
    } catch (err) {
      rethrowScopeError(err);
    }
    // Netatmo acked: the next command (a quick on -> off) must see the new
    // mode before the refresh lands. The refresh replaces this payload anyway.
    if (rawDevice) {
      rawDevice.floodlight = floodlight;
    }
    refreshSoon(refresh, 'floodlight');
    return;
  }

  // Camera monitoring: setstate on the module itself, no room involved.
  if (isCameraMonitoring) {
    // `ext:<selector>:<netatmo id>` -> `<netatmo id>` (MAC with colons).
    const moduleId = device.external_id.replace(gladys.externalId(''), '');
    try {
      await client.setState({ homeId, moduleId, monitoring: transform(value) });
    } catch (err) {
      rethrowScopeError(err);
    }
    return;
  }

  // Heating mode: the home's, no room involved. The command acks right away;
  // the refresh (not awaited: it costs a full account load) republishes the
  // new mode on every thermostat and valve of the home.
  if (feature.type === DEVICE_FEATURE_TYPES.THERMOSTAT.PRESET) {
    await setHomeThermMode(client, homeId, transform(value));
    refreshSoon(refresh, 'heating mode');
    return;
  }

  const roomId = getDeviceParam(device, PARAMS.ROOM_ID);
  if (!roomId) {
    throw new Error(`Missing ${PARAMS.ROOM_ID} param on ${device.external_id}`);
  }
  try {
    await client.setRoomThermpoint({ homeId, roomId, temp: transform(value) });
  } catch (err) {
    rethrowScopeError(err);
  }
}
