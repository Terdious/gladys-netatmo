// -----------------------------------------------------------------------------
// Momentary Netatmo events (issue #5), fed by the Gladys Plus webhook relay.
//
// This is the documented EXCEPTION to the "trigger, not data" doctrine: motion,
// person, animal, vehicle and smoke detections exist ONLY in the event stream —
// no API state ever reports them, so refreshing cannot surface them. They are
// published as dedicated binary features, which is what makes a scene trigger
// ("camera detects motion -> ...") possible.
//
// Netatmo sends `push_type: "<module type>-<event>"` (e.g. "NACamera-movement",
// "NOC-human", "NSD-smoke"). We key on the EVENT part, so every module type
// goes through one table and unknown events are ignored rather than guessed.
//
// Each detection is published as 1, then automatically back to 0 after
// EVENT_RESET_MS: the stream carries no "cleared" counterpart, and a feature
// stuck at 1 would make a scene trigger fire once and never again.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { EVENT_FEATURE_SUFFIXES, EVENT_RESET_MS } from './constants.js';

const logger = createLogger({ name: 'netatmo-events' });

/**
 * Extract the event name of a webhook payload: the part after the module-type
 * prefix of `push_type` ("NACamera-movement" -> "movement"), falling back to
 * the explicit `event_type` field.
 * @param {object} payload parsed webhook body
 * @returns {string|undefined} the event name, lowercased
 */
export function eventNameOf(payload) {
  const pushType = typeof payload?.push_type === 'string' ? payload.push_type : '';
  const fromPushType = pushType.includes('-') ? pushType.slice(pushType.indexOf('-') + 1) : '';
  const name = fromPushType || payload?.event_type;
  return typeof name === 'string' && name.length > 0 ? name.toLowerCase() : undefined;
}

/**
 * Netatmo id of the module the event is about. Cameras report `camera_id`,
 * other modules `module_id`; `device_id` is the catch-all.
 * @param {object} payload parsed webhook body
 * @returns {string|undefined} the module id
 */
export function eventDeviceIdOf(payload) {
  return payload?.module_id ?? payload?.camera_id ?? payload?.device_id;
}

/**
 * Create the momentary-event engine.
 * @param {object} deps dependencies
 * @param {object} deps.gladys SDK instance (devices, publishStates, externalId)
 * @param {number} [deps.resetMs] auto-reset delay (tests)
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers] injectable timers (tests)
 */
export function createEvents({
  gladys,
  resetMs = EVENT_RESET_MS,
  timers = { setTimeout, clearTimeout },
}) {
  // Pending auto-resets, keyed by feature external id.
  const resetTimers = new Map();

  /** Publish one feature state, defensively (a failing publish must not throw). */
  async function publish(featureExternalId, state) {
    try {
      await gladys.publishStates([{ device_feature_external_id: featureExternalId, state }]);
    } catch (err) {
      logger.warn(`Publishing ${featureExternalId} = ${state} failed: ${err.message}`);
    }
  }

  /** Arm (or re-arm) the automatic return to 0 of a detection feature. */
  function scheduleReset(featureExternalId) {
    const pending = resetTimers.get(featureExternalId);
    if (pending) {
      timers.clearTimeout(pending);
    }
    const timer = timers.setTimeout(async () => {
      resetTimers.delete(featureExternalId);
      await publish(featureExternalId, 0);
    }, resetMs);
    resetTimers.set(featureExternalId, timer);
  }

  /**
   * Handle one relayed webhook body: publish the matching detection feature of
   * the device the user created in Gladys.
   * @param {string|object|null} body raw webhook body (JSON string or object)
   * @returns {Promise<string|undefined>} the published feature external id, if any
   */
  async function handleWebhook(body) {
    let payload = body;
    if (typeof body === 'string') {
      try {
        payload = JSON.parse(body);
      } catch {
        logger.debug('Webhook body is not JSON — ignored');
        return undefined;
      }
    }
    if (!payload || typeof payload !== 'object') {
      return undefined;
    }
    const eventName = eventNameOf(payload);
    const suffix = eventName ? EVENT_FEATURE_SUFFIXES[eventName] : undefined;
    if (!suffix) {
      // Connection/disconnection, on/off, daily summary…: nothing momentary to
      // publish (the refresh triggered alongside covers the pollable state).
      logger.debug(`Webhook event "${eventName ?? 'unknown'}" carries no momentary state`);
      return undefined;
    }
    const deviceId = eventDeviceIdOf(payload);
    if (!deviceId) {
      logger.debug(`Webhook event "${eventName}" without a module id — ignored`);
      return undefined;
    }
    const deviceExternalId = gladys.externalId(deviceId);
    const featureExternalId = `${deviceExternalId}:${suffix}`;
    // The user may not have created this device (or created it before the
    // feature existed): publishing an unknown feature would just be rejected.
    const device = (gladys.devices ?? []).find((d) => d.external_id === deviceExternalId);
    const hasFeature = (device?.features ?? []).some((f) => f.external_id === featureExternalId);
    if (!hasFeature) {
      logger.debug(
        `Webhook event "${eventName}" for ${deviceExternalId}: feature not created in Gladys — ignored`,
      );
      return undefined;
    }
    logger.info(`Netatmo event: ${eventName} on ${deviceExternalId}`);
    await publish(featureExternalId, 1);
    scheduleReset(featureExternalId);
    return featureExternalId;
  }

  /** Cancel every pending auto-reset (disconnect / shutdown). */
  function stop() {
    for (const timer of resetTimers.values()) {
      timers.clearTimeout(timer);
    }
    resetTimers.clear();
  }

  return { handleWebhook, stop, pendingResets: () => resetTimers.size };
}
