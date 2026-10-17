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
// The event goes to the first module id of the payload (module, camera,
// device, then their bridge) whose feature the user created: the BTicino
// door entry (issue #59) is ONE device, its gateway's, so a ring naming the
// street panel lands on the gateway's ring.
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
//
// Two sources feed the SAME path (`handleEvent`, a normalized event): the
// Gladys Plus webhooks (real time) and the `getevents` poll of every refresh
// cycle (src/netatmo/eventsPoll.js), the fallback when the webhooks deliver
// nothing. A detection one source already published is never published again
// by the other: same Netatmo event id (and sub-event id), or the same feature
// within EVENT_DEDUP_WINDOW_MS when the ids do not match.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import {
  EVENT_FEATURE_SUFFIXES,
  EVENT_RESET_MS,
  EVENT_CLEARED_SUB_TYPES,
  FLOODLIGHT_MODES,
  SCENE_TRIGGERS,
  SCENE_EVENT_DEDUP_SIZE,
  EVENT_DEDUP_WINDOW_MS,
  EVENT_DEDUP_RETENTION_MS,
  EVENT_DEDUP_MAX_ENTRIES,
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

// Where a normalized event comes from: the Gladys Plus webhook relay (real
// time) or the `getevents` poll of the refresh cycle (fallback).
export const EVENT_SOURCES = {
  WEBHOOK: 'webhook',
  POLL: 'poll',
};

/** Non-empty strings only, most specific first, without duplicates. */
function idsOf(...values) {
  return [...new Set(values.filter((id) => typeof id === 'string' && id.length > 0))];
}

/**
 * Normalize a webhook payload into the event both sources share (see
 * handleEvent). A webhook carries no reliable event time: its arrival time is
 * the event time.
 * @param {object} payload parsed webhook body
 * @param {number} time arrival time (epoch ms)
 * @param {string} [type] event name override (default: eventNameOf)
 * @returns {object} the normalized event
 */
export function normalizeWebhookEvent(payload, time, type = eventNameOf(payload)) {
  return {
    source: EVENT_SOURCES.WEBHOOK,
    type,
    subType: payload?.sub_type === undefined ? undefined : String(payload.sub_type),
    moduleIds: idsOf(payload?.module_id, payload?.camera_id, payload?.device_id),
    homeId: payload?.home_id ?? payload?.home?.id,
    homeName: payload?.home_name ?? null,
    eventId: typeof payload?.event_id === 'string' ? payload.event_id : undefined,
    subeventId: typeof payload?.subevent_id === 'string' ? payload.subevent_id : undefined,
    time,
    persons: eventPersonsOf(payload),
  };
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
 * @param {() => number} [deps.now] clock (tests)
 * @param {number} [deps.dedupWindowMs] webhook / poll dedup window (tests)
 */
export function createEvents({
  gladys,
  getHomes = () => [],
  resetMs = EVENT_RESET_MS,
  timers = { setTimeout, clearTimeout },
  now = Date.now,
  dedupWindowMs = EVENT_DEDUP_WINDOW_MS,
}) {
  // Pending auto-resets, keyed by feature external id.
  const resetTimers = new Map();
  // Recently fired scene events (dedup of re-delivered webhooks), in order.
  const firedSceneEvents = new Set();
  // What each source recently published (webhook / poll dedup), in record
  // order: {source, keys, target, at (event time), recordedAt}.
  const publications = [];

  /** Drop the publications too old to match anything any more. */
  function forgetOldPublications() {
    const limit = now() - EVENT_DEDUP_RETENTION_MS;
    while (
      publications.length > 0 &&
      (publications[0].recordedAt < limit || publications.length > EVENT_DEDUP_MAX_ENTRIES)
    ) {
      publications.shift();
    }
  }

  /**
   * Whether this publication was already made: by the OTHER source (same
   * Netatmo event / sub-event id, or the same target within the dedup
   * window — a webhook may carry no id, or another one), or by the poll itself
   * for the same event id (the sub-events of one outdoor camera event are one
   * detection, not one per sub-event). The webhook path alone keeps its
   * historical behaviour: a re-delivered webhook publishes again.
   * Otherwise the publication is remembered.
   * @returns {boolean} true when it is a duplicate (nothing remembered)
   */
  function claim({ source, keys, target, at }) {
    forgetOldPublications();
    const duplicate = publications.some((entry) => {
      const otherSource = entry.source !== source;
      if (!otherSource && source !== EVENT_SOURCES.POLL) {
        return false;
      }
      if (keys.some((key) => entry.keys.includes(key))) {
        return true;
      }
      return otherSource && entry.target === target && Math.abs(entry.at - at) <= dedupWindowMs;
    });
    if (!duplicate) {
      publications.push({ source, keys, target, at, recordedAt: now() });
    }
    return duplicate;
  }

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

  /** The home an event is about: its home id, else the home of the module. */
  function homeOf(event) {
    const homes = getHomes();
    return (
      homes.find((home) => home.id === event.homeId) ??
      homes.find((home) =>
        (home.modules ?? []).some((module) => event.moduleIds.includes(module.id)),
      )
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
   * Fire one scene event of a normalized event, unless the other source
   * already fired it.
   */
  async function fireEventScene(event, key, data, subjectId) {
    const dedupKey = event.eventId ? `${event.eventId}:${subjectId}` : undefined;
    const duplicate = claim({
      source: event.source,
      keys: dedupKey ? [`scene:${dedupKey}`] : [],
      target: `scene:${key}:${subjectId}`,
      at: event.time,
    });
    if (duplicate) {
      logger.debug(`Scene event ${key} already fired by the other event source — ignored`);
      return false;
    }
    return fireSceneEvent(key, data, dedupKey);
  }

  /**
   * Fire the scene events an event carries (issue #39): a known person seen /
   * gone, a siren sounding.
   * @param {object} event normalized event (normalizeWebhookEvent, eventsPoll)
   * @returns {Promise<number>} number of scene events fired
   */
  async function fireEventScenes(event) {
    let fired = 0;
    const moduleId = event.moduleIds[0];
    const home = homeOf(event);
    const homeName = home?.name ?? event.homeName ?? null;
    const personTrigger = PERSON_EVENT_TRIGGERS[event.type];
    if (personTrigger) {
      for (const person of event.persons ?? []) {
        const knownPerson = (home?.persons ?? []).find((entry) => entry.id === person.id);
        // An unrecognized face is not a "known person" (is_known false), and
        // neither is an id the homes data does not know without the flag.
        if (person.is_known === false || (!knownPerson && person.is_known !== true)) {
          continue;
        }
        // getevents never says whether the face is known: only a person
        // named in the Netatmo app is.
        if (event.source === EVENT_SOURCES.POLL && !knownPerson?.pseudo) {
          continue;
        }
        const data = {
          camera: moduleId ? gladys.externalId(moduleId) : null,
          person: knownPerson?.pseudo ?? null,
          camera_name: moduleId ? moduleNameOf(home, moduleId) : null,
          home_name: homeName,
        };
        if (await fireEventScene(event, personTrigger, data, person.id)) {
          fired += 1;
        }
      }
    }
    // siren_sounding: sub_type 0 reports the END of the sound — not an event
    // a scene waits for; anything else is the siren starting.
    if (event.type === 'siren_sounding' && moduleId && Number(event.subType) !== 0) {
      const data = {
        siren: gladys.externalId(moduleId),
        siren_name: moduleNameOf(home, moduleId),
        home_name: homeName,
      };
      if (await fireEventScene(event, SCENE_TRIGGERS.SIREN_SOUNDING, data, moduleId)) {
        fired += 1;
      }
    }
    return fired;
  }

  /**
   * Fire the scene events a webhook payload carries (issue #39).
   * @param {object} payload parsed webhook body
   * @param {string|undefined} eventName event name (eventNameOf)
   * @returns {Promise<number>} number of scene events fired
   */
  function fireSceneEvents(payload, eventName) {
    return fireEventScenes(normalizeWebhookEvent(payload, now(), eventName));
  }

  /** Publish one feature state, defensively (a failing publish must not throw). */
  async function publish(featureExternalId, state) {
    try {
      await gladys.publishStates([{ device_feature_external_id: featureExternalId, state }]);
    } catch (err) {
      logger.warn(`Publishing ${featureExternalId} = ${state} failed: ${err.message}`);
    }
  }

  /**
   * The Netatmo ids an event may be about, most specific first: the module,
   * the camera, the device, then the bridge of each of them (homes summaries)
   * — a module grouped on its BTicino gateway's device (issue #59) carries
   * no device of its own: the door entry ring is the gateway's feature.
   */
  function candidateIdsOf(event) {
    const ids = [...event.moduleIds];
    const modules = getHomes().flatMap((home) => home.modules ?? []);
    for (const id of [...ids]) {
      const bridge = modules.find((module) => module.id === id)?.bridge;
      if (typeof bridge === 'string' && bridge.length > 0) {
        ids.push(bridge);
      }
    }
    return [...new Set(ids)];
  }

  /**
   * The created feature a momentary event goes to: `<id>:<suffix>` for the
   * first candidate id one of the devices the user created carries.
   * @returns {{featureExternalId: string, deviceExternalId: string}|undefined} the target
   */
  function findEventFeature(event, suffix) {
    for (const id of candidateIdsOf(event)) {
      const featureExternalId = `${gladys.externalId(id)}:${suffix}`;
      const device = (gladys.devices ?? []).find((d) =>
        (d.features ?? []).some((f) => f.external_id === featureExternalId),
      );
      if (device) {
        return { featureExternalId, deviceExternalId: device.external_id };
      }
    }
    return undefined;
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
   * Publish the momentary detection of a normalized event — the path shared
   * by the webhooks and the getevents poll — on the feature of the device the
   * user created in Gladys.
   * @param {object} event normalized event: {source, type, subType, moduleIds,
   *   homeId, eventId, subeventId, time (epoch ms)}
   * @returns {Promise<{outcome: string, featureExternalId?: string}>} what
   *   happened: `published`, `cleared`, `duplicate` (the other source already
   *   published it), `not_momentary`, `no_module` or `not_created`
   */
  async function publishDetection(event) {
    const label = event.source === EVENT_SOURCES.POLL ? 'getevents' : 'Webhook';
    const suffix = event.type ? EVENT_FEATURE_SUFFIXES[event.type] : undefined;
    if (!suffix) {
      // Connection/disconnection, on/off, daily summary…: nothing momentary to
      // publish (the refresh covers the pollable state).
      logger.debug(`${label} event "${event.type ?? 'unknown'}" carries no momentary state`);
      return { outcome: 'not_momentary' };
    }
    if (event.moduleIds.length === 0) {
      logger.debug(`${label} event "${event.type}" without a module id — ignored`);
      return { outcome: 'no_module' };
    }
    // The user may not have created this device (or created it before the
    // feature existed): publishing an unknown feature would just be rejected.
    const target = findEventFeature(event, suffix);
    if (!target) {
      logger.debug(
        `${label} event "${event.type}" for ${gladys.externalId(event.moduleIds[0])}: feature not created in Gladys — ignored`,
      );
      return { outcome: 'not_created' };
    }
    const { featureExternalId, deviceExternalId } = target;
    const cleared =
      event.subType !== undefined &&
      (EVENT_CLEARED_SUB_TYPES[event.type] ?? []).includes(event.subType);
    const keys = [];
    if (event.eventId) {
      keys.push(`event:${event.eventId}:${suffix}`);
    }
    if (event.subeventId) {
      keys.push(`subevent:${event.subeventId}`);
    }
    const duplicate = claim({
      source: event.source,
      keys,
      target: `${featureExternalId}=${cleared ? 0 : 1}`,
      at: event.time,
    });
    if (duplicate) {
      logger.debug(
        `${label} event "${event.type}" on ${deviceExternalId} already published — duplicate ignored`,
      );
      return { outcome: 'duplicate', featureExternalId };
    }
    const via = event.source === EVENT_SOURCES.POLL ? ' (getevents)' : '';
    if (cleared) {
      logger.info(`Netatmo event: ${event.type} cleared on ${deviceExternalId}${via}`);
      const pending = resetTimers.get(featureExternalId);
      if (pending) {
        timers.clearTimeout(pending);
        resetTimers.delete(featureExternalId);
      }
      await publish(featureExternalId, 0);
      return { outcome: 'cleared', featureExternalId };
    }
    logger.info(`Netatmo event: ${event.type} on ${deviceExternalId}${via}`);
    await publish(featureExternalId, 1);
    scheduleReset(featureExternalId);
    return { outcome: 'published', featureExternalId };
  }

  /**
   * Handle one normalized event (webhook or getevents poll): its scene events,
   * then its momentary detection.
   * @param {object} event normalized event (see publishDetection)
   * @returns {Promise<{outcome: string, featureExternalId?: string, scenes: number}>} the result
   */
  async function handleEvent(event) {
    const scenes = await fireEventScenes(event);
    return { ...(await publishDetection(event)), scenes };
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
    const event = normalizeWebhookEvent(payload, now());
    if (event.type === 'light_mode') {
      await fireEventScenes(event);
      return publishFloodlight(payload);
    }
    const { outcome, featureExternalId } = await handleEvent(event);
    return outcome === 'published' || outcome === 'cleared' ? featureExternalId : undefined;
  }

  /** Cancel every pending auto-reset (disconnect / shutdown). */
  function stop() {
    for (const timer of resetTimers.values()) {
      timers.clearTimeout(timer);
    }
    resetTimers.clear();
  }

  return {
    handleWebhook,
    handleEvent,
    fireSceneEvents,
    stop,
    pendingResets: () => resetTimers.size,
  };
}
