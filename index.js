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
import { createWebhooks } from './src/netatmo/webhooks.js';
import { createEvents } from './src/netatmo/events.js';
import { createEventsPoll } from './src/netatmo/eventsPoll.js';
import { createWebRtc } from './src/netatmo/webrtc.js';
import { setDeviceValue } from './src/netatmo/setValue.js';
import { SCENE_ACTIONS } from './src/netatmo/scenes.js';
import {
  WIDGETS,
  WIDGET_OF_UPDATE,
  getWidgetImage,
  refreshWidgets,
  requestRefresh,
} from './src/netatmo/widgets.js';
import { createBticinoDiagnostic } from './src/netatmo/bticino.js';
import {
  createWebhookHistory,
  describeWebhookBody,
  runDeviceDiagnostic,
} from './src/netatmo/diagnostic.js';
import {
  CONNECTION_MESSAGES,
  DEVICE_DIAGNOSTIC_ACTION_KEY,
  WEBHOOK_KEY,
} from './src/netatmo/constants.js';

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
  // Last connection status reported: the degraded message (an API family
  // failing for several cycles, issue #33) only rides on a CONNECTED status —
  // "reconnect required" or "unreachable" must never be overwritten by it.
  let connected = null;
  let telemetry = null;
  // While connected, the status also carries the actionable hints: scopes the
  // token lacks (added by a newer release, issue #35) first, then a degraded
  // API family.
  function connectedHint() {
    if (oauth.missingScopes().length > 0) {
      return CONNECTION_MESSAGES.MISSING_SCOPES;
    }
    return telemetry?.getDegradedMessage() ?? null;
  }
  async function setStatus(isConnected, message) {
    connected = isConnected;
    const shown = message ?? (isConnected ? connectedHint() : null);
    await reportConnectionStatus(gladys, isConnected, shown ?? undefined);
  }

  // BTicino door entry diagnostic log (issue #59): raw payloads of the BN*
  // modules (fed by every load) and of their webhook events.
  const bticinoDiagnostic = createBticinoDiagnostic();
  // Recent webhook events (redacted), shown by the Device diagnostic action.
  const webhookHistory = createWebhookHistory();

  // WebRTC live view of the doorbell and the Indoor Camera Advance (issue
  // #70): inert with an SDK or a Gladys core that cannot relay it yet.
  const webRtc = createWebRtc({
    gladys,
    client,
    getRawDevice: (id) => telemetry.getRawDevice(id),
  });

  // Momentary detections (motion, person, smoke, doorbell ring…): published as
  // push features straight from the event payload — no API state reports them.
  // Identity events (known person seen / gone, siren sounding) are fired as
  // scene events: the homes summaries give the person and home names.
  const events = createEvents({ gladys, getHomes: () => telemetry.getHomes() });
  // The same detections from GET /api/getevents at the end of every refresh
  // cycle: the fallback when the webhooks deliver nothing (deduplicated
  // against them, never replaying history on a restart).
  const eventsPoll = createEventsPoll({ client, events });

  telemetry = createTelemetry({
    gladys,
    client,
    fetchImpl,
    bticinoDiagnostic,
    webRtc,
    eventsPoll,
    ...(refreshIntervalMs ? { refreshIntervalMs } : {}),
    onDegradedChange: async () => {
      if (connected) {
        await setStatus(true);
      }
    },
  });
  // Gladys Plus webhooks (issue #5): a relayed event triggers an immediate
  // telemetry refresh (doctrine "trigger, not data"). Degrades to poll only
  // when Gladys Plus is not linked. The refresh starts from a FRESH load: a
  // cycle in flight or a load still in the burst cache predates the event and
  // would miss its new state (a known person arriving, issue #57).
  const webhooks = createWebhooks({
    gladys,
    client,
    refresh: () => telemetry.refreshNow(config),
  });

  // Tokens wiped after the 24h grace window: ask the user to reconnect.
  oauth.onAuthLost(async (message) => {
    telemetry.stop();
    await setStatus(false, message);
  });

  // A scheduled refresh recovered after failures (Netatmo/DNS outage over):
  // reflect it on the Configuration screen and make sure telemetry runs.
  oauth.onRefreshRecovered(async () => {
    await setStatus(true);
    telemetry.start(config);
  });

  // A token response revealed missing scopes (or a reconnect granted them):
  // refresh the status shown on the Configuration screen.
  // The rest of the account keeps working: only the new devices need it.
  oauth.onMissingScopes(async () => {
    if (oauth.hasTokens() && connected) {
      await setStatus(true);
    }
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
      await setStatus(false, CONNECTION_MESSAGES.MISSING_CLIENT_CONFIG);
      return;
    }
    if (!oauth.hasTokens()) {
      telemetry.stop();
      logger.warn('Netatmo account not connected yet — waiting for the OAuth2 connection');
      await setStatus(false, CONNECTION_MESSAGES.NOT_CONNECTED);
      return;
    }
    try {
      await oauth.ensureFreshAccessToken();
      oauth.scheduleTokenRefresh();
      await setStatus(true);
      // Start (or restart) the global value refresh loop for the devices the
      // user created in Gladys.
      telemetry.start(config);
      // (Re)register the webhook relay URL at Netatmo — the Netatmo pattern is
      // to re-register on every successful connection, best effort.
      await webhooks.register();
      // Nudges are dropped while disconnected: re-pull every widget now.
      refreshWidgets(gladys);
      logger.info('Netatmo account connected, token refresh and telemetry engines armed');
    } catch (err) {
      if (err instanceof NotConnectedError) {
        telemetry.stop();
        await setStatus(false, CONNECTION_MESSAGES.NOT_CONNECTED);
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
        await setStatus(false, CONNECTION_MESSAGES.NETATMO_UNREACHABLE);
        return;
      }
      logger.error(`Netatmo token check failed: ${err.message}`);
      telemetry.stop();
      await setStatus(false, CONNECTION_MESSAGES.RECONNECT_REQUIRED);
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
      await setStatus(false, CONNECTION_MESSAGES.SAVE_CREDENTIALS_FIRST);
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
    await setStatus(true);
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
    // A Legrand command keeps the commanded value in the dedup itself (issue
    // #60): only the other commands need the dedup forgotten below.
    let remembered = false;
    await setDeviceValue(
      {
        gladys,
        client,
        refresh: () => telemetry.refreshNow(config),
        scheduleRefresh: (delayMs, key) => telemetry.scheduleRefresh(config, delayMs, key),
        getRawDevice: (id) => telemetry.getRawDevice(id),
        patchRoom: (homeId, roomId, patch) => telemetry.patchRoom(homeId, roomId, patch),
        setpointDuration: config.setpoint_duration,
        getHomes: () => telemetry.getHomes(),
        rememberState: (featureExternalId, state) => {
          remembered = true;
          telemetry.rememberState(featureExternalId, state);
        },
      },
      { device, feature, value },
    );
    // Gladys saved the commanded value: the next load re-publishes what
    // Netatmo reports, even if it is what was published before the command
    // (issue #77: a mode or setpoint Netatmo did not apply must show again).
    if (!remembered) {
      telemetry.forgetPublished(feature.external_id);
    }
  });

  // --- Scene actions: operations a scene author placed in a scene -----------
  // One handler per key of the manifest `scene_actions` field, receiving the
  // RESOLVED fields (variables substituted, defaults applied), resolving the
  // declared outputs (see src/netatmo/scenes.js). Throwing fails that action
  // only: the scene logs it and continues.
  for (const [actionKey, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(actionKey, (fields) => {
      logger.info(`onSceneAction <- ${actionKey}`);
      return handler(
        { gladys, client, telemetry, refresh: () => telemetry.refreshNow(config) },
        fields,
      );
    });
  }

  // --- Dashboard widgets -----------------------------------------------------
  // One content handler per key of the manifest `widgets` field (pulled by
  // the core, cached by TTL), the taps on their buttons, and the bytes of
  // the camera images they declare (see src/netatmo/widgets.js).
  const widgetContext = () => ({
    gladys,
    client,
    telemetry,
    config,
    refresh: () => telemetry.refreshNow(config),
  });
  for (const [widgetKey, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(widgetKey, (request) => widget.get(widgetContext(), request));
    if (typeof widget.action === 'function') {
      gladys.onWidgetAction(widgetKey, (actionKey, params, { settings, values } = {}) => {
        logger.info(`onWidgetAction <- ${widgetKey}.${actionKey}`);
        return widget.action(widgetContext(), { actionKey, params, settings, values });
      });
    }
  }
  gladys.onWidgetGetImage((imageKey) => getWidgetImage(imageKey));
  // The data a widget computes changed (heating mode, room temperatures,
  // module health, camera snapshots or monitoring): nudge the core to re-pull
  // it now instead of waiting for the content TTL. Live tiles need no nudge.
  telemetry.onUpdate((kind) => {
    if (WIDGET_OF_UPDATE[kind]) {
      requestRefresh(gladys, WIDGET_OF_UPDATE[kind]);
    }
  });

  // --- Camera: Gladys asks for a fresh snapshot ------------------------------
  gladys.onGetImage(async (device) => {
    logger.info(`onGetImage <- ${device.external_id}`);
    return telemetry.getCameraSnapshot(config, device);
  });

  // --- Camera: WebRTC live view (doorbell, Indoor Camera Advance) -----------
  // Registered only when the SDK has the handlers (feature detection): the
  // released SDK 0.15 does not, and the dashboard keeps the still image.
  webRtc.register();

  // --- Webhooks: a Netatmo event was relayed by Gladys Plus ------------------
  // fire_and_forget: the resolved value is ignored. Two complementary paths:
  // momentary detections are published from the payload (real time; the
  // getevents poll only catches what the webhooks did not deliver), and every
  // event debounces a refresh of the pollable state.
  gladys.onWebhook(WEBHOOK_KEY, async (request) => {
    // Info level: the only visible proof that Gladys Plus delivers (one line
    // per event; Netatmo pushes a handful per hour at most).
    logger.info(`Netatmo webhook event received: ${describeWebhookBody(request?.body)}`);
    try {
      webhookHistory.record(request?.body);
    } catch (err) {
      logger.debug(`Webhook history failed: ${err.message}`);
    }
    if (config.bticino_api) {
      try {
        bticinoDiagnostic.logWebhook(request?.body);
      } catch (err) {
        logger.debug(`BTicino diagnostic log failed: ${err.message}`);
      }
    }
    await events.handleWebhook(request?.body);
    webhooks.handleEvent();
  });
  // The Gladys Plus availability changed (Plus linked/unlinked, key changed):
  // re-register the fresh URL at Netatmo, or degrade to poll only.
  gladys.onWebhookUpdated(async () => {
    logger.info('Gladys Plus webhook availability changed -> re-registering');
    await webhooks.register();
  });

  // --- Action: Device diagnostic (Configuration screen) ----------------------
  // A plain-text report on one module (picked among the created devices, or
  // typed: name / Netatmo id) or on the whole account, to paste in an issue
  // (see src/netatmo/diagnostic.js). Also logged at info level.
  gladys.onAction(DEVICE_DIAGNOSTIC_ACTION_KEY, (fields) => {
    logger.info(`onAction ${DEVICE_DIAGNOSTIC_ACTION_KEY}`);
    return runDeviceDiagnostic(
      {
        gladys,
        oauth,
        telemetry,
        webhooks,
        webhookHistory,
        eventsPoll,
        getConfig: () => config,
      },
      fields,
    );
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
      previous.security_api !== config.security_api ||
      previous.shutter_api !== config.shutter_api ||
      previous.aircare_api !== config.aircare_api ||
      previous.bticino_api !== config.bticino_api ||
      previous.legrand_api !== config.legrand_api;
    if (togglesChanged) {
      telemetry.resetDedup();
    }
    if (config.bticino_api && !previous.bticino_api) {
      // BTicino toggle (re-)enabled: log every BTicino entry again.
      bticinoDiagnostic.reset();
    }
    if (
      config.bticino_api !== previous.bticino_api ||
      config.legrand_api !== previous.legrand_api
    ) {
      // The BTicino and Legrand scopes are only requested while their toggle
      // is on: the "click Connect again" hint follows the toggles.
      await oauth.recheckScopes();
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
    // Possibly an upgraded core: offer the WebRTC param again (issue #70).
    webRtc.resetCoreSupport();
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
    webhooks.stop();
    events.stop();
  });

  return {
    oauth,
    client,
    telemetry,
    webhooks,
    events,
    eventsPoll,
    bticinoDiagnostic,
    webhookHistory,
    webRtc,
    getConfig: () => config,
  };
}

// --- Startup (container entry point only) ------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const gladys = new GladysIntegration();
  const { oauth, telemetry, webhooks, events } = setupIntegration(gladys);

  // The SDK disconnects cleanly and exits with code 0 when the supervisor
  // stops the container (SIGTERM/SIGINT).
  gladys.handleShutdown((signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
    oauth.stop();
    telemetry.stop();
    webhooks.stop();
    events.stop();
  });

  logger.info('Starting the Netatmo integration...');
  gladys.connect().catch((err) => {
    logger.error('Initial connection failed', err);
    process.exit(1);
  });
}
