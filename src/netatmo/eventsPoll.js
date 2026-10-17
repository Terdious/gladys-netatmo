// -----------------------------------------------------------------------------
// getevents poll: the fallback source of the momentary detections.
//
// Motion, person, animal, vehicle, smoke and carbon monoxide detections and
// the doorbell / door entry rings exist only in the Netatmo event stream (see
// src/netatmo/events.js). The Gladys Plus webhooks bring them in real time —
// when Netatmo delivers. When it does not (no Gladys Plus, a webhook Netatmo
// holds but never calls, a 24 h ban after failed deliveries), the features
// would stay empty while the Netatmo app shows the alerts. So every refresh
// cycle also reads the last events of each home (`GET /api/getevents`,
// pyatmo `async_update_events`) and hands the NEW ones to the very same path
// as the webhooks (`events.handleEvent`): same features, same 60 s reset,
// same scene events. A detection the webhook already published is never
// published twice (see the dedup of events.js).
//
// Rules:
//   - only the homes with a camera, doorbell or alarm discovered (Security
//     family on), or a BTicino door entry gateway (BTicino toggle on);
//   - one call per eligible home and per cycle, at most one per home within
//     EVENTS_POLL_MIN_INTERVAL_MS (the webhook-triggered refreshes poll too);
//   - the first answer after a start only SEEDS the events already there:
//     history is never replayed on a restart;
//   - an event older than EVENTS_POLL_MAX_AGE_MS at poll time is recorded as
//     seen, never published (no stale trigger after an outage);
//   - a failure never breaks the cycle: logged at warn once per streak,
//     counted in the `events` family of the health (Device diagnostic). It
//     never marks devices degraded: the polled states do not depend on it.
//
// Every event seen is kept (time, type, sub type, ids and what happened to
// it — never a URL or a message) for the Device diagnostic report: events in
// getevents and zero webhook = Netatmo does not deliver the webhooks.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import {
  CAMERA_MODULE_TYPES,
  BTICINO_GATEWAY_TYPES,
  SUPPORTED_MODULE_TYPE,
  EVENTS_POLL_SIZE,
  EVENTS_POLL_MIN_INTERVAL_MS,
  EVENTS_POLL_MAX_AGE_MS,
  EVENTS_POLL_SEEN_SIZE,
  EVENTS_POLL_TIMEOUT_MS,
  EVENTS_POLL_HISTORY_SIZE,
  EVENTS_POLL_HISTORY_PER_MODULE,
  EVENTS_POLL_HISTORY_MAX_MODULES,
} from './constants.js';
import { EVENT_SOURCES } from './events.js';

const defaultLogger = createLogger({ name: 'netatmo-events-poll' });

// Name of the poll in the per-family health (Device diagnostic report).
export const EVENTS_HEALTH_FAMILY = 'events';

// Module types whose events the poll reads, per configuration toggle.
const SECURITY_EVENT_MODULE_TYPES = [
  ...CAMERA_MODULE_TYPES,
  SUPPORTED_MODULE_TYPE.NSD,
  SUPPORTED_MODULE_TYPE.NCO,
];

// Netatmo error code of a scope refusal (403): the token lacks a permission.
const SCOPE_ERROR_CODE = 13;

// What happened to an event seen by the poll (Device diagnostic report).
export const POLL_OUTCOME_LABELS = {
  startup: 'already there at startup — not published',
  too_old: 'too old when seen — not published',
  published: 'published',
  cleared: 'published (back to normal)',
  duplicate: 'already published (by a webhook, or for the same event)',
  not_momentary: 'no momentary feature for this type',
  not_created: 'feature not created in Gladys',
  no_module: 'no module id',
  error: 'publication failed',
};

/** Non-empty strings only, without duplicates. */
function idsOf(...values) {
  return [...new Set(values.filter((id) => typeof id === 'string' && id.length > 0))];
}

/** A getevents time (UNIX seconds) in epoch ms, undefined when missing. */
function timeMsOf(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/** Lowercased event type, undefined when missing. */
function typeOf(value) {
  return typeof value === 'string' && value.length > 0 ? value.toLowerCase() : undefined;
}

/**
 * The homes whose events the poll reads: a camera, doorbell or alarm
 * discovered with the Security family on, or a BTicino door entry gateway
 * with the BTicino toggle on.
 * @param {object} config normalized configuration
 * @param {Array<object>} homes homes summaries (discovery summarizeHome)
 * @returns {Array<object>} the eligible homes
 */
export function eventsPollHomes(config, homes = []) {
  const types = [
    ...(config?.security_api ? SECURITY_EVENT_MODULE_TYPES : []),
    ...(config?.bticino_api ? BTICINO_GATEWAY_TYPES : []),
  ];
  if (types.length === 0) {
    return [];
  }
  return homes.filter(
    (home) =>
      typeof home?.id === 'string' &&
      (home.modules ?? []).some((module) => types.includes(module.type)),
  );
}

/**
 * Normalize one getevents entry into the events of the shared path
 * (events.js handleEvent): one per sub-event for the outdoor camera
 * (`outdoor` + `subevents` human / animal / vehicle), the entry itself
 * otherwise (`movement`, `person`, `incoming_call`, `smoke`, `co_detected`…).
 * @param {object} raw a `body.home.events[]` entry
 * @param {string} homeId the home polled
 * @returns {Array<{key: string, summary: object, event: object}>} the items:
 *   a stable key (seen-set), the diagnostic summary, the normalized event
 */
export function normalizeGetEvent(raw, homeId) {
  if (!raw || typeof raw !== 'object') {
    return [];
  }
  const eventId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined;
  const moduleIds = idsOf(raw.module_id, raw.camera_id, raw.device_id);
  const type = typeOf(raw.type);
  const persons =
    typeof raw.person_id === 'string'
      ? [
          {
            id: raw.person_id,
            ...(typeof raw.is_known === 'boolean' ? { is_known: raw.is_known } : {}),
          },
        ]
      : [];
  const base = {
    source: EVENT_SOURCES.POLL,
    homeId,
    homeName: null,
    eventId,
    moduleIds,
    persons,
  };
  const fallbackKey = `${type ?? 'unknown'}:${moduleIds[0] ?? 'none'}:${raw.time ?? 'none'}`;
  const subevents = Array.isArray(raw.subevents)
    ? raw.subevents.filter((sub) => sub && typeof sub === 'object')
    : [];
  if (subevents.length > 0) {
    return subevents.map((sub, index) => {
      const subeventId = typeof sub.id === 'string' && sub.id.length > 0 ? sub.id : undefined;
      const subType = typeOf(sub.type);
      const time = timeMsOf(sub.time ?? raw.time);
      return {
        key: subeventId ? `subevent:${subeventId}` : `${eventId ?? fallbackKey}:${index}`,
        summary: { id: eventId, type, sub_type: subType, module_id: moduleIds[0], time },
        event: { ...base, type: subType, subType: undefined, subeventId, time },
      };
    });
  }
  const subType =
    raw.sub_type === undefined || raw.sub_type === null ? undefined : String(raw.sub_type);
  const time = timeMsOf(raw.time);
  return [
    {
      key: eventId ? `event:${eventId}` : fallbackKey,
      summary: { id: eventId, type, sub_type: subType, module_id: moduleIds[0], time },
      event: { ...base, type, subType, subeventId: undefined, time },
    },
  ];
}

/**
 * In-memory history of the events seen by the poll: the last ones overall
 * and the last ones per module id, for a bounded number of ids (the least
 * recently seen id goes first). Entries carry no URL and no message.
 * @param {object} [options] bounds
 * @returns {{record: Function, recent: Function, forModule: Function,
 *   lastAt: () => number|null, total: () => number}} the history
 */
export function createEventsPollHistory({
  size = EVENTS_POLL_HISTORY_SIZE,
  perModule = EVENTS_POLL_HISTORY_PER_MODULE,
  maxModules = EVENTS_POLL_HISTORY_MAX_MODULES,
} = {}) {
  const overall = [];
  const byModule = new Map();
  let last = null;
  let count = 0;

  /** Record one event seen: `{seenAt, time, id, type, sub_type, module_id, outcome, scenes}`. */
  function record(entry) {
    last = entry.seenAt;
    count += 1;
    overall.push(entry);
    if (overall.length > size) {
      overall.shift();
    }
    if (entry.module_id) {
      const list = byModule.get(entry.module_id) ?? [];
      byModule.delete(entry.module_id); // re-inserted last: most recently seen
      list.push(entry);
      if (list.length > perModule) {
        list.shift();
      }
      byModule.set(entry.module_id, list);
      if (byModule.size > maxModules) {
        byModule.delete(byModule.keys().next().value);
      }
    }
    return entry;
  }

  return {
    record,
    /** The last `n` events overall, oldest first. */
    recent: (n = size) => overall.slice(-n),
    /** The last events of a module id, oldest first. */
    forModule: (id) => [...(byModule.get(id) ?? [])],
    lastAt: () => last,
    total: () => count,
  };
}

/** Whether a Netatmo error is a scope refusal (403, error code 13). */
function isScopeError(err) {
  return err?.status === 403 && err?.body?.error?.code === SCOPE_ERROR_CODE;
}

/**
 * Create the getevents poll.
 * @param {object} deps dependencies
 * @param {object} deps.client Netatmo API client (getEvents)
 * @param {object} deps.events momentary-event engine (events.js handleEvent)
 * @param {() => number} [deps.now] clock (tests)
 * @param {object} [deps.logger] logger (tests)
 * @param {object} [deps.history] events history (createEventsPollHistory)
 * @param {number} [deps.size] events asked per call
 * @param {number} [deps.minIntervalMs] minimum delay between two polls of a home
 * @param {number} [deps.maxAgeMs] age beyond which an event is not published
 */
export function createEventsPoll({
  client,
  events,
  now = Date.now,
  logger = defaultLogger,
  history = createEventsPollHistory(),
  size = EVENTS_POLL_SIZE,
  minIntervalMs = EVENTS_POLL_MIN_INTERVAL_MS,
  maxAgeMs = EVENTS_POLL_MAX_AGE_MS,
}) {
  // Per home: {seeded, seen (ordered set of keys), newest {time, id}, lastPollAt}.
  const homes = new Map();
  const health = {
    lastAttemptAt: null,
    lastSuccessAt: null,
    failures: 0,
    lastError: null,
    published: 0,
  };
  let inFlight = null;

  function homeState(homeId) {
    if (!homes.has(homeId)) {
      homes.set(homeId, { seeded: false, seen: new Set(), newest: null, lastPollAt: null });
    }
    return homes.get(homeId);
  }

  /** Remember a key as seen, within the bounded set. */
  function markSeen(state, key) {
    state.seen.add(key);
    if (state.seen.size > EVENTS_POLL_SEEN_SIZE) {
      state.seen.delete(state.seen.values().next().value);
    }
  }

  /** Hand one new item to the shared path, unless it is a startup seed or too old. */
  async function processItem(state, item) {
    const { summary, event } = item;
    let outcome;
    let scenes = 0;
    if (!state.seeded) {
      outcome = 'startup';
    } else if (event.time === undefined || now() - event.time > maxAgeMs) {
      outcome = 'too_old';
    } else {
      try {
        const result = await events.handleEvent(event);
        ({ outcome } = result);
        scenes = result.scenes ?? 0;
      } catch (err) {
        logger.warn(`getevents: publishing a ${event.type} event failed: ${err.message}`);
        outcome = 'error';
      }
      if (outcome === 'published' || outcome === 'cleared') {
        health.published += 1;
      }
    }
    history.record({ seenAt: now(), ...summary, outcome, scenes });
  }

  /** Poll one home; throws the Netatmo error. */
  async function pollHome(homeId) {
    const state = homeState(homeId);
    state.lastPollAt = now();
    const raw = await client.getEvents(homeId, { size, timeoutMs: EVENTS_POLL_TIMEOUT_MS });
    const items = raw
      .flatMap((entry) => normalizeGetEvent(entry, homeId))
      .filter((item) => !state.seen.has(item.key))
      // Oldest first: the detections are published in the order they happened.
      .sort((a, b) => (a.event.time ?? 0) - (b.event.time ?? 0));
    for (const item of items) {
      if (state.seen.has(item.key)) {
        continue; // the same key twice in one answer
      }
      markSeen(state, item.key);
      if (item.event.time !== undefined && item.event.time >= (state.newest?.time ?? -Infinity)) {
        state.newest = { time: item.event.time, id: item.summary.id ?? null };
      }
      await processItem(state, item);
    }
    if (!state.seeded) {
      state.seeded = true;
      logger.info(
        `getevents: ${items.length} event(s) already in home ${homeId} at startup — recorded, not published`,
      );
    }
  }

  /** Log a failed home poll: warn on the first failure of a streak only. */
  function reportFailure(homeId, err) {
    const scope = isScopeError(err);
    const reason = scope
      ? 'Netatmo refused it (missing scope rights) — click Connect again on the Configuration screen to grant the camera / door entry permissions'
      : err.message;
    health.lastError = scope ? 'missing scope rights (click Connect again)' : err.message;
    const message = `getevents failed for home ${homeId}: ${reason} — the detections wait for the webhooks or the next cycle`;
    if (health.failures === 0) {
      logger.warn(message);
    } else {
      logger.debug(message);
    }
  }

  async function runPoll(config, homeList) {
    const eligible = eventsPollHomes(config, homeList);
    const eligibleIds = new Set(eligible.map((home) => home.id));
    // A home no longer eligible (toggle off, camera removed) is forgotten: if
    // it comes back, it is seeded again instead of replaying what it missed.
    for (const homeId of homes.keys()) {
      if (!eligibleIds.has(homeId)) {
        homes.delete(homeId);
      }
    }
    let attempted = false;
    let failed = false;
    for (const home of eligible) {
      const state = homeState(home.id);
      if (state.lastPollAt !== null && now() - state.lastPollAt < minIntervalMs) {
        continue; // polled a moment ago (a webhook-triggered refresh)
      }
      attempted = true;
      try {
        await pollHome(home.id);
      } catch (err) {
        reportFailure(home.id, err);
        failed = true;
      }
    }
    if (!attempted) {
      return;
    }
    health.lastAttemptAt = now();
    if (failed) {
      health.failures += 1;
      return;
    }
    if (health.failures > 0) {
      logger.info(`getevents answers again after ${health.failures} failed cycle(s)`);
    }
    health.failures = 0;
    health.lastError = null;
    health.lastSuccessAt = now();
  }

  /**
   * Poll the eligible homes (single-flight: a poll in progress is shared).
   * Never throws.
   * @param {object} config normalized configuration
   * @param {Array<object>} homeList homes summaries of the last load
   * @returns {Promise<void>}
   */
  function poll(config, homeList) {
    if (!inFlight) {
      inFlight = runPoll(config, homeList)
        .catch((err) => logger.warn(`getevents poll failed: ${err.message}`))
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  /**
   * The `events` family of the health (null until the first poll attempt).
   * @returns {{family: string, lastSuccessAt: number|null, failures: number}|null} the entry
   */
  function getHealth() {
    if (health.lastAttemptAt === null) {
      return null;
    }
    return {
      family: EVENTS_HEALTH_FAMILY,
      lastSuccessAt: health.lastSuccessAt,
      failures: health.failures,
    };
  }

  /**
   * State of the poll for the Device diagnostic report.
   * @returns {object} health, homes polled (newest event seen) and history
   */
  function status() {
    return {
      ...health,
      homes: [...homes].map(([id, state]) => ({
        id,
        seeded: state.seeded,
        lastPollAt: state.lastPollAt,
        newest: state.newest,
      })),
      history,
    };
  }

  return { poll, getHealth, status, history };
}
