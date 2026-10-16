// -----------------------------------------------------------------------------
// Scene triggers and actions (issue #39): the identity events of the webhook
// stream (known person seen / gone, siren sounding) fired as scene events
// carrying only declared keys, and the three scene actions (heating mode,
// persons away / home) against the fake Netatmo cloud.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import { createEvents, eventPersonsOf } from '../../src/netatmo/events.js';
import {
  SCENE_ACTIONS,
  endtimeOf,
  findPerson,
  findSchedule,
  resolveHome,
  resolveRoom,
  setpointOf,
} from '../../src/netatmo/scenes.js';
import { startFakeNetatmo } from '../helpers/fakeNetatmo.js';

const manifest = JSON.parse(
  await readFile(new URL('../../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const config = normalizeConfig({ security_api: 'true' });
const NOW = 1_800_000_000_000;

let netatmo;
let client;
let gladys;
let telemetry;

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
  const sceneEvents = [];
  gladys = {
    sceneEvents,
    devices: [],
    externalId: (suffix) => `ext:netatmo:${suffix}`,
    async publishStates() {},
    async publishDiscoveredDevices() {},
    async publishTransports() {},
    async publishCameraImage() {},
    async publishSceneEvent(key, data) {
      sceneEvents.push({ key, data });
      return { success: true };
    },
  };
  telemetry = createTelemetry({ gladys, client, loadTtlMs: 0 });
  // The user created every discovered device (cameras, siren, thermostat…).
  gladys.devices = await telemetry.syncDiscovery(config);
});

afterEach(async () => {
  telemetry.stop();
  await netatmo.close();
});

function ctx(extra = {}) {
  return { gladys, client, telemetry, now: () => NOW, ...extra };
}

/** Keys a trigger's event may carry: its filters and its variables. */
function declaredKeys(triggerKey) {
  const trigger = manifest.scene_triggers.find((entry) => entry.key === triggerKey);
  return [...trigger.fields, ...trigger.variables].map((entry) => entry.key);
}

function assertDeclared(event) {
  const declared = declaredKeys(event.key);
  for (const [key, value] of Object.entries(event.data)) {
    assert.ok(declared.includes(key), `data.${key} is not declared, the core would drop it`);
    assert.ok(value === null || typeof value !== 'object', `data.${key} must be a primitive`);
  }
}

// --- Triggers -----------------------------------------------------------------

test('the homes summaries carry names, known persons, modules and heating mode', () => {
  const [home] = telemetry.getHomes();
  assert.equal(home.id, 'home-1');
  assert.equal(home.name, 'Maison');
  assert.deepEqual(home.persons, [
    { id: 'person-1', pseudo: 'Alice' },
    { id: 'person-2', pseudo: 'Bob' },
  ]);
  assert.ok(home.modules.some((module) => module.id === 'camera-1'));
  assert.equal(home.therm_mode, 'schedule');
});

test('a recognized face fires known_person_arrived with the person, camera and home names', async () => {
  const events = createEvents({ gladys, getHomes: telemetry.getHomes });
  await events.handleWebhook({
    event_type: 'person',
    push_type: 'NACamera-person',
    home_id: 'home-1',
    camera_id: 'camera-1',
    event_id: 'evt-1',
    persons: [
      { id: 'person-1', is_known: true, face_url: 'https://example.invalid/face.jpg' },
      { id: 'stranger', is_known: false },
    ],
  });
  // One event for Alice, none for the unrecognized face.
  assert.deepEqual(gladys.sceneEvents, [
    {
      key: 'known_person_arrived',
      data: {
        camera: 'ext:netatmo:camera-1',
        person: 'Alice',
        camera_name: 'Caméra salon',
        home_name: 'Maison',
      },
    },
  ]);
  assertDeclared(gladys.sceneEvents[0]);
  events.stop();
});

test('a re-delivered webhook never fires the same scene event twice', async () => {
  const events = createEvents({ gladys, getHomes: telemetry.getHomes });
  const payload = {
    event_type: 'person',
    push_type: 'NACamera-person',
    home_id: 'home-1',
    camera_id: 'camera-1',
    event_id: 'evt-dup',
    persons: [{ id: 'person-2', is_known: true }],
  };
  await events.handleWebhook(payload);
  await events.handleWebhook(JSON.stringify(payload));
  assert.equal(gladys.sceneEvents.length, 1);
  events.stop();
});

test('person_away fires known_person_left, the camera found through the home modules', async () => {
  const events = createEvents({ gladys, getHomes: telemetry.getHomes });
  // No home_id in this payload: the home is the one owning the camera.
  await events.handleWebhook({
    push_type: 'NACamera-person_away',
    camera_id: 'camera-1',
    person_id: 'person-2',
  });
  assert.deepEqual(gladys.sceneEvents, [
    {
      key: 'known_person_left',
      data: {
        camera: 'ext:netatmo:camera-1',
        person: 'Bob',
        camera_name: 'Caméra salon',
        home_name: 'Maison',
      },
    },
  ]);
  assertDeclared(gladys.sceneEvents[0]);
  events.stop();
});

test('an id unknown to the homes data is a known person only when Netatmo says so', async () => {
  const events = createEvents({ gladys, getHomes: telemetry.getHomes });
  await events.handleWebhook({
    event_type: 'person',
    push_type: 'NACamera-person',
    home_id: 'home-1',
    camera_id: 'camera-1',
    persons: [{ id: 'new-person', is_known: true }, { id: 'no-flag' }],
  });
  assert.equal(gladys.sceneEvents.length, 1);
  assert.equal(gladys.sceneEvents[0].data.person, null);
  events.stop();
});

test('the Gladys device name wins over the Netatmo name for the camera variable', async () => {
  gladys.devices = gladys.devices.map((device) =>
    device.external_id === 'ext:netatmo:camera-1' ? { ...device, name: 'Entrée' } : device,
  );
  const events = createEvents({ gladys, getHomes: telemetry.getHomes });
  await events.handleWebhook({
    push_type: 'NACamera-person',
    home_id: 'home-1',
    camera_id: 'camera-1',
    persons: [{ id: 'person-1', is_known: true }],
  });
  assert.equal(gladys.sceneEvents[0].data.camera_name, 'Entrée');
  events.stop();
});

test('siren_sounding fires once when the siren starts, never when it stops', async () => {
  const events = createEvents({ gladys, getHomes: telemetry.getHomes });
  await events.handleWebhook({
    push_type: 'NIS-siren_sounding',
    home_id: 'home-1',
    module_id: 'siren-1',
    sub_type: 1,
  });
  await events.handleWebhook({
    push_type: 'NIS-siren_sounding',
    home_id: 'home-1',
    module_id: 'siren-1',
    sub_type: 0,
  });
  assert.deepEqual(gladys.sceneEvents, [
    {
      key: 'siren_sounding',
      data: { siren: 'ext:netatmo:siren-1', siren_name: 'Sirène', home_name: 'Maison' },
    },
  ]);
  assertDeclared(gladys.sceneEvents[0]);
  events.stop();
});

test('a person event still drives the momentary "person detected" feature', async () => {
  const published = [];
  gladys.publishStates = async (states) => published.push(...states);
  const timers = { setTimeout: () => 1, clearTimeout: () => {} };
  const events = createEvents({ gladys, getHomes: telemetry.getHomes, timers });
  const featureId = await events.handleWebhook({
    push_type: 'NACamera-person',
    camera_id: 'camera-1',
    persons: [{ id: 'person-1', is_known: true }],
  });
  assert.equal(featureId, 'ext:netatmo:camera-1:human');
  assert.deepEqual(published, [{ device_feature_external_id: featureId, state: 1 }]);
  assert.equal(gladys.sceneEvents.length, 1);
});

test('a refused scene event (older core, rate limit) is logged, never thrown', async () => {
  gladys.publishSceneEvent = async () => {
    throw new Error('404 NOT_FOUND');
  };
  const events = createEvents({ gladys, getHomes: telemetry.getHomes });
  const fired = await events.fireSceneEvents(
    { push_type: 'NIS-siren_sounding', module_id: 'siren-1' },
    'siren_sounding',
  );
  assert.equal(fired, 0);
});

test('without homes data the events still fire, with the names left empty', async () => {
  const bare = { ...gladys, devices: [] };
  const events = createEvents({ gladys: bare });
  await events.fireSceneEvents(
    { push_type: 'NACamera-person', home_name: 'Chalet', persons: [{ id: 'p', is_known: true }] },
    'person',
  );
  assert.deepEqual(gladys.sceneEvents.at(-1), {
    key: 'known_person_arrived',
    data: { camera: null, person: null, camera_name: null, home_name: 'Chalet' },
  });
});

test('eventPersonsOf reads the persons array or a single person id, skipping junk', () => {
  assert.deepEqual(eventPersonsOf({ persons: [{ id: 'a' }, null, 'x', { id: 3 }] }), [{ id: 'a' }]);
  assert.deepEqual(eventPersonsOf({ person_id: 'b', is_known: true }), [
    { id: 'b', is_known: true },
  ]);
  assert.deepEqual(eventPersonsOf({ persons: 'junk' }), []);
  assert.deepEqual(eventPersonsOf(undefined), []);
});

// --- Actions ------------------------------------------------------------------

test('set_heating_mode sets the mode of the only home, with an end time for away', async () => {
  let refreshed = false;
  const outputs = await SCENE_ACTIONS.set_heating_mode(
    ctx({ refresh: async () => (refreshed = true) }),
    { mode: 'away', duration_minutes: 90 },
  );
  assert.deepEqual(outputs, { home_name: 'Maison' });
  assert.deepEqual(netatmo.state.setThermModeRequests, [
    { home_id: 'home-1', mode: 'away', endtime: String(NOW / 1000 + 90 * 60) },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshed, true);
});

test('set_heating_mode: schedule ignores the duration, frost guard goes without one', async () => {
  await SCENE_ACTIONS.set_heating_mode(ctx(), { mode: 'schedule', duration_minutes: 30 });
  await SCENE_ACTIONS.set_heating_mode(ctx(), { mode: 'hg' });
  assert.deepEqual(netatmo.state.setThermModeRequests, [
    { home_id: 'home-1', mode: 'schedule' },
    { home_id: 'home-1', mode: 'hg' },
  ]);
});

test('set_heating_mode uses the home of the chosen device', async () => {
  await SCENE_ACTIONS.set_heating_mode(ctx(), { device: 'ext:netatmo:valve-1', mode: 'hg' });
  assert.equal(netatmo.state.setThermModeRequests[0].home_id, 'home-1');
});

test('set_heating_mode refuses an unknown mode, a bad duration and a foreign device', async () => {
  await assert.rejects(
    SCENE_ACTIONS.set_heating_mode(ctx(), { mode: 'off' }),
    /Unknown heating mode/,
  );
  await assert.rejects(
    SCENE_ACTIONS.set_heating_mode(ctx(), { mode: 'away', duration_minutes: -5 }),
    /Invalid duration/,
  );
  await assert.rejects(
    SCENE_ACTIONS.set_heating_mode(ctx(), { device: 'ext:other:x', mode: 'away' }),
    /not a Netatmo device/,
  );
  assert.equal(netatmo.state.setThermModeRequests.length, 0);
});

test('set_heating_mode surfaces the missing-scope message', async () => {
  netatmo.state.failSetThermModeWith = {
    status: 403,
    body: { error: { code: 13, message: 'scope' } },
  };
  await assert.rejects(
    SCENE_ACTIONS.set_heating_mode(ctx(), { mode: 'away' }),
    /reconnect your Netatmo/,
  );
});

test('set_persons_away marks one person by name, or the whole home empty', async () => {
  assert.deepEqual(await SCENE_ACTIONS.set_persons_away(ctx(), { person: ' alice ' }), {
    home_name: 'Maison',
  });
  await SCENE_ACTIONS.set_persons_away(ctx(), { person: '' });
  await SCENE_ACTIONS.set_persons_away(ctx(), {});
  assert.deepEqual(netatmo.state.setPersonsAwayRequests, [
    'home_id=home-1&person_id=person-1',
    'home_id=home-1',
    'home_id=home-1',
  ]);
});

test('set_persons_home marks one person, or every known person, at home', async () => {
  await SCENE_ACTIONS.set_persons_home(ctx(), { person: 'person-2' });
  await SCENE_ACTIONS.set_persons_home(ctx(), { device: 'ext:netatmo:camera-1' });
  assert.deepEqual(netatmo.state.setPersonsHomeRequests, [
    'home_id=home-1&person_ids%5B%5D=person-2',
    'home_id=home-1&person_ids%5B%5D=person-1&person_ids%5B%5D=person-2',
  ]);
});

test('the persons actions refuse an unknown person and a home without persons', async () => {
  await assert.rejects(
    SCENE_ACTIONS.set_persons_away(ctx(), { person: 'Eve' }),
    /not a person known to the Netatmo home Maison/,
  );
  netatmo.state.homes[0].persons = [];
  await telemetry.refreshValues(config);
  await assert.rejects(SCENE_ACTIONS.set_persons_home(ctx(), {}), /has no known person/);
  assert.equal(netatmo.state.setPersonsHomeRequests.length, 0);
});

test('the persons actions surface the missing-scope message', async () => {
  netatmo.state.failPersonsWith = { status: 403, body: { error: { code: 13, message: 'scope' } } };
  await assert.rejects(SCENE_ACTIONS.set_persons_away(ctx(), {}), /reconnect your Netatmo/);
  await assert.rejects(SCENE_ACTIONS.set_persons_home(ctx(), {}), /reconnect your Netatmo/);
});

test('resolveHome: no home known yet, several homes, a device without home', () => {
  const fits = () => true;
  const empty = { gladys, telemetry: { getHomes: () => [] } };
  assert.throws(() => resolveHome(empty, undefined, fits, 'a heating'), /No Netatmo home/);
  const two = { gladys, telemetry: { getHomes: () => [{ id: 'a' }, { id: 'b' }] } };
  assert.throws(() => resolveHome(two, undefined, fits, 'a heating'), /2 Netatmo homes/);
  const homeless = {
    gladys: { devices: [{ external_id: 'ext:netatmo:x', name: 'X', params: [] }] },
    telemetry: { getHomes: () => [] },
  };
  assert.throws(() => resolveHome(homeless, 'ext:netatmo:x', fits, 'x'), /belongs to no/);
  // A home the last load did not list is still usable by its id.
  const unlisted = {
    gladys: {
      devices: [{ external_id: 'ext:netatmo:y', params: [{ name: 'home_id', value: 'h9' }] }],
    },
    telemetry: { getHomes: () => [] },
  };
  assert.equal(resolveHome(unlisted, 'ext:netatmo:y', fits, 'x').id, 'h9');
});

test('findPerson and endtimeOf helpers', () => {
  const home = { name: 'H', persons: [{ id: 'p1', pseudo: 'Zoé' }] };
  assert.equal(findPerson(home, 'ZOÉ').id, 'p1');
  assert.equal(findPerson(home, 'p1').pseudo, 'Zoé');
  assert.equal(
    endtimeOf(undefined, () => NOW),
    undefined,
  );
  assert.equal(
    endtimeOf('', () => NOW),
    undefined,
  );
  assert.equal(
    endtimeOf('10', () => NOW),
    NOW / 1000 + 600,
  );
  assert.throws(() => endtimeOf(60 * 24 * 31, () => NOW), /Invalid duration/);
});

// --- Advanced heating (issue #58) -------------------------------------------------

test('set_room_setpoint sets a manual setpoint on the room of the device, for a duration', async () => {
  let refreshed = false;
  const outputs = await SCENE_ACTIONS.set_room_setpoint(
    ctx({ refresh: async () => (refreshed = true) }),
    { device: 'ext:netatmo:valve-1', temperature: 20.3, duration_minutes: 45 },
  );
  assert.deepEqual(outputs, { home_name: 'Maison', room_name: 'Chambre' });
  await SCENE_ACTIONS.set_room_setpoint(ctx(), {
    device: 'ext:netatmo:therm-1',
    temperature: '18',
  });
  assert.deepEqual(netatmo.state.setpointRequests, [
    {
      home_id: 'home-1',
      room_id: 'room-2',
      mode: 'manual',
      temp: '20.5',
      endtime: String(NOW / 1000 + 45 * 60),
    },
    { home_id: 'home-1', room_id: 'room-1', mode: 'manual', temp: '18' },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshed, true);
});

test('boost_room boosts the room, back_to_schedule returns it to the schedule', async () => {
  assert.deepEqual(
    await SCENE_ACTIONS.boost_room(ctx(), {
      device: 'ext:netatmo:therm-1',
      duration_minutes: 30,
    }),
    { home_name: 'Maison', room_name: 'Salon' },
  );
  await SCENE_ACTIONS.boost_room(ctx(), { device: 'ext:netatmo:therm-1' });
  await SCENE_ACTIONS.room_back_to_schedule(ctx(), { device: 'ext:netatmo:therm-1' });
  assert.deepEqual(netatmo.state.setpointRequests, [
    { home_id: 'home-1', room_id: 'room-1', mode: 'max', endtime: String(NOW / 1000 + 1800) },
    { home_id: 'home-1', room_id: 'room-1', mode: 'max' },
    { home_id: 'home-1', room_id: 'room-1', mode: 'home' },
  ]);
  // Like the cloud, the next load reads the room back on the schedule.
  await telemetry.refreshValues(config);
  const room = telemetry.getHomes()[0].rooms.find((entry) => entry.id === 'room-1');
  assert.equal(room.therm_setpoint_mode, 'schedule');
});

test('the room actions refuse a missing device, a non-heating device and a bad setpoint', async () => {
  await assert.rejects(SCENE_ACTIONS.boost_room(ctx(), {}), /Choose the thermostat or valve/);
  await assert.rejects(
    SCENE_ACTIONS.room_back_to_schedule(ctx(), { device: 'ext:netatmo:camera-1' }),
    /is not a Netatmo thermostat or valve/,
  );
  await assert.rejects(
    SCENE_ACTIONS.room_back_to_schedule(ctx(), { device: 'ext:other:x' }),
    /not a Netatmo device/,
  );
  await assert.rejects(
    SCENE_ACTIONS.set_room_setpoint(ctx(), { device: 'ext:netatmo:therm-1', temperature: 35 }),
    /Invalid setpoint 35/,
  );
  await assert.rejects(
    SCENE_ACTIONS.set_room_setpoint(ctx(), {
      device: 'ext:netatmo:therm-1',
      temperature: 20,
      duration_minutes: 0,
    }),
    /Invalid duration/,
  );
  assert.equal(netatmo.state.setpointRequests.length, 0);
});

test('the room actions surface the missing-scope message', async () => {
  netatmo.state.failSetpointWith = { status: 403, body: { error: { code: 13, message: 'scope' } } };
  await assert.rejects(
    SCENE_ACTIONS.boost_room(ctx(), { device: 'ext:netatmo:therm-1' }),
    /reconnect your Netatmo/,
  );
});

test('set_heating_schedule switches to the schedule named in the scene, case ignored', async () => {
  let refreshed = false;
  const outputs = await SCENE_ACTIONS.set_heating_schedule(
    ctx({ refresh: async () => (refreshed = true) }),
    { schedule: '  vacances ' },
  );
  assert.deepEqual(outputs, { home_name: 'Maison', schedule_name: 'Vacances' });
  await SCENE_ACTIONS.set_heating_schedule(ctx(), {
    device: 'ext:netatmo:valve-1',
    schedule: 'schedule-week',
  });
  assert.deepEqual(netatmo.state.switchScheduleRequests, [
    { home_id: 'home-1', schedule_id: 'schedule-holidays' },
    { home_id: 'home-1', schedule_id: 'schedule-week' },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshed, true);
});

test('set_heating_schedule names the available schedules when the name is unknown', async () => {
  await assert.rejects(
    SCENE_ACTIONS.set_heating_schedule(ctx(), { schedule: 'Default' }),
    /"Default" is not a heating schedule of the Netatmo home Maison \(available: "Semaine", "Vacances"\)/,
  );
  netatmo.state.failSwitchScheduleWith = {
    status: 403,
    body: { error: { code: 13, message: 'scope' } },
  };
  await assert.rejects(
    SCENE_ACTIONS.set_heating_schedule(ctx(), { schedule: 'Semaine' }),
    /reconnect your Netatmo/,
  );
});

test('resolveRoom, setpointOf and findSchedule helpers', () => {
  const room = resolveRoom(ctx(), 'ext:netatmo:valve-1');
  assert.equal(room.roomId, 'room-2');
  assert.equal(room.home.id, 'home-1');
  // A room the summary does not list yet: named from the device params.
  const unlisted = {
    gladys: {
      devices: [
        {
          external_id: 'ext:netatmo:v9',
          model: 'NRV',
          params: [
            { name: 'home_id', value: 'h9' },
            { name: 'room_id', value: 'r9' },
            { name: 'room_name', value: 'Grenier' },
          ],
        },
      ],
    },
    telemetry: { getHomes: () => [] },
  };
  assert.equal(resolveRoom(unlisted, 'ext:netatmo:v9').roomName, 'Grenier');
  assert.equal(setpointOf(7), 7);
  assert.equal(setpointOf(' 21.74 '), 21.5);
  assert.throws(() => setpointOf('abc'), /Invalid setpoint/);
  assert.throws(() => setpointOf(6.5), /Invalid setpoint/);
  const home = { name: 'H', schedules: [{ id: 'S1', name: 'Hiver ', selected: true }] };
  assert.equal(findSchedule(home, 'HIVER').id, 'S1');
  assert.equal(findSchedule(home, 's1').name, 'Hiver ');
  assert.throws(() => findSchedule(home, ''), /available: "Hiver "/);
  assert.throws(() => findSchedule({ name: 'H' }, 'x'), /has no heating schedule known yet/);
});
