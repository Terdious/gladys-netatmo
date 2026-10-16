// -----------------------------------------------------------------------------
// WebRTC live view of the video doorbell (NDB) and the Indoor Camera Advance
// (NPC), issue #70.
//
// These two cameras stream ONLY in WebRTC through the Netatmo cloud: no HLS,
// no RTSP, nothing on the LAN. Gladys (core PR GladysAssistant/Gladys#3215)
// negotiates the stream in the browser and relays the SDP offer / answer to
// the integration (SDK GladysAssistant/integration-sdk-js#43):
//   - discovery: the camera carries the reserved device param
//     GLADYS_CAMERA_STREAM_PROTOCOL = webrtc;
//   - onCameraWebRtcOffer(device, { sessionId, sdp }): POST /api/webrtc/offer,
//     resolve { sdpAnswer, sessionId, streamId } (streamId = Netatmo tag_id);
//   - onCameraWebRtcStop(device, { sessionId, streamId }): POST
//     /api/webrtc/terminate.
// The media flows from the Netatmo cloud to the browser, never through the
// integration.
//
// Feature detection, so the integration stays inert where this is not
// available yet:
//   - SDK without the two handlers (the released 0.15): nothing registered,
//     no param published — the dashboard keeps the still image;
//   - Gladys core without the relay: it rejects any unknown GLADYS_* param
//     with a 400 on the WHOLE discovery publish. The telemetry then publishes
//     again without the param and stops sending it until the next connection
//     (see `discoveryParam` / `rejectedByCore`).
//
// The SDP never reaches the logs: it carries the public IP addresses of the
// browser (ICE candidates).
// -----------------------------------------------------------------------------

import sdk, { createLogger } from '@gladysassistant/integration-sdk';

import { PARAMS, WEBRTC_CAMERA_MODULE_TYPES } from './constants.js';
import { rethrowScopeError } from './setValue.js';

const logger = createLogger({ name: 'netatmo-webrtc' });

// Local fallbacks matching the SDK branch (and the core constants): used when
// the installed SDK does not export them yet.
export const CAMERA_STREAM_PROTOCOL_PARAM =
  sdk?.CAMERA_STREAM_PROTOCOL_PARAM ?? 'GLADYS_CAMERA_STREAM_PROTOCOL';
export const CAMERA_STREAM_PROTOCOL_WEBRTC = sdk?.CAMERA_STREAM_PROTOCOLS?.WEBRTC ?? 'webrtc';

// The core waits 15 s for the answer (CAMERA_WEBRTC_OFFER_TIMEOUT_MS): give
// up on Netatmo a little before, so the user gets a clear error (and the
// still image) instead of a bare core timeout.
export const WEBRTC_OFFER_TIMEOUT_MS = 12 * 1000;

// Netatmo answers an unknown or already-ended session with this error code
// on terminate ("Nil session", pyatmo fixture webrtc_terminate_no_session).
const NIL_SESSION_ERROR_CODE = 21;

/**
 * Whether this SDK instance can relay WebRTC live views (SDK with
 * onCameraWebRtcOffer / onCameraWebRtcStop).
 * @param {object} gladys SDK instance
 * @returns {boolean} true when both handlers can be registered
 */
export function sdkSupportsWebRtc(gladys) {
  return (
    typeof gladys?.onCameraWebRtcOffer === 'function' &&
    typeof gladys?.onCameraWebRtcStop === 'function'
  );
}

/** Error of the WebRTC `body` of a Netatmo answer (HTTP 200, body.status error). */
function netatmoAckError(what, ack) {
  const code = ack?.error?.code;
  const message = ack?.error?.message ?? 'unknown error';
  const error = new Error(
    `Netatmo refused the ${what}: ${message}${code !== undefined ? ` (${code})` : ''}`,
  );
  error.netatmoCode = code;
  return error;
}

/**
 * Create the WebRTC relay.
 * @param {object} deps dependencies
 * @param {object} deps.gladys SDK instance (external ids)
 * @param {object} deps.client Netatmo API client
 * @param {(id: string) => object|undefined} deps.getRawDevice last raw Netatmo
 *   payload of a device (telemetry cache)
 */
export function createWebRtc({ gladys, client, getRawDevice }) {
  const enabled = sdkSupportsWebRtc(gladys);
  // The connected Gladys core refused the param (no WebRTC relay yet): stop
  // sending it until the next connection — a core upgrade restarts it.
  let coreRejected = false;

  /**
   * Netatmo ids of the camera of a command: device id from the external id,
   * home id from the device params (always carried by the command), else
   * from the last load.
   * @param {object} device the Gladys device of the command
   * @returns {{deviceId: string, homeId: string}} the Netatmo ids
   */
  function resolveCamera(device) {
    const prefix = gladys.externalId('');
    const externalId = device?.external_id ?? '';
    const deviceId = externalId.startsWith(prefix) ? externalId.slice(prefix.length) : '';
    const rawDevice = deviceId ? getRawDevice(deviceId) : undefined;
    const paramHomeId = (device?.params ?? []).find((p) => p.name === PARAMS.HOME_ID)?.value;
    const homeId = paramHomeId || rawDevice?.home || rawDevice?.home_id;
    if (!deviceId || !homeId) {
      throw new Error(`Camera ${externalId || '(none)'} is unknown to the Netatmo account`);
    }
    if (rawDevice && !WEBRTC_CAMERA_MODULE_TYPES.includes(rawDevice.type)) {
      throw new Error(`Camera ${externalId} (${rawDevice.type}) has no WebRTC live view`);
    }
    return { deviceId, homeId };
  }

  /**
   * onCameraWebRtcOffer handler: relay the browser's complete SDP offer to
   * Netatmo and resolve its answer.
   * @param {object} device the Gladys device of the command
   * @param {{sessionId: string, sdp: string}} offer the browser's offer
   * @returns {Promise<{sdpAnswer: string, sessionId: string, streamId: string|null}>}
   *   the answer, with the Netatmo session id and tag id echoed on stop
   */
  async function offer(device, { sessionId, sdp } = {}) {
    const { deviceId, homeId } = resolveCamera(device);
    if (typeof sdp !== 'string' || sdp.length === 0) {
      throw new Error(`Camera ${device.external_id}: empty WebRTC offer`);
    }
    logger.debug(`WebRTC offer -> camera ${deviceId} (session ${sessionId})`);
    let response;
    try {
      response = await client.webRtcOffer({
        homeId,
        deviceId,
        sdp,
        sessionId,
        timeoutMs: WEBRTC_OFFER_TIMEOUT_MS,
      });
    } catch (err) {
      if (err.name === 'TimeoutError') {
        throw new Error(`Netatmo did not answer the live view of camera ${deviceId} in time`, {
          cause: err,
        });
      }
      rethrowScopeError(err);
    }
    const ack = response?.body;
    if (!ack || ack.status !== 'ok') {
      throw netatmoAckError(`live view of camera ${deviceId}`, ack);
    }
    if (typeof ack.sdpAnswer !== 'string' || ack.sdpAnswer.length === 0) {
      throw new Error(`Netatmo answered the live view of camera ${deviceId} without an SDP`);
    }
    const answer = {
      sdpAnswer: ack.sdpAnswer,
      // Netatmo echoes the session id it was given: it is the one terminate
      // expects, with the tag id.
      sessionId: typeof ack.session_id === 'string' && ack.session_id ? ack.session_id : sessionId,
      streamId: typeof ack.tag_id === 'string' && ack.tag_id ? ack.tag_id : null,
    };
    logger.debug(`WebRTC answer <- camera ${deviceId} (session ${answer.sessionId})`);
    return answer;
  }

  /**
   * onCameraWebRtcStop handler: end the Netatmo session. A session Netatmo
   * already forgot is not an error.
   * @param {object} device the Gladys device of the command
   * @param {{sessionId: string, streamId: string|null}} session ids from offer()
   * @returns {Promise<void>} resolves once Netatmo ended the session
   */
  async function stop(device, { sessionId, streamId } = {}) {
    const { deviceId, homeId } = resolveCamera(device);
    logger.debug(`WebRTC terminate -> camera ${deviceId} (session ${sessionId})`);
    let response;
    try {
      response = await client.webRtcTerminate({ homeId, deviceId, sessionId, tagId: streamId });
    } catch (err) {
      rethrowScopeError(err);
    }
    const ack = response?.body;
    if (ack && ack.status !== 'ok') {
      if (ack.error?.code === NIL_SESSION_ERROR_CODE) {
        logger.debug(`WebRTC session ${sessionId} of camera ${deviceId} already ended`);
        return;
      }
      throw netatmoAckError(`end of the live view of camera ${deviceId}`, ack);
    }
  }

  /**
   * Register the two handlers on the SDK, when it has them.
   * @returns {boolean} whether they were registered
   */
  function register() {
    if (!enabled) {
      logger.debug(
        'SDK without onCameraWebRtcOffer / onCameraWebRtcStop: WebRTC live view disabled',
      );
      return false;
    }
    gladys.onCameraWebRtcOffer((device, request) => offer(device, request));
    gladys.onCameraWebRtcStop((device, session) => stop(device, session));
    return true;
  }

  /**
   * Device param declaring the WebRTC live view, for the discovery of the
   * WebRTC cameras — null when the SDK cannot relay it or the connected core
   * refused it.
   * @returns {{name: string, value: string}|null} the param
   */
  function discoveryParam() {
    if (!enabled || coreRejected) {
      return null;
    }
    return { name: CAMERA_STREAM_PROTOCOL_PARAM, value: CAMERA_STREAM_PROTOCOL_WEBRTC };
  }

  /**
   * Whether a discovery publish failed because the core does not know the
   * param (Gladys without the WebRTC relay): a 400 naming it.
   * @param {Error} err the publish error
   * @returns {boolean} true when the publish should be retried without it
   */
  function isParamRejection(err) {
    return (
      Number(err?.status) === 400 && String(err?.message).includes(CAMERA_STREAM_PROTOCOL_PARAM)
    );
  }

  /** The connected core refused the param: stop sending it. */
  function rejectedByCore() {
    if (!coreRejected) {
      logger.info(
        'This Gladys version has no WebRTC camera live view yet: the doorbell and the Indoor Camera Advance keep the still image',
      );
    }
    coreRejected = true;
  }

  /** New connection (possibly to an upgraded core): try the param again. */
  function resetCoreSupport() {
    coreRejected = false;
  }

  return {
    enabled,
    offer,
    stop,
    register,
    discoveryParam,
    isParamRejection,
    rejectedByCore,
    resetCoreSupport,
  };
}
