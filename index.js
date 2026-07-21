// -----------------------------------------------------------------------------
// Entry point of the Gladys external integration.
//
// Role of this file: wire the SDK to the Netatmo modules (src/netatmo/). It
// holds NO Netatmo logic: OAuth2 lives in src/netatmo/oauth.js, API calls in
// src/netatmo/client.js. This file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. reports the connection status on the Configuration screen.
//
// The wiring is exported as `setupIntegration(gladys, deps)` so the e2e test
// exercises the REAL wiring instead of duplicating it; the singleton bootstrap
// below only runs when the file is the process entry point (the container).
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { pathToFileURL } from 'node:url';

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';

import { normalizeConfig } from './src/config.js';
import { createNetatmoOAuth, NotConnectedError } from './src/netatmo/oauth.js';
import { createNetatmoClient } from './src/netatmo/client.js';
import { CONNECTION_MESSAGES } from './src/netatmo/constants.js';

/**
 * Report the application-level connection status of the integration.
 * Defensive: an older Gladys core without the endpoint must never crash the
 * integration, so failures are only logged.
 */
async function reportConnectionStatus(gladys, connected, message) {
  try {
    await gladys.setConnectionStatus(connected, message);
  } catch (err) {
    logger.debug(`setConnectionStatus skipped (older Gladys core?): ${err.message}`);
  }
}

/**
 * Wire every SDK handler on the given instance.
 * @param {GladysIntegration} gladys SDK instance
 * @param {object} [deps] injectable dependencies (tests)
 * @param {typeof fetch} [deps.fetchImpl] fetch used for the Netatmo API
 * @param {string} [deps.netatmoBaseUrl] Netatmo base URL override
 * @returns {{oauth: object, client: object, getConfig: () => object}}
 */
export function setupIntegration(gladys, { fetchImpl = fetch, netatmoBaseUrl } = {}) {
  // Current configuration (hot-reloaded via onConfigUpdated).
  let config = normalizeConfig();

  const oauth = createNetatmoOAuth({
    gladys,
    getConfig: () => config,
    fetchImpl,
    ...(netatmoBaseUrl ? { baseUrl: netatmoBaseUrl } : {}),
  });
  const client = createNetatmoClient({
    oauth,
    fetchImpl,
    ...(netatmoBaseUrl ? { baseUrl: netatmoBaseUrl } : {}),
  });

  // Tokens wiped after the 24h grace window: ask the user to reconnect.
  oauth.onAuthLost(async (message) => {
    await reportConnectionStatus(gladys, false, message);
  });

  /**
   * Shared by the connected / config-updated paths: make sure the stored
   * tokens are usable, keep the refresh engine armed, and reflect the real
   * state on the Configuration screen.
   */
  async function syncConnection() {
    if (!config.client_id || !config.client_secret) {
      // Expected state on every fresh install, until the user fills the form.
      logger.warn('Netatmo client id / client secret not configured yet');
      await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.MISSING_CLIENT_CONFIG);
      return;
    }
    if (!oauth.hasTokens()) {
      logger.warn('Netatmo account not connected yet — waiting for the OAuth2 connection');
      await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.NOT_CONNECTED);
      return;
    }
    try {
      await oauth.ensureFreshAccessToken();
      oauth.scheduleTokenRefresh();
      await reportConnectionStatus(gladys, true);
      logger.info('Netatmo account connected, token refresh engine armed');
    } catch (err) {
      if (err instanceof NotConnectedError) {
        await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.NOT_CONNECTED);
        return;
      }
      if (err.transient) {
        // The refresh engine keeps retrying with backoff on its own.
        logger.warn(`Netatmo unreachable at startup (${err.message}) — retrying in the background`);
        oauth.scheduleTokenRefresh();
        await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.NETATMO_UNREACHABLE);
        return;
      }
      logger.error(`Netatmo token check failed: ${err.message}`);
      await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.RECONNECT_REQUIRED);
    }
  }

  // --- OAuth2: the user clicks Connect on the Configuration screen -----------
  gladys.onOAuthAuthorizeUrl(async (key, redirectUri) => {
    logger.info(`onOAuthAuthorizeUrl <- ${key}`);
    return oauth.buildAuthorizeUrl(redirectUri);
  });

  // --- OAuth2: Netatmo redirected the user back through the Gladys relay -----
  gladys.onOAuthCallback(async (key, params) => {
    logger.info(`onOAuthCallback <- ${key}`);
    await oauth.handleCallback(params);
    // Validate the brand-new tokens (and their scopes) with a real API call.
    const homes = await client.getHomesData();
    logger.info(`Netatmo account connected: ${homes.length} home(s) visible`);
    await reportConnectionStatus(gladys, true);
  });

  // --- Discovery: Gladys asks for the list of devices ------------------------
  gladys.onScanRequest(async () => {
    // Device discovery (Weather / Energy / Security) lands in the next
    // milestones — see the roadmap issue of the repository.
    logger.info('onScanRequest -> device discovery not implemented yet');
  });

  // --- Configuration updated by the user -------------------------------------
  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('onConfigUpdated -> new configuration received');
    config = normalizeConfig(newConfig);
    oauth.loadFromConfig(config);
    await syncConnection();
  });

  // --- Connection lifecycle --------------------------------------------------
  gladys.on('connected', async () => {
    logger.info('WebSocket connected to Gladys');
    try {
      config = normalizeConfig(await gladys.getConfig());
      oauth.loadFromConfig(config);
      await syncConnection();
    } catch (err) {
      logger.error('Post-connection initialization failed', err);
    }
  });

  gladys.on('disconnected', () => {
    logger.warn('WebSocket disconnected - the SDK will try to reconnect');
    oauth.stop();
  });

  return { oauth, client, getConfig: () => config };
}

// --- Startup (container entry point only) ------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const gladys = new GladysIntegration();
  const { oauth } = setupIntegration(gladys);

  // The SDK disconnects cleanly and exits with code 0 when the supervisor
  // stops the container (SIGTERM/SIGINT).
  gladys.handleShutdown((signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
    oauth.stop();
  });

  logger.info('Starting the Netatmo integration...');
  gladys.connect().catch((err) => {
    logger.error('Initial connection failed', err);
    process.exit(1);
  });
}
