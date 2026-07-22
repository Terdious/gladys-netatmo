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
import { createTelemetry } from './src/netatmo/telemetry.js';
import { setDeviceValue } from './src/netatmo/setValue.js';
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
 * @param {number} [deps.refreshIntervalMs] telemetry cadence override (tests)
 * @returns {{oauth: object, client: object, telemetry: object, getConfig: () => object}}
 */
export function setupIntegration(
  gladys,
  { fetchImpl = fetch, netatmoBaseUrl, refreshIntervalMs } = {},
) {
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
  const telemetry = createTelemetry({
    gladys,
    client,
    fetchImpl,
    ...(refreshIntervalMs ? { refreshIntervalMs } : {}),
  });

  // Tokens wiped after the 24h grace window: ask the user to reconnect.
  oauth.onAuthLost(async (message) => {
    telemetry.stop();
    await reportConnectionStatus(gladys, false, message);
  });

  // A scheduled refresh recovered after failures (Netatmo/DNS outage over):
  // reflect it on the Configuration screen and make sure telemetry runs.
  oauth.onRefreshRecovered(async () => {
    await reportConnectionStatus(gladys, true);
    telemetry.start(config);
  });

  /**
   * Shared by the connected / config-updated paths: make sure the stored
   * tokens are usable, keep the refresh engine armed, and reflect the real
   * state on the Configuration screen.
   */
  async function syncConnection() {
    if (!config.client_id || !config.client_secret) {
      // Expected state on every fresh install, until the user fills the form.
      // Stop any running loop: the previous credentials are gone.
      telemetry.stop();
      logger.warn('Netatmo client id / client secret not configured yet');
      await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.MISSING_CLIENT_CONFIG);
      return;
    }
    if (!oauth.hasTokens()) {
      telemetry.stop();
      logger.warn('Netatmo account not connected yet — waiting for the OAuth2 connection');
      await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.NOT_CONNECTED);
      return;
    }
    try {
      await oauth.ensureFreshAccessToken();
      oauth.scheduleTokenRefresh();
      await reportConnectionStatus(gladys, true);
      // Start (or restart) the global value refresh loop for the devices the
      // user created in Gladys.
      telemetry.start(config);
      logger.info('Netatmo account connected, token refresh and telemetry engines armed');
    } catch (err) {
      if (err instanceof NotConnectedError) {
        telemetry.stop();
        await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.NOT_CONNECTED);
        return;
      }
      if (err.transient) {
        // The refresh engine keeps retrying with backoff on its own — and
        // telemetry STILL starts: a cycle failing while Netatmo is down is
        // caught and retried every interval, so states resume by themselves
        // when the cloud comes back (the recovered hook flips the status).
        logger.warn(`Netatmo unreachable at startup (${err.message}) — retrying in the background`);
        oauth.scheduleTokenRefresh();
        telemetry.start(config);
        await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.NETATMO_UNREACHABLE);
        return;
      }
      logger.error(`Netatmo token check failed: ${err.message}`);
      telemetry.stop();
      await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.RECONNECT_REQUIRED);
    }
  }

  // --- OAuth2: the user clicks Connect on the Configuration screen -----------
  gladys.onOAuthAuthorizeUrl(async (key, redirectUri) => {
    logger.info(`onOAuthAuthorizeUrl <- ${key}`);
    if (!config.client_id || !config.client_secret) {
      // The credentials may have just been saved: the config-updated push and
      // the connect click can race, so re-fetch the store before giving up.
      try {
        config = normalizeConfig(await gladys.getConfig());
        oauth.loadFromConfig(config);
      } catch (err) {
        logger.warn(`Config re-fetch before connect failed: ${err.message}`);
      }
    }
    if (!config.client_id || !config.client_secret) {
      // The user filled the form but never saved it (the front does not save
      // on Connect): surface an actionable hint right on the config screen —
      // the front only shows a generic error for the failed command itself.
      await reportConnectionStatus(gladys, false, CONNECTION_MESSAGES.SAVE_CREDENTIALS_FIRST);
      throw new Error('Netatmo client id / client secret must be saved first');
    }
    return oauth.buildAuthorizeUrl(redirectUri);
  });

  // --- OAuth2: Netatmo redirected the user back through the Gladys relay -----
  gladys.onOAuthCallback(async (key, params) => {
    logger.info(`onOAuthCallback <- ${key}`);
    await oauth.handleCallback(params);
    // Validate the brand-new tokens with a real API call — but a transient
    // failure here (Netatmo 500 seconds after a successful exchange) must not
    // report the WHOLE connection as failed: the tokens are stored and
    // refreshing, and the telemetry loop surfaces any real problem.
    try {
      const homes = await client.getHomesData();
      logger.info(`Netatmo account connected: ${homes.length} home(s) visible`);
    } catch (err) {
      logger.warn(`Post-connect validation call failed (${err.message}) — the loop will retry`);
    }
    await reportConnectionStatus(gladys, true);
    telemetry.start(config);
  });

  // --- Discovery: Gladys asks for the list of devices ------------------------
  gladys.onScanRequest(async () => {
    logger.info('onScanRequest -> loading and publishing the Netatmo devices');
    await telemetry.syncDiscovery(config);
  });

  // --- Command: the user acts on a controllable feature ----------------------
  gladys.onSetValue(async (device, feature, value) => {
    logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
    await setDeviceValue({ gladys, client }, { device, feature, value });
  });

  // --- Camera: Gladys asks for a fresh snapshot ------------------------------
  gladys.onGetImage(async (device) => {
    logger.info(`onGetImage <- ${device.external_id}`);
    return telemetry.getCameraSnapshot(config, device);
  });

  // --- Configuration updated by the user -------------------------------------
  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('onConfigUpdated -> new configuration received');
    const previous = config;
    config = normalizeConfig(newConfig);
    oauth.loadFromConfig(config);
    // Only when the API toggles actually changed: forget the dedup memory so
    // the next cycle re-publishes every value. A plain save must not flood
    // the state history with duplicates of every state.
    const togglesChanged =
      previous.energy_api !== config.energy_api ||
      previous.weather_api !== config.weather_api ||
      previous.security_api !== config.security_api;
    if (togglesChanged) {
      telemetry.resetDedup();
    }
    await syncConnection();
    // Saving the configuration re-runs the discovery automatically: enabling
    // a toggle (e.g. security_api) must surface its devices without a manual
    // re-scan on the Discovery screen.
    if (oauth.hasTokens()) {
      await telemetry.syncDiscovery(config);
    }
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
    telemetry.stop();
  });

  return { oauth, client, telemetry, getConfig: () => config };
}

// --- Startup (container entry point only) ------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const gladys = new GladysIntegration();
  const { oauth, telemetry } = setupIntegration(gladys);

  // The SDK disconnects cleanly and exits with code 0 when the supervisor
  // stops the container (SIGTERM/SIGINT).
  gladys.handleShutdown((signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
    oauth.stop();
    telemetry.stop();
  });

  logger.info('Starting the Netatmo integration...');
  gladys.connect().catch((err) => {
    logger.error('Initial connection failed', err);
    process.exit(1);
  });
}
