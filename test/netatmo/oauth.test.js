// -----------------------------------------------------------------------------
// Unit tests of the OAuth2 manager, against the fake Netatmo cloud:
// authorization URL, code exchange, single-use state (replay protection),
// refresh-token rotation, expiry-driven refresh and the transient/fatal
// error classification of the token endpoint.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoOAuth, NotConnectedError } from '../../src/netatmo/oauth.js';
import { OAUTH_SCOPES } from '../../src/netatmo/constants.js';
import {
  startFakeNetatmo,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_AUTH_CODE,
} from '../helpers/fakeNetatmo.js';

const REDIRECT_URI = 'https://gladys.local/oauth-callback';

let netatmo;
let configStore; // what the integration persisted through gladys.setConfig
let oauth;
let clock; // controllable now()

function createOAuth(config = {}) {
  const fullConfig = normalizeConfig({
    client_id: FAKE_CLIENT_ID,
    client_secret: FAKE_CLIENT_SECRET,
    ...config,
  });
  const manager = createNetatmoOAuth({
    gladys: {
      async setConfig(partial) {
        Object.assign(configStore, partial);
      },
    },
    getConfig: () => fullConfig,
    baseUrl: netatmo.url,
    now: () => clock,
  });
  manager.loadFromConfig(fullConfig);
  return manager;
}

/** Run the authorize + callback round-trip, returns the state used. */
async function connectAccount() {
  const authorizeUrl = oauth.buildAuthorizeUrl(REDIRECT_URI);
  const state = new URL(authorizeUrl).searchParams.get('state');
  await oauth.handleCallback({ code: FAKE_AUTH_CODE, state, redirectUri: REDIRECT_URI });
  return state;
}

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  configStore = {};
  clock = 1_000_000_000_000;
  oauth = createOAuth();
});

afterEach(async () => {
  oauth.stop();
  await netatmo.close();
});

test('buildAuthorizeUrl carries client_id, redirect_uri, the full scope set and a state', () => {
  const url = new URL(oauth.buildAuthorizeUrl(REDIRECT_URI));
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), FAKE_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), OAUTH_SCOPES.join(' '));
  assert.match(url.searchParams.get('state'), /^[0-9a-f]{32}$/);
});

test('buildAuthorizeUrl refuses to run without client credentials', () => {
  const bare = createNetatmoOAuth({
    gladys: { setConfig: async () => {} },
    getConfig: () => normalizeConfig(),
    baseUrl: netatmo.url,
  });
  assert.throws(() => bare.buildAuthorizeUrl(REDIRECT_URI), /client id \/ client secret/);
});

test('handleCallback exchanges the code and persists the tokens', async () => {
  await connectAccount();

  const exchange = netatmo.state.tokenRequests[0];
  assert.equal(exchange.grant_type, 'authorization_code');
  assert.equal(exchange.code, FAKE_AUTH_CODE);
  assert.equal(exchange.redirect_uri, REDIRECT_URI);
  assert.equal(exchange.scope, OAUTH_SCOPES.join(' '));

  assert.equal(configStore.access_token, 'access-1');
  assert.equal(configStore.refresh_token, 'refresh-1');
  // expires_in=10800s from the fake clock.
  assert.equal(configStore.expires_at, clock + 10800 * 1000);
  assert.equal(oauth.hasTokens(), true);
});

test('handleCallback rejects a state mismatch', async () => {
  oauth.buildAuthorizeUrl(REDIRECT_URI);
  await assert.rejects(
    oauth.handleCallback({ code: FAKE_AUTH_CODE, state: 'forged', redirectUri: REDIRECT_URI }),
    /state mismatch/,
  );
  assert.equal(netatmo.state.tokenRequests.length, 0);
});

test('handleCallback consumes the state: a replayed callback is rejected', async () => {
  const state = await connectAccount();
  // Same code + state again (the replay bug fixed in the core front by #2628).
  await assert.rejects(
    oauth.handleCallback({ code: FAKE_AUTH_CODE, state, redirectUri: REDIRECT_URI }),
    /state mismatch/,
  );
  // Only the first exchange reached Netatmo.
  assert.equal(netatmo.state.tokenRequests.length, 1);
});

test('refreshTokens rotates the refresh token and persists the new pair', async () => {
  await connectAccount();
  await oauth.refreshTokens();

  const refresh = netatmo.state.tokenRequests[1];
  assert.equal(refresh.grant_type, 'refresh_token');
  assert.equal(refresh.refresh_token, 'refresh-1');

  assert.equal(configStore.access_token, 'access-2');
  assert.equal(configStore.refresh_token, 'refresh-2');
});

test('ensureFreshAccessToken returns the cached token while it is valid', async () => {
  await connectAccount();
  const token = await oauth.ensureFreshAccessToken();
  assert.equal(token, 'access-1');
  // Only the initial exchange, no refresh.
  assert.equal(netatmo.state.tokenRequests.length, 1);
});

test('ensureFreshAccessToken refreshes an expired token', async () => {
  await connectAccount();
  clock += 10800 * 1000; // jump past the expiry
  const token = await oauth.ensureFreshAccessToken();
  assert.equal(token, 'access-2');
  assert.equal(netatmo.state.tokenRequests.at(-1).grant_type, 'refresh_token');
});

test('ensureFreshAccessToken throws NotConnectedError without a stored refresh token', async () => {
  const bare = createOAuth({ access_token: '', refresh_token: '', expires_at: 0 });
  await assert.rejects(bare.ensureFreshAccessToken(), NotConnectedError);
  bare.stop();
});

test('a 5xx from the token endpoint is transient and keeps the tokens', async () => {
  await connectAccount();
  netatmo.state.failTokenWith = 503;
  clock += 10800 * 1000;
  await assert.rejects(oauth.ensureFreshAccessToken(), (err) => err.transient === true);
  // Tokens untouched: the engine may retry later with the same refresh token.
  assert.equal(configStore.refresh_token, 'refresh-1');
  assert.equal(oauth.hasTokens(), true);
});

test('an invalid_grant from the token endpoint is fatal-looking (not transient)', async () => {
  await connectAccount();
  netatmo.state.validRefreshToken = 'rotated-elsewhere'; // our refresh token is now invalid
  clock += 10800 * 1000;
  await assert.rejects(
    oauth.ensureFreshAccessToken(),
    (err) => err.transient !== true && err.status === 400,
  );
  // Even then the tokens are NOT wiped here: the scheduled engine owns the
  // 24h grace window before clearing them.
  assert.equal(oauth.hasTokens(), true);
});
