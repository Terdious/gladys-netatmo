// -----------------------------------------------------------------------------
// "Device diagnostic" action of the Configuration screen (manifest `actions`,
// key DEVICE_DIAGNOSTIC_ACTION_KEY), modelled on the gladys-tuya one.
//
// A plain-text report (the core renders the result as escaped text, line
// breaks only) a user copies into a GitHub issue to get a module supported or
// a bug understood:
//   - the integration version, the enabled families, the granted / missing
//     OAuth scopes, the health of every API family and of the webhooks;
//   - for ONE module (picked among the devices created in Gladys, or typed:
//     name or Netatmo id of a module not created): its type, name, home,
//     bridge, support status, the Gladys device and features the integration
//     publishes for it, its raw homesdata / homestatus entries, the fields
//     Netatmo reports that the integration does not use, the last webhook
//     events naming it and the last events the getevents poll saw for it
//     (events in getevents and no webhook = Netatmo does not deliver);
//   - with no module given: a summary of every module of the account.
// Everything raw goes through the shared redaction (src/netatmo/redact.js):
// tokens, URLs and e-mail addresses go, the ids stay — the report says so,
// the user reads it before posting it publicly.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

import { createLogger } from '@gladysassistant/integration-sdk';

import {
  DEVICE_DIAGNOSTIC_TAG,
  DEVICE_DIAGNOSTIC_MAX_ENTRY,
  DEVICE_DIAGNOSTIC_MAX_MODULES,
  WEBHOOK_HISTORY_SIZE,
  WEBHOOK_HISTORY_PER_MODULE,
  WEBHOOK_HISTORY_MAX_MODULES,
  SUPPORTED_CATEGORY_TYPE,
  requestedScopes,
} from './constants.js';
import { getModuleCategory, netatmoId } from './discovery.js';
import { convertDevice } from './convert.js';
import { UPDATE_MAPPINGS } from './updateMappings.js';
import { redactForDiagnostic } from './redact.js';
import { POLL_OUTCOME_LABELS } from './eventsPoll.js';
import { legrandNotExposedReason } from './legrand.js';

const defaultLogger = createLogger({ name: 'netatmo-diagnostic' });

export const ISSUES_URL = 'https://github.com/Terdious/gladys-netatmo/issues/new';

// Configuration toggle of each API family (support status lines).
const FAMILY_TOGGLES = {
  [SUPPORTED_CATEGORY_TYPE.ENERGY]: 'energy_api',
  [SUPPORTED_CATEGORY_TYPE.WEATHER]: 'weather_api',
  [SUPPORTED_CATEGORY_TYPE.SECURITY]: 'security_api',
  [SUPPORTED_CATEGORY_TYPE.SHUTTER]: 'shutter_api',
  [SUPPORTED_CATEGORY_TYPE.AIRCARE]: 'aircare_api',
  [SUPPORTED_CATEGORY_TYPE.BTICINO]: 'bticino_api',
  [SUPPORTED_CATEGORY_TYPE.LEGRAND]: 'legrand_api',
};

// Fields every module carries that the integration consumes for its
// topology, names and reachability (on top of the fields its UPDATE_MAPPINGS
// table reads): never reported as "not used".
const STRUCTURAL_FIELDS = new Set([
  'id',
  '_id',
  'type',
  'name',
  'module_name',
  'station_name',
  'room_id',
  'home_id',
  'bridge',
  'modules_bridged',
  'reachable',
  // Cameras: snapshot / live stream URLs (src/netatmo/camera.js).
  'vpn_url',
  'is_local',
]);

// Keys the integration itself adds to a raw device (src/netatmo/discovery.js):
// not Netatmo fields.
const INTERNAL_KEYS = new Set([
  'categoryAPI',
  'apiNotConfigured',
  'not_handled',
  'home',
  'room',
  'plug',
  'homestatus',
  'therm_mode',
  'therm_mode_endtime',
  'apiErrorCode',
  'grouped_modules',
  'modules',
]);

/** The integration version (package.json), "unknown" when unreadable. */
export function integrationVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/** Lowercase, trimmed, accents removed: "Éclairage " === "eclairage". */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

/** Parse a webhook body (object or JSON string); null when it is neither. */
function parseBody(body) {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return body && typeof body === 'object' ? body : null;
}

// Fields of a webhook payload naming a module (top level, or under the
// `extra_params` of the app-style pushes).
const WEBHOOK_ID_FIELDS = ['module_id', 'camera_id', 'device_id', 'bridge', 'id'];

/** Every module id a webhook payload names. */
export function webhookModuleIds(payload) {
  const ids = new Set();
  for (const source of [payload, payload?.extra_params]) {
    for (const field of WEBHOOK_ID_FIELDS) {
      if (typeof source?.[field] === 'string' && source[field].length > 0) {
        ids.add(source[field]);
      }
    }
  }
  return [...ids];
}

/**
 * One-line summary of a relayed webhook body, for the info log: its push /
 * event type and the module ids it names — never the payload itself.
 * @param {unknown} body raw webhook body (object or JSON string)
 * @returns {string} the summary
 */
export function describeWebhookBody(body) {
  const payload = parseBody(body);
  if (!payload) {
    const size = typeof body === 'string' ? `${body.length} characters` : typeof body;
    return `non-JSON body (${size}) — ignored`;
  }
  const type = payload.push_type ?? payload.event_type ?? 'no push_type';
  const ids = webhookModuleIds(payload);
  return `${type}${ids.length > 0 ? ` (${ids.join(', ')})` : ''}`;
}

/**
 * In-memory ring buffer of the recent webhook events (redacted on record):
 * the last ones overall, and the last ones per module id they name, for a
 * bounded number of ids (the least recently seen id goes first).
 * @param {object} [options] bounds and clock
 * @returns {{record: Function, recent: Function, forModule: Function,
 *   lastAt: () => number|null, total: () => number}} the history
 */
export function createWebhookHistory({
  now = Date.now,
  size = WEBHOOK_HISTORY_SIZE,
  perModule = WEBHOOK_HISTORY_PER_MODULE,
  maxModules = WEBHOOK_HISTORY_MAX_MODULES,
} = {}) {
  const overall = [];
  const byModule = new Map();
  let last = null;
  let count = 0;

  /**
   * Record one relayed webhook body. Never throws.
   * @param {unknown} body raw webhook body (object or JSON string)
   * @returns {object|null} the recorded entry, null when the body is not JSON
   */
  function record(body) {
    const payload = parseBody(body);
    if (!payload) {
      return null;
    }
    const at = now();
    const entry = {
      at,
      push_type: typeof payload.push_type === 'string' ? payload.push_type : undefined,
      event_type: typeof payload.event_type === 'string' ? payload.event_type : undefined,
      payload: redactForDiagnostic(payload),
    };
    last = at;
    count += 1;
    overall.push(entry);
    if (overall.length > size) {
      overall.shift();
    }
    for (const id of webhookModuleIds(payload)) {
      const list = byModule.get(id) ?? [];
      byModule.delete(id); // re-inserted last: most recently seen
      list.push(entry);
      if (list.length > perModule) {
        list.shift();
      }
      byModule.set(id, list);
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
    /** The last events naming a module id, oldest first. */
    forModule: (id) => [...(byModule.get(id) ?? [])],
    lastAt: () => last,
    total: () => count,
  };
}

/** ISO time of an epoch, or "never". */
function timeOf(at) {
  return typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : 'never';
}

/** Redacted, bounded JSON of a raw entry. */
export function redactedJson(value, maxLength = DEVICE_DIAGNOSTIC_MAX_ENTRY) {
  let json;
  try {
    json = JSON.stringify(redactForDiagnostic(value));
  } catch (err) {
    json = `<unserializable: ${err.message}>`;
  }
  if (json === undefined) {
    return 'none';
  }
  return json.length <= maxLength
    ? json
    : `${json.slice(0, maxLength)} …[truncated, ${json.length} characters in total]`;
}

/**
 * Index every module of a load: the raw homesdata / homestatus / errors
 * entries of the homes, and the raw devices of the load (legacy APIs and
 * BTicino modules grouped on their gateway included).
 * @param {object|null} load loadAccount result
 * @returns {Map<string, object>} module entry by Netatmo id, in account order
 */
export function indexModules(load) {
  const modules = new Map();
  const entryOf = (id) => {
    if (!modules.has(id)) {
      modules.set(id, { id });
    }
    return modules.get(id);
  };
  for (const home of load?.rawHomes ?? []) {
    const homeRef = { id: home.id, name: home.name };
    for (const module of home.homesdata ?? []) {
      if (typeof module?.id === 'string') {
        Object.assign(entryOf(module.id), { home: homeRef, homesdata: module });
      }
    }
    for (const module of home.homestatus ?? []) {
      if (typeof module?.id === 'string') {
        Object.assign(entryOf(module.id), { home: homeRef, homestatus: module });
      }
    }
    for (const error of home.errors ?? []) {
      if (typeof error?.id === 'string' && modules.has(error.id)) {
        const entry = modules.get(error.id);
        entry.errors = [...(entry.errors ?? []), error];
      }
    }
  }
  for (const device of load?.devices ?? []) {
    const id = netatmoId(device);
    if (!id) {
      continue;
    }
    entryOf(id).rawDevice = device;
    for (const module of device.grouped_modules ?? []) {
      const moduleId = netatmoId(module);
      if (moduleId) {
        Object.assign(entryOf(moduleId), { rawDevice: module, gateway: device });
      }
    }
  }
  return modules;
}

/** Type and name of an indexed module, whatever source carries them. */
function describe(entry) {
  const raw = entry.rawDevice ?? {};
  const type = entry.homesdata?.type ?? entry.homestatus?.type ?? raw.type ?? 'unknown';
  const name = entry.homesdata?.name ?? raw.name ?? raw.station_name ?? raw.module_name ?? entry.id;
  return { type, name };
}

/**
 * Support status of a module: the integration's category for its type, and
 * whether its family toggle is on.
 */
export function supportOf(type, config, rawDevice) {
  let { moduleSupported, categoryAPI, apiNotConfigured } = getModuleCategory(type, config);
  if (!moduleSupported && rawDevice && !rawDevice.not_handled && rawDevice.categoryAPI) {
    // Virtual devices (known persons) carry their own category.
    ({ categoryAPI } = rawDevice);
    moduleSupported = true;
    apiNotConfigured = Boolean(rawDevice.apiNotConfigured);
  }
  if (!moduleSupported) {
    return { supported: false, text: 'not supported by the integration' };
  }
  const toggle = FAMILY_TOGGLES[categoryAPI];
  return apiNotConfigured
    ? { supported: true, text: `supported, but its family is off (${toggle} toggle)` }
    : { supported: true, text: `supported (${categoryAPI} family)` };
}

/**
 * What the integration publishes for a module: the Gladys device it maps to
 * (its own, or its BTicino gateway's) and the features keyed by its id.
 * @returns {{device: object|null, features: Array<object>, reason?: string}} the mapping
 */
export function publishedFor(gladys, entry) {
  const top = entry.gateway ?? entry.rawDevice;
  if (!top) {
    return { device: null, features: [], reason: 'not in the last device load' };
  }
  let converted;
  try {
    converted = convertDevice(gladys, top);
  } catch (err) {
    return { device: null, features: [], reason: `conversion failed: ${err.message}` };
  }
  if (!converted) {
    let reason = 'no feature to publish';
    if (top.not_handled) {
      reason = 'module type not supported';
    } else if (top.apiNotConfigured) {
      reason = 'its family is off in the configuration';
    } else if (legrandNotExposedReason(top)) {
      // Legrand gateway, parent entry of a double switch (issue #60).
      reason = legrandNotExposedReason(top);
    }
    return { device: null, features: [], reason };
  }
  const prefix = `${gladys.externalId(entry.id)}:`;
  return {
    device: converted,
    features: converted.features.filter((feature) => feature.external_id.startsWith(prefix)),
  };
}

/**
 * The fields of a module's raw entries the integration does not use: not
 * structural (STRUCTURAL_FIELDS) and not read by its UPDATE_MAPPINGS table —
 * found by running the table on a recording proxy. The fastest way to spot a
 * value Netatmo reports and Gladys does not show.
 * @param {object} entry indexed module (see indexModules)
 * @returns {string[]} the unused field names, sorted
 */
export function unmappedFieldsOf(entry) {
  const { type } = describe(entry);
  const sources = [entry.homesdata, entry.homestatus].filter(Boolean);
  const merged = sources.length > 0 ? Object.assign({}, ...sources) : { ...entry.rawDevice };
  const read = new Set();
  const proxy = new Proxy(merged, {
    get(target, key) {
      if (typeof key === 'string') {
        read.add(key);
      }
      return target[key];
    },
  });
  const table = UPDATE_MAPPINGS[type];
  try {
    const mapping = typeof table === 'function' ? table(proxy) : table;
    for (const extract of Object.values(mapping ?? {})) {
      try {
        extract(proxy);
      } catch {
        // A partial payload may break an extractor: what it read is noted.
      }
    }
  } catch {
    // Same for a table built from the payload.
  }
  return Object.keys(merged)
    .filter((key) => !STRUCTURAL_FIELDS.has(key) && !INTERNAL_KEYS.has(key) && !read.has(key))
    .sort();
}

/**
 * Resolve the module(s) the action fields point at. `device` (a select of
 * the devices created in Gladys: their external_id) wins over `device_ref`
 * (free text: Netatmo id, Gladys device name, or Netatmo module name — case
 * and accents ignored).
 * @param {object} fields action fields
 * @param {Map<string, object>} modules indexed modules
 * @param {object} gladys SDK instance (devices, externalId)
 * @returns {{query: string|null, ids: string[]}} the query and the matched ids
 */
export function resolveModules(fields, modules, gladys) {
  const prefix = gladys.externalId('');
  const picked = String(fields?.device ?? '').trim();
  const typed = String(fields?.device_ref ?? '').trim();
  const query = picked || typed;
  if (!query) {
    return { query: null, ids: [] };
  }
  if (query.startsWith(prefix)) {
    // A created device: its external_id is `ext:netatmo:<Netatmo id>`.
    return { query, ids: [query.slice(prefix.length)] };
  }
  const wanted = normalizeName(query);
  const ids = new Set();
  for (const id of modules.keys()) {
    if (normalizeName(id) === wanted) {
      ids.add(id);
    }
  }
  if (ids.size === 0) {
    for (const device of gladys.devices ?? []) {
      if (normalizeName(device.name) === wanted && device.external_id?.startsWith(prefix)) {
        ids.add(device.external_id.slice(prefix.length));
      }
    }
    for (const [id, entry] of modules) {
      if (normalizeName(describe(entry).name) === wanted) {
        ids.add(id);
      }
    }
  }
  return { query, ids: [...ids] };
}

/** Whether the user created a device with this external_id in Gladys. */
function isCreated(gladys, externalId) {
  return (gladys.devices ?? []).some((device) => device.external_id === externalId);
}

/** One line per recent webhook event. */
function webhookLines(events, indent = '  ') {
  if (events.length === 0) {
    return [`${indent}none since the integration started`];
  }
  return events.map(
    (event) =>
      `${indent}${timeOf(event.at)} ${event.push_type ?? event.event_type ?? 'event'}: ${redactedJson(event.payload)}`,
  );
}

/**
 * One line per event seen by the getevents poll: event time, type / sub
 * type, Netatmo event id and what the integration did with it. The entries
 * hold no URL and no message (see eventsPoll.js); the line is redacted all
 * the same.
 */
function polledEventLines(entries, indent = '  ') {
  if (entries.length === 0) {
    return [`${indent}none since the integration started`];
  }
  return entries.map((entry) => {
    const type = `${entry.type ?? 'event'}${entry.sub_type !== undefined ? ` / ${entry.sub_type}` : ''}`;
    const outcome = POLL_OUTCOME_LABELS[entry.outcome] ?? entry.outcome;
    const scenes = entry.scenes > 0 ? `, ${entry.scenes} scene event(s)` : '';
    const ids = [
      entry.module_id ? redactForDiagnostic(entry.module_id) : null,
      entry.id ? `event ${redactForDiagnostic(entry.id)}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return `${indent}${timeOf(entry.time)} ${type} (${ids || 'no id'}): ${outcome}${scenes}`;
  });
}

/** The getevents poll line of the account health. */
function eventsPollLine(poll) {
  if (poll.lastAttemptAt === null) {
    return '  Events poll (getevents): not run yet (no camera, doorbell, alarm or door entry discovered with its family on)';
  }
  const newest = poll.homes
    .filter((home) => home.newest)
    .map((home) => `${home.id}: ${timeOf(home.newest.time)}`)
    .join(', ');
  return `  Events poll (getevents): last poll ${timeOf(poll.lastAttemptAt)}, ${poll.history.total()} event(s) seen since start, ${poll.published} detection(s) published from it${
    newest ? `, newest event per home ${newest}` : ''
  }${poll.lastError ? `, last error: ${poll.lastError}` : ''}`;
}

/** The header shared by both reports: versions, families, scopes, health. */
function headerLines(ctx) {
  const { config, scopes, health, webhook, loadError, load } = ctx;
  const families = Object.entries(FAMILY_TOGGLES)
    .filter(([, toggle]) => config[toggle])
    .map(([family, toggle]) => `${family} (${toggle})`);
  const lines = [
    'Netatmo integration — device diagnostic',
    `Integration version: ${ctx.version}`,
    `Report time: ${timeOf(ctx.now())}`,
    `Enabled families: ${families.length > 0 ? families.join(', ') : 'none'}`,
    `Scopes requested: ${scopes.requested.join(' ')}`,
    `Scopes granted: ${scopes.granted ? scopes.granted.join(' ') : 'unknown until the next token refresh'}`,
    `Scopes missing: ${scopes.missing.length > 0 ? `${scopes.missing.join(' ')} — click Connect again on the Configuration screen` : 'none'}`,
    '',
    'Account health:',
  ];
  if (loadError) {
    lines.push(`  Account load for this report failed: ${loadError}`);
  }
  lines.push(
    `  Last load: ${timeOf(health.lastLoadAt)}${health.partial ? ' (partial)' : ''}${
      load?.failed?.length ? ` — failed: ${load.failed.join(', ')}` : ''
    }`,
  );
  for (const family of health.families) {
    lines.push(
      `  ${family.family}: last success ${timeOf(family.lastSuccessAt)}, ${family.failures} consecutive failure(s)`,
    );
  }
  lines.push(`  Degraded: ${health.degraded ?? 'no'}`);
  lines.push(
    `  Webhook (Gladys Plus): ${webhook.registered ? 'registered at Netatmo' : 'not registered (poll only)'}, last event received ${timeOf(webhook.history.lastAt())}, ${webhook.history.total()} since start`,
  );
  if (webhook.check) {
    lines.push(`  Webhook URL held by Netatmo: ${describeWebhookCheck(webhook.check)}`);
  }
  if (ctx.eventsPoll) {
    lines.push(eventsPollLine(ctx.eventsPoll));
  }
  return lines;
}

/**
 * A webhook URL without its secret: scheme, host and the route segments
 * before the Open API key (`/v1/api/external-integration/` or the legacy
 * `/v1/api/netatmo/` of the former core service).
 * @param {string} url a webhook URL
 * @returns {string} the URL, key and what follows it redacted
 */
export function describeWebhookUrl(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const route = segments.slice(0, 3).join('/');
    return `${parsed.protocol}//${parsed.host}/${route}${segments.length > 3 ? '/<redacted>' : ''}`;
  } catch {
    return '<redacted url>';
  }
}

/** One line on the URL Netatmo holds versus the integration's. */
export function describeWebhookCheck(check) {
  if (check.error) {
    return `could not be read (${check.error})`;
  }
  if (!check.atNetatmo || check.atNetatmo.length === 0) {
    return 'none — Netatmo holds no webhook for this application';
  }
  if (check.matches) {
    return `the integration's URL (${describeWebhookUrl(check.ours)})`;
  }
  const held = check.atNetatmo.map(describeWebhookUrl).join(', ');
  return `${held} — NOT the integration's URL${check.ours ? ` (${describeWebhookUrl(check.ours)})` : ''}: another client (the developer portal field, the former core Netatmo service…) overwrote it; save the Gladys Plus key again to re-register`;
}

/** The report lines of one module. */
function moduleLines(ctx, modules, id) {
  const { gladys, config, webhook } = ctx;
  const entry = modules.get(id);
  if (!entry) {
    return [`Module ${id}: not found in the last account load.`];
  }
  const { type, name } = describe(entry);
  const support = supportOf(type, config, entry.rawDevice);
  const bridge = entry.homesdata?.bridge ?? entry.homestatus?.bridge ?? entry.rawDevice?.bridge;
  const published = publishedFor(gladys, entry);
  const lines = [
    `Module ${id}`,
    `  Type: ${type}`,
    `  Name: ${name}`,
    `  Home: ${entry.home ? `${entry.home.name} (${entry.home.id})` : 'none (legacy API)'}`,
    `  Bridge: ${bridge ?? 'none'}`,
    `  Reachable: ${entry.rawDevice?.reachable === false ? 'no' : entry.homestatus || entry.rawDevice ? 'yes' : 'unknown'}`,
    `  Support: ${support.text}`,
  ];
  if (published.device) {
    const deviceId = published.device.external_id;
    lines.push(
      `  Gladys device: "${published.device.name}" ${deviceId} (${published.device.model})${
        entry.gateway ? ' — the device of its door entry gateway' : ''
      }, ${isCreated(gladys, deviceId) ? 'created in Gladys' : 'not created in Gladys yet'}`,
    );
    lines.push(
      published.features.length > 0
        ? `  Features: ${published.features
            .map(
              (feature) =>
                `${feature.external_id.slice(gladys.externalId(id).length + 1)} (${feature.category}/${feature.type}${feature.read_only === false ? ', writable' : ''})`,
            )
            .join(', ')}`
        : '  Features: none for this module',
    );
  } else {
    lines.push(`  Gladys device: none (${published.reason})`);
  }
  const unmapped = unmappedFieldsOf(entry);
  lines.push(
    `  Fields not used by the integration: ${unmapped.length > 0 ? unmapped.join(', ') : 'none'}`,
  );
  if (entry.homesdata || entry.homestatus || entry.errors) {
    lines.push(`  homesdata: ${redactedJson(entry.homesdata)}`);
    lines.push(`  homestatus: ${redactedJson(entry.homestatus)}`);
    if (entry.errors) {
      lines.push(`  homestatus errors: ${redactedJson(entry.errors)}`);
    }
  } else if (entry.rawDevice) {
    const legacy = Object.fromEntries(
      Object.entries(entry.rawDevice).filter(([key]) => !INTERNAL_KEYS.has(key)),
    );
    lines.push(`  Legacy API payload: ${redactedJson(legacy)}`);
  }
  lines.push('  Recent webhook events naming it:');
  lines.push(...webhookLines(webhook.history.forModule(id), '    '));
  if (ctx.eventsPoll) {
    lines.push('  Last events seen by getevents:');
    lines.push(...polledEventLines(ctx.eventsPoll.history.forModule(id), '    '));
  }
  return lines;
}

/** The summary line of one module (and of the modules grouped on it). */
function summaryLine(ctx, entry, indent) {
  const { gladys, config } = ctx;
  const { type, name } = describe(entry);
  const support = supportOf(type, config, entry.rawDevice);
  let mapping;
  if (entry.gateway) {
    mapping = `grouped into the device of its gateway ${netatmoId(entry.gateway)}`;
  } else {
    const published = publishedFor(gladys, entry);
    mapping = published.device
      ? `device "${published.device.name}" (${isCreated(gladys, published.device.external_id) ? 'created' : 'not created'} in Gladys)`
      : `no Gladys device (${published.reason})`;
  }
  return `${indent}- ${type} "${name}" ${entry.id}: ${support.supported ? 'supported' : 'not supported'} — ${mapping}`;
}

/** The account summary: every module, per home, grouped modules indented. */
function summaryLines(ctx, modules) {
  const lines = ['Modules:'];
  const homes = new Map();
  const others = [];
  for (const entry of modules.values()) {
    if (entry.gateway) {
      continue; // listed under its gateway
    }
    if (entry.home) {
      const list = homes.get(entry.home.id) ?? { home: entry.home, entries: [] };
      list.entries.push(entry);
      homes.set(entry.home.id, list);
    } else {
      others.push(entry);
    }
  }
  const grouped = (gatewayId) =>
    [...modules.values()].filter(
      (entry) => entry.gateway && netatmoId(entry.gateway) === gatewayId,
    );
  for (const { home, entries } of homes.values()) {
    lines.push(`  Home "${home.name}" (${home.id}):`);
    for (const entry of entries) {
      lines.push(summaryLine(ctx, entry, '    '));
      for (const child of grouped(entry.id)) {
        lines.push(summaryLine(ctx, child, '      '));
      }
    }
  }
  if (others.length > 0) {
    lines.push('  Outside the homes (legacy APIs, virtual devices):');
    for (const entry of others) {
      lines.push(summaryLine(ctx, entry, '    '));
    }
  }
  if (modules.size === 0) {
    lines.push('  none (no account load yet)');
  }
  lines.push('', 'Last webhook events (all modules):');
  lines.push(...webhookLines(ctx.webhook.history.recent(5)));
  if (ctx.eventsPoll) {
    lines.push('', 'Last events seen by getevents (all modules):');
    lines.push(...polledEventLines(ctx.eventsPoll.history.recent(5)));
  }
  return lines;
}

/**
 * Build the diagnostic report.
 * @param {object} ctx `{gladys, config, version, now, scopes: {requested,
 *   granted, missing}, load, loadError, health, webhook: {registered, history},
 *   eventsPoll?: eventsPoll.status()}`
 * @param {object} fields the action fields (`device`, `device_ref`)
 * @returns {string} the plain-text report
 */
export function buildDiagnosticReport(ctx, fields = {}) {
  const modules = indexModules(ctx.load);
  const { query, ids } = resolveModules(fields, modules, ctx.gladys);
  const lines = headerLines(ctx);
  lines.push('');
  if (!query) {
    lines.push(...summaryLines(ctx, modules));
  } else if (ids.length === 0) {
    lines.push(`No Netatmo module matches "${query}" (name or Netatmo id). Account summary:`, '');
    lines.push(...summaryLines(ctx, modules));
  } else {
    const shown = ids.slice(0, DEVICE_DIAGNOSTIC_MAX_MODULES);
    if (ids.length > shown.length) {
      lines.push(
        `${ids.length} modules match "${query}": the first ${shown.length} are detailed.`,
        '',
      );
    }
    for (const id of shown) {
      lines.push(...moduleLines(ctx, modules, id), '');
    }
    // A gateway: the modules grouped on its device are detailed too.
    for (const id of shown) {
      for (const [childId, entry] of modules) {
        if (entry.gateway && netatmoId(entry.gateway) === id && !shown.includes(childId)) {
          lines.push(...moduleLines(ctx, modules, childId), '');
        }
      }
    }
  }
  while (lines.at(-1) === '') {
    lines.pop();
  }
  lines.push(
    '',
    `How to report: open an issue at ${ISSUES_URL} and paste this report. Read it first: tokens, URLs and e-mail addresses are redacted, but module, home and event ids and the names you gave your modules are kept.`,
  );
  return lines.join('\n');
}

/**
 * Run the action: fresh view of the account (a load sharing the burst
 * cache; the last load when it fails), the report, also logged at info
 * level for a user who cannot copy from the screen.
 * @param {object} deps `{gladys, oauth, telemetry, webhooks, webhookHistory,
 *   eventsPoll?, getConfig, logger?, now?}`
 * @param {object} fields the action fields
 * @returns {Promise<string>} the report
 */
export async function runDeviceDiagnostic(deps, fields = {}) {
  const {
    gladys,
    oauth,
    telemetry,
    webhooks,
    webhookHistory,
    eventsPoll,
    getConfig,
    logger = defaultLogger,
    now = Date.now,
  } = deps;
  const config = getConfig();
  try {
    // The select lists the created devices: make sure their names are fresh.
    await gladys.getDevices?.();
  } catch (err) {
    logger.debug(`getDevices failed before the diagnostic: ${err.message}`);
  }
  let load = null;
  let loadError = null;
  if (oauth.hasTokens()) {
    try {
      load = await telemetry.getAccount(config);
    } catch (err) {
      loadError = err.message;
      load = telemetry.getLastLoad?.() ?? null;
    }
  } else {
    loadError = 'the Netatmo account is not connected';
  }
  const report = buildDiagnosticReport(
    {
      gladys,
      config,
      version: integrationVersion(),
      now,
      scopes: {
        requested: requestedScopes(config),
        granted: oauth.grantedScopes?.() ?? null,
        missing: oauth.missingScopes(),
      },
      load,
      loadError,
      health: telemetry.getHealth(),
      webhook: {
        registered: Boolean(webhooks?.isRegistered?.()),
        history: webhookHistory,
        check: oauth.hasTokens() && webhooks?.check ? await webhooks.check() : null,
      },
      eventsPoll: eventsPoll?.status() ?? null,
    },
    fields,
  );
  logger.info(`${DEVICE_DIAGNOSTIC_TAG}\n${report}`);
  return report;
}
