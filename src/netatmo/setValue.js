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
//     new position lands without waiting for the next cycle;
//   - room thermostat mode (issue #77): POST /api/setroomthermpoint mode
//     `off` (OFF) or `home` (HEATING, back to the room's schedule), skipped
//     when the room is already in that mode; a setpoint reaching a room that
//     is off is not sent (a `manual` setpoint would switch the room back on);
//   - BTicino staircase / outdoor light (BNSL, issue #59): POST /api/setstate
//     `on` through its bridge (the BNCX door entry). Netatmo never reports
//     the light state back: the commanded value is published once Netatmo
//     acknowledged it (optimistic), a module error in the answer fails the
//     command instead;
//   - Legrand Home + Control light / dimmer / plug / relay (issue #60): POST
//     /api/setstate `on` or `brightness` through the Legrand gateway (plug_id
//     param), like pyatmo. Netatmo reports the state back in homestatus: the
//     commanded value is remembered (dedup) and ONE refresh shortly after
//     publishes what Netatmo reports — a module error in the answer fails the
//     command.
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
  BTICINO_MODULE_TYPES,
  BTICINO_GATEWAY_TYPES,
  BTICINO_LIGHT_SUFFIX,
  LEGRAND_MODULE_TYPES,
  LEGRAND_ON_SUFFIX,
  LEGRAND_BRIGHTNESS_SUFFIX,
  LEGRAND_REFRESH_DELAY_MS,
  CONNECTION_MESSAGES,
  NETATMO_SETPOINT_MODES,
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
 * Scope refusal of a family added after the first connection (shutters,
 * BTicino door entry): the token predates its scopes. Besides the failed
 * command, say it on the Configuration screen (in the user's language) — the
 * account stays connected for every other device.
 * @param {object} gladys SDK instance
 * @param {Error} err the Netatmo error
 * @param {object} message multi-language message (CONNECTION_MESSAGES)
 */
async function rethrowFamilyScopeError(gladys, err, message) {
  if (!isScopeError(err)) {
    throw err;
  }
  try {
    await gladys.setConnectionStatus(true, message);
  } catch (statusErr) {
    logger.debug(`setConnectionStatus skipped (older Gladys core?): ${statusErr.message}`);
  }
  throw new Error(message.en, { cause: err });
}

/**
 * Netatmo id of the module a feature belongs to: `ext:<selector>:<id>:<suffix>`
 * → `<id>` (a MAC keeps its colons). The features of a BTicino door entry
 * carry the id of their own module, not the device's (issue #59).
 */
function moduleIdOfFeature(gladys, feature, suffix) {
  const prefix = gladys.externalId('');
  const end = feature.external_id.length - suffix.length - 1;
  return feature.external_id.startsWith(prefix) && end > prefix.length
    ? feature.external_id.slice(prefix.length, end)
    : undefined;
}

/**
 * Module errors of a /api/setstate answer that Netatmo acknowledged with
 * HTTP 200 (`body.errors: [{code, id}]`, e.g. code 6 for a bridge that did
 * not relay the command): the command did not happen.
 */
function setStateErrorsOf(answer) {
  const errors = answer?.body?.errors ?? answer?.errors;
  return Array.isArray(errors) ? errors.filter(Boolean) : [];
}

/**
 * Switch the BTicino staircase / outdoor light (issue #59): /api/setstate
 * `{id, on, bridge}` (pyatmo SwitchMixin), then publish the commanded value —
 * Netatmo never reports this state back.
 */
async function setBticinoLight({ gladys, client }, { device, feature, value }, homeId) {
  const moduleId = moduleIdOfFeature(gladys, feature, BTICINO_LIGHT_SUFFIX);
  if (!moduleId) {
    throw new Error(`Cannot read the module of ${feature.external_id}`);
  }
  const deviceId = device.external_id.replace(gladys.externalId(''), '');
  let bridge;
  if (BTICINO_GATEWAY_TYPES.includes(device.model)) {
    // One device per door entry: the light rides on its gateway's device,
    // and must be one of the modules it bridges.
    bridge = deviceId;
    const bridged = getDeviceParam(device, PARAMS.MODULES_BRIDGE_ID);
    let bridgedIds;
    try {
      bridgedIds = bridged ? JSON.parse(bridged) : null;
    } catch {
      bridgedIds = null;
    }
    if (Array.isArray(bridgedIds) && !bridgedIds.includes(moduleId)) {
      throw new Error(`Module ${moduleId} is not bridged by ${device.external_id}`);
    }
  } else {
    bridge = getDeviceParam(device, PARAMS.PLUG_ID);
  }
  if (!bridge) {
    throw new Error(`Missing ${PARAMS.PLUG_ID} param on ${device.external_id}`);
  }
  const on = value === true || Number(value) === 1;
  let answer;
  try {
    answer = await client.setState({ homeId, moduleId, on, bridge });
  } catch (err) {
    await rethrowFamilyScopeError(gladys, err, CONNECTION_MESSAGES.BTICINO_SCOPE_MISSING);
  }
  const errors = setStateErrorsOf(answer);
  if (errors.length > 0) {
    throw new Error(
      `Netatmo did not switch the light ${moduleId}: ${errors
        .map((error) => `error ${error.code} on ${error.id}`)
        .join(', ')}`,
    );
  }
  try {
    await gladys.publishStates([
      { device_feature_external_id: feature.external_id, state: on ? 1 : 0 },
    ]);
  } catch (err) {
    logger.warn(`Publishing the light state of ${moduleId} failed: ${err.message}`);
  }
}

/**
 * Switch a room off or back on (issue #77, the `thermostat/mode` feature of
 * the room): setroomthermpoint `off`, or `home` — the room follows its
 * schedule again, and the Gladys Thermostat service then writes its own
 * setpoint (a `manual` one). Nothing is sent when the room is already in the
 * requested mode (any mode but `off` is "heating"): the Thermostat service may
 * write the mode on every pass. No refresh: the setpoint the room's schedule
 * gives could be read before the setpoint Gladys sends right after, and look
 * like a change made on the thermostat; the next cycle reports the new mode.
 */
async function setRoomMode(
  { client, patchRoom },
  { homeId, roomId, room, setpointMode, externalId },
) {
  const current = room?.therm_setpoint_mode;
  const isOff = (mode) => mode === NETATMO_SETPOINT_MODES.OFF;
  if (typeof current === 'string' && current !== '' && isOff(current) === isOff(setpointMode)) {
    logger.debug(`Room ${roomId} already "${current}": nothing to send for ${externalId}`);
    return;
  }
  try {
    await client.setRoomThermpoint({ homeId, roomId, mode: setpointMode });
  } catch (err) {
    rethrowScopeError(err);
  }
  // Netatmo acked: the commands that follow (the setpoint the Thermostat
  // service writes right after) must see the new mode before the next load.
  patchRoom?.(homeId, roomId, { therm_setpoint_mode: setpointMode });
}

/**
 * Command a Legrand module (issue #60): /api/setstate `{id, on, bridge}` or
 * `{id, brightness, bridge}` (pyatmo SwitchMixin / DimmableMixin), the bridge
 * being its Legrand gateway (plug_id param; left out for a module that has
 * none). Netatmo reports the new state in homestatus: the commanded value is
 * remembered by the telemetry dedup — Gladys saved it already — and one
 * refresh shortly after publishes what Netatmo actually reports.
 */
async function setLegrandModule(
  { gladys, client, scheduleRefresh, rememberState },
  { device, feature, value },
  homeId,
  transform,
) {
  const moduleId = device.external_id.replace(gladys.externalId(''), '');
  const bridge = getDeviceParam(device, PARAMS.PLUG_ID);
  const suffix = suffixOf(device, feature);
  let fields;
  let state;
  if (suffix === LEGRAND_BRIGHTNESS_SUFFIX) {
    state = transform(value);
    fields = { brightness: state };
  } else {
    const on = value === true || Number(value) === 1;
    state = on ? 1 : 0;
    fields = { on };
  }
  let answer;
  try {
    answer = await client.setState({ homeId, moduleId, ...fields, ...(bridge ? { bridge } : {}) });
  } catch (err) {
    await rethrowFamilyScopeError(gladys, err, CONNECTION_MESSAGES.LEGRAND_SCOPE_MISSING);
  }
  const errors = setStateErrorsOf(answer);
  if (errors.length > 0) {
    throw new Error(
      `Netatmo did not apply the command to ${moduleId}: ${errors
        .map((error) => `error ${error.code} on ${error.id}`)
        .join(', ')}`,
    );
  }
  rememberState?.(feature.external_id, state);
  scheduleRefresh?.(LEGRAND_REFRESH_DELAY_MS, 'legrand');
}

/**
 * Apply a user command on a Netatmo device.
 * @param {object} deps `{gladys, client, refresh?, scheduleRefresh?,
 * getRawDevice?, patchRoom?, rememberState?, awaitSetpoint?}` SDK instance, Netatmo API
 * client, the immediate refresh after a heating mode or floodlight change, the
 * delayed refresh to arm after a shutter or Legrand command
 * (`(delayMs?, key?)`), the last raw Netatmo payload of a module (by id), the
 * patch of a room's last payload after a room mode command and the telemetry
 * dedup update after a Legrand command (`(featureExternalId, state)`), and
 * the re-reads until Netatmo reports a sent room setpoint
 * (`(featureExternalId, state)`)
 * @param {object} command `{device, feature, value}` from the SDK
 * @returns {Promise<void>} resolves when Netatmo acknowledged the command
 */
export async function setDeviceValue(
  {
    gladys,
    client,
    refresh,
    scheduleRefresh,
    getRawDevice,
    patchRoom,
    rememberState,
    awaitSetpoint,
  },
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
  const isBticinoLight =
    BTICINO_MODULE_TYPES.includes(device.model) &&
    feature.category === DEVICE_FEATURE_CATEGORIES.LIGHT &&
    feature.external_id.endsWith(`:${BTICINO_LIGHT_SUFFIX}`);
  const isLegrand =
    LEGRAND_MODULE_TYPES.includes(device.model) &&
    [DEVICE_FEATURE_CATEGORIES.LIGHT, DEVICE_FEATURE_CATEGORIES.SWITCH].includes(
      feature.category,
    ) &&
    [LEGRAND_ON_SUFFIX, LEGRAND_BRIGHTNESS_SUFFIX].includes(suffixOf(device, feature));
  if (
    !transform ||
    (!isCameraMonitoring &&
      !isThermostatSetpoint &&
      !isShutter &&
      !isFloodlight &&
      !isBticinoLight &&
      !isLegrand)
  ) {
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
      await rethrowFamilyScopeError(gladys, err, CONNECTION_MESSAGES.SHUTTER_SCOPE_MISSING);
    }
    scheduleRefresh?.();
    return;
  }

  // BTicino staircase / outdoor light: setstate through the door entry bridge.
  if (isBticinoLight) {
    await setBticinoLight({ gladys, client }, { device, feature, value }, homeId);
    return;
  }

  // Legrand light / dimmer / plug / relay: setstate through its gateway.
  if (isLegrand) {
    await setLegrandModule(
      { gladys, client, scheduleRefresh, rememberState },
      { device, feature, value },
      homeId,
      transform,
    );
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
  const room = getRawDevice
    ? getRawDevice(device.external_id.replace(gladys.externalId(''), ''))?.room
    : undefined;

  // Room thermostat mode (issue #77): off, or back to the room's schedule.
  if (feature.type === DEVICE_FEATURE_TYPES.THERMOSTAT.MODE) {
    const setpointMode = transform(value);
    await setRoomMode(
      { client, patchRoom },
      { homeId, roomId, room, setpointMode, externalId: feature.external_id },
    );
    return;
  }

  // A `manual` setpoint switches an off room back on. The Gladys Thermostat
  // service stops a room with OFF then its frost protection setpoint, and
  // starts it with HEATING before the setpoint (Gladys spec thermostat.md
  // C.0): the setpoint reaching an off room is the one of a stop, and must
  // leave the room off. Like a Matter or Zigbee thermostat, the mode decides.
  if (room?.therm_setpoint_mode === NETATMO_SETPOINT_MODES.OFF) {
    logger.info(
      `Room ${roomId} is off: setpoint ${value} not sent (switch the room back on with its thermostat mode)`,
    );
    return;
  }
  try {
    await client.setRoomThermpoint({ homeId, roomId, temp: transform(value) });
  } catch (err) {
    rethrowScopeError(err);
  }
  awaitSetpoint?.(feature.external_id, Number(transform(value)));
}
