// -----------------------------------------------------------------------------
// User command → Netatmo (port of the core netatmo.setValue.js).
//
// The only writable feature of this milestone is the thermostat setpoint:
// POST /api/setroomthermpoint with the device's home_id/room_id params and
// mode `manual`. A 403 with the Netatmo error code 13 means the token lacks
// the write scope — surfaced as a clear "reconnect" message.
// -----------------------------------------------------------------------------

import { PARAMS } from './constants.js';
import { writeValues } from './deviceMapping.js';

/** Read a device param value by name. */
export function getDeviceParam(device, name) {
  return (device.params ?? []).find((param) => param.name === name)?.value;
}

/**
 * Apply a user command on a Netatmo device.
 * @param {object} deps `{client}` Netatmo API client
 * @param {object} command `{device, feature, value}` from the SDK
 * @returns {Promise<void>} resolves when Netatmo acknowledged the command
 */
export async function setDeviceValue({ client }, { device, feature, value }) {
  const transform = writeValues[feature.category]?.[feature.type];
  if (!transform) {
    throw new Error(`Feature ${feature.external_id} is not writable`);
  }
  const homeId = getDeviceParam(device, PARAMS.HOME_ID);
  const roomId = getDeviceParam(device, PARAMS.ROOM_ID);
  if (!homeId || !roomId) {
    throw new Error(`Missing ${PARAMS.HOME_ID}/${PARAMS.ROOM_ID} params on ${device.external_id}`);
  }
  try {
    await client.setRoomThermpoint({ homeId, roomId, temp: transform(value) });
  } catch (err) {
    if (err.status === 403 && err.body?.error?.code === 13) {
      // Core behaviour: scope-rights failure gets its own actionable message.
      throw new Error(
        'Netatmo rejected the command (missing scope rights) — please reconnect your Netatmo account',
        { cause: err },
      );
    }
    throw err;
  }
}
