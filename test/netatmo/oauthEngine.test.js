// -----------------------------------------------------------------------------
// Unit tests of the SCHEDULED token-refresh engine — the most safety-critical
// code of the integration: the transient backoff ladder, the 24h grace window
// that protects the stored tokens from fatal-looking Netatmo answers, the
// wipe + auth-lost callback past the window, the recovery callback, and the
// store-write failure path (a Gladys core restart must never be treated as a
// Netatmo auth failure).
//
// Timers are injected: each armed timer is captured and fired by hand, the
// clock is a plain variable.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoOAuth } from '../../src/netatmo/oauth.js';
import {
  RECONNECT_BACKOFF_MS,
  RECONNECT_RECURRENT_MS,
  FATAL_RETRY_WINDOW_MS,
} from '../../src/netatmo/constants.js';
import { startFakeNetatmo, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from '../helpers/fakeNetatmo.js';

let netatmo;
let clock;
let timers; // every armed timer: {fn, ms}
let configStore;
let failSetConfig;
let oauth;
let authLostMessages;
let recoveredCount;

/** Fire the most recently armed timer (the engine re-arms as it goes). */
async function fireTimer() {
  const timer = timers.at(-1);
  assert.ok(timer, 'a timer should be armed');
  await timer.fn();
}

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  clock = 1_000_000_000_000;
  timers = [];
  configStore = {};
  failSetConfig = false;
  authLostMessages = [];
  recoveredCount = 0;

  const config = normalizeConfig({
    client_id: FAKE_CLIENT_ID,
    client_secret: FAKE_CLIENT_SECRET,
    // Seed the tokens the fake cloud considers current.
    access_token: 'access-0',
    refresh_token: 'refresh-0',
    expires_at: clock + 10 * 60 * 1000,
  });
  oauth = createNetatmoOAuth({
    gladys: {
      async setConfig(partial) {
        if (failSetConfig) {
          throw new Error('host API unavailable');
        }
        Object.assign(configStore, partial);
      },
    },
    getConfig: () => config,
    baseUrl: netatmo.url,
    now: () => clock,
    timers: {
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return { unref() {} };
      },
      clearTimeout: () => {},
    },
  });
  oauth.loadFromConfig(config);
  oauth.onAuthLost(async (message) => {
    authLostMessages.push(message);
  });
  oauth.onRefreshRecovered(async () => {
    recoveredCount += 1;
  });
});

afterEach(async () => {
  oauth.stop();
  await netatmo.close();
});

test('transient failures walk the backoff ladder, then recovery fires the callback', async () => {
  oauth.scheduleTokenRefresh();
  assert.equal(timers.length, 1);

  // Netatmo down: each firing re-arms with the next backoff delay.
  netatmo.state.failTokenWith = 503;
  for (const expectedDelay of RECONNECT_BACKOFF_MS.slice(0, 3)) {
    await fireTimer();
    assert.equal(timers.at(-1).ms, expectedDelay);
  }

  // Netatmo is back: the refresh succeeds, the recovery callback fires, and
  // the next timer is a regular 80%-of-lifetime schedule again.
  netatmo.state.failTokenWith = null;
  await fireTimer();
  assert.equal(recoveredCount, 1);
  assert.equal(authLostMessages.length, 0);
  assert.ok(oauth.hasTokens());
  assert.equal(configStore.refresh_token, netatmo.state.validRefreshToken);
});

test('fatal-looking failures keep the tokens during the 24h grace window, then wipe', async () => {
  oauth.scheduleTokenRefresh();
  netatmo.state.failTokenWith = 400; // fatal-looking (invalid_grant & co)

  await fireTimer();
  assert.ok(oauth.hasTokens(), 'tokens survive inside the grace window');
  assert.equal(timers.at(-1).ms, RECONNECT_RECURRENT_MS);
  assert.equal(authLostMessages.length, 0);

  // Still failing 25 hours later: the window is exhausted.
  clock += FATAL_RETRY_WINDOW_MS + 60 * 60 * 1000;
  await fireTimer();
  assert.equal(oauth.hasTokens(), false);
  assert.equal(authLostMessages.length, 1);
  assert.equal(configStore.refresh_token, '');
});

test('a store-write failure is transient: tokens survive in memory, no fatal window', async () => {
  oauth.scheduleTokenRefresh();
  failSetConfig = true; // the Gladys core is restarting

  await fireTimer();
  // The Netatmo refresh itself succeeded (rotation happened server-side):
  // memory holds the new tokens, the engine retries with a transient backoff
  // instead of entering the fatal path.
  assert.ok(oauth.hasTokens());
  assert.equal(authLostMessages.length, 0);
  assert.equal(timers.at(-1).ms, RECONNECT_BACKOFF_MS[0]);

  // The core is back: the next firing refreshes AND persists.
  failSetConfig = false;
  await fireTimer();
  assert.equal(configStore.refresh_token, netatmo.state.validRefreshToken);
  assert.equal(recoveredCount, 1);
});

test('loadFromConfig never overwrites fresher in-memory tokens with stale stored ones', async () => {
  // Refresh once: memory now holds rotated tokens newer than the seed.
  await oauth.refreshTokens();
  const freshToken = await oauth.ensureFreshAccessToken();

  // A config push arrives with the STALE stored tokens (failed persist, or
  // an old snapshot): memory must win.
  oauth.loadFromConfig(
    normalizeConfig({
      client_id: FAKE_CLIENT_ID,
      client_secret: FAKE_CLIENT_SECRET,
      access_token: 'access-0',
      refresh_token: 'refresh-0',
      expires_at: clock + 60 * 1000, // older than the in-memory expiry
    }),
  );
  assert.equal(await oauth.ensureFreshAccessToken(), freshToken);
});
