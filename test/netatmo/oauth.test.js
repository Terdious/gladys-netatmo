// -----------------------------------------------------------------------------
// Unit tests of the OAuth2 manager, against the fake Netatmo cloud:
// authorization URL, code exchange, single-use state (replay protection),
// refresh-token rotation, expiry-driven refresh and the transient/fatal
// error classification of the token endpoint.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import {
  createNetatmoOAuth,
  NotConnectedError,
  parseGrantedScopes,
} from '../../src/netatmo/oauth.js';
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

test('the granted scopes are parsed from an array or a space-separated string', () => {
  assert.deepEqual(parseGrantedScopes(['read_station', 'read_doorbell']), [
    'read_station',
    'read_doorbell',
  ]);
  assert.deepEqual(parseGrantedScopes('read_station read_doorbell'), [
    'read_station',
    'read_doorbell',
  ]);
  assert.equal(parseGrantedScopes(undefined), null);
  assert.equal(parseGrantedScopes(''), null);
});

test('scopes missing from the token are tracked until Connect grants them (issue #35)', async () => {
  const notified = [];
  oauth.onMissingScopes((missing) => notified.push(missing));
  assert.deepEqual(oauth.missingScopes(), []); // unknown before any token response
  assert.equal(oauth.grantedScopes(), null); // shown as unknown by the diagnostic

  // Full grant on the authorization exchange: nothing missing, nothing notified.
  await connectAccount();
  assert.deepEqual(oauth.missingScopes(), []);
  assert.equal(notified.length, 0);

  // A token granted before the doorbell scopes existed: the refresh echoes the
  // old set, the new scopes are reported missing.
  netatmo.state.grantedScopes = OAUTH_SCOPES.filter((scope) => !scope.includes('doorbell'));
  await oauth.refreshTokens();
  assert.deepEqual(oauth.missingScopes(), ['read_doorbell', 'access_doorbell']);
  assert.deepEqual(notified, [['read_doorbell', 'access_doorbell']]);
  assert.ok(!oauth.grantedScopes().includes('read_doorbell'));

  // Same set on the next refresh: no duplicate notification.
  await oauth.refreshTokens();
  assert.equal(notified.length, 1);

  // The user clicks Connect again: the full set is granted.
  await connectAccount();
  assert.deepEqual(oauth.missingScopes(), []);
  assert.deepEqual(notified.at(-1), []);
});

test('a token predating the Indoor Camera Advance reports the camerapro scopes missing (issue #55)', async () => {
  assert.ok(OAUTH_SCOPES.includes('read_camerapro'));
  assert.ok(OAUTH_SCOPES.includes('write_camerapro'));
  assert.ok(OAUTH_SCOPES.includes('access_camerapro'));
  await connectAccount();
  netatmo.state.grantedScopes = OAUTH_SCOPES.filter((scope) => !scope.endsWith('_camerapro'));
  await oauth.refreshTokens();
  assert.deepEqual(oauth.missingScopes(), [
    'read_camerapro',
    'write_camerapro',
    'access_camerapro',
  ]);
});

test('the BTicino scopes are requested and tracked only while its toggle is on (issue #59)', async () => {
  const bticinoScopes = ['read_bfi', 'write_bfi', 'read_mx', 'write_mx'];
  // Toggle off (default): neither asked nor reported missing.
  const off = new URL(oauth.buildAuthorizeUrl(REDIRECT_URI)).searchParams.get('scope');
  assert.ok(bticinoScopes.every((scope) => !off.split(' ').includes(scope)));
  await connectAccount();
  netatmo.state.grantedScopes = [...OAUTH_SCOPES];
  await oauth.refreshTokens();
  assert.deepEqual(oauth.missingScopes(), []);
  oauth.stop();

  // Toggle on with a token granted before: the authorize URL asks for them
  // and the re-check reports them missing without waiting for a refresh.
  let config = normalizeConfig({
    client_id: FAKE_CLIENT_ID,
    client_secret: FAKE_CLIENT_SECRET,
    bticino_api: 'true',
  });
  const notified = [];
  oauth = createNetatmoOAuth({
    gladys: {
      async setConfig(partial) {
        Object.assign(configStore, partial);
      },
    },
    getConfig: () => config,
    baseUrl: netatmo.url,
    now: () => clock,
  });
  oauth.onMissingScopes((missing) => notified.push(missing));
  const on = new URL(oauth.buildAuthorizeUrl(REDIRECT_URI)).searchParams.get('scope');
  assert.ok(bticinoScopes.every((scope) => on.split(' ').includes(scope)));
  await connectAccount();
  netatmo.state.grantedScopes = [...OAUTH_SCOPES]; // the old grant
  await oauth.refreshTokens();
  assert.deepEqual(oauth.missingScopes(), bticinoScopes);

  // Toggle back off: the re-check clears the hint.
  config = normalizeConfig({
    client_id: FAKE_CLIENT_ID,
    client_secret: FAKE_CLIENT_SECRET,
    bticino_api: 'false',
  });
  await oauth.recheckScopes();
  assert.deepEqual(oauth.missingScopes(), []);
  assert.deepEqual(notified.at(-1), []);
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

test('the legacy expire_in field (no expires_in) still sets the token expiry', async () => {
  netatmo.state.overrides['/oauth2/token'] = {
    body: { access_token: 'legacy-access', refresh_token: 'legacy-refresh', expire_in: 3600 },
  };
  await connectAccount();
  assert.equal(configStore.access_token, 'legacy-access');
  assert.equal(configStore.expires_at, clock + 3600 * 1000);

  // The expiry is honoured: cached before it, refreshed past it.
  assert.equal(await oauth.ensureFreshAccessToken(), 'legacy-access');
  assert.equal(netatmo.state.tokenRequests.length, 1);
  clock += 3600 * 1000;
  await oauth.ensureFreshAccessToken();
  assert.equal(netatmo.state.tokenRequests.length, 2);
  assert.equal(netatmo.state.tokenRequests[1].grant_type, 'refresh_token');
});

test('an object-shaped token error ({error: {message}}) surfaces its message', async () => {
  netatmo.state.overrides['/oauth2/token'] = {
    status: 400,
    body: { error: { code: 21, message: 'Invalid authorization code' } },
  };
  await assert.rejects(
    connectAccount(),
    (err) =>
      err.status === 400 &&
      err.transient === false &&
      err.message === 'Netatmo token endpoint answered 400: Invalid authorization code',
  );

  // Without a message, the error object itself is described (never "[object Object]").
  netatmo.state.overrides['/oauth2/token'] = { status: 400, body: { error: { code: 21 } } };
  await assert.rejects(connectAccount(), /answered 400: \{"code":21\}$/);
  assert.equal(oauth.hasTokens(), false);
});

test('a token granted before the Smarther scopes reports them missing (issue #54)', async () => {
  await connectAccount();
  // An account connected with 2.0.x: everything but the Smarther scopes.
  netatmo.state.grantedScopes = OAUTH_SCOPES.filter((scope) => !scope.endsWith('_smarther'));
  await oauth.refreshTokens();
  assert.deepEqual(oauth.missingScopes(), ['read_smarther', 'write_smarther']);
  assert.ok(OAUTH_SCOPES.join(' ').includes('read_smarther write_smarther'));
});
