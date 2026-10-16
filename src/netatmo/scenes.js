// -----------------------------------------------------------------------------
// Scene actions (issue #39, manifest `scene_actions`, Gladys 5.1+).
//
// A scene action is an OPERATION a scene author places in a scene, with
// parameters: "set the heating to away for 3 hours", "mark everybody away".
// Each one is declared in the manifest `scene_actions` field and handled here
// under the same key; index.js registers every entry with
// `gladys.onSceneAction(key, ...)`.
//
// The rules that matter (SDK contract):
//   - `fields` arrive RESOLVED: scene variables substituted (`string` fields),
//     defaults applied, validated by the core; a `"source": "devices"` field
//     is the chosen device external_id, an empty optional field is absent;
//   - resolve the declared `outputs` (scalars only), or `undefined`;
//   - throwing fails THIS action only: the scene logs it and continues;
//   - never fire a scene event as a consequence of a received action (a scene
//     bound to that event would loop through the integration).
//
// The Netatmo HOME an action applies to: the home of the chosen device (its
// `home_id` param) — the scene editor can only list Gladys devices, not
// Netatmo homes — or, when no device is chosen, the only home of the account
// that fits the action (an account with several homes must choose).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import {
  NETATMO_THERM_MODES,
  PARAMS,
  SCENE_ACTION_KEYS,
  ENERGY_MODULE_TYPES,
  CAMERA_MODULE_TYPES,
} from './constants.js';
import { getDeviceParam, rethrowScopeError, setHomeThermMode } from './setValue.js';

const logger = createLogger({ name: 'netatmo-scenes' });

// Longest away / frost guard period a scene may ask for (30 days).
export const MAX_DURATION_MINUTES = 30 * 24 * 60;

const HEATING_MODES = Object.values(NETATMO_THERM_MODES);

/**
 * Resolve the Netatmo home an action applies to.
 * @param {object} ctx `{gladys, telemetry}`
 * @param {string|undefined} deviceExternalId the chosen device, if any
 * @param {(home: object) => boolean} fits whether a home can run the action
 * @param {string} what what the action needs, for the error messages
 * @returns {object} the home summary (see discovery summarizeHome)
 */
export function resolveHome({ gladys, telemetry }, deviceExternalId, fits, what) {
  const homes = telemetry.getHomes();
  if (deviceExternalId) {
    const device = (gladys.devices ?? []).find((d) => d.external_id === deviceExternalId);
    if (!device) {
      throw new Error(`Device ${deviceExternalId} is not a Netatmo device of this Gladys`);
    }
    const homeId = getDeviceParam(device, PARAMS.HOME_ID);
    if (!homeId) {
      throw new Error(`Device ${device.name ?? deviceExternalId} belongs to no Netatmo home`);
    }
    // A home the last load did not list (yet): still usable by its id.
    return homes.find((home) => home.id === homeId) ?? { id: homeId, name: homeId, persons: [] };
  }
  const candidates = homes.filter(fits);
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length === 0) {
    throw new Error(`No Netatmo home with ${what} is known yet`);
  }
  throw new Error(
    `${candidates.length} Netatmo homes have ${what}: choose a device of the home in the action`,
  );
}

const hasModuleOf = (types) => (home) =>
  (home.modules ?? []).some((module) => types.includes(module.type));
/** The optional `person` field: absent, empty or blank (an empty variable) means none. */
const personFieldOf = (fields) => (typeof fields.person === 'string' ? fields.person.trim() : '');

const hasPersonsOrCamera = (home) =>
  (home.persons ?? []).length > 0 || hasModuleOf(CAMERA_MODULE_TYPES)(home);

/**
 * Find a known person of a home by name (the Netatmo pseudo, case and
 * surrounding spaces ignored) or by id.
 * @param {object} home home summary
 * @param {string} person name or id typed in the scene (or a scene variable)
 * @returns {{id: string, pseudo: string}} the person
 */
export function findPerson(home, person) {
  const wanted = String(person).trim().toLowerCase();
  const found = (home.persons ?? []).find(
    (entry) => entry.id.toLowerCase() === wanted || entry.pseudo?.trim().toLowerCase() === wanted,
  );
  if (!found) {
    throw new Error(`"${person}" is not a person known to the Netatmo home ${home.name}`);
  }
  return found;
}

/**
 * End of an away / frost guard period, `durationMinutes` from now.
 * @param {unknown} durationMinutes the optional duration field
 * @param {() => number} now clock (ms)
 * @returns {number|undefined} UNIX seconds, or undefined for "until changed"
 */
export function endtimeOf(durationMinutes, now) {
  if (durationMinutes === undefined || durationMinutes === null || durationMinutes === '') {
    return undefined;
  }
  const minutes = Number(durationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_DURATION_MINUTES) {
    throw new Error(`Invalid duration ${durationMinutes}: 1 to ${MAX_DURATION_MINUTES} minutes`);
  }
  return Math.round(now() / 1000 + minutes * 60);
}

export const SCENE_ACTIONS = {
  /**
   * Change the heating mode of a home: schedule, away or frost guard, the two
   * latter for an optional duration (setthermmode `endtime`).
   */
  async [SCENE_ACTION_KEYS.SET_HEATING_MODE](ctx, fields) {
    const { client, now = Date.now, refresh } = ctx;
    if (!HEATING_MODES.includes(fields.mode)) {
      throw new Error(`Unknown heating mode "${fields.mode}"`);
    }
    const home = resolveHome(ctx, fields.device, hasModuleOf(ENERGY_MODULE_TYPES), 'a heating');
    const endtime =
      fields.mode === NETATMO_THERM_MODES.SCHEDULE
        ? undefined
        : endtimeOf(fields.duration_minutes, now);
    logger.info(`Scene action: heating mode of ${home.id} -> ${fields.mode}`);
    await setHomeThermMode(client, home.id, fields.mode, endtime);
    if (refresh) {
      Promise.resolve()
        .then(refresh)
        .catch((err) =>
          logger.warn(`Refresh after the heating mode change failed: ${err.message}`),
        );
    }
    return { home_name: home.name };
  },

  /**
   * Mark one known person as away — or, without a person, the whole home as
   * empty (the presence-driven camera monitoring then re-arms).
   */
  async [SCENE_ACTION_KEYS.SET_PERSONS_AWAY](ctx, fields) {
    const home = resolveHome(ctx, fields.device, hasPersonsOrCamera, 'cameras');
    const name = personFieldOf(fields);
    const person = name ? findPerson(home, name) : undefined;
    logger.info(`Scene action: ${person ? 'one person' : 'everybody'} away in ${home.id}`);
    try {
      await ctx.client.setPersonsAway(home.id, person?.id);
    } catch (err) {
      rethrowScopeError(err);
    }
    return { home_name: home.name };
  },

  /** Mark one known person — or, without a person, every known person — at home. */
  async [SCENE_ACTION_KEYS.SET_PERSONS_HOME](ctx, fields) {
    const home = resolveHome(ctx, fields.device, hasPersonsOrCamera, 'cameras');
    const name = personFieldOf(fields);
    const personIds = name
      ? [findPerson(home, name).id]
      : (home.persons ?? []).map((person) => person.id);
    if (personIds.length === 0) {
      throw new Error(`The Netatmo home ${home.name} has no known person`);
    }
    logger.info(`Scene action: ${personIds.length} person(s) at home in ${home.id}`);
    try {
      await ctx.client.setPersonsHome(home.id, personIds);
    } catch (err) {
      rethrowScopeError(err);
    }
    return { home_name: home.name };
  },
};
