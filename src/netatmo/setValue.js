// -----------------------------------------------------------------------------
// User command → Netatmo (port of the core netatmo.setValue.js).
//
// Three writable features:
//   - thermostat setpoint: POST /api/setroomthermpoint with the device's
//     home_id/room_id params and mode `manual`;
//   - heating mode (thermostat preset, issue #38): POST /api/setthermmode
//     with the home_id param — the mode is the HOME's, so it applies to the
//     whole home; an immediate refresh then republishes it on every device;
//   - camera monitoring: POST /api/setstate (JSON) with the home_id param and
//     the camera module id — no room required (core PR #2623).
// A 403 with the Netatmo error code 13 means the token lacks the write scope
// — surfaced as a clear "reconnect" message.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';

import { PARAMS, SUPPORTED_MODULE_TYPE } from './constants.js';
import { writeValues } from './deviceMapping.js';

const logger = createLogger({ name: 'netatmo-set-value' });

const CAMERA_MODELS = [SUPPORTED_MODULE_TYPE.NACAMERA, SUPPORTED_MODULE_TYPE.NOC];

/** Read a device param value by name. */
export function getDeviceParam(device, name) {
  return (device.params ?? []).find((param) => param.name === name)?.value;
}

/** Rethrow a Netatmo error, a missing write scope with an actionable message. */
export function rethrowScopeError(err) {
  if (err.status === 403 && err.body?.error?.code === 13) {
    // Core behaviour: scope-rights failure gets its own actionable message.
    throw new Error(
      'Netatmo rejected the command (missing scope rights) — please reconnect your Netatmo account',
      { cause: err },
    );
  }
  throw err;
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
 * Apply a user command on a Netatmo device.
 * @param {object} deps `{gladys, client, refresh}` SDK instance, Netatmo API
 * client and an optional immediate-refresh callback (heating mode)
 * @param {object} command `{device, feature, value}` from the SDK
 * @returns {Promise<void>} resolves when Netatmo acknowledged the command
 */
export async function setDeviceValue({ gladys, client, refresh }, { device, feature, value }) {
  const transform = writeValues[feature.category]?.[feature.type];
  const isCameraMonitoring =
    CAMERA_MODELS.includes(device.model) && feature.external_id.endsWith(':monitoring');
  const isThermostatSetpoint = feature.category === DEVICE_FEATURE_CATEGORIES.THERMOSTAT;
  if (!transform || (!isCameraMonitoring && !isThermostatSetpoint)) {
    // Every other feature (boiler status, open window...) is read-only: a
    // command reaching it is a routing error, never something to forward.
    throw new Error(`Feature ${feature.external_id} is not writable`);
  }
  const homeId = getDeviceParam(device, PARAMS.HOME_ID);
  if (!homeId) {
    throw new Error(`Missing ${PARAMS.HOME_ID} param on ${device.external_id}`);
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
    if (refresh) {
      Promise.resolve()
        .then(refresh)
        .catch((err) =>
          logger.warn(`Refresh after the heating mode change failed: ${err.message}`),
        );
    }
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
