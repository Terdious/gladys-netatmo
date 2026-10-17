// -----------------------------------------------------------------------------
// getevents poll (the webhook fallback of the momentary detections): the
// events of the fake Netatmo cloud, shaped like the pyatmo fixture
// getevents.json (`body.home.events[]`, outdoor camera `subevents`), go
// through the same path as the webhooks — same features, same reset, same
// scene events — without replaying history on a start, without stale
// triggers, and never twice with the webhooks.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { createEvents } from '../../src/netatmo/events.js';
import {
  createEventsPoll,
  createEventsPollHistory,
  eventsPollHomes,
  normalizeGetEvent,
} from '../../src/netatmo/eventsPoll.js';
import { startFakeNetatmo } from '../helpers/fakeNetatmo.js';

const CONFIG = normalizeConfig({ security_api: true, bticino_api: true });
const ext = (id) => `ext:netatmo:${id}`;
// pyatmo getevents.json ids and shapes.
const NOC_ID = '12:34:56:10:b9:0e';
const CAMERA_ID = '12:34:56:00:f1:62';
const NDB_ID = '12:34:56:10:f1:66';
const SMOKE_ID = '12:34:56:00:8a:20';
const CO_ID = '12:34:56:00:8a:21';
const BNCX_ID = '00:03:50:c0:47:74';
const BNEU_ID = 'c04774-a06f-db4f3bf1ff93';
const HOME_ID = '91763b24c43d3e344f424e8b';

const HOME = {
  id: HOME_ID,
  name: 'MYHOME',
  persons: [{ id: 'person-1', pseudo: 'John Doe' }, { id: 'face-unnamed' }],
  modules: [
    { id: CAMERA_ID, type: 'NACamera', name: 'Hall' },
    { id: NOC_ID, type: 'NOC', name: 'Front' },
    { id: NDB_ID, type: 'NDB', name: 'Doorbell' },
    { id: SMOKE_ID, type: 'NSD', name: 'Smoke' },
    { id: CO_ID, type: 'NCO', name: 'CO' },
    { id: BNCX_ID, type: 'BNCX', name: 'Door entry' },
    { id: BNEU_ID, type: 'BNEU', name: 'Street panel', bridge: BNCX_ID },
  ],
};

let netatmo;
let client;
let gladys;
let events;
let poll;
let clock;
let timers;
let logs;

/** Seconds since the epoch, `secondsAgo` before the fake clock. */
const ago = (secondsAgo) => Math.round(clock / 1000) - secondsAgo;

function device(id, suffixes) {
  return {
    external_id: ext(id),
    name: `Gladys ${id}`,
    features: suffixes.map((suffix) => ({ external_id: `${ext(id)}:${suffix}` })),
  };
}

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
    clearTimeout: (id) => scheduled.delete(id),
    async flush() {
      const pending = [...scheduled.values()];
      scheduled.clear();
      for (const fn of pending) {
        await fn();
      }
    },
  };
}

function setEvents(list) {
  netatmo.state.events[HOME_ID] = list;
}

function stateOf(suffixedId) {
  return gladys.published
    .filter((s) => s.device_feature_external_id === suffixedId)
    .map((s) => s.state);
}

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
  clock = 1_645_900_000_000;
  timers = fakeTimers();
  gladys = {
    published: [],
    sceneEvents: [],
    externalId: ext,
    devices: [
      device(CAMERA_ID, ['motion', 'human']),
      device(NOC_ID, ['motion', 'human', 'animal', 'vehicle']),
      device(NDB_ID, ['ring']),
      device(SMOKE_ID, ['smoke']),
      device(CO_ID, ['carbon_monoxide']),
      device(BNCX_ID, ['ring']),
    ],
    async publishStates(states) {
      this.published.push(...states);
    },
    async publishSceneEvent(key, data) {
      this.sceneEvents.push({ key, data });
    },
  };
  events = createEvents({ gladys, getHomes: () => [HOME], timers, now: () => clock });
  logs = { warn: [], info: [], debug: [] };
  poll = createEventsPoll({
    client,
    events,
    now: () => clock,
    logger: {
      warn: (line) => logs.warn.push(line),
      info: (line) => logs.info.push(line),
      debug: (line) => logs.debug.push(line),
    },
  });
});

afterEach(async () => {
  events.stop();
  await netatmo.close();
});

/** Seed the poll with what is there at startup, then move the clock on. */
async function seed(list = []) {
  setEvents(list);
  await poll.poll(CONFIG, [HOME]);
  clock += 2 * 60 * 1000;
}

// --- Normalization and eligibility -----------------------------------------------

test('a getevents entry is normalized like a webhook: one item per outdoor sub-event', () => {
  const outdoor = {
    id: '11111111111111111f7763a6d',
    type: 'outdoor',
    time: 1645794709,
    module_id: NOC_ID,
    subevents: [
      { id: 'sub-1', type: 'human', time: 1645794709, snapshot: { url: 'https://x.invalid/s' } },
      { id: 'sub-2', type: 'vehicle', time: 1645794716 },
    ],
  };
  const items = normalizeGetEvent(outdoor, HOME_ID);
  assert.deepEqual(
    items.map((item) => [item.key, item.event.type, item.event.time, item.summary.sub_type]),
    [
      ['subevent:sub-1', 'human', 1645794709000, 'human'],
      ['subevent:sub-2', 'vehicle', 1645794716000, 'vehicle'],
    ],
  );
  assert.equal(items[0].event.source, 'poll');
  assert.equal(items[0].event.eventId, outdoor.id);
  assert.deepEqual(items[0].event.moduleIds, [NOC_ID]);
  // No URL ever reaches the diagnostic summary.
  assert.ok(!JSON.stringify(items.map((item) => item.summary)).includes('http'));

  const [person] = normalizeGetEvent(
    {
      id: '1111111111111112c91b3628',
      type: 'person',
      time: 1645901266,
      module_id: CAMERA_ID,
      person_id: 'person-1',
      message: '<b>John Doe</b> gesehen',
    },
    HOME_ID,
  );
  assert.equal(person.key, 'event:1111111111111112c91b3628');
  assert.deepEqual(person.event.persons, [{ id: 'person-1' }]);
  const [smoke] = normalizeGetEvent({ id: 'e', type: 'smoke', sub_type: 0, time: 1 }, HOME_ID);
  assert.equal(smoke.event.subType, '0');
  assert.deepEqual(normalizeGetEvent(null, HOME_ID), []);
  // No id at all: a stable key from the type, module and time.
  assert.equal(
    normalizeGetEvent({ type: 'movement', module_id: 'm', time: 5 }, HOME_ID)[0].key,
    'movement:m:5',
  );
});

test('only homes with a camera, doorbell or alarm (Security) or a door entry (BTicino) are polled', () => {
  const energyOnly = { id: 'h2', modules: [{ id: 't', type: 'NATherm1' }] };
  const doorEntry = { id: 'h3', modules: [{ id: 'g', type: 'BNCX' }] };
  const smokeOnly = { id: 'h4', modules: [{ id: 's', type: 'NSD' }] };
  const homes = [HOME, energyOnly, doorEntry, smokeOnly];
  assert.deepEqual(
    eventsPollHomes(CONFIG, homes).map((home) => home.id),
    [HOME_ID, 'h3', 'h4'],
  );
  assert.deepEqual(
    eventsPollHomes(normalizeConfig({ security_api: false, bticino_api: true }), homes).map(
      (home) => home.id,
    ),
    [HOME_ID, 'h3'],
  );
  assert.deepEqual(eventsPollHomes(normalizeConfig({ security_api: false }), homes), []);
});

// --- Startup, new events, stale events -------------------------------------------

test('the first answer only seeds: history is never replayed on a start', async () => {
  await seed([
    { id: 'old-motion', type: 'movement', time: ago(20), module_id: CAMERA_ID },
    { id: 'old-ring', type: 'incoming_call', time: ago(10), module_id: NDB_ID },
  ]);
  assert.equal(gladys.published.length, 0);
  assert.deepEqual(netatmo.state.getEventsRequests, [{ home_id: HOME_ID, size: '30' }]);
  assert.ok(logs.info.some((line) => line.includes('2 event(s) already in home')));
  assert.deepEqual(
    poll.history.recent().map((entry) => entry.outcome),
    ['startup', 'startup'],
  );
  // The same events again: nothing new.
  await poll.poll(CONFIG, [HOME]);
  assert.equal(gladys.published.length, 0);
  assert.equal(poll.history.total(), 2);
});

test('new events drive the same features as the webhooks, then reset after a minute', async () => {
  await seed([{ id: 'old', type: 'movement', time: ago(300), module_id: CAMERA_ID }]);
  setEvents([
    // pyatmo getevents.json: an outdoor event with human / vehicle / human sub-events.
    {
      id: 'outdoor-1',
      type: 'outdoor',
      time: ago(60),
      module_id: NOC_ID,
      video_status: 'available',
      subevents: [
        { id: 'sub-h1', type: 'human', time: ago(60) },
        { id: 'sub-v1', type: 'vehicle', time: ago(55) },
        { id: 'sub-h2', type: 'human', time: ago(50) },
      ],
    },
    { id: 'outdoor-2', type: 'outdoor', time: ago(40), module_id: NOC_ID, subevents: [] },
    {
      id: 'outdoor-3',
      type: 'outdoor',
      time: ago(30),
      module_id: NOC_ID,
      subevents: [{ id: 'sub-a1', type: 'animal', time: ago(30) }],
    },
    { id: 'move-1', type: 'movement', time: ago(45), module_id: CAMERA_ID },
    { id: 'ring-1', type: 'incoming_call', time: ago(20), module_id: NDB_ID },
    { id: 'answer-1', type: 'accepted_call', time: ago(15), module_id: NDB_ID },
    // BTicino: the street panel rings, the gateway's ring feature fires.
    { id: 'ring-2', type: 'incoming_call', time: ago(18), module_id: BNEU_ID },
    { id: 'co-1', type: 'co_detected', sub_type: 2, time: ago(10), module_id: CO_ID },
    { id: 'conn-1', type: 'connection', time: ago(5), module_id: NOC_ID },
    { id: 'old', type: 'movement', time: ago(300), module_id: CAMERA_ID },
  ]);
  await poll.poll(CONFIG, [HOME]);

  // One outdoor event = one detection per category, not one per sub-event.
  assert.deepEqual(stateOf(`${ext(NOC_ID)}:human`), [1]);
  assert.deepEqual(stateOf(`${ext(NOC_ID)}:vehicle`), [1]);
  assert.deepEqual(stateOf(`${ext(NOC_ID)}:animal`), [1]);
  assert.deepEqual(stateOf(`${ext(CAMERA_ID)}:motion`), [1]);
  assert.deepEqual(stateOf(`${ext(NDB_ID)}:ring`), [1]);
  assert.deepEqual(stateOf(`${ext(BNCX_ID)}:ring`), [1]);
  assert.deepEqual(stateOf(`${ext(CO_ID)}:carbon_monoxide`), [1]);
  // Published oldest first.
  assert.equal(gladys.published[0].device_feature_external_id, `${ext(NOC_ID)}:human`);
  const outcomes = Object.fromEntries(
    poll.history.recent().map((entry) => [`${entry.id}/${entry.sub_type ?? ''}`, entry.outcome]),
  );
  assert.equal(outcomes['answer-1/'], 'not_momentary');
  assert.equal(outcomes['conn-1/'], 'not_momentary');
  assert.equal(outcomes['outdoor-1/human'], 'duplicate');
  assert.equal(poll.status().published, 7);

  // Same 60 s reset as the webhooks.
  await timers.flush();
  assert.deepEqual(stateOf(`${ext(CAMERA_ID)}:motion`), [1, 0]);
  assert.deepEqual(stateOf(`${ext(NDB_ID)}:ring`), [1, 0]);
});

test('a smoke detection then its "cleared" event: 1 then 0, like the webhooks', async () => {
  await seed();
  setEvents([
    { id: 'smoke-1', type: 'smoke', sub_type: 1, time: ago(50), module_id: SMOKE_ID },
    { id: 'smoke-2', type: 'smoke', sub_type: 0, time: ago(20), module_id: SMOKE_ID },
  ]);
  await poll.poll(CONFIG, [HOME]);
  assert.deepEqual(stateOf(`${ext(SMOKE_ID)}:smoke`), [1, 0]);
  assert.equal(events.pendingResets(), 0);
  assert.equal(poll.history.recent().at(-1).outcome, 'cleared');
});

test('an event older than 10 minutes at poll time is recorded, never published', async () => {
  await seed();
  setEvents([
    { id: 'stale', type: 'movement', time: ago(11 * 60), module_id: CAMERA_ID },
    { id: 'no-time', type: 'movement', module_id: CAMERA_ID },
  ]);
  await poll.poll(CONFIG, [HOME]);
  assert.equal(gladys.published.length, 0);
  assert.deepEqual(
    poll.history.forModule(CAMERA_ID).map((entry) => entry.outcome),
    ['too_old', 'too_old'],
  );
});

test('a person event fires the known-person scene once, an unnamed face never', async () => {
  await seed();
  setEvents([
    { id: 'p-1', type: 'person', time: ago(30), module_id: CAMERA_ID, person_id: 'person-1' },
    { id: 'p-2', type: 'person', time: ago(20), module_id: CAMERA_ID, person_id: 'face-unnamed' },
  ]);
  await poll.poll(CONFIG, [HOME]);
  assert.deepEqual(gladys.sceneEvents, [
    {
      key: 'known_person_arrived',
      data: {
        camera: ext(CAMERA_ID),
        person: 'John Doe',
        camera_name: `Gladys ${CAMERA_ID}`,
        home_name: 'MYHOME',
      },
    },
  ]);
  // Both still drive the "person detected" feature (re-armed by the second).
  assert.deepEqual(stateOf(`${ext(CAMERA_ID)}:human`), [1, 1]);
  assert.equal(poll.history.recent().at(-2).scenes, 1);
  // The webhook of the same event (same id) fires nothing more.
  await events.handleWebhook({
    push_type: 'NACamera-person',
    event_id: 'p-1',
    home_id: HOME_ID,
    camera_id: CAMERA_ID,
    persons: [{ id: 'person-1', is_known: true }],
  });
  assert.equal(gladys.sceneEvents.length, 1);
});

// --- Webhook / poll dedup ------------------------------------------------------

test('an event a webhook already published is not published again by the poll', async () => {
  await seed();
  // Webhook with the Netatmo event id: matched by id.
  await events.handleWebhook({
    push_type: 'NACamera-movement',
    event_id: 'move-1',
    camera_id: CAMERA_ID,
  });
  // Webhook without an id: matched by module + type within 90 s.
  await events.handleWebhook({ push_type: 'NDB-incoming_call', device_id: NDB_ID });
  // NOC webhook carrying the outdoor event id: its sub-event is the same detection.
  await events.handleWebhook({ push_type: 'NOC-human', event_id: 'out-1', camera_id: NOC_ID });
  assert.equal(gladys.published.length, 3);

  setEvents([
    { id: 'move-1', type: 'movement', time: ago(5), module_id: CAMERA_ID },
    { id: 'ring-1', type: 'incoming_call', time: ago(1), module_id: NDB_ID },
    {
      id: 'out-1',
      type: 'outdoor',
      time: ago(3),
      module_id: NOC_ID,
      subevents: [{ id: 'sub-1', type: 'human', time: ago(3) }],
    },
  ]);
  await poll.poll(CONFIG, [HOME]);
  assert.equal(gladys.published.length, 3, 'nothing published twice');
  assert.deepEqual(
    poll.history.recent().map((entry) => entry.outcome),
    ['duplicate', 'duplicate', 'duplicate'],
  );
});

test('the same type on the same module more than 90 s apart is a new detection', async () => {
  await seed();
  await events.handleWebhook({ push_type: 'NACamera-movement', camera_id: CAMERA_ID });
  setEvents([{ id: 'move-2', type: 'movement', time: ago(-100), module_id: CAMERA_ID }]);
  clock += 100 * 1000;
  await poll.poll(CONFIG, [HOME]);
  assert.deepEqual(stateOf(`${ext(CAMERA_ID)}:motion`), [1, 1]);
});

test('a webhook arriving after the poll published the event publishes nothing', async () => {
  await seed();
  setEvents([{ id: 'ring-9', type: 'incoming_call', time: ago(10), module_id: NDB_ID }]);
  await poll.poll(CONFIG, [HOME]);
  assert.deepEqual(stateOf(`${ext(NDB_ID)}:ring`), [1]);
  // By id…
  assert.equal(
    await events.handleWebhook({
      push_type: 'NDB-incoming_call',
      event_id: 'ring-9',
      device_id: NDB_ID,
    }),
    undefined,
  );
  // …or, without one, by module + type within the window.
  assert.equal(
    await events.handleWebhook({ push_type: 'NDB-incoming_call', device_id: NDB_ID }),
    undefined,
  );
  assert.deepEqual(stateOf(`${ext(NDB_ID)}:ring`), [1]);
  // Webhooks alone keep their behaviour: a re-delivery publishes again.
  await events.handleWebhook({ push_type: 'NACamera-movement', camera_id: CAMERA_ID });
  await events.handleWebhook({ push_type: 'NACamera-movement', camera_id: CAMERA_ID });
  assert.deepEqual(stateOf(`${ext(CAMERA_ID)}:motion`), [1, 1]);
});

// --- Budget, failures, health ------------------------------------------------------

test('a home is polled at most once per 30 s (webhook-triggered refreshes)', async () => {
  await seed();
  await poll.poll(CONFIG, [HOME]);
  clock += 10 * 1000;
  await poll.poll(CONFIG, [HOME]);
  assert.equal(netatmo.state.getEventsRequests.length, 2);
  clock += 30 * 1000;
  await poll.poll(CONFIG, [HOME]);
  assert.equal(netatmo.state.getEventsRequests.length, 3);
});

test('failures: warn once per streak, counted in the events health, never thrown', async () => {
  assert.equal(poll.getHealth(), null, 'no health entry before the first attempt');
  netatmo.state.failGetEventsWith = { status: 500, body: { error: { code: 500 } } };
  await poll.poll(CONFIG, [HOME]);
  clock += 2 * 60 * 1000;
  await poll.poll(CONFIG, [HOME]);
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /getevents failed for home/);
  assert.deepEqual(poll.getHealth(), { family: 'events', lastSuccessAt: null, failures: 2 });

  // Recovery: the first answer seeds (nothing was seeded yet), the streak ends.
  netatmo.state.failGetEventsWith = null;
  setEvents([{ id: 'during', type: 'movement', time: ago(30), module_id: CAMERA_ID }]);
  clock += 2 * 60 * 1000;
  await poll.poll(CONFIG, [HOME]);
  assert.equal(gladys.published.length, 0);
  assert.deepEqual(poll.getHealth(), { family: 'events', lastSuccessAt: clock, failures: 0 });
  assert.ok(logs.info.some((line) => line.includes('answers again after 2 failed cycle(s)')));
  assert.equal(poll.status().lastError, null);
});

test('a scope refusal says to click Connect again', async () => {
  netatmo.state.failGetEventsWith = {
    status: 403,
    body: { error: { code: 13, message: 'Application does not have the good scope rights' } },
  };
  await poll.poll(CONFIG, [HOME]);
  assert.match(logs.warn[0], /missing scope rights.*click Connect again/);
  assert.match(poll.status().lastError, /missing scope rights/);
  // A scope refusal is not a token problem: no token refresh, one request.
  assert.equal(netatmo.state.getEventsRequests.length, 1);
});

test('a non-ok answer is a failure; a home no longer eligible is forgotten, then re-seeded', async () => {
  netatmo.state.overrides['/api/getevents'] = { body: { status: 'error' } };
  await poll.poll(CONFIG, [HOME]);
  assert.equal(poll.getHealth().failures, 1);
  delete netatmo.state.overrides['/api/getevents'];
  clock += 60 * 1000;

  await seed([{ id: 'a', type: 'movement', time: ago(10), module_id: CAMERA_ID }]);
  assert.deepEqual(poll.status().homes, [
    {
      id: HOME_ID,
      seeded: true,
      lastPollAt: clock - 2 * 60 * 1000,
      newest: { time: ago(130) * 1000, id: 'a' },
    },
  ]);
  // Security family off: the home is not polled, its memory goes.
  await poll.poll(normalizeConfig({ security_api: false }), [HOME]);
  assert.deepEqual(poll.status().homes, []);
  // Back on: what happened meanwhile is seeded, not replayed.
  setEvents([{ id: 'b', type: 'movement', time: ago(5), module_id: CAMERA_ID }]);
  await poll.poll(CONFIG, [HOME]);
  assert.equal(gladys.published.length, 0);
});

test('the history is bounded overall and per module', () => {
  const history = createEventsPollHistory({ size: 2, perModule: 1, maxModules: 1 });
  history.record({ seenAt: 1, module_id: 'a', id: '1' });
  history.record({ seenAt: 2, module_id: 'b', id: '2' });
  history.record({ seenAt: 3, id: '3' });
  assert.deepEqual(
    history.recent().map((entry) => entry.id),
    ['2', '3'],
  );
  assert.deepEqual(history.forModule('a'), []);
  assert.deepEqual(
    history.forModule('b').map((entry) => entry.id),
    ['2'],
  );
  assert.equal(history.lastAt(), 3);
  assert.equal(history.total(), 3);
});
