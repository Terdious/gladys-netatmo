// -----------------------------------------------------------------------------
// BTicino Classe 300X / Classe 300 EOS door entry — diagnostic log (issue #59).
//
// While the `bticino_api` toggle is on, the integration writes to its logs, at
// info level and tagged BTICINO_DIAGNOSTIC_TAG:
//   - the raw homesdata / homestatus entries of every BTicino module (`BN*`
//     type), plus their homestatus `errors` entries — on the first complete
//     load, then only when their content changes (never every 120 s cycle);
//   - every webhook event about a BTicino module (its push/event/module type
//     starts with `BN`, or its module id is a known BTicino module), raw.
// The real payloads of step 1 came from these lines; they keep collecting
// what is still unknown (the ring webhook, any state Netatmo adds later).
// The "Device diagnostic" action (src/netatmo/diagnostic.js) gives the same
// data on demand, for any module.
//
// The lines may end up pasted in a public issue: secrets are redacted (see
// src/netatmo/redact.js), while the ids the maintainer needs (module, bridge,
// home, event ids) are kept. Each line is bounded to
// BTICINO_DIAGNOSTIC_MAX_LINE characters.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { BTICINO_DIAGNOSTIC_TAG, BTICINO_DIAGNOSTIC_MAX_LINE } from './constants.js';
import { redactForDiagnostic } from './redact.js';

// Moved to src/netatmo/redact.js (shared with the Device diagnostic action).
export { redactForDiagnostic };

const defaultLogger = createLogger({ name: 'netatmo-bticino' });

// homestatus fields that move without any state change (signal, timestamps):
// left out of the change detection — a signal that drifts by one point must
// not re-log the whole entry every cycle — but kept in the logged content.
const VOLATILE_KEYS = new Set([
  'wifi_strength',
  'rf_strength',
  'last_seen',
  'last_activity',
  'last_message',
  'last_status_store',
]);

/**
 * Whether a Netatmo module type is a BTicino one (`BN` prefix: BNCX, BNEU,
 * BNDL, BNSL… — the Smarther BNS included, harmless).
 * @param {unknown} type module type
 * @returns {boolean} true for a BTicino module type
 */
export function isBticinoType(type) {
  return typeof type === 'string' && type.startsWith('BN');
}

/**
 * One tagged diagnostic line: `<tag> <label>: <redacted JSON>`, cut at
 * BTICINO_DIAGNOSTIC_MAX_LINE characters with an explicit marker.
 * @param {string} label what the payload is
 * @param {unknown} payload raw payload (redacted here)
 * @param {number} [maxLength] line bound
 * @returns {string} the line
 */
export function formatDiagnosticLine(label, payload, maxLength = BTICINO_DIAGNOSTIC_MAX_LINE) {
  let json;
  try {
    json = JSON.stringify(redactForDiagnostic(payload));
  } catch (err) {
    json = `<unserializable: ${err.message}>`;
  }
  const line = `${BTICINO_DIAGNOSTIC_TAG} ${label}: ${json}`;
  if (line.length <= maxLength) {
    return line;
  }
  return `${line.slice(0, maxLength)} …[truncated, ${line.length} characters in total]`;
}

/**
 * The raw entries of the BTicino modules of one home, per source, exactly as
 * Netatmo sent them (no merge). homestatus `errors` entries carry no type:
 * they are kept when their id is a BTicino module of homesdata.
 * @param {string} homeId Netatmo home id
 * @param {Array} modulesHomeData homesdata `modules` of the home
 * @param {Array} modulesHomestatus homestatus `modules` of the home
 * @param {Array} [errors] homestatus `errors` of the home
 * @returns {{home_id: string, homesdata: Array, homestatus: Array, errors: Array}|null}
 *   the entries, null when the home has no BTicino module at all
 */
export function bticinoEntriesOf(
  homeId,
  modulesHomeData = [],
  modulesHomestatus = [],
  errors = [],
) {
  const homesdata = (modulesHomeData ?? []).filter((module) => isBticinoType(module?.type));
  const homestatus = (modulesHomestatus ?? []).filter((module) => isBticinoType(module?.type));
  const ids = new Set([...homesdata, ...homestatus].map((module) => module.id));
  const bticinoErrors = (Array.isArray(errors) ? errors : []).filter(
    (error) => error && ids.has(error.id),
  );
  if (homesdata.length === 0 && homestatus.length === 0) {
    return null;
  }
  return { home_id: homeId, homesdata, homestatus, errors: bticinoErrors };
}

// Webhook fields naming a module type or an event type ("BNEU-…").
const WEBHOOK_TYPE_FIELDS = [
  'push_type',
  'event_type',
  'type',
  'module_type',
  'device_type',
  'camera_type',
];
// Webhook fields naming a module.
const WEBHOOK_ID_FIELDS = ['module_id', 'device_id', 'camera_id', 'bridge', 'id'];

/**
 * Whether a webhook payload is about a BTicino module: one of its type
 * fields starts with `BN` (e.g. `push_type: "BNEU-…"`), or one of its module
 * id fields is a known BTicino module.
 * @param {object} payload parsed webhook body
 * @param {Set<string>} [knownIds] ids of the BTicino modules of the last loads
 * @returns {boolean} true for a BTicino event
 */
export function isBticinoWebhook(payload, knownIds = new Set()) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  if (WEBHOOK_TYPE_FIELDS.some((field) => isBticinoType(payload[field]))) {
    return true;
  }
  return WEBHOOK_ID_FIELDS.some(
    (field) => typeof payload[field] === 'string' && knownIds.has(payload[field]),
  );
}

/** Change signature of an entry: its redacted JSON without the volatile keys. */
function signatureOf(entry) {
  const stable = Object.fromEntries(
    Object.entries(entry ?? {}).filter(([key]) => !VOLATILE_KEYS.has(key)),
  );
  return JSON.stringify(redactForDiagnostic(stable));
}

/**
 * Create the BTicino diagnostic logger.
 * @param {object} [deps] dependencies
 * @param {{info: Function}} [deps.logger] logger (tests)
 * @returns {{logLoad: Function, logWebhook: Function, reset: Function, knownIds: () => Set<string>}}
 */
export function createBticinoDiagnostic({ logger = defaultLogger } = {}) {
  // Last logged signature per `<source>|<home id>|<module id>`.
  const signatures = new Map();
  // Last logged summary per home id.
  const summaries = new Map();
  // Ids of the BTicino modules seen by the loads (webhook matching).
  const ids = new Set();
  // Whether the "no BTicino module found" hint was logged (once).
  let emptyLogged = false;

  function logEntry(source, homeId, entry) {
    const key = `${source}|${homeId}|${entry?.id}`;
    const signature = signatureOf(entry);
    if (signatures.get(key) === signature) {
      return false;
    }
    const changed = signatures.has(key);
    signatures.set(key, signature);
    logger.info(
      formatDiagnosticLine(
        `${source} ${entry?.type ?? 'error'} ${entry?.id} (home ${homeId})${changed ? ' changed' : ''}`,
        entry,
      ),
    );
    return true;
  }

  /**
   * Log the BTicino entries of a load (loadAccount `bticino`), on change only.
   * @param {Array} homes per-home entries (see bticinoEntriesOf)
   * @param {{partial?: boolean}} [options] a partial load never reports a
   *   module as gone, nor the account as having none
   */
  function logLoad(homes = [], { partial = false } = {}) {
    const seen = new Set();
    for (const home of homes) {
      const homeId = home.home_id;
      const summary = `home ${homeId}: ${home.homesdata.length} BTicino module(s) in homesdata (${home.homesdata
        .map((module) => module.type)
        .join(', ')}), ${home.homestatus.length} in homestatus, ${home.errors.length} in errors`;
      if (summaries.get(homeId) !== summary) {
        summaries.set(homeId, summary);
        logger.info(`${BTICINO_DIAGNOSTIC_TAG} ${summary}`);
      }
      for (const [source, entries] of [
        ['homesdata', home.homesdata],
        ['homestatus', home.homestatus],
        ['homestatus-error', home.errors],
      ]) {
        for (const entry of entries) {
          seen.add(`${source}|${homeId}|${entry?.id}`);
          if (typeof entry?.id === 'string') {
            ids.add(entry.id);
          }
          logEntry(source, homeId, entry);
        }
      }
    }
    if (partial) {
      return;
    }
    for (const key of [...signatures.keys()]) {
      if (!seen.has(key)) {
        signatures.delete(key);
        const [source, homeId, id] = key.split('|');
        logger.info(
          `${BTICINO_DIAGNOSTIC_TAG} ${source} ${id} (home ${homeId}) no longer reported`,
        );
      }
    }
    if (homes.length === 0 && !emptyLogged) {
      emptyLogged = true;
      logger.info(
        `${BTICINO_DIAGNOSTIC_TAG} no BTicino module (BN*) in homesdata — if you own a Classe 300X / Classe 300 EOS, click Connect again on the Configuration screen to grant the BTicino permissions`,
      );
    } else if (homes.length > 0) {
      emptyLogged = false;
    }
  }

  /**
   * Log a webhook event about a BTicino module, raw (redacted).
   * @param {unknown} body webhook body (object or JSON string)
   * @returns {boolean} true when the event was logged
   */
  function logWebhook(body) {
    let payload = body;
    if (typeof body === 'string') {
      try {
        payload = JSON.parse(body);
      } catch {
        return false;
      }
    }
    if (!isBticinoWebhook(payload, ids)) {
      return false;
    }
    const kind = payload.push_type ?? payload.event_type ?? 'event';
    logger.info(formatDiagnosticLine(`webhook ${kind}`, payload));
    return true;
  }

  /** Forget everything logged: the next load logs every entry again. */
  function reset() {
    signatures.clear();
    summaries.clear();
    emptyLogged = false;
  }

  return { logLoad, logWebhook, reset, knownIds: () => new Set(ids) };
}
