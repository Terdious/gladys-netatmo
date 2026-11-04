// -----------------------------------------------------------------------------
// How long a setpoint sent by Gladys lasts (`setpoint_duration`): the endtime
// of each duration, "until the next schedule change" computed from the
// homesdata timetable (pyatmo shape: `m_offset` minutes from Monday 00:00 in
// the home's timezone, DST included), "no end" clamped down when Netatmo
// refuses the endtime, and the setting applied to the setpoint feature writes
// (what the Gladys Thermostat service writes) — never to the room mode.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import { activeTimetableOf, summarizeHome } from '../../src/netatmo/discovery.js';
import { setDeviceValue } from '../../src/netatmo/setValue.js';
import {
  NO_END_DURATIONS_SECONDS,
  SETPOINT_DURATION_VALUES,
  endtimeForDuration,
  isInvalidEndtimeError,
  nextScheduleChangeOf,
  normalizeSetpointDuration,
  resetNoEndClamp,
  sendRoomThermpoint,
} from '../../src/netatmo/roomSetpoint.js';
import { startFakeNetatmo } from '../helpers/fakeNetatmo.js';

const ENERGY_ONLY = normalizeConfig({ weather_api: false });
const THERM = 'ext:netatmo:therm-1';
// Wednesday 2026-10-14 10:15 in Paris (CEST, UTC+2): the eco slot.
const WEDNESDAY_10_15 = Date.parse('2026-10-14T08:15:00Z');
const seconds = (iso) => Date.parse(iso) / 1000;

/** The timetable of the fake home (see fakeNetatmo buildWeekTimetable). */
function weekHome(timezone = 'Europe/Paris') {
  const day = [
    [0, 1],
    [360, 0],
    [480, 4],
    [1080, 0],
    [1350, 1],
  ];
  const timetable = [];
  for (let index = 6; index >= 0; index -= 1) {
    for (const [minutes, zone] of day) {
      timetable.push({ zone_id: zone, m_offset: index * 1440 + minutes });
    }
  }
  return {
    id: 'home-1',
    timezone,
    timetable: activeTimetableOf({
      schedules: [
        {
          id: 'cooling',
          type: 'cooling',
          selected: true,
          timetable: [{ zone_id: 0, m_offset: 1 }],
        },
        {
          id: 'week',
          type: 'therm',
          selected: true,
          // Unsorted, with an invalid slot: sorted and filtered.
          timetable: [...timetable, { zone_id: 0, m_offset: 20000 }, { m_offset: 5 }],
          zones: [
            { id: 0, rooms: [{ id: 'salon', therm_setpoint_temperature: 21 }] },
            { id: 1, rooms_temp: [{ room_id: 'salon', temp: 17 }] },
            { id: 4, rooms: [{ id: 'salon', therm_setpoint_temperature: 18 }] },
          ],
        },
      ],
    }),
  };
}

test('activeTimetableOf: the slots of the selected heating schedule, sorted, with the room temperatures', () => {
  const { timetable } = weekHome();
  assert.equal(timetable.slots.length, 35);
  assert.deepEqual(timetable.slots.slice(0, 3), [
    { m_offset: 0, zone_id: 1 },
    { m_offset: 360, zone_id: 0 },
    { m_offset: 480, zone_id: 4 },
  ]);
  assert.deepEqual(timetable.zones, [
    { id: 0, rooms: { salon: 21 } },
    { id: 1, rooms: { salon: 17 } },
    { id: 4, rooms: { salon: 18 } },
  ]);
  assert.equal(activeTimetableOf({}), undefined);
  assert.equal(activeTimetableOf({ schedules: [{ id: 's', selected: true }] }), undefined);
});

test('nextScheduleChangeOf: the next slot that changes the room temperature, in the home timezone', () => {
  const home = weekHome();
  // Wednesday 10:15, eco (18 °C): comfort (21 °C) at 18:00 Paris.
  assert.equal(
    nextScheduleChangeOf(home, 'salon', WEDNESDAY_10_15),
    seconds('2026-10-14T16:00:00Z'),
  );
  // Sunday 23:00 (night): the week wraps to Monday 06:00.
  assert.equal(
    nextScheduleChangeOf(home, 'salon', Date.parse('2026-10-18T21:00:00Z')),
    seconds('2026-10-19T04:00:00Z'),
  );
  // Saturday 22:45 CEST (night) → Sunday 06:00 CET: the DST change in between
  // is an hour longer than the minutes counted.
  assert.equal(
    nextScheduleChangeOf(home, 'salon', Date.parse('2026-10-24T20:45:00Z')),
    seconds('2026-10-25T05:00:00Z'),
  );
  // Another timezone, the same wall clock times.
  assert.equal(
    nextScheduleChangeOf(weekHome('America/New_York'), 'salon', Date.parse('2026-10-14T14:15:00Z')),
    seconds('2026-10-14T22:00:00Z'),
  );
});

test('nextScheduleChangeOf: same temperature skipped, zone change when unknown, nothing when it never changes', () => {
  const timetable = {
    // Monday 06:00 is the first slot: before it, Sunday's last slot applies.
    slots: [
      { m_offset: 360, zone_id: 0 },
      { m_offset: 480, zone_id: 4 },
      { m_offset: 1080, zone_id: 1 },
    ],
    zones: [
      { id: 0, rooms: { chambre: 19 } },
      { id: 4, rooms: { chambre: 19 } },
      { id: 1, rooms: { chambre: 16 } },
    ],
  };
  const home = { id: 'h', timezone: 'Europe/Paris', timetable };
  // Monday 03:00 Paris: night (Sunday's slot) → 06:00 (19 °C).
  const monday3 = Date.parse('2026-10-19T01:00:00Z');
  assert.equal(nextScheduleChangeOf(home, 'chambre', monday3), seconds('2026-10-19T04:00:00Z'));
  // Monday 07:00 (19 °C): eco keeps 19 °C, night at 18:00.
  const monday7 = Date.parse('2026-10-19T05:00:00Z');
  assert.equal(nextScheduleChangeOf(home, 'chambre', monday7), seconds('2026-10-19T16:00:00Z'));
  // A room the zones do not list: the next change of zone (08:00).
  assert.equal(nextScheduleChangeOf(home, 'bureau', monday7), seconds('2026-10-19T06:00:00Z'));
  // A schedule that never changes the room.
  const flat = {
    ...home,
    timetable: { slots: [{ m_offset: 0, zone_id: 0 }], zones: timetable.zones },
  };
  assert.equal(nextScheduleChangeOf(flat, 'chambre', monday7), undefined);
  // Nothing to compute from.
  assert.equal(nextScheduleChangeOf(undefined, 'chambre', monday7), undefined);
  assert.equal(
    nextScheduleChangeOf({ ...home, timezone: undefined }, 'chambre', monday7),
    undefined,
  );
  assert.equal(
    nextScheduleChangeOf({ ...home, timezone: 'Mars/Olympus' }, 'chambre', monday7),
    undefined,
  );
});

test('endtimeForDuration: each option of the setting', () => {
  const now = () => WEDNESDAY_10_15;
  const context = { home: weekHome(), roomId: 'salon', now };
  const nowSeconds = WEDNESDAY_10_15 / 1000;
  assert.deepEqual(
    Object.fromEntries(
      SETPOINT_DURATION_VALUES.map((duration) => [duration, endtimeForDuration(duration, context)]),
    ),
    {
      default: {},
      '1h': { endtime: nowSeconds + 3600 },
      '3h': { endtime: nowSeconds + 10800 },
      '6h': { endtime: nowSeconds + 21600 },
      '12h': { endtime: nowSeconds + 43200 },
      next_change: { endtime: seconds('2026-10-14T16:00:00Z') },
      no_end: { noEnd: true },
    },
  );
  // No timetable known: Netatmo's default duration.
  assert.deepEqual(endtimeForDuration('next_change', { home: undefined, roomId: 'x', now }), {});
  assert.deepEqual(endtimeForDuration(undefined, context), {});
  assert.equal(normalizeSetpointDuration(' 3h '), '3h');
  assert.equal(normalizeSetpointDuration('forever'), 'default');
  assert.equal(normalizeConfig({ setpoint_duration: 'no_end' }).setpoint_duration, 'no_end');
  assert.equal(normalizeConfig({ setpoint_duration: 'bogus' }).setpoint_duration, 'default');
});

test('isInvalidEndtimeError: a 4xx naming the endtime or Netatmo "invalid argument", never a scope or auth error', () => {
  const error = (status, body) => Object.assign(new Error('x'), { status, body });
  assert.equal(isInvalidEndtimeError(error(400, { error: { code: 21, message: 'x' } })), true);
  assert.equal(isInvalidEndtimeError(error(400, { error: { message: 'Invalid endtime' } })), true);
  assert.equal(isInvalidEndtimeError(error(400, { error: { message: 'Endtime too far' } })), true);
  assert.equal(isInvalidEndtimeError(error(403, { error: { code: 21 } })), false);
  assert.equal(isInvalidEndtimeError(error(400, { error: { code: 10 } })), false);
  assert.equal(isInvalidEndtimeError(error(500, { error: { code: 21 } })), false);
  assert.equal(isInvalidEndtimeError(new Error('network')), false);
});

test('sendRoomThermpoint "no end": 30 days, shorter after an endtime refusal (remembered), never lost', async () => {
  resetNoEndClamp();
  const now = () => WEDNESDAY_10_15;
  const nowSeconds = WEDNESDAY_10_15 / 1000;
  const sent = [];
  let maxAccepted = 2 * 24 * 3600;
  const client = {
    async setRoomThermpoint(setpoint) {
      sent.push(setpoint);
      if (setpoint.endtime !== undefined && setpoint.endtime - nowSeconds > maxAccepted) {
        throw Object.assign(new Error('400'), {
          status: 400,
          body: { error: { code: 21, message: 'Invalid endtime' } },
        });
      }
      return { status: 'ok' };
    },
  };
  const setpoint = { homeId: 'h', roomId: 'r', temp: 20, noEnd: true, now };
  await sendRoomThermpoint(client, setpoint);
  assert.deepEqual(
    sent.map((entry) => entry.endtime - nowSeconds),
    NO_END_DURATIONS_SECONDS.slice(0, 3),
  );
  assert.deepEqual(sent[2], { homeId: 'h', roomId: 'r', temp: 20, endtime: nowSeconds + 172800 });
  // The next one starts at the step Netatmo accepted.
  sent.length = 0;
  await sendRoomThermpoint(client, setpoint);
  assert.deepEqual(
    sent.map((entry) => entry.endtime - nowSeconds),
    [172800],
  );
  // Every endtime refused: sent without one (Netatmo's default duration).
  sent.length = 0;
  maxAccepted = 0;
  await sendRoomThermpoint(client, setpoint);
  assert.deepEqual(sent.at(-1), { homeId: 'h', roomId: 'r', temp: 20 });
  // Any other error is the caller's.
  const failing = {
    async setRoomThermpoint() {
      throw Object.assign(new Error('403'), { status: 403, body: { error: { code: 13 } } });
    },
  };
  await assert.rejects(sendRoomThermpoint(failing, setpoint), /403/);
  resetNoEndClamp();
});

test('summarizeHome: a room heats when one of its modules says so, with the timetable and timezone', () => {
  const summary = summarizeHome(
    {
      id: 'h',
      timezone: 'Europe/Paris',
      schedules: [
        { id: 's', type: 'therm', selected: true, timetable: [{ zone_id: 0, m_offset: 0 }] },
      ],
    },
    [
      { type: 'NRV', room: { id: 'r1', name: 'Chambre', heating_power_request: 0 } },
      { type: 'NATherm1', boiler_status: true, room: { id: 'r1', name: 'Chambre' } },
      { type: 'NRV', room: { id: 'r2', name: 'Bureau', heating_power_request: 0 } },
      // An unreachable thermostat replays its last boiler status: ignored.
      { type: 'NATherm1', reachable: false, boiler_status: true, room: { id: 'r3', name: 'Cave' } },
    ],
  );
  assert.deepEqual(
    summary.rooms.map((room) => [room.name, room.heating]),
    [
      ['Chambre', true],
      ['Bureau', false],
      ['Cave', false],
    ],
  );
  assert.equal(summary.timezone, 'Europe/Paris');
  assert.deepEqual(summary.timetable, { slots: [{ m_offset: 0, zone_id: 0 }], zones: [] });
});

// --- The setting on the setpoint feature writes --------------------------------

let netatmo;
let client;
let gladys;
let telemetry;

beforeEach(async () => {
  resetNoEndClamp();
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
  gladys = {
    devices: [],
    externalId: (suffix) => `ext:netatmo:${suffix}`,
    async publishStates() {},
    async publishDiscoveredDevices() {},
    async publishTransports() {},
    async publishCameraImage() {},
  };
  telemetry = createTelemetry({ gladys, client, loadTtlMs: 0 });
  gladys.devices = await telemetry.syncDiscovery(ENERGY_ONLY);
  await telemetry.refreshValues(ENERGY_ONLY);
});

afterEach(async () => {
  telemetry.stop();
  await netatmo.close();
});

/** setDeviceValue wired like index.js, with the setting and a fixed clock. */
function command(suffix, value, setpointDuration) {
  const device = gladys.devices.find((entry) => entry.external_id === THERM);
  return setDeviceValue(
    {
      gladys,
      client,
      getRawDevice: (id) => telemetry.getRawDevice(id),
      patchRoom: (homeId, roomId, patch) => telemetry.patchRoom(homeId, roomId, patch),
      setpointDuration,
      getHomes: () => telemetry.getHomes(),
      now: () => WEDNESDAY_10_15,
    },
    {
      device,
      feature: device.features.find((f) => f.external_id === `${THERM}:${suffix}`),
      value,
    },
  );
}

test('the setpoint feature writes carry the endtime of the setpoint_duration setting', async () => {
  const nowSeconds = WEDNESDAY_10_15 / 1000;
  const expected = {
    // Today's behaviour: Netatmo's default duration.
    default: undefined,
    '1h': nowSeconds + 3600,
    '3h': nowSeconds + 3 * 3600,
    '6h': nowSeconds + 6 * 3600,
    '12h': nowSeconds + 12 * 3600,
    // Salon (therm-1), eco slot: comfort at 18:00 Paris (fake home schedule).
    next_change: seconds('2026-10-14T16:00:00Z'),
    no_end: nowSeconds + 30 * 24 * 3600,
  };
  for (const [duration, endtime] of Object.entries(expected)) {
    netatmo.state.setpointRequests = [];
    await command('therm_setpoint_temperature', 20.5, duration);
    assert.deepEqual(
      netatmo.state.setpointRequests,
      [
        {
          home_id: 'home-1',
          room_id: 'room-1',
          mode: 'manual',
          temp: '20.5',
          ...(endtime === undefined ? {} : { endtime: String(endtime) }),
        },
      ],
      duration,
    );
  }
  // No setting passed (an older wiring): Netatmo's default duration.
  netatmo.state.setpointRequests = [];
  await command('therm_setpoint_temperature', 19);
  assert.equal(netatmo.state.setpointRequests[0].endtime, undefined);
});

test('no end on the real API: an endtime refusal steps down, the room mode never takes it', async () => {
  // Netatmo refuses the first endtime (30 days), accepts the next one (7 days).
  const nowSeconds = WEDNESDAY_10_15 / 1000;
  const refused = [];
  const realClient = client;
  client = {
    ...realClient,
    async setRoomThermpoint(setpoint) {
      if (refused.length === 0) {
        refused.push(setpoint.endtime - nowSeconds);
        throw Object.assign(new Error('Netatmo API answered 400'), {
          status: 400,
          body: { error: { code: 21, message: 'Invalid endtime' } },
        });
      }
      return realClient.setRoomThermpoint(setpoint);
    },
  };
  await command('therm_setpoint_temperature', 21, 'no_end');
  assert.deepEqual(refused, [30 * 24 * 3600]);
  assert.deepEqual(
    netatmo.state.setpointRequests.map((form) => Number(form.endtime) - nowSeconds),
    [7 * 24 * 3600],
  );
  // The room mode (off / back to the schedule) is not a setpoint: no endtime.
  netatmo.state.setpointRequests = [];
  await command('room_mode', 0, 'no_end');
  assert.deepEqual(netatmo.state.setpointRequests, [
    { home_id: 'home-1', room_id: 'room-1', mode: 'off' },
  ]);
});
