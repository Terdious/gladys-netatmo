// -----------------------------------------------------------------------------
// Unit tests of the authenticated API client: the 401 refresh-and-retry path,
// and the 403 scope-refusal (Netatmo error code 13) that must NOT trigger a
// refresh nor replay the (non-idempotent) request; plus the degraded payload
// shapes (non-ok status, missing home, errors at body.errors).
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

test('setThermMode posts the home mode, with the endtime only for away / frost guard', async () => {
  await client.setThermMode('home-1', 'away', 1_800_000_000.4);
  await client.setThermMode('home-1', 'hg');
  await client.setThermMode('home-1', 'schedule', 1_800_000_000);
  assert.deepEqual(netatmo.state.setThermModeRequests, [
    { home_id: 'home-1', mode: 'away', endtime: '1800000000' },
    { home_id: 'home-1', mode: 'hg' },
    { home_id: 'home-1', mode: 'schedule' },
  ]);
});

test('getHomeStatus reads the errors at home.errors, or at body.errors as a fallback', async () => {
  const home = netatmo.state.homeStatuses['home-1'].home;
  let status = await client.getHomeStatus('home-1');
  assert.equal(status.home.id, 'home-1');
  assert.deepEqual(status.errors, [{ code: 6, id: 'valve-2' }]);

  // Same unreachable module, reported next to `home` instead of inside it.
  delete home.errors;
  netatmo.state.homeStatuses['home-1'].errors = [{ code: 6, id: 'valve-2' }];
  status = await client.getHomeStatus('home-1');
  assert.equal(status.home.id, 'home-1');
  assert.deepEqual(status.errors, [{ code: 6, id: 'valve-2' }]);

  // No errors anywhere: an empty array, never undefined.
  delete netatmo.state.homeStatuses['home-1'].errors;
  status = await client.getHomeStatus('home-1');
  assert.deepEqual(status.errors, []);
});

test('getHomeStatus degrades to "no home" on a non-ok status or a missing body.home', async () => {
  netatmo.state.overrides['/api/homestatus'] = {
    body: { status: 'error', body: netatmo.state.homeStatuses['home-1'] },
  };
  assert.deepEqual(await client.getHomeStatus('home-1'), { home: undefined, errors: [] });

  netatmo.state.overrides['/api/homestatus'] = {
    body: { status: 'ok', body: { errors: [{ code: 6, id: 'valve-2' }] } },
  };
  assert.deepEqual(await client.getHomeStatus('home-1'), { home: undefined, errors: [] });

  netatmo.state.overrides['/api/homestatus'] = { body: { status: 'ok' } };
  assert.deepEqual(await client.getHomeStatus('home-1'), { home: undefined, errors: [] });
});

test('the legacy device lists degrade to [] on a non-ok status', async () => {
  // Sanity: the regular answers do carry devices.
  assert.equal((await client.getThermostatsData()).length, 1);
  assert.equal((await client.getStationsData()).length, 1);
  assert.equal((await client.getHomeCoachsData()).length, 2);

  for (const path of [
    '/api/getthermostatsdata',
    '/api/getstationsdata',
    '/api/gethomecoachsdata',
  ]) {
    // HTTP 200 but a non-ok status, devices included: they must not be trusted.
    netatmo.state.overrides[path] = {
      body: { status: 'error', body: { devices: [{ _id: 'ghost', type: 'NAMain' }] } },
    };
  }
  assert.deepEqual(await client.getThermostatsData(), []);
  assert.deepEqual(await client.getStationsData(), []);
  assert.deepEqual(await client.getHomeCoachsData(), []);
  assert.equal(refreshCalls, 0);
});
