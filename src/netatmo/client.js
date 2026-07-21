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

/**
 * Create the Netatmo API client.
 * @param {object} deps dependencies
 * @param {object} deps.oauth OAuth manager (created by createNetatmoOAuth)
 * @param {typeof fetch} [deps.fetchImpl] fetch implementation (tests)
 * @param {string} [deps.baseUrl] Netatmo base URL (tests)
 */
export function createNetatmoClient({ oauth, fetchImpl = fetch, baseUrl = NETATMO_BASE_URL }) {
  async function requestOnce(path, accessToken, { method = 'GET', form } = {}) {
    return fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
  }

  /**
   * Authenticated request returning the parsed JSON body.
   * @param {string} path API path (from API_PATHS, may carry a query string)
   * @param {object} [options] `{method, form}` for form POSTs
   * @returns {Promise<object>} parsed response body
   */
  async function request(path, options = {}) {
    let accessToken = await oauth.ensureFreshAccessToken();
    let response = await requestOnce(path, accessToken, options);
    if (response.status === 401 || response.status === 403) {
      // Token invalidated server-side before its expiry: refresh once, retry.
      logger.warn(
        `Netatmo answered ${response.status} on ${path} — refreshing the token and retrying once`,
      );
      await oauth.refreshTokens();
      accessToken = await oauth.ensureFreshAccessToken();
      response = await requestOnce(path, accessToken, options);
    }
    const body = await response.json().catch(() => ({}));
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

  return {
    request,
    getHomesData,
    getHomeStatus,
    getThermostatsData,
    getStationsData,
    setRoomThermpoint,
  };
}
