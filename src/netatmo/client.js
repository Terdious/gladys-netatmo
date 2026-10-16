// -----------------------------------------------------------------------------
// Authenticated Netatmo API client.
//
// Every call goes out with a fresh Bearer token (the OAuth manager refreshes
// it when needed); a 401/403 answer triggers ONE forced refresh + retry, in
// case Netatmo invalidated the token early.
//
// Endpoints mirror the core service: homesdata/homestatus (Energy topology +
// live status), getthermostatsdata (legacy Energy details), getstationsdata
// (Weather stations), gethomecoachsdata (Home Coach air quality monitors,
// issue #37), setroomthermpoint (thermostat setpoint), setthermmode (heating
// mode of a home) and setpersonsaway / setpersonshome (presence of the
// persons known to the cameras).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { NETATMO_BASE_URL, API_PATHS } from './constants.js';

const logger = createLogger({ name: 'netatmo-client' });

// Netatmo error code for "scope rights" refusals (403): NOT a token problem.
const SCOPE_ERROR_CODE = 13;
// Hard bound on any single Netatmo API request.
const REQUEST_TIMEOUT_MS = 30 * 1000;

/**
 * Create the Netatmo API client.
 * @param {object} deps dependencies
 * @param {object} deps.oauth OAuth manager (created by createNetatmoOAuth)
 * @param {typeof fetch} [deps.fetchImpl] fetch implementation (tests)
 * @param {string} [deps.baseUrl] Netatmo base URL (tests)
 */
export function createNetatmoClient({ oauth, fetchImpl = fetch, baseUrl = NETATMO_BASE_URL }) {
  async function requestOnce(path, accessToken, { method = 'GET', form, json } = {}) {
    return fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {}),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      ...(json ? { body: JSON.stringify(json) } : {}),
      // A hung connection must never stall a whole refresh cycle (the
      // single-flight would keep returning the stuck promise for minutes).
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /**
   * Authenticated request returning the parsed JSON body.
   * @param {string} path API path (from API_PATHS, may carry a query string)
   * @param {object} [options] `{method, form}` (form POST) or `{method, json}` (JSON POST)
   * @returns {Promise<object>} parsed response body
   */
  async function request(path, options = {}) {
    let accessToken = await oauth.ensureFreshAccessToken();
    let response = await requestOnce(path, accessToken, options);
    let body = await response.json().catch(() => ({}));
    // Netatmo reports an expired/invalid token as 401 OR 403 (error code 3);
    // a 403 with error code 13 is a SCOPE refusal — refreshing would burn a
    // refresh-token rotation and replay a non-idempotent POST for nothing.
    const isAuthFailure =
      (response.status === 401 || response.status === 403) &&
      body?.error?.code !== SCOPE_ERROR_CODE;
    if (isAuthFailure) {
      logger.warn(
        `Netatmo answered ${response.status} on ${path} — refreshing the token and retrying once`,
      );
      await oauth.refreshTokens();
      accessToken = await oauth.ensureFreshAccessToken();
      response = await requestOnce(path, accessToken, options);
      body = await response.json().catch(() => ({}));
    }
    if (!response.ok) {
      const error = new Error(`Netatmo API ${path} answered ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  /**
   * Fetch the homes topology (homes, rooms, modules).
   * @returns {Promise<Array>} the homes array (empty when none)
   */
  async function getHomesData() {
    const body = await request(API_PATHS.HOMESDATA);
    return body?.body?.homes ?? [];
  }

  /**
   * Fetch the live status of one home. Unreachable-module errors are reported
   * at `body.home.errors` or `body.errors` depending on the API mood.
   * @param {string} homeId Netatmo home id
   * @returns {Promise<{home: object, errors: Array}>} home status + errors
   */
  async function getHomeStatus(homeId) {
    const query = new URLSearchParams({ home_id: homeId }).toString();
    const body = await request(`${API_PATHS.HOMESTATUS}?${query}`);
    if (body?.status !== 'ok' || !body?.body?.home) {
      return { home: undefined, errors: [] };
    }
    const { home } = body.body;
    return { home, errors: home.errors ?? body.body.errors ?? [] };
  }

  /**
   * Fetch the legacy thermostat data (relay plugs + thermostat modules).
   * @returns {Promise<Array>} the plugs array (each carries `modules`)
   */
  async function getThermostatsData() {
    const body = await request(API_PATHS.GET_THERMOSTATS);
    return body?.status === 'ok' ? (body?.body?.devices ?? []) : [];
  }

  /**
   * Fetch the weather stations (NAMain devices, each carrying `modules`).
   * @returns {Promise<Array>} the stations array
   */
  async function getStationsData() {
    const body = await request(API_PATHS.GET_WEATHER_STATIONS);
    return body?.status === 'ok' ? (body?.body?.devices ?? []) : [];
  }

  /**
   * Fetch the Home Coach / Smart Indoor Air Quality Monitors (NHC devices,
   * legacy API shaped like getstationsdata: `_id`, `station_name`,
   * `dashboard_data`, no modules).
   * @returns {Promise<Array>} the Home Coach devices array
   */
  async function getHomeCoachsData() {
    const body = await request(API_PATHS.GET_HOME_COACHS);
    return body?.status === 'ok' ? (body?.body?.devices ?? []) : [];
  }

  /**
   * Set a room thermostat setpoint (mode `manual`, like the core).
   * @param {{homeId: string, roomId: string, temp: number}} setpoint target
   * @returns {Promise<object>} parsed response body
   */
  async function setRoomThermpoint({ homeId, roomId, temp }) {
    return request(API_PATHS.SET_ROOM_THERMPOINT, {
      method: 'POST',
      form: { home_id: homeId, room_id: roomId, mode: 'manual', temp },
    });
  }

  /**
   * Set the heating mode of a whole home (issue #38): follow the schedule,
   * away or frost guard. `endtime` (UNIX seconds) bounds an away / frost
   * guard period; Netatmo ignores it for the schedule.
   * @param {string} homeId Netatmo home id
   * @param {string} mode `schedule` | `away` | `hg`
   * @param {number} [endtime] end of the away / frost guard period (UNIX seconds)
   * @returns {Promise<object>} parsed response body
   */
  async function setThermMode(homeId, mode, endtime) {
    const form = { home_id: homeId, mode };
    if (endtime !== undefined && endtime !== null && mode !== 'schedule') {
      form.endtime = String(Math.round(endtime));
    }
    return request(API_PATHS.SET_THERM_MODE, { method: 'POST', form });
  }

  /**
   * Mark one person as away, or the whole home as empty when no person is
   * given (issue #39) — what re-arms the camera monitoring set to follow the
   * presence.
   * @param {string} homeId Netatmo home id
   * @param {string} [personId] Netatmo person id; absent = everybody
   * @returns {Promise<object>} parsed response body
   */
  async function setPersonsAway(homeId, personId) {
    const form = { home_id: homeId };
    if (personId) {
      form.person_id = personId;
    }
    return request(API_PATHS.SET_PERSONS_AWAY, { method: 'POST', form });
  }

  /**
   * Mark persons as at home (issue #39). The ids travel as a repeated
   * `person_ids[]` form field, like pyatmo does.
   * @param {string} homeId Netatmo home id
   * @param {string[]} personIds Netatmo person ids
   * @returns {Promise<object>} parsed response body
   */
  async function setPersonsHome(homeId, personIds) {
    const form = [['home_id', homeId], ...personIds.map((id) => ['person_ids[]', id])];
    return request(API_PATHS.SET_PERSONS_HOME, { method: 'POST', form });
  }

  /**
   * Set the state of a module through the JSON /api/setstate endpoint: camera
   * monitoring on/off (core PR #2623) or a roller shutter target_position +
   * bridge (issue #34). Every field besides homeId/moduleId goes into the
   * module entry as is.
   * @param {{homeId: string, moduleId: string}} state target + module fields
   * @returns {Promise<object>} parsed response body
   */
  async function setState({ homeId, moduleId, ...fields }) {
    return request(API_PATHS.SET_STATE, {
      method: 'POST',
      json: { home: { id: homeId, modules: [{ id: moduleId, ...fields }] } },
    });
  }

  /**
   * Register a webhook URL at Netatmo (issue #5): Netatmo then POSTs every
   * event (Energy, camera, siren, smoke…) to this URL. Idempotent — safe to
   * re-register on every connection.
   * @param {string} url the Gladys Plus relay URL from gladys.getWebhooks()
   * @returns {Promise<object>} parsed response body
   */
  async function addWebhook(url) {
    return request(API_PATHS.ADD_WEBHOOK, { method: 'POST', form: { url } });
  }

  /**
   * Drop the registered webhook at Netatmo (on disconnect / key cleared).
   * @returns {Promise<object>} parsed response body
   */
  async function dropWebhook() {
    return request(API_PATHS.DROP_WEBHOOK, { method: 'POST', form: { app_types: 'app_security' } });
  }

  return {
    request,
    getHomesData,
    getHomeStatus,
    getThermostatsData,
    getStationsData,
    getHomeCoachsData,
    setRoomThermpoint,
    setThermMode,
    setPersonsAway,
    setPersonsHome,
    setState,
    addWebhook,
    dropWebhook,
  };
}
