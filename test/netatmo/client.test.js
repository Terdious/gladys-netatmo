// -----------------------------------------------------------------------------
// Unit tests of the authenticated API client: the 401 refresh-and-retry path,
// and the 403 scope-refusal (Netatmo error code 13) that must NOT trigger a
// refresh nor replay the (non-idempotent) request.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNetatmoClient } from '../../src/netatmo/client.js';
import { startFakeNetatmo } from '../helpers/fakeNetatmo.js';

let netatmo;
let refreshCalls;
let client;

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('token-old', 'token-new');
  refreshCalls = 0;
  let current = 'token-old';
  client = createNetatmoClient({
    oauth: {
      ensureFreshAccessToken: async () => current,
      refreshTokens: async () => {
        refreshCalls += 1;
        current = 'token-new';
      },
    },
    baseUrl: netatmo.url,
  });
});

afterEach(async () => {
  await netatmo.close();
});

test('a 401 refreshes the token once and retries the request', async () => {
  netatmo.state.rejectAccessToken = 'token-old';
  const homes = await client.getHomesData();
  assert.ok(Array.isArray(homes) && homes.length > 0);
  assert.equal(refreshCalls, 1);
  const auths = netatmo.state.apiRequests.map((r) => r.authorization);
  assert.deepEqual(auths, ['Bearer token-old', 'Bearer token-new']);
});

test('a 403 scope refusal (code 13) is NOT retried and burns no token refresh', async () => {
  netatmo.state.failSetpointWith = { status: 403, body: { error: { code: 13, message: 'scope' } } };
  await assert.rejects(
    client.setRoomThermpoint({ homeId: 'home-1', roomId: 'room-1', temp: 21 }),
    (err) => err.status === 403 && err.body?.error?.code === 13,
  );
  assert.equal(refreshCalls, 0);
  // The non-idempotent POST went out exactly once.
  assert.equal(netatmo.state.setpointRequests.length, 1);
});
