// -----------------------------------------------------------------------------
// End-to-end test: the REAL @gladysassistant/integration-sdk client wired by
// the REAL setupIntegration() from index.js, connected to a fake Gladys core
// (WebSocket + REST) and a fake Netatmo cloud, exercising the OAuth2 relay:
//   1. fresh install -> connection status "missing client config";
//   2. config filled -> "not connected yet";
//   3. Connect button -> authorize URL acked with client_id/scope/state;
//   4. relayed callback -> code exchanged, tokens stored in the core config,
//      connection status true, homesdata validated with the Bearer token;
//   5. replayed callback -> rejected (single-use state).
// -----------------------------------------------------------------------------

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GladysIntegration, WEBSOCKET_MESSAGE_TYPES } from '@gladysassistant/integration-sdk';

import { setupIntegration } from '../index.js';
import { startFakeGladysCore, waitFor } from './helpers/fakeGladysCore.js';
import {
  startFakeNetatmo,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_AUTH_CODE,
} from './helpers/fakeNetatmo.js';

const { EXTERNAL_INTEGRATION } = WEBSOCKET_MESSAGE_TYPES;
const REDIRECT_URI = 'https://gladys.local/oauth-callback';

let core;
let netatmo;
let gladys;
let integration;
let messageId = 0;

function nextMessageId() {
  messageId += 1;
  return `msg-${messageId}`;
}

async function sendAndWaitResult(type, payload) {
  const id = nextMessageId();
  core.send(type, { message_id: id, ...payload });
  return waitFor(() => core.state.commandResults.find((result) => result.message_id === id));
}

// The fake core serves this object on GET /config: tests mutate it to
// simulate a config saved in the store without a config-updated push.
const coreConfig = {};

before(async () => {
  netatmo = await startFakeNetatmo();
  core = await startFakeGladysCore({ config: coreConfig });

  gladys = new GladysIntegration({
    hostApiUrl: core.url,
    token: 'integration-token',
    selector: 'netatmo',
  });
  integration = setupIntegration(gladys, { netatmoBaseUrl: netatmo.url });

  await gladys.connect();
});

after(async () => {
  integration.oauth.stop();
  await gladys.disconnect();
  await core.close();
  await netatmo.close();
});

test('a fresh install reports "missing client config" on the Configuration screen', async () => {
  const status = await waitFor(() => core.state.connectionStatuses[0]);
  assert.equal(status.connected, false);
  assert.match(status.message.en, /client id and client secret/);
});

test('Connect without saved credentials fails with an actionable status message', async () => {
  const result = await sendAndWaitResult(EXTERNAL_INTEGRATION.OAUTH_GET_AUTHORIZE_URL, {
    key: 'netatmo_account',
    redirect_uri: REDIRECT_URI,
  });
  assert.equal(result.success, false);
  assert.match(result.error, /must be saved first/);
  // The config screen gets an explicit "save first" hint (the front only
  // shows a generic error for the failed command itself).
  const status = core.state.connectionStatuses.at(-1);
  assert.match(status.message.fr, /SAUVEGARDEZ/);
});

test('a save-then-connect race is covered by the config re-fetch', async () => {
  // Credentials land in the core store, but no config-updated push reaches
  // the container (the front does not save on Connect; pushes can also race).
  Object.assign(coreConfig, { client_id: FAKE_CLIENT_ID, client_secret: FAKE_CLIENT_SECRET });
  const result = await sendAndWaitResult(EXTERNAL_INTEGRATION.OAUTH_GET_AUTHORIZE_URL, {
    key: 'netatmo_account',
    redirect_uri: REDIRECT_URI,
  });
  assert.equal(result.success, true);
  assert.equal(new URL(result.data.authorize_url).searchParams.get('client_id'), FAKE_CLIENT_ID);
});

test('filling the client credentials moves the status to "not connected yet"', async () => {
  const statusCount = core.state.connectionStatuses.length;
  core.send(EXTERNAL_INTEGRATION.CONFIG_UPDATED, {
    config: { client_id: FAKE_CLIENT_ID, client_secret: FAKE_CLIENT_SECRET },
  });
  const status = await waitFor(() => core.state.connectionStatuses[statusCount]);
  assert.equal(status.connected, false);
  assert.match(status.message.en, /not connected yet/);
});

test('the Connect button gets a Netatmo authorize URL', async () => {
  const result = await sendAndWaitResult(EXTERNAL_INTEGRATION.OAUTH_GET_AUTHORIZE_URL, {
    key: 'netatmo_account',
    redirect_uri: REDIRECT_URI,
  });
  assert.equal(result.success, true);
  const url = new URL(result.data.authorize_url);
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), FAKE_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.ok(url.searchParams.get('scope').includes('read_station'));
  assert.ok(url.searchParams.get('state'));
});

test('the relayed callback exchanges the code, stores the tokens and validates the account', async () => {
  // Restart the round-trip to hold a valid state.
  const authorize = await sendAndWaitResult(EXTERNAL_INTEGRATION.OAUTH_GET_AUTHORIZE_URL, {
    key: 'netatmo_account',
    redirect_uri: REDIRECT_URI,
  });
  const state = new URL(authorize.data.authorize_url).searchParams.get('state');

  const result = await sendAndWaitResult(EXTERNAL_INTEGRATION.OAUTH_CALLBACK, {
    key: 'netatmo_account',
    code: FAKE_AUTH_CODE,
    state,
    redirect_uri: REDIRECT_URI,
  });
  assert.equal(result.success, true);

  // Tokens stored in the core config store, outside the config_schema.
  assert.equal(core.state.config.access_token, 'access-1');
  assert.equal(core.state.config.refresh_token, 'refresh-1');
  assert.ok(core.state.config.expires_at > 0);

  // The account was validated with a real (fake) homesdata call.
  const homesdataCall = netatmo.state.apiRequests.find((r) => r.path.startsWith('/api/homesdata'));
  assert.ok(homesdataCall);
  assert.equal(homesdataCall.authorization, 'Bearer access-1');

  // And the Configuration screen shows connected.
  const lastStatus = core.state.connectionStatuses.at(-1);
  assert.equal(lastStatus.connected, true);

  // A replayed callback (same code + state) is rejected: single-use state.
  const replay = await sendAndWaitResult(EXTERNAL_INTEGRATION.OAUTH_CALLBACK, {
    key: 'netatmo_account',
    code: FAKE_AUTH_CODE,
    state,
    redirect_uri: REDIRECT_URI,
  });
  assert.equal(replay.success, false);
  assert.match(replay.error, /state mismatch/);
});

test('a scan request publishes the discovered Netatmo devices', async () => {
  core.send(EXTERNAL_INTEGRATION.SCAN_REQUEST, {});
  const devices = await waitFor(() => core.state.discovered.at(-1));
  // 7 supported devices from the fixtures (the cameras are skipped).
  assert.equal(devices.length, 7);
  const therm = devices.find((device) => device.external_id === 'ext:netatmo:therm-1');
  assert.ok(therm);
  assert.equal(
    therm.features.some((f) => f.external_id.endsWith(':therm_setpoint_temperature')),
    true,
  );
  // The transport badges went along (unreachable valve included) — published
  // right after the device list, so wait for them.
  // (the SDK posts entries as {device_external_id, transport})
  const badge = await waitFor(() =>
    core.state.transports
      .flat()
      .find((t) => t.device_external_id === 'ext:netatmo:valve-2' && t.transport === 'unreachable'),
  );
  assert.ok(badge);
});

test('saving the configuration re-runs the discovery automatically', async () => {
  const discoveredCount = core.state.discovered.length;
  // The user enables the Security API and saves: the cameras must surface
  // without a manual re-scan on the Discovery screen. The core pushes the
  // FULL config store (the OAuth tokens live in the same store).
  core.send(EXTERNAL_INTEGRATION.CONFIG_UPDATED, {
    config: {
      ...core.state.config,
      client_id: FAKE_CLIENT_ID,
      client_secret: FAKE_CLIENT_SECRET,
      security_api: 'true',
    },
  });
  await waitFor(() => core.state.discovered.length > discoveredCount);
  const republished = core.state.discovered.at(-1);
  assert.equal(republished.length, 9); // 7 devices + the 2 cameras
  assert.ok(republished.some((device) => device.external_id === 'ext:netatmo:camera-1'));
});
