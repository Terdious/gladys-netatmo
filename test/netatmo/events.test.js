// -----------------------------------------------------------------------------
// Unit tests of the momentary-event engine (issue #5): a relayed webhook
// payload publishes the matching detection feature, which returns to 0 by
// itself (the Netatmo stream carries no "cleared" event), and everything that
// is not a momentary detection is ignored.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEvents,
  eventNameOf,
  eventDeviceIdOf,
  normalizeWebhookEvent,
} from '../../src/netatmo/events.js';

// Injectable timers: capture the scheduled reset so the test drives it.
function fakeTimers() {
  const scheduled = new Map();
  let nextId = 0;
  return {
    scheduled,
    setTimeout: (fn) => {
      nextId += 1;
      scheduled.set(nextId, fn);
      return nextId;
    },
    clearTimeout: (id) => {
      scheduled.delete(id);
    },
    async flush() {
      const pending = [...scheduled.values()];
      scheduled.clear();
      for (const fn of pending) {
        await fn();
      }
    },
  };
}

function fakeGladys({
  features = ['motion', 'human', 'animal', 'vehicle', 'smoke', 'carbon_monoxide', 'ring'],
} = {}) {
  const published = [];
  return {
    published,
    externalId: (suffix) => `ext:netatmo:${suffix}`,
    devices: [
      {
        external_id: 'ext:netatmo:camera-1',
        features: features.map((suffix) => ({
          external_id: `ext:netatmo:camera-1:${suffix}`,
        })),
      },
    ],
    async publishStates(states) {
      published.push(...states);
    },
  };
}

function stateOf(gladys, featureExternalId) {
  return gladys.published
    .filter((s) => s.device_feature_external_id === featureExternalId)
    .map((s) => s.state);
}

test('the event name comes from push_type, with event_type as a fallback', () => {
  assert.equal(eventNameOf({ push_type: 'NACamera-movement' }), 'movement');
  assert.equal(eventNameOf({ push_type: 'NOC-human' }), 'human');
  assert.equal(eventNameOf({ push_type: 'NSD-smoke' }), 'smoke');
  assert.equal(eventNameOf({ push_type: 'NCO-co_detected' }), 'co_detected');
  assert.equal(eventNameOf({ event_type: 'movement' }), 'movement');
  assert.equal(eventNameOf({}), undefined);
});

test('the module id accepts the camera, module and device fields', () => {
  assert.equal(eventDeviceIdOf({ camera_id: 'cam' }), 'cam');
  assert.equal(eventDeviceIdOf({ module_id: 'mod', camera_id: 'cam' }), 'mod');
  assert.equal(eventDeviceIdOf({ device_id: 'dev' }), 'dev');
  assert.equal(eventDeviceIdOf({}), undefined);
});

test('a motion event publishes 1, then returns to 0 on its own', async () => {
  const gladys = fakeGladys();
  const timers = fakeTimers();
  const events = createEvents({ gladys, timers });

  await events.handleWebhook(
    JSON.stringify({ push_type: 'NACamera-movement', camera_id: 'camera-1' }),
  );
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:motion'), [1]);
  assert.equal(events.pendingResets(), 1);

  // No "cleared" event exists in the Netatmo stream: the reset is automatic.
  await timers.flush();
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:motion'), [1, 0]);
  assert.equal(events.pendingResets(), 0);
});

test('person, animal, vehicle and smoke events each drive their own feature', async () => {
  const gladys = fakeGladys();
  const events = createEvents({ gladys, timers: fakeTimers() });

  await events.handleWebhook({ push_type: 'NACamera-person', camera_id: 'camera-1' });
  await events.handleWebhook({ push_type: 'NOC-animal', camera_id: 'camera-1' });
  await events.handleWebhook({ push_type: 'NOC-vehicle', camera_id: 'camera-1' });
  await events.handleWebhook({ push_type: 'NSD-smoke', device_id: 'camera-1' });

  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:human'), [1]);
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:animal'), [1]);
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:vehicle'), [1]);
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:smoke'), [1]);
});

test('Indoor Camera Advance events (NPC- prefix) drive the camera detections (issue #55)', async () => {
  const gladys = fakeGladys();
  const timers = fakeTimers();
  const events = createEvents({ gladys, timers });

  assert.equal(
    await events.handleWebhook({ push_type: 'NPC-movement', camera_id: 'camera-1' }),
    'ext:netatmo:camera-1:motion',
  );
  await events.handleWebhook({ push_type: 'NPC-person', camera_id: 'camera-1' });
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:motion'), [1]);
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:human'), [1]);
  // The connection event (known to pyatmo) carries no momentary state.
  assert.equal(
    await events.handleWebhook({ push_type: 'NPC-connection', camera_id: 'camera-1' }),
    undefined,
  );
  await timers.flush();
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:motion'), [1, 0]);
});

test('a light_mode event publishes the floodlight mode on its two features (issue #56)', async () => {
  const gladys = fakeGladys({ features: ['motion', 'floodlight', 'floodlight_auto'] });
  const timers = fakeTimers();
  const events = createEvents({ gladys, timers });
  // pyatmo test_process_webhook_light_mode payload shape.
  const lightMode = (subType) => ({
    event_type: 'light_mode',
    device_id: 'camera-1',
    camera_id: 'camera-1',
    home_id: 'home-1',
    push_type: 'NOC-light_mode',
    sub_type: subType,
  });

  assert.equal(await events.handleWebhook(lightMode('on')), 'ext:netatmo:camera-1:floodlight');
  await events.handleWebhook(lightMode('auto'));
  await events.handleWebhook(lightMode('off'));
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:floodlight'), [1, 0, 0]);
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:floodlight_auto'), [0, 1, 0]);
  // A state, not a detection: nothing returns to 0 on its own.
  assert.equal(events.pendingResets(), 0);

  // Unknown or missing mode, unknown device: left to the refresh.
  const before = gladys.published.length;
  assert.equal(await events.handleWebhook(lightMode('strobe')), undefined);
  assert.equal(await events.handleWebhook(lightMode(undefined)), undefined);
  assert.equal(
    await events.handleWebhook({ ...lightMode('on'), camera_id: 'other', device_id: 'other' }),
    undefined,
  );
  assert.equal(gladys.published.length, before);
});

test('a carbon monoxide event (NCO-co_detected) publishes 1, then resets (issue #36)', async () => {
  const gladys = fakeGladys();
  const timers = fakeTimers();
  const events = createEvents({ gladys, timers });

  // Payload shape of the smoke alarm events (pyatmo): the alarm is `device_id`.
  const published = await events.handleWebhook({
    event_type: 'co_detected',
    device_id: 'camera-1',
    home_id: 'home-1',
    push_type: 'NCO-co_detected',
  });
  assert.equal(published, 'ext:netatmo:camera-1:carbon_monoxide');
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:carbon_monoxide'), [1]);

  await timers.flush();
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:carbon_monoxide'), [1, 0]);
});

test('carbon monoxide: pre-alarm and alarm are detections, sub_type 0 (OK) clears', async () => {
  const gladys = fakeGladys({ features: ['carbon_monoxide'] });
  const events = createEvents({ gladys, timers: fakeTimers() });
  const co = (subType) =>
    events.handleWebhook({
      push_type: 'NCO-co_detected',
      device_id: 'camera-1',
      sub_type: subType,
    });

  // Netatmo: co_detected sub_type 0 = OK, 1 = pre-alarm, 2 = alarm.
  await co(1);
  await co(2);
  await co(0);
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:carbon_monoxide'), [1, 1, 0]);
  assert.equal(events.pendingResets(), 0);
});

test('a doorbell ring (NDB-incoming_call) publishes 1, then resets (issue #35)', async () => {
  const gladys = fakeGladys();
  const timers = fakeTimers();
  const events = createEvents({ gladys, timers });

  const published = await events.handleWebhook({
    event_type: 'incoming_call',
    device_id: 'camera-1',
    home_id: 'home-1',
    push_type: 'NDB-incoming_call',
  });
  assert.equal(published, 'ext:netatmo:camera-1:ring');
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:ring'), [1]);

  // The answered / missed follow-ups describe the SAME ring: not mapped, so a
  // scene fires once per ring.
  for (const followUp of ['accepted_call', 'missed_call']) {
    assert.equal(
      await events.handleWebhook({ push_type: `NDB-${followUp}`, device_id: 'camera-1' }),
      undefined,
    );
  }
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:ring'), [1]);

  await timers.flush();
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:ring'), [1, 0]);
});

test('a new detection re-arms the reset instead of stacking timers', async () => {
  const gladys = fakeGladys();
  const timers = fakeTimers();
  const events = createEvents({ gladys, timers });

  await events.handleWebhook({ push_type: 'NACamera-movement', camera_id: 'camera-1' });
  await events.handleWebhook({ push_type: 'NACamera-movement', camera_id: 'camera-1' });
  assert.equal(events.pendingResets(), 1, 'one pending reset for the feature, not two');
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:motion'), [1, 1]);
});

test('a smoke "cleared" event (sub_type 0) returns the feature to 0, never raises a detection', async () => {
  const gladys = fakeGladys();
  const timers = fakeTimers();
  const events = createEvents({ gladys, timers });

  // Netatmo: smoke sub_type 1 = detected, 0 = cleared.
  await events.handleWebhook({ push_type: 'NSD-smoke', device_id: 'camera-1', sub_type: 1 });
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:smoke'), [1]);
  assert.equal(events.pendingResets(), 1);

  await events.handleWebhook({ push_type: 'NSD-smoke', device_id: 'camera-1', sub_type: 0 });
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:smoke'), [1, 0]);
  assert.equal(events.pendingResets(), 0, 'the pending reset is cancelled');

  // A "cleared" event alone (string sub_type too) never publishes a detection.
  await events.handleWebhook({ push_type: 'NSD-smoke', device_id: 'camera-1', sub_type: '0' });
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:smoke'), [1, 0, 0]);
  await timers.flush();
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:smoke'), [1, 0, 0]);
});

test('non-momentary events, unknown devices and junk bodies are ignored', async () => {
  const gladys = fakeGladys();
  const events = createEvents({ gladys, timers: fakeTimers() });

  // Connection/on-off/summary events: the refresh covers the pollable state.
  assert.equal(
    await events.handleWebhook({ push_type: 'NACamera-connection', camera_id: 'camera-1' }),
    undefined,
  );
  // A device the user never created in Gladys.
  assert.equal(
    await events.handleWebhook({ push_type: 'NACamera-movement', camera_id: 'unknown-cam' }),
    undefined,
  );
  // Malformed bodies must never throw inside a fire-and-forget handler.
  assert.equal(await events.handleWebhook('not json at all'), undefined);
  assert.equal(await events.handleWebhook(null), undefined);
  assert.equal(gladys.published.length, 0);
});

test('a detection whose feature was not created yet is skipped', async () => {
  // The user created the camera BEFORE the detection features existed: the
  // device is there, the feature is not (an "Update" is pending in Discovery).
  const gladys = fakeGladys({ features: ['camera', 'monitoring'] });
  const events = createEvents({ gladys, timers: fakeTimers() });

  assert.equal(
    await events.handleWebhook({ push_type: 'NACamera-movement', camera_id: 'camera-1' }),
    undefined,
  );
  assert.equal(gladys.published.length, 0);
});

test('a failing publish never throws out of the handler', async () => {
  const gladys = fakeGladys();
  gladys.publishStates = async () => {
    throw new Error('host API down');
  };
  const events = createEvents({ gladys, timers: fakeTimers() });

  await events.handleWebhook({ push_type: 'NACamera-movement', camera_id: 'camera-1' });
});

test('a webhook payload is normalized into the event the getevents poll shares', () => {
  const event = normalizeWebhookEvent(
    {
      push_type: 'NOC-human',
      camera_id: 'cam',
      device_id: 'cam',
      home_id: 'home-1',
      event_id: 'evt',
      subevent_id: 'sub',
      sub_type: 1,
    },
    42,
  );
  assert.deepEqual(event, {
    source: 'webhook',
    type: 'human',
    subType: '1',
    moduleIds: ['cam'],
    homeId: 'home-1',
    homeName: null,
    eventId: 'evt',
    subeventId: 'sub',
    time: 42,
    persons: [],
  });
});

test('handleEvent: the outcome of a normalized event (shared with the getevents poll)', async () => {
  const gladys = fakeGladys();
  const events = createEvents({ gladys, timers: fakeTimers(), now: () => 1000 });
  const base = { source: 'poll', moduleIds: ['camera-1'], time: 1000, persons: [] };
  assert.deepEqual(await events.handleEvent({ ...base, type: 'movement', eventId: 'e1' }), {
    outcome: 'published',
    featureExternalId: 'ext:netatmo:camera-1:motion',
    scenes: 0,
  });
  assert.equal((await events.handleEvent({ ...base, type: 'tag_open' })).outcome, 'not_momentary');
  assert.equal(
    (await events.handleEvent({ ...base, type: 'movement', moduleIds: [] })).outcome,
    'no_module',
  );
  assert.equal(
    (await events.handleEvent({ ...base, type: 'movement', moduleIds: ['other'] })).outcome,
    'not_created',
  );
  // The same Netatmo event from the webhook afterwards: already published.
  assert.equal(
    await events.handleWebhook({
      push_type: 'NACamera-movement',
      event_id: 'e1',
      camera_id: 'camera-1',
    }),
    undefined,
  );
  assert.deepEqual(stateOf(gladys, 'ext:netatmo:camera-1:motion'), [1]);
});
