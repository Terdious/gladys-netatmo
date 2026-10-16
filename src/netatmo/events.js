// -----------------------------------------------------------------------------
// Momentary Netatmo events (issue #5), fed by the Gladys Plus webhook relay.
//
// This is the documented EXCEPTION to the "trigger, not data" doctrine: motion,
// person, animal, vehicle, smoke and carbon monoxide detections and the
// doorbell ring exist ONLY in the event stream — no API state ever reports
// them, so refreshing cannot surface them. They are published as dedicated
// features, which is what makes a scene trigger ("camera detects motion -> ...")
// possible.
//
// Netatmo sends `push_type: "<module type>-<event>"` (e.g. "NACamera-movement",
// "NOC-human", "NSD-smoke", "NCO-co_detected", "NDB-incoming_call"). We key on
// the EVENT part, so every module type goes through one table and unknown
// events are ignored rather than guessed.
//
// Each detection is published as 1, then automatically back to 0 after
// EVENT_RESET_MS: most events have no "cleared" counterpart, and a feature
// stuck at 1 would make a scene trigger fire once and never again. The few
// that do (smoke and carbon monoxide, see EVENT_CLEARED_SUB_TYPES) return
// the feature to 0 at once instead of raising a new detection.
//
// One STATE event is published straight away too (issue #56): `light_mode`
// carries the new floodlight mode of an outdoor camera in `sub_type` (on /
// off / auto — pyatmo stores it verbatim). The refresh every webhook triggers
// confirms it from homestatus right after.
//
// Some events carry an IDENTITY no feature can hold (issue #39): which known
// person a camera recognized, which person left, which siren sounds. They are
// fired as scene events (manifest `scene_triggers`, Gladys 5.1+) — a trigger,
// never a state: one event per Netatmo event, never re-fired.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import {
  EVENT_FEATURE_SUFFIXES,
  EVENT_RESET_MS,
  EVENT_CLEARED_SUB_TYPES,
  FLOODLIGHT_MODES,
  SCENE_TRIGGERS,
  SCENE_EVENT_DEDUP_SIZE,
} from './constants.js';

const logger = createLogger({ name: 'netatmo-events' });

// Every scene trigger key this module fires: each one must be declared in the
// manifest `scene_triggers` field (the core answers 404 otherwise).
export const SCENE_TRIGGER_KEYS = Object.values(SCENE_TRIGGERS);

// Webhook event name -> scene trigger key of the person events.
const PERSON_EVENT_TRIGGERS = {
  person: SCENE_TRIGGERS.KNOWN_PERSON_ARRIVED,
  person_away: SCENE_TRIGGERS.KNOWN_PERSON_LEFT,
};

/**
 * The persons a webhook payload is about: the `persons` array of a camera
 * `person` event (`[{id, is_known, face_url…}]`), or a single `person_id`.
 * Malformed entries are skipped.
 * @param {object} payload parsed webhook body
 * @returns {Array<{id: string, is_known?: boolean}>} the persons
 */
export function eventPersonsOf(payload) {
  const persons = Array.isArray(payload?.persons)
    ? payload.persons.filter((person) => person && typeof person.id === 'string')
    : [];
  if (persons.length > 0) {
    return persons;
  }
  if (typeof payload?.person_id === 'string') {
    return [{ id: payload.person_id, is_known: payload.is_known }];
  }
  return [];
}

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
 * @param {object} deps.gladys SDK instance (devices, publishStates,
 * publishSceneEvent, externalId)
 * @param {() => Array<object>} [deps.getHomes] homes summaries of the last
 * account load (names, known persons, modules — see discovery summarizeHome)
 * @param {number} [deps.resetMs] auto-reset delay (tests)
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers] injectable timers (tests)
 */
export function createEvents({
  gladys,
  getHomes = () => [],
  resetMs = EVENT_RESET_MS,
  timers = { setTimeout, clearTimeout },
}) {
  // Pending auto-resets, keyed by feature external id.
  const resetTimers = new Map();
  // Recently fired scene events (dedup of re-delivered webhooks), in order.
  const firedSceneEvents = new Set();

  /** Fire one scene event, defensively (an older core answers 404, a burst 429). */
  async function fireSceneEvent(key, data, dedupKey) {
    if (dedupKey) {
      if (firedSceneEvents.has(dedupKey)) {
        logger.debug(`Scene event ${key} already fired for ${dedupKey} — duplicate ignored`);
        return false;
      }
      firedSceneEvents.add(dedupKey);
      if (firedSceneEvents.size > SCENE_EVENT_DEDUP_SIZE) {
        firedSceneEvents.delete(firedSceneEvents.values().next().value);
      }
    }
    try {
      await gladys.publishSceneEvent(key, data);
      logger.info(`Scene event ${key} fired`);
      return true;
    } catch (err) {
      logger.warn(`Scene event ${key} refused: ${err.message}`);
      return false;
    }
  }

  /** The home a payload is about: its `home_id`, else the home of the module. */
  function homeOf(payload, moduleId) {
    const homes = getHomes();
    const homeId = payload.home_id ?? payload.home?.id;
    return (
      homes.find((home) => home.id === homeId) ??
      homes.find((home) => (home.modules ?? []).some((module) => module.id === moduleId))
    );
  }

  /**
   * Name of a module for the scene variables: the name the user gave the
   * device in Gladys, else its Netatmo name.
   */
  function moduleNameOf(home, moduleId) {
    const externalId = gladys.externalId(moduleId);
    const device = (gladys.devices ?? []).find((d) => d.external_id === externalId);
    const netatmoName = (home?.modules ?? []).find((module) => module.id === moduleId)?.name;
    return device?.name ?? netatmoName ?? null;
  }

  /**
   * Fire the scene events a webhook payload carries (issue #39): a known
   * person seen / gone, a siren sounding.
   * @param {object} payload parsed webhook body
   * @param {string|undefined} eventName event name (eventNameOf)
   * @returns {Promise<number>} number of scene events fired
   */
  async function fireSceneEvents(payload, eventName) {
    let fired = 0;
    const moduleId = eventDeviceIdOf(payload);
    const home = homeOf(payload, moduleId);
    const homeName = home?.name ?? payload.home_name ?? null;
    const personTrigger = PERSON_EVENT_TRIGGERS[eventName];
    if (personTrigger) {
      for (const person of eventPersonsOf(payload)) {
        const knownPerson = (home?.persons ?? []).find((entry) => entry.id === person.id);
        // An unrecognized face is not a "known person" (is_known false), and
        // neither is an id the homes data does not know without the flag.
        if (person.is_known === false || (!knownPerson && person.is_known !== true)) {
          continue;
        }
        const data = {
          camera: moduleId ? gladys.externalId(moduleId) : null,
          person: knownPerson?.pseudo ?? null,
          camera_name: moduleId ? moduleNameOf(home, moduleId) : null,
          home_name: homeName,
        };
        const dedupKey = payload.event_id ? `${payload.event_id}:${person.id}` : undefined;
        if (await fireSceneEvent(personTrigger, data, dedupKey)) {
          fired += 1;
        }
      }
    }
    // siren_sounding: sub_type 0 reports the END of the sound — not an event
    // a scene waits for; anything else is the siren starting.
    if (eventName === 'siren_sounding' && moduleId && Number(payload.sub_type) !== 0) {
      const data = {
        siren: gladys.externalId(moduleId),
        siren_name: moduleNameOf(home, moduleId),
        home_name: homeName,
      };
      const dedupKey = payload.event_id ? `${payload.event_id}:${moduleId}` : undefined;
      if (await fireSceneEvent(SCENE_TRIGGERS.SIREN_SOUNDING, data, dedupKey)) {
        fired += 1;
      }
    }
    return fired;
  }

  /** Publish one feature state, defensively (a failing publish must not throw). */
  async function publish(featureExternalId, state) {
    try {
      await gladys.publishStates([{ device_feature_external_id: featureExternalId, state }]);
    } catch (err) {
      logger.warn(`Publishing ${featureExternalId} = ${state} failed: ${err.message}`);
    }
  }

  /** External ids of the features the user created on a device. */
  function createdFeatureIds(deviceExternalId) {
    const device = (gladys.devices ?? []).find((d) => d.external_id === deviceExternalId);
    return new Set((device?.features ?? []).map((f) => f.external_id));
  }

  /**
   * Publish the floodlight mode of a `light_mode` event on the two floodlight
   * features (issue #56). An unknown mode is left to the refresh.
   * @returns {Promise<string|undefined>} the light feature external id, if published
   */
  async function publishFloodlight(payload) {
    const mode =
      payload.sub_type === undefined ? undefined : String(payload.sub_type).toLowerCase();
    const deviceId = eventDeviceIdOf(payload);
    if (!Object.values(FLOODLIGHT_MODES).includes(mode) || !deviceId) {
      logger.debug(`Webhook light_mode without a known mode or module — left to the refresh`);
      return undefined;
    }
    const deviceExternalId = gladys.externalId(deviceId);
    const created = createdFeatureIds(deviceExternalId);
    const states = [
      [`${deviceExternalId}:floodlight`, mode === FLOODLIGHT_MODES.ON ? 1 : 0],
      [`${deviceExternalId}:floodlight_auto`, mode === FLOODLIGHT_MODES.AUTO ? 1 : 0],
    ].filter(([featureExternalId]) => created.has(featureExternalId));
    if (states.length === 0) {
      logger.debug(`Webhook light_mode for ${deviceExternalId}: floodlight not created — ignored`);
      return undefined;
    }
    logger.info(`Netatmo event: floodlight ${mode} on ${deviceExternalId}`);
    for (const [featureExternalId, state] of states) {
      await publish(featureExternalId, state);
    }
    return states[0][0];
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
    await fireSceneEvents(payload, eventName);
    if (eventName === 'light_mode') {
      return publishFloodlight(payload);
    }
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
    const subType = payload.sub_type === undefined ? undefined : String(payload.sub_type);
    if (subType !== undefined && (EVENT_CLEARED_SUB_TYPES[eventName] ?? []).includes(subType)) {
      logger.info(`Netatmo event: ${eventName} cleared on ${deviceExternalId}`);
      const pending = resetTimers.get(featureExternalId);
      if (pending) {
        timers.clearTimeout(pending);
        resetTimers.delete(featureExternalId);
      }
      await publish(featureExternalId, 0);
      return featureExternalId;
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

  return { handleWebhook, fireSceneEvents, stop, pendingResets: () => resetTimers.size };
}
