// -----------------------------------------------------------------------------
// How long a room setpoint sent by Gladys lasts (setroomthermpoint `endtime`).
//
// Netatmo ends every manual setpoint: without an `endtime`, after the duration
// set in the Netatmo app (the "default duration of a manual setpoint"), the
// room goes back to its Netatmo schedule. The `setpoint_duration` setting
// chooses what a setpoint written to the `therm_setpoint_temperature` feature
// carries — the dashboard, a scene "control a device", the Gladys Thermostat
// service all write through it:
//   - `default`: no endtime, Netatmo's own duration (the behaviour before);
//   - `1h` / `3h` / `6h` / `12h`: that long from now;
//   - `next_change`: until the next slot of the active Netatmo schedule that
//     changes the room's temperature (or, when the zones carry no room
//     temperatures, the next change of zone), computed from the homesdata
//     timetable (`m_offset`: minutes from Monday 00:00 in the home's
//     timezone);
//   - `no_end`: as far as Netatmo accepts. No maximum is documented (pyatmo
//     and Home Assistant pass the endtime through unchecked): 30 days first,
//     then shorter steps when Netatmo refuses the endtime, the step accepted
//     being remembered — and, as a last resort, no endtime at all, so the
//     setpoint is never lost. Meant for the Gladys Thermostat service: Gladys
//     drives the schedule and writes every change itself; a setpoint Netatmo
//     ends on its own (back to its schedule after its default duration) is
//     reported back as a different setpoint, which the Thermostat service
//     takes for a manual change made on the thermostat (a hold).
// Scene actions keep the duration they are given, and a boost is never
// affected by the setting.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'netatmo-room-setpoint' });

export const SETPOINT_DURATIONS = {
  DEFAULT: 'default',
  ONE_HOUR: '1h',
  THREE_HOURS: '3h',
  SIX_HOURS: '6h',
  TWELVE_HOURS: '12h',
  NEXT_CHANGE: 'next_change',
  NO_END: 'no_end',
};

export const SETPOINT_DURATION_VALUES = Object.values(SETPOINT_DURATIONS);

// Labels of the durations, shared by the manifest setting (test-enforced) and
// the heating widget form.
export const SETPOINT_DURATION_LABELS = {
  [SETPOINT_DURATIONS.DEFAULT]: {
    en: 'Netatmo default duration',
    fr: 'Durée par défaut de Netatmo',
    de: 'Netatmo-Standarddauer',
    es: 'Duración predeterminada de Netatmo',
  },
  [SETPOINT_DURATIONS.ONE_HOUR]: { en: '1 hour', fr: '1 heure', de: '1 Stunde', es: '1 hora' },
  [SETPOINT_DURATIONS.THREE_HOURS]: {
    en: '3 hours',
    fr: '3 heures',
    de: '3 Stunden',
    es: '3 horas',
  },
  [SETPOINT_DURATIONS.SIX_HOURS]: {
    en: '6 hours',
    fr: '6 heures',
    de: '6 Stunden',
    es: '6 horas',
  },
  [SETPOINT_DURATIONS.TWELVE_HOURS]: {
    en: '12 hours',
    fr: '12 heures',
    de: '12 Stunden',
    es: '12 horas',
  },
  [SETPOINT_DURATIONS.NEXT_CHANGE]: {
    en: 'Until the next schedule change',
    fr: "Jusqu'au prochain créneau du planning",
    de: 'Bis zur nächsten Zeitplanänderung',
    es: 'Hasta el próximo cambio de programación',
  },
  [SETPOINT_DURATIONS.NO_END]: { en: 'No end', fr: 'Sans fin', de: 'Ohne Ende', es: 'Sin fin' },
};

const FIXED_DURATION_MINUTES = {
  [SETPOINT_DURATIONS.ONE_HOUR]: 60,
  [SETPOINT_DURATIONS.THREE_HOURS]: 3 * 60,
  [SETPOINT_DURATIONS.SIX_HOURS]: 6 * 60,
  [SETPOINT_DURATIONS.TWELVE_HOURS]: 12 * 60,
};

// `no_end`: the endtimes tried, longest first (seconds from now).
export const NO_END_DURATIONS_SECONDS = [30 * 24 * 3600, 7 * 24 * 3600, 2 * 24 * 3600, 12 * 3600];

const MINUTES_PER_WEEK = 7 * 24 * 60;
const MINUTE_MS = 60 * 1000;

/**
 * A `setpoint_duration` value as configured, `default` when unknown.
 * @param {unknown} value raw value
 * @returns {string} one of SETPOINT_DURATION_VALUES
 */
export function normalizeSetpointDuration(value) {
  const duration = String(value ?? '').trim();
  return SETPOINT_DURATION_VALUES.includes(duration) ? duration : SETPOINT_DURATIONS.DEFAULT;
}

const formatters = new Map();

function formatterOf(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      }),
    );
  }
  return formatters.get(timeZone);
}

/**
 * The wall clock of an instant in a timezone, as a UTC-based timestamp
 * (`Date.UTC` of the local date and time), to the second.
 */
function wallMsOf(ms, timeZone) {
  const parts = Object.fromEntries(
    formatterOf(timeZone)
      .formatToParts(new Date(ms))
      .map((part) => [part.type, Number(part.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** The instant a wall clock time of a timezone happens (DST-aware). */
function instantOfWall(wallMs, timeZone) {
  const offsetAt = (ms) => wallMsOf(ms, timeZone) - Math.floor(ms / 1000) * 1000;
  const guess = wallMs - offsetAt(wallMs);
  return wallMs - offsetAt(guess);
}

/**
 * End of the current slot of the active Netatmo schedule for a room: the
 * next timetable slot whose zone gives the room another temperature (the next
 * change of zone when the zones carry no temperature for the room).
 * @param {object|undefined} home home summary (`timetable`, `timezone`)
 * @param {string} roomId Netatmo room id
 * @param {number} nowMs current time (epoch ms)
 * @returns {number|undefined} UNIX seconds, undefined when unknown (no
 *   timetable or timezone, or a schedule that never changes the room)
 */
export function nextScheduleChangeOf(home, roomId, nowMs) {
  const slots = home?.timetable?.slots ?? [];
  const zones = home?.timetable?.zones ?? [];
  if (slots.length === 0 || !home.timezone) {
    return undefined;
  }
  let nowWall;
  try {
    nowWall = wallMsOf(nowMs, home.timezone);
  } catch (err) {
    logger.warn(`Unknown timezone "${home.timezone}" of the home ${home.id}: ${err.message}`);
    return undefined;
  }
  const minuteWall = Math.floor(nowWall / MINUTE_MS) * MINUTE_MS;
  // Monday = 0 (getUTCDay: Sunday = 0).
  const weekday = (new Date(minuteWall).getUTCDay() + 6) % 7;
  const nowMinute = weekday * 1440 + Math.floor((minuteWall % 86400000) / MINUTE_MS);
  // Before the first slot of the week, the last slot of the previous week applies.
  let current = slots.length - 1;
  slots.forEach((slot, index) => {
    if (slot.m_offset <= nowMinute) {
      current = index;
    }
  });
  const temperatureOf = (zoneId) => zones.find((zone) => zone.id === zoneId)?.rooms?.[roomId];
  const currentZone = slots[current].zone_id;
  const currentTemperature = temperatureOf(currentZone);
  for (let step = 1; step <= slots.length; step += 1) {
    const slot = slots[(current + step) % slots.length];
    let minutesAhead = slot.m_offset - nowMinute;
    while (minutesAhead <= 0) {
      minutesAhead += MINUTES_PER_WEEK;
    }
    const temperature = temperatureOf(slot.zone_id);
    const changes =
      currentTemperature !== undefined && temperature !== undefined
        ? temperature !== currentTemperature
        : slot.zone_id !== currentZone;
    if (changes) {
      return Math.round(instantOfWall(minuteWall + minutesAhead * MINUTE_MS, home.timezone) / 1000);
    }
  }
  return undefined;
}

/**
 * The endtime a setpoint carries for a duration.
 * @param {string} duration one of SETPOINT_DURATION_VALUES
 * @param {object} context `{home, roomId, now}`: the home summary, the room,
 *   the clock (ms)
 * @returns {{endtime?: number, noEnd?: boolean}} the UNIX seconds endtime, or
 *   `noEnd` (see sendRoomThermpoint), or nothing (Netatmo's default duration)
 */
export function endtimeForDuration(duration, { home, roomId, now = Date.now }) {
  if (FIXED_DURATION_MINUTES[duration]) {
    return { endtime: Math.round(now() / 1000 + FIXED_DURATION_MINUTES[duration] * 60) };
  }
  if (duration === SETPOINT_DURATIONS.NEXT_CHANGE) {
    const endtime = nextScheduleChangeOf(home, roomId, now());
    if (endtime === undefined) {
      logger.info(
        `No schedule change known for the room ${roomId}: Netatmo's default duration applies`,
      );
      return {};
    }
    return { endtime };
  }
  if (duration === SETPOINT_DURATIONS.NO_END) {
    return { noEnd: true };
  }
  return {};
}

/** Netatmo refused the request for its endtime (out of its range). */
export function isInvalidEndtimeError(err) {
  if (!(err?.status >= 400 && err.status < 500) || err.status === 401 || err.status === 403) {
    return false;
  }
  const error = err.body?.error ?? {};
  return /end.?time/i.test(String(error.message ?? '')) || error.code === 21;
}

// The longest `no_end` step Netatmo accepted (the next ones start there).
let acceptedNoEndSeconds = NO_END_DURATIONS_SECONDS[0];

/** Forget the accepted `no_end` step (tests). */
export function resetNoEndClamp() {
  acceptedNoEndSeconds = NO_END_DURATIONS_SECONDS[0];
}

/**
 * setroomthermpoint, `no_end` resolved: the longest endtime Netatmo accepts
 * (shorter steps after an "invalid endtime" refusal, then no endtime).
 * Other errors are thrown as is (the caller turns a scope refusal into its
 * actionable message).
 * @param {object} client Netatmo API client
 * @param {object} setpoint `{homeId, roomId, mode?, temp?, endtime?, noEnd?, now?}`
 * @returns {Promise<object>} the Netatmo answer
 */
export async function sendRoomThermpoint(client, { noEnd, now = Date.now, ...setpoint }) {
  if (!noEnd) {
    return client.setRoomThermpoint(setpoint);
  }
  const steps = NO_END_DURATIONS_SECONDS.filter((seconds) => seconds <= acceptedNoEndSeconds);
  for (const seconds of steps) {
    try {
      const answer = await client.setRoomThermpoint({
        ...setpoint,
        endtime: Math.round(now() / 1000 + seconds),
      });
      acceptedNoEndSeconds = seconds;
      return answer;
    } catch (err) {
      if (!isInvalidEndtimeError(err)) {
        throw err;
      }
      logger.warn(`Netatmo refused an endtime ${seconds} s ahead (${err.message}): trying shorter`);
    }
  }
  logger.warn(`Netatmo refused every endtime: setpoint of ${setpoint.roomId} sent without one`);
  const { endtime: _ignored, ...withoutEndtime } = setpoint;
  return client.setRoomThermpoint(withoutEndtime);
}
