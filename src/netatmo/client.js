// -----------------------------------------------------------------------------
// Minimal authenticated Netatmo API client.
//
// Every call goes out with a fresh Bearer token (the OAuth manager refreshes
// it when needed); a 401/403 answer triggers ONE forced refresh + retry, in
// case Netatmo invalidated the token early.
//
// This first milestone only needs `getHomesData` (used to validate a fresh
// connection); the device discovery milestones will grow this module with
// homestatus / getstationsdata / setroomthermpoint, mirroring the core paths.
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
  async function requestOnce(path, accessToken) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    return response;
  }

  /**
   * Authenticated GET returning the parsed JSON body.
   * @param {string} path API path (from API_PATHS)
   * @returns {Promise<object>} parsed response body
   */
  async function apiGet(path) {
    let accessToken = await oauth.ensureFreshAccessToken();
    let response = await requestOnce(path, accessToken);
    if (response.status === 401 || response.status === 403) {
      // Token invalidated server-side before its expiry: refresh once, retry.
      logger.warn(
        `Netatmo answered ${response.status} on ${path} — refreshing the token and retrying once`,
      );
      await oauth.refreshTokens();
      accessToken = await oauth.ensureFreshAccessToken();
      response = await requestOnce(path, accessToken);
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
    const body = await apiGet(API_PATHS.HOMESDATA);
    return body?.body?.homes ?? [];
  }

  return { apiGet, getHomesData };
}
