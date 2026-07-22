// -----------------------------------------------------------------------------
// Authenticated Netatmo API client.
//
// Every call goes out with a fresh Bearer token (the OAuth manager refreshes
// it when needed); a 401/403 answer triggers ONE forced refresh + retry, in
// case Netatmo invalidated the token early.
//
// Endpoints mirror the core service: homesdata/homestatus (Energy topology +
// live status), getthermostatsdata (legacy Energy details), getstationsdata
// (Weather stations) and setroomthermpoint (thermostat setpoint).
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
   * Set the state of a module (camera monitoring on/off), through the JSON
   * /api/setstate endpoint (core PR #2623).
   * @param {{homeId: string, moduleId: string, monitoring: string}} state target
   * @returns {Promise<object>} parsed response body
   */
  async function setState({ homeId, moduleId, monitoring }) {
    return request(API_PATHS.SET_STATE, {
      method: 'POST',
      json: { home: { id: homeId, modules: [{ id: moduleId, monitoring }] } },
    });
  }

  return {
    request,
    getHomesData,
    getHomeStatus,
    getThermostatsData,
    getStationsData,
    setRoomThermpoint,
    setState,
  };
}
