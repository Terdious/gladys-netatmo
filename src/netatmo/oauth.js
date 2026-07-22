// -----------------------------------------------------------------------------
// Netatmo OAuth2 manager (authorization-code flow).
//
// The Gladys core knows no provider: it renders a "Connect" button for the
// `oauth2` field of the manifest, opens the URL we return from
// `onOAuthAuthorizeUrl`, and relays the provider redirect back to us through
// `onOAuthCallback`. Everything Netatmo-specific happens here:
//   - build the authorization URL (client_id, scopes, anti-CSRF state);
//   - exchange the authorization code for tokens;
//   - refresh the access token at 80% of its lifetime (rotating the refresh
//     token, as Netatmo does on every refresh);
//   - persist the tokens in the Gladys config store (keys OUTSIDE the
//     config_schema: they never reach the configuration form).
//
// Error handling mirrors the core service hardening (core PR #2618): a 5xx,
// a 429 or a network error is TRANSIENT (keep the tokens, retry with backoff);
// any other 4xx is fatal-looking, but the stored tokens survive a 24h grace
// window before being wiped — Netatmo sometimes answers bogus 400s during
// outages, and wiping the refresh token forces the user to reconnect by hand.
//
// The anti-CSRF state is SINGLE-USE: it is consumed by the first callback, so
// a replayed callback (the bug fixed in the front by core PR #2628) is
// rejected instead of burning a second token exchange.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';

import { createLogger } from '@gladysassistant/integration-sdk';

import {
  NETATMO_BASE_URL,
  OAUTH2,
  OAUTH_SCOPES,
  TOKEN_REFRESH_RATIO,
  TOKEN_REFRESH_MIN_DELAY_MS,
  TOKEN_EXPIRY_MARGIN_MS,
  RECONNECT_BACKOFF_MS,
  RECONNECT_RECURRENT_MS,
  FATAL_RETRY_WINDOW_MS,
  CONNECTION_MESSAGES,
} from './constants.js';

const logger = createLogger({ name: 'netatmo-oauth' });

/** Error thrown when an API call needs a connected Netatmo account. */
export class NotConnectedError extends Error {
  constructor() {
    super('Netatmo account is not connected');
    this.code = 'NOT_CONNECTED';
  }
}

/**
 * Read the Netatmo error payload ({error: "invalid_grant"} or
 * {error: {code, message}}) without assuming its shape.
 * @param {unknown} body parsed response body
 * @returns {string} short error description
 */
function describeNetatmoError(body) {
  const error = body?.error;
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    return error.message ?? JSON.stringify(error);
  }
  return 'unknown error';
}

/**
 * Create the OAuth2 manager.
 * @param {object} deps dependencies
 * @param {object} deps.gladys SDK instance (setConfig is the token store)
 * @param {() => object} deps.getConfig current normalized config accessor
 * @param {typeof fetch} [deps.fetchImpl] fetch implementation (tests)
 * @param {string} [deps.baseUrl] Netatmo base URL (tests)
 * @param {() => number} [deps.now] clock (tests)
 */
export function createNetatmoOAuth({
  gladys,
  getConfig,
  fetchImpl = fetch,
  baseUrl = NETATMO_BASE_URL,
  now = Date.now,
  // Injectable timers so the tests can drive the scheduled refresh engine
  // (backoff ladder, 24h grace window) without waiting real time.
  timers = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
  },
}) {
  // In-memory tokens, kept in sync with the Gladys config store: loaded from it
  // on (re)connect / config update, written back on every exchange or refresh.
  let tokens = { accessToken: '', refreshToken: '', expiresAt: 0 };

  // Single-use anti-CSRF state of the authorization round-trip in progress.
  let pendingAuth = null;

  // Refresh engine state.
  let refreshTimer = null;
  let refreshInFlight = null;
  let retryAttempt = 0;
  let firstFatalAt = null;

  // Called when the tokens are wiped for good (grace window exhausted).
  let authLostCallback = null;
  // Called when a SCHEDULED refresh succeeds after failures: the connection
  // recovered in the background and the caller can resume (telemetry, status).
  let refreshRecoveredCallback = null;

  /** Sync the in-memory tokens from the (normalized) config store. */
  function loadFromConfig(config) {
    // Netatmo rotates the refresh token on every refresh: when a store write
    // failed (Gladys core restarting), the store may hold an OLDER token than
    // memory. Never overwrite fresher in-memory tokens with stale stored ones.
    if (tokens.refreshToken && tokens.expiresAt > (Number(config.expires_at) || 0)) {
      return;
    }
    tokens = {
      accessToken: config.access_token,
      refreshToken: config.refresh_token,
      expiresAt: config.expires_at,
    };
  }

  function hasTokens() {
    return Boolean(tokens.refreshToken);
  }

  /**
   * Build the Netatmo authorization URL for the Connect button.
   * @param {string} redirectUri callback URL owned by the Gladys relay
   * @returns {string} URL to open in the user's browser
   */
  function buildAuthorizeUrl(redirectUri) {
    const config = getConfig();
    if (!config.client_id || !config.client_secret) {
      // The message is acked to Gladys and shown to the user in the UI.
      throw new Error('Netatmo client id / client secret must be configured first');
    }
    const state = crypto.randomBytes(16).toString('hex');
    pendingAuth = { state, redirectUri };
    const params = new URLSearchParams({
      client_id: config.client_id,
      redirect_uri: redirectUri,
      scope: OAUTH_SCOPES.join(' '),
      state,
    });
    return `${baseUrl}${OAUTH2.AUTHORIZE_PATH}?${params.toString()}`;
  }

  /** POST to the Netatmo token endpoint with a form-urlencoded body. */
  async function postToken(form) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${OAUTH2.TOKEN_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json',
        },
        body: new URLSearchParams(form).toString(),
        // A hung token request must not stall the refresh engine for minutes.
        signal: AbortSignal.timeout(30 * 1000),
      });
    } catch (err) {
      // Network failure: always transient.
      err.transient = true;
      throw err;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        `Netatmo token endpoint answered ${response.status}: ${describeNetatmoError(body)}`,
      );
      error.status = response.status;
      error.transient = response.status >= 500 || response.status === 429;
      throw error;
    }
    return body;
  }

  /** Store the token response, in memory and in the Gladys config store. */
  async function persistTokens(data) {
    // Netatmo historically answers `expire_in`; the OAuth2 standard field is
    // `expires_in`. Accept both (the core reads `expire_in`).
    const expiresInSeconds = Number(data.expires_in ?? data.expire_in) || 0;
    tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: expiresInSeconds > 0 ? now() + expiresInSeconds * 1000 : 0,
    };
    try {
      await gladys.setConfig({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt,
      });
    } catch (err) {
      // A failed STORE write (Gladys core restarting) is not a Netatmo auth
      // failure: the in-memory tokens are valid and the refresh engine must
      // NOT enter the fatal path (which would re-hit Netatmo and burn a
      // refresh-token rotation every retry). The next successful refresh
      // persists again.
      err.transient = true;
      throw err;
    }
  }

  /** Wipe the tokens (memory + store): the user must reconnect. */
  async function clearTokens() {
    tokens = { accessToken: '', refreshToken: '', expiresAt: 0 };
    await gladys.setConfig({ access_token: '', refresh_token: '', expires_at: 0 });
  }

  /**
   * Handle the OAuth2 callback relayed by Gladys: verify the anti-CSRF state,
   * exchange the code and persist the tokens.
   * @param {{code: string, state: string, redirectUri: string}} params relay payload
   */
  async function handleCallback({ code, state, redirectUri }) {
    if (!pendingAuth || pendingAuth.state !== state) {
      // Forged, stale or replayed callback: the state is single-use.
      throw new Error('OAuth state mismatch — please restart the connection from Gladys');
    }
    pendingAuth = null;
    const config = getConfig();
    const data = await postToken({
      grant_type: 'authorization_code',
      client_id: config.client_id,
      client_secret: config.client_secret,
      code,
      redirect_uri: redirectUri,
      scope: OAUTH_SCOPES.join(' '),
    });
    await persistTokens(data);
    retryAttempt = 0;
    firstFatalAt = null;
    scheduleTokenRefresh();
    logger.info('Netatmo tokens obtained and stored');
  }

  /**
   * Refresh the access token (single-flight). Netatmo rotates the refresh
   * token: the new one replaces the stored one.
   * @returns {Promise<void>} resolves when the new tokens are persisted
   */
  function refreshTokens() {
    if (refreshInFlight) {
      return refreshInFlight;
    }
    refreshInFlight = (async () => {
      if (!tokens.refreshToken) {
        throw new NotConnectedError();
      }
      const config = getConfig();
      const data = await postToken({
        grant_type: 'refresh_token',
        client_id: config.client_id,
        client_secret: config.client_secret,
        refresh_token: tokens.refreshToken,
      });
      await persistTokens(data);
      retryAttempt = 0;
      firstFatalAt = null;
      logger.debug('Netatmo access token refreshed');
    })();
    return refreshInFlight.finally(() => {
      refreshInFlight = null;
    });
  }

  /**
   * Return a valid access token, refreshing it first when it is missing or
   * about to expire. Throws NotConnectedError when no account is connected.
   * @returns {Promise<string>} a fresh access token
   */
  async function ensureFreshAccessToken() {
    if (!hasTokens()) {
      throw new NotConnectedError();
    }
    const stillValid = tokens.accessToken && tokens.expiresAt - now() > TOKEN_EXPIRY_MARGIN_MS;
    if (!stillValid) {
      await refreshTokens();
    }
    return tokens.accessToken;
  }

  function stopTimer() {
    if (refreshTimer) {
      timers.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  function armTimer(delayMs) {
    stopTimer();
    refreshTimer = timers.setTimeout(runScheduledRefresh, delayMs);
    // Never keep the process (or a test run) alive just for this timer.
    refreshTimer.unref?.();
  }

  /** Timer body: refresh, and on failure retry per the transient/fatal rules. */
  async function runScheduledRefresh() {
    try {
      const wasRetrying = retryAttempt > 0 || firstFatalAt !== null;
      await refreshTokens();
      scheduleTokenRefresh();
      if (wasRetrying) {
        // The connection recovered in the background: let the caller resume
        // (report connected, restart telemetry). A throwing callback must not
        // be classified as a refresh failure.
        try {
          await refreshRecoveredCallback?.();
        } catch (cbErr) {
          logger.error(`Refresh-recovered callback failed: ${cbErr.message}`);
        }
      }
    } catch (err) {
      if (err.transient) {
        const delay = RECONNECT_BACKOFF_MS[Math.min(retryAttempt, RECONNECT_BACKOFF_MS.length - 1)];
        retryAttempt += 1;
        logger.warn(
          `Transient Netatmo token refresh failure (${err.message}) — retrying in ${delay / 1000}s`,
        );
        armTimer(delay);
        return;
      }
      // Fatal-looking (invalid_grant & co): grace window before wiping.
      if (firstFatalAt === null) {
        firstFatalAt = now();
      }
      if (now() - firstFatalAt < FATAL_RETRY_WINDOW_MS) {
        logger.warn(
          `Netatmo token refresh failed (${err.message}) — keeping tokens, retrying in ${RECONNECT_RECURRENT_MS / 1000}s`,
        );
        armTimer(RECONNECT_RECURRENT_MS);
        return;
      }
      logger.error(
        `Netatmo token refresh failed for 24h (${err.message}) — clearing tokens, reconnection required`,
      );
      await clearTokens().catch((clearErr) =>
        logger.error('Failed to clear Netatmo tokens', clearErr),
      );
      // Defensive: a throwing callback in a bare timer body would take the
      // whole process down with an unhandled rejection.
      try {
        await authLostCallback?.(CONNECTION_MESSAGES.RECONNECT_REQUIRED);
      } catch (cbErr) {
        logger.error(`Auth-lost callback failed: ${cbErr.message}`);
      }
    }
  }

  /** Arm the refresh timer at 80% of the remaining token lifetime. */
  function scheduleTokenRefresh() {
    if (!hasTokens()) {
      return;
    }
    const remaining = Math.max(0, tokens.expiresAt - now());
    const delay = Math.max(TOKEN_REFRESH_MIN_DELAY_MS, remaining * TOKEN_REFRESH_RATIO);
    armTimer(delay);
  }

  return {
    loadFromConfig,
    hasTokens,
    buildAuthorizeUrl,
    handleCallback,
    refreshTokens,
    ensureFreshAccessToken,
    scheduleTokenRefresh,
    /** Register the callback invoked when the tokens are wiped for good. */
    onAuthLost(callback) {
      authLostCallback = callback;
    },
    /** Register the callback invoked when a scheduled refresh RECOVERS. */
    onRefreshRecovered(callback) {
      refreshRecoveredCallback = callback;
    },
    /** Stop the refresh engine (shutdown, WebSocket disconnected). */
    stop() {
      stopTimer();
    },
  };
}
