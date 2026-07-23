// -----------------------------------------------------------------------------
// Unit tests of the Gladys Plus webhook engine (issue #5): registration at
// Netatmo through getWebhooks(), the "trigger, not data" debounced refresh, and
// the graceful degradation when Gladys Plus is not linked.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNetatmoClient } from '../../src/netatmo/client.js';
import { createWebhooks } from '../../src/netatmo/webhooks.js';
import { startFakeNetatmo } from '../helpers/fakeNetatmo.js';

let netatmo;
let client;

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
});

afterEach(async () => {
  await netatmo.close();
});

// Injectable timers: capture the scheduled callback so the test drives it.
function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout: (fn) => {
      scheduled.push(fn);
      return scheduled.length; // a truthy handle
    },
    clearTimeout: () => {},
    async flush() {
      const pending = scheduled.splice(0);
      for (const fn of pending) {
        await fn();
      }
    },
  };
}

test('register() registers the relay URL at Netatmo when Gladys Plus is available', async () => {
  const gladys = {
    getWebhooks: async () => ({
      available: true,
      webhooks: [{ key: 'events', mode: 'fire_and_forget', url: 'https://relay/webhook/abc' }],
    }),
  };
  const webhooks = createWebhooks({ gladys, client, refresh: async () => {} });

  const ok = await webhooks.register();
  assert.equal(ok, true);
  assert.equal(webhooks.isRegistered(), true);
  assert.equal(netatmo.state.addWebhookRequests.length, 1);
  assert.equal(netatmo.state.addWebhookRequests[0].url, 'https://relay/webhook/abc');
});

test('register() degrades to poll only when Gladys Plus is not linked', async () => {
  const gladys = { getWebhooks: async () => ({ available: false, webhooks: [] }) };
  const webhooks = createWebhooks({ gladys, client, refresh: async () => {} });

  const ok = await webhooks.register();
  assert.equal(ok, false);
  assert.equal(webhooks.isRegistered(), false);
  assert.equal(netatmo.state.addWebhookRequests.length, 0);
});

test('register() degrades to poll only on an older core without the webhook endpoint', async () => {
  const gladys = {
    getWebhooks: async () => {
      throw new Error('404 not found');
    },
  };
  const webhooks = createWebhooks({ gladys, client, refresh: async () => {} });

  assert.equal(await webhooks.register(), false);
  assert.equal(netatmo.state.addWebhookRequests.length, 0);
});

test('a burst of events triggers a single debounced refresh (trigger, not data)', async () => {
  const gladys = { getWebhooks: async () => ({ available: false, webhooks: [] }) };
  let refreshCount = 0;
  const timers = fakeTimers();
  const webhooks = createWebhooks({
    gladys,
    client,
    refresh: async () => {
      refreshCount += 1;
    },
    timers,
  });

  // Three events in the same burst schedule exactly one refresh.
  webhooks.handleEvent();
  webhooks.handleEvent();
  webhooks.handleEvent();
  assert.equal(timers.scheduled.length, 1);

  await timers.flush();
  assert.equal(refreshCount, 1);

  // A later event schedules a fresh refresh.
  webhooks.handleEvent();
  await timers.flush();
  assert.equal(refreshCount, 2);
});

test('drop() removes the Netatmo webhook only when one was registered', async () => {
  const gladys = {
    getWebhooks: async () => ({
      available: true,
      webhooks: [{ key: 'events', mode: 'fire_and_forget', url: 'https://relay/webhook/abc' }],
    }),
  };
  const webhooks = createWebhooks({ gladys, client, refresh: async () => {} });

  // Nothing registered yet: drop is a no-op.
  await webhooks.drop();
  assert.equal(netatmo.state.dropWebhookRequests.length, 0);

  await webhooks.register();
  await webhooks.drop();
  assert.equal(netatmo.state.dropWebhookRequests.length, 1);
  assert.equal(webhooks.isRegistered(), false);
});
