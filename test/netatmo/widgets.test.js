// -----------------------------------------------------------------------------
// Dashboard widgets (issue #40): every content passes the SDK's
// validateWidgetContent untouched (nothing the core would drop, truncate or
// trim), live tiles reference features the integration publishes, every
// button action is handled, camera images are content-addressed and valid,
// and the telemetry nudges the widgets when their data moves.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { validateWidgetContent, validateWidgetImage } from '@gladysassistant/integration-sdk';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import {
  WIDGETS,
  WIDGET_KEYS,
  WEATHER_VIEWS,
  cameraImageKey,
  getWidgetImage,
  refreshWidgets,
  requestRefresh,
} from '../../src/netatmo/widgets.js';
import { startFakeNetatmo, addIndoorCameraAdvance, NPC_ID } from '../helpers/fakeNetatmo.js';

const config = normalizeConfig({ security_api: 'true' });

/** A real (tiny) JPEG: the widget image validator checks the magic numbers. */
function tinyJpeg(shade) {
  const width = 16;
  const height = 9;
  const data = Buffer.alloc(width * height * 4, shade);
  return Buffer.from(jpeg.encode({ width, height, data }, 80).data);
}

let netatmo;
let client;
let gladys;
let telemetry;

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  netatmo.state.snapshotJpeg = tinyJpeg(120);
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
  gladys = {
    devices: [],
    nudges: [],
    externalId: (suffix) => `ext:netatmo:${suffix}`,
    async publishStates() {},
    async publishDiscoveredDevices() {},
    async publishTransports() {},
    async publishCameraImage() {},
    requestWidgetRefresh(key) {
      this.nudges.push(key);
    },
  };
  telemetry = createTelemetry({ gladys, client, loadTtlMs: 0 });
  // The user created every discovered device, then a cycle ran (images too).
  gladys.devices = await telemetry.syncDiscovery(config);
  await telemetry.refreshValues(config);
});

afterEach(async () => {
  telemetry.stop();
  await netatmo.close();
});

function ctx(extra = {}) {
  return { gladys, client, telemetry, ...extra };
}

function getContent(key, settings = {}, request = {}) {
  return WIDGETS[key].get(ctx(), { settings, language: 'en', units: 'metric', ...request });
}

function componentsOf(content, type) {
  return content.components.filter((component) => component.type === type);
}

function assertRenderedAsSent(content) {
  // [] = nothing the core would drop, truncate or trim to the content budget.
  assert.deepEqual(validateWidgetContent(content), []);
}

const publishedFeatureIds = () =>
  new Set(gladys.devices.flatMap((device) => device.features.map((f) => f.external_id)));

// --- Weather -------------------------------------------------------------------

test('the weather content is rendered as sent, with live tiles on published features', async () => {
  for (const view of Object.keys(WEATHER_VIEWS)) {
    const content = await getContent(WIDGET_KEYS.WEATHER, { view });
    assertRenderedAsSent(content);
    for (const tile of componentsOf(content, 'value')) {
      assert.ok(publishedFeatureIds().has(tile.device_feature), `unknown ${tile.device_feature}`);
    }
  }
  const overview = await getContent(WIDGET_KEYS.WEATHER);
  assert.deepEqual(
    componentsOf(overview, 'value').map((tile) => tile.device_feature),
    [
      'ext:netatmo:outdoor-1:temperature',
      'ext:netatmo:outdoor-1:humidity',
      'ext:netatmo:station-1:temperature',
      'ext:netatmo:station-1:co2',
      'ext:netatmo:wind-1:wind_strength',
    ],
  );
  const indoor = await getContent(WIDGET_KEYS.WEATHER, { view: 'indoor' });
  assert.equal(componentsOf(indoor, 'value').length, 5);
});

test('the weather health rows flag an unreachable module and a low battery', async () => {
  let [status] = componentsOf(await getContent(WIDGET_KEYS.WEATHER), 'status');
  // The dead anemometer of the fixtures (reachable: false).
  assert.deepEqual(status.items, [
    {
      label: 'Anémomètre mort',
      value: { en: 'Unreachable', fr: 'Injoignable', de: 'Nicht erreichbar', es: 'Inaccesible' },
      color: 'danger',
      icon: 'wifi-off',
    },
  ]);

  const [station] = netatmo.state.stationDevices;
  station.modules[0].battery_percent = 12;
  station.modules[1].reachable = true;
  await telemetry.refreshValues(config);
  const content = await getContent(WIDGET_KEYS.WEATHER);
  assertRenderedAsSent(content);
  [status] = componentsOf(content, 'status');
  assert.equal(status.items.length, 2); // outdoor 12 % + anemometer 9 %
  assert.equal(status.items[0].label, 'Extérieur');
  assert.equal(status.items[0].value.fr, 'Batterie faible (12 %)');
  assert.equal(status.items[0].color, 'warning');

  station.modules[0].battery_percent = 80;
  station.modules[1].battery_percent = 70;
  await telemetry.refreshValues(config);
  [status] = componentsOf(await getContent(WIDGET_KEYS.WEATHER), 'status');
  assert.equal(status.items[0].color, 'success');
});

test('the weather widget shows the chosen station, or explains that none exists', async () => {
  const chosen = await getContent(WIDGET_KEYS.WEATHER, { station: 'ext:netatmo:station-1' });
  assert.equal(componentsOf(chosen, 'text')[0].text, 'Station');

  gladys.devices = gladys.devices.filter((device) => device.model !== 'NAMain');
  const empty = await getContent(WIDGET_KEYS.WEATHER);
  assertRenderedAsSent(empty);
  assert.match(componentsOf(empty, 'text')[0].text.en, /No Netatmo weather station/);
});

// --- Heating -------------------------------------------------------------------

// Wednesday 2026-10-14 10:15 in Paris (CEST): the eco slot (08:00-18:00).
const WEDNESDAY_10_15 = Date.parse('2026-10-14T08:15:00Z');
const roomStatusOf = (roomId) =>
  netatmo.state.homeStatuses['home-1'].home.rooms.find((room) => room.id === roomId);
const buttonOf = (content, key) =>
  componentsOf(content, 'button').find((button) => button.action.key === key);

/** Send the room form as the core relays it (params as declared, values typed). */
async function sendRoomForm(values, extra = {}) {
  const content = await getContent(WIDGET_KEYS.HEATING);
  const { action } = buttonOf(content, 'room_setpoint');
  return WIDGETS[WIDGET_KEYS.HEATING].action(ctx({ now: () => WEDNESDAY_10_15, ...extra }), {
    actionKey: action.key,
    params: action.params,
    settings: {},
    values,
  });
}

test('the heating content: schedule caption, mode and heating tiles, compact room rows, buttons', async () => {
  const content = await getContent(WIDGET_KEYS.HEATING, {}, { language: 'fr' });
  assertRenderedAsSent(content);
  // The home and its active schedule (issue #58).
  assert.equal(componentsOf(content, 'text')[0].text.fr, 'Maison · Planning: Semaine');
  // The heating mode of the home, and how many rooms heat.
  const [mode, heating] = componentsOf(content, 'value');
  assert.deepEqual(
    [mode.value, mode.color, mode.icon, mode.label.fr],
    ['Planning', 'success', 'calendar', 'Mode du chauffage'],
  );
  assert.deepEqual([heating.value, heating.color], ['2/2', 'warning']);
  // Rooms: measured → setpoint in the user's language (decimal comma), then
  // the markers: manual setpoint, open window, heating (heat requested, or
  // the boiler of the thermostat running — issue #77).
  const [status] = componentsOf(content, 'status');
  assert.deepEqual(
    status.items.map((item) => [item.label, item.value, item.icon, item.color]),
    [
      ['Salon', '19,5 → 21 °C · Chauffe', 'sun', 'warning'], // boiler_status true
      ['Chambre', '17 → 19 °C · Manuel · Fenêtre · Chauffe', 'wind', 'warning'],
    ],
  );
  // The heating modes but the active one (its tile shows it), the room form,
  // the schedule form: the 4 buttons of the content budget.
  assert.deepEqual(
    componentsOf(content, 'button').map((button) => [button.action.key, button.style]),
    [
      ['mode_hg', 'secondary'],
      ['mode_away', 'secondary'],
      ['room_setpoint', 'primary'],
      ['switch_schedule', 'secondary'],
    ],
  );
  // The schedule button opens a form listing the heating schedules only, the
  // active one pre-selected.
  const [field] = buttonOf(content, 'switch_schedule').action.fields;
  assert.equal(field.default, 'schedule-week');
  assert.deepEqual(
    field.options.map((option) => [option.value, option.label.en]),
    [
      ['schedule-week', 'Semaine'],
      ['schedule-holidays', 'Vacances'],
    ],
  );
});

test('the room form: room, command, setpoint 7-30 °C, duration options of the setting', async () => {
  let content = await getContent(WIDGET_KEYS.HEATING);
  const { action } = buttonOf(content, 'room_setpoint');
  assert.deepEqual(action.params, { home_id: 'home-1' });
  const [room, command, temperature, duration] = action.fields;
  assert.deepEqual(
    [room.key, room.display, room.default, room.options.map((option) => option.value)],
    ['room_id', 'radio', 'room-1', ['room-1', 'room-2']],
  );
  assert.deepEqual(
    command.options.map((option) => [option.value, option.label.en]),
    [
      ['setpoint', 'Set the setpoint'],
      ['boost', 'Boost'],
      ['schedule', 'Back to schedule'],
      ['off', 'Off'],
    ],
  );
  assert.equal(command.default, 'setpoint');
  // Two rooms: no setpoint pre-filled (left empty, the room's current one).
  assert.deepEqual(
    [temperature.type, temperature.required, temperature.min, temperature.max, temperature.default],
    ['number', false, 7, 30, undefined],
  );
  assert.deepEqual(
    duration.options.map((option) => option.value),
    ['default', '1h', '3h', '6h', '12h', 'next_change', 'no_end'],
  );
  assert.equal(duration.default, 'default');

  // The room of the chosen valve is pre-selected; the duration is the setting.
  content = await WIDGETS[WIDGET_KEYS.HEATING].get(
    ctx({ config: normalizeConfig({ setpoint_duration: 'no_end' }) }),
    { settings: { device: 'ext:netatmo:valve-1' }, language: 'en', units: 'metric' },
  );
  assertRenderedAsSent(content);
  const fields = buttonOf(content, 'room_setpoint').action.fields;
  assert.equal(fields[0].default, 'room-2');
  assert.equal(fields[3].default, 'no_end');

  // A single room: its current setpoint is pre-filled.
  const home = telemetry.getHomes()[0];
  const single = {
    ...ctx(),
    telemetry: { ...telemetry, getHomes: () => [{ ...home, rooms: [home.rooms[0]] }] },
  };
  const singleContent = await WIDGETS[WIDGET_KEYS.HEATING].get(single, { settings: {} });
  assertRenderedAsSent(singleContent);
  assert.equal(buttonOf(singleContent, 'room_setpoint').action.fields[2].default, 21);
});

test('the heating rows mark a boost, an off room, an open window, and follow the unit system', async () => {
  const salon = roomStatusOf('room-1');
  const chambre = roomStatusOf('room-2');
  salon.therm_setpoint_mode = 'max';
  chambre.therm_setpoint_mode = 'off';
  chambre.heating_power_request = 0;
  netatmo.state.homeStatuses['home-1'].home.modules.find((m) => m.id === 'therm-1').boiler_status =
    false;
  await telemetry.refreshValues(config);
  let content = await getContent(WIDGET_KEYS.HEATING);
  assertRenderedAsSent(content);
  let [status] = componentsOf(content, 'status');
  assert.deepEqual(
    status.items.map((item) => [item.value, item.icon, item.color]),
    [
      ['19.5 → 21 °C · Boost', 'zap', 'neutral'],
      // Off: no setpoint shown (an off room aims at no temperature).
      ['17 °C · Off · Window', 'wind', 'neutral'],
    ],
  );
  assert.deepEqual(componentsOf(content, 'value')[1].value, '0/2');

  chambre.therm_setpoint_mode = 'schedule';
  await telemetry.refreshValues(config);
  content = await getContent(WIDGET_KEYS.HEATING, {}, { units: 'us' });
  [status] = componentsOf(content, 'status');
  assert.deepEqual(
    status.items.map((item) => [item.value, item.color]),
    [
      ['67.1 → 69.8 °F · Boost', 'neutral'],
      ['62.6 → 66.2 °F · Window', 'info'],
    ],
  );
});

test('twelve heated rooms: nine rows and a tenth that sums up the others', async () => {
  const status = netatmo.state.homeStatuses['home-1'].home;
  const home = netatmo.state.homes[0];
  for (let index = 3; index <= 12; index += 1) {
    home.rooms.push({ id: `room-${index}`, name: `Pièce ${index}` });
    home.modules.push({
      id: `valve-${index}`,
      type: 'NRV',
      name: `Vanne ${index}`,
      room_id: `room-${index}`,
      bridge: 'plug-1',
    });
    status.modules.push({ id: `valve-${index}`, type: 'NRV', battery_state: 'high' });
    status.rooms.push({
      id: `room-${index}`,
      therm_measured_temperature: 18 + index / 2,
      therm_setpoint_temperature: 20,
      therm_setpoint_mode: 'schedule',
      heating_power_request: index === 12 ? 50 : 0,
    });
  }
  await telemetry.refreshValues(config);
  const content = await getContent(WIDGET_KEYS.HEATING);
  assertRenderedAsSent(content);
  const [rows] = componentsOf(content, 'status');
  assert.equal(rows.items.length, 10);
  assert.equal(rows.items[8].label, 'Pièce 9');
  assert.deepEqual(rows.items[9], {
    label: { en: '+3 rooms', fr: '+3 pièces', de: '+3 Räume', es: '+3 habitaciones' },
    // Bounded to the 40 characters of a row value.
    value: 'Pièce 10 23 · Pièce 11 23.5 · Pièce 12 …',
    icon: 'more-horizontal',
    color: 'warning',
  });
  assert.equal(componentsOf(content, 'value')[1].value, '3/12');
  // The room form still lists every room, in a dropdown.
  const [room] = buttonOf(content, 'room_setpoint').action.fields;
  assert.deepEqual([room.display, room.options.length], ['dropdown', 12]);
});

test('a home with one schedule shows it without the schedule button, none without schedules', async () => {
  netatmo.state.homes[0].schedules = [{ id: 's1', name: 'Hiver', type: 'therm', selected: true }];
  await telemetry.refreshValues(config);
  let content = await getContent(WIDGET_KEYS.HEATING);
  assertRenderedAsSent(content);
  assert.equal(componentsOf(content, 'text')[0].text.en, 'Maison · Schedule: Hiver');
  assert.deepEqual(
    componentsOf(content, 'button').map((button) => button.action.key),
    ['mode_hg', 'mode_away', 'room_setpoint'],
  );
  netatmo.state.homes[0].schedules = [];
  await telemetry.refreshValues(config);
  content = await getContent(WIDGET_KEYS.HEATING);
  assert.equal(componentsOf(content, 'text')[0].text, 'Maison');
});

test('an unknown heating mode: every mode button and the room form fit the 4 buttons', async () => {
  const home = telemetry.getHomes()[0];
  const unknown = {
    ...ctx(),
    telemetry: { ...telemetry, getHomes: () => [{ ...home, therm_mode: undefined }] },
  };
  const content = await WIDGETS[WIDGET_KEYS.HEATING].get(unknown, { settings: {}, language: 'en' });
  assertRenderedAsSent(content);
  assert.deepEqual(
    [componentsOf(content, 'value')[0].value, componentsOf(content, 'value')[0].color],
    ['?', 'neutral'],
  );
  assert.deepEqual(
    componentsOf(content, 'button').map((button) => button.action.key),
    ['mode_schedule', 'mode_hg', 'mode_away', 'room_setpoint'],
  );
});

test('the schedule button switches the schedule, then a toast and a refresh', async () => {
  const content = await getContent(WIDGET_KEYS.HEATING);
  const button = buttonOf(content, 'switch_schedule');
  let refreshes = 0;
  const message = await WIDGETS[WIDGET_KEYS.HEATING].action(
    ctx({ refresh: async () => (refreshes += 1) }),
    {
      actionKey: button.action.key,
      params: button.action.params,
      settings: {},
      values: { schedule_id: 'schedule-holidays' },
    },
  );
  assert.deepEqual(message, {
    en: 'Active schedule: Vacances',
    fr: 'Planning actif: Vacances',
    de: 'Aktiver Zeitplan: Vacances',
    es: 'Programación activa: Vacances',
  });
  assert.deepEqual(netatmo.state.switchScheduleRequests, [
    { home_id: 'home-1', schedule_id: 'schedule-holidays' },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);
  // The next content shows the new active schedule, pre-selected in the form.
  await telemetry.refreshValues(config);
  const after = await getContent(WIDGET_KEYS.HEATING);
  assert.equal(componentsOf(after, 'text')[0].text.en, 'Maison · Schedule: Vacances');
  assert.equal(buttonOf(after, 'switch_schedule').action.fields[0].default, 'schedule-holidays');
});

test('the schedule action refuses a missing form, an unknown schedule, and explains the scope', async () => {
  const { action } = WIDGETS[WIDGET_KEYS.HEATING];
  const params = { home_id: 'home-1' };
  await assert.rejects(action(ctx(), { actionKey: 'switch_schedule', params }), /Update Gladys/);
  await assert.rejects(
    action(ctx(), { actionKey: 'switch_schedule', params: {}, values: { schedule_id: 'x' } }),
    /Unknown widget action/,
  );
  await assert.rejects(
    action(ctx(), { actionKey: 'switch_schedule', params, values: { schedule_id: 'nope' } }),
    /Unknown heating schedule nope/,
  );
  netatmo.state.failSwitchScheduleWith = {
    status: 403,
    body: { error: { code: 13, message: 'scope' } },
  };
  await assert.rejects(
    action(ctx(), {
      actionKey: 'switch_schedule',
      params,
      values: { schedule_id: 'schedule-holidays' },
    }),
    /reconnect your Netatmo/,
  );
});

test('every heating mode button is handled: setthermmode, then a toast and a refresh', async () => {
  let refreshes = 0;
  const press = async (key) => {
    const content = await getContent(WIDGET_KEYS.HEATING);
    const { action } = buttonOf(content, key);
    const message = await WIDGETS[WIDGET_KEYS.HEATING].action(
      ctx({ refresh: async () => (refreshes += 1) }),
      { actionKey: action.key, params: action.params, settings: {} },
    );
    assert.ok(message.en.length > 0 && message.en.length <= 200);
    for (const language of ['fr', 'de', 'es']) {
      assert.ok(message[language].length <= 200);
    }
    await telemetry.refreshValues(config);
  };
  await press('mode_hg');
  await press('mode_away');
  // Away is active now: its button is gone, Schedule is back.
  const after = await getContent(WIDGET_KEYS.HEATING);
  assert.equal(buttonOf(after, 'mode_away'), undefined);
  assert.equal(componentsOf(after, 'value')[0].value, 'Away');
  await press('mode_schedule');
  assert.deepEqual(netatmo.state.setThermModeRequests, [
    { home_id: 'home-1', mode: 'hg' },
    { home_id: 'home-1', mode: 'away' },
    { home_id: 'home-1', mode: 'schedule' },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 3);
});

test('the room form sets a setpoint for the chosen duration (setroomthermpoint endtime)', async () => {
  const nowSeconds = WEDNESDAY_10_15 / 1000;
  const expected = {
    default: undefined,
    '1h': nowSeconds + 3600,
    '3h': nowSeconds + 3 * 3600,
    '6h': nowSeconds + 6 * 3600,
    '12h': nowSeconds + 12 * 3600,
    // Salon, Wednesday 10:15 in the eco slot (18 °C): comfort (21 °C) at 18:00 Paris.
    next_change: Date.parse('2026-10-14T16:00:00Z') / 1000,
    no_end: nowSeconds + 30 * 24 * 3600,
  };
  for (const [duration, endtime] of Object.entries(expected)) {
    netatmo.state.setpointRequests = [];
    await sendRoomForm({ room_id: 'room-1', command: 'setpoint', temperature: 21.3, duration });
    assert.deepEqual(
      netatmo.state.setpointRequests,
      [
        {
          home_id: 'home-1',
          room_id: 'room-1',
          mode: 'manual',
          temp: '21.5', // rounded to the Netatmo step (0.5 °C)
          ...(endtime === undefined ? {} : { endtime: String(endtime) }),
        },
      ],
      duration,
    );
  }
});

test('the room form: current setpoint, boost, back to schedule, off, then a toast and a refresh', async () => {
  let refreshes = 0;
  const refresh = async () => (refreshes += 1);
  // Left empty: the room's current setpoint (Chambre, 19 °C), for 3 hours.
  let message = await sendRoomForm(
    { room_id: 'room-2', command: 'setpoint', duration: '3h' },
    { refresh },
  );
  assert.deepEqual(message, {
    en: 'Chambre: 19 °C (3 hours)',
    fr: 'Chambre: 19 °C (3 heures)',
    de: 'Chambre: 19 °C (3 Stunden)',
    es: 'Chambre: 19 °C (3 horas)',
  });
  // Next change for the Chambre: eco and comfort keep 19 °C, night (16 °C) at 22:30.
  netatmo.state.setpointRequests = [];
  await sendRoomForm({
    room_id: 'room-2',
    command: 'setpoint',
    temperature: 20,
    duration: 'next_change',
  });
  assert.equal(
    netatmo.state.setpointRequests[0].endtime,
    String(Date.parse('2026-10-14T20:30:00Z') / 1000),
  );
  // A boost keeps Netatmo's boost duration for "default" and "no end".
  netatmo.state.setpointRequests = [];
  message = await sendRoomForm({ room_id: 'room-1', command: 'boost', duration: 'no_end' });
  await sendRoomForm({ room_id: 'room-1', command: 'boost', duration: '1h' });
  await sendRoomForm({ room_id: 'room-1', command: 'schedule', duration: '6h' });
  await sendRoomForm({ room_id: 'room-1', command: 'off', duration: 'default' });
  await sendRoomForm({ room_id: 'room-1', command: 'off', duration: '12h' });
  assert.equal(message.en, 'Salon: Boost');
  const nowSeconds = WEDNESDAY_10_15 / 1000;
  assert.deepEqual(netatmo.state.setpointRequests, [
    { home_id: 'home-1', room_id: 'room-1', mode: 'max' },
    { home_id: 'home-1', room_id: 'room-1', mode: 'max', endtime: String(nowSeconds + 3600) },
    { home_id: 'home-1', room_id: 'room-1', mode: 'home' },
    { home_id: 'home-1', room_id: 'room-1', mode: 'off' },
    { home_id: 'home-1', room_id: 'room-1', mode: 'off', endtime: String(nowSeconds + 43200) },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);
  // The duration defaults to the setting when the form sends none.
  netatmo.state.setpointRequests = [];
  message = await sendRoomForm(
    { room_id: 'room-1', command: 'schedule' },
    { config: normalizeConfig({ setpoint_duration: '1h' }) },
  );
  assert.equal(message.fr, 'Salon: retour au planning');
  await sendRoomForm(
    { room_id: 'room-1', temperature: '20' },
    { config: normalizeConfig({ setpoint_duration: '1h' }) },
  );
  assert.equal(netatmo.state.setpointRequests[1].endtime, String(nowSeconds + 3600));
});

test('the room form refuses a missing form, an unknown room or command, a bad setpoint, a scope refusal', async () => {
  const { action } = WIDGETS[WIDGET_KEYS.HEATING];
  const params = { home_id: 'home-1' };
  await assert.rejects(action(ctx(), { actionKey: 'room_setpoint', params }), /Update Gladys/);
  await assert.rejects(
    action(ctx(), { actionKey: 'room_setpoint', params: {}, values: { room_id: 'room-1' } }),
    /Unknown widget action/,
  );
  await assert.rejects(sendRoomForm({ room_id: 'room-9' }), /Unknown room room-9/);
  await assert.rejects(
    sendRoomForm({ room_id: 'room-1', command: 'explode' }),
    /Unknown room command/,
  );
  await assert.rejects(
    sendRoomForm({ room_id: 'room-1', command: 'setpoint', temperature: 31 }),
    /Invalid setpoint 31/,
  );
  delete roomStatusOf('room-1').therm_setpoint_temperature;
  await telemetry.refreshValues(config);
  await assert.rejects(
    sendRoomForm({ room_id: 'room-1', command: 'setpoint', temperature: null }),
    /type the setpoint/,
  );
  assert.deepEqual(netatmo.state.setpointRequests, []);
  netatmo.state.failSetpointWith = { status: 403, body: { error: { code: 13, message: 'scope' } } };
  await assert.rejects(
    sendRoomForm({ room_id: 'room-1', command: 'boost' }),
    /reconnect your Netatmo/,
  );
});

test('an unknown or forged heating action fails, so the user sees the error', async () => {
  const { action } = WIDGETS[WIDGET_KEYS.HEATING];
  await assert.rejects(
    action(ctx(), { actionKey: 'mode_off', params: { home_id: 'home-1', mode: 'off' } }),
    /Unknown widget action/,
  );
  await assert.rejects(
    action(ctx(), { actionKey: 'mode_away', params: { home_id: 'home-1', mode: 'hg' } }),
    /Unknown widget action/,
  );
  netatmo.state.failSetThermModeWith = {
    status: 403,
    body: { error: { code: 13, message: 'scope' } },
  };
  await assert.rejects(
    action(ctx(), { actionKey: 'mode_away', params: { home_id: 'home-1', mode: 'away' } }),
    /reconnect your Netatmo/,
  );
});

test('the heating widget explains a missing or ambiguous home', async () => {
  const bare = { ...ctx(), telemetry: { ...telemetry, getHomes: () => [] } };
  const waiting = await WIDGETS[WIDGET_KEYS.HEATING].get(bare, { settings: {} });
  assertRenderedAsSent(waiting);
  assert.match(waiting.components[0].text.en, /Waiting/);

  const home = telemetry.getHomes()[0];
  const two = {
    ...ctx(),
    telemetry: { ...telemetry, getHomes: () => [home, { ...home, id: 'home-2' }] },
  };
  const ambiguous = await WIDGETS[WIDGET_KEYS.HEATING].get(two, { settings: {} });
  assertRenderedAsSent(ambiguous);
  assert.match(ambiguous.components[0].text.en, /Several Netatmo homes/);
  // Choosing a device of the home settles it.
  const chosen = await WIDGETS[WIDGET_KEYS.HEATING].get(two, {
    settings: { device: 'ext:netatmo:valve-1' },
    language: 'en',
    units: 'metric',
  });
  assert.equal(componentsOf(chosen, 'text')[0].text.en, 'Maison · Schedule: Semaine');

  const noHeating = {
    ...ctx(),
    telemetry: { ...telemetry, getHomes: () => [{ ...home, modules: [] }] },
  };
  const none = await WIDGETS[WIDGET_KEYS.HEATING].get(noHeating, { settings: {} });
  assert.match(none.components[0].text.en, /No Netatmo heating/);

  // A home without heated room: no rows, no heating tile, no room form.
  const noRoom = {
    ...ctx(),
    telemetry: { ...telemetry, getHomes: () => [{ ...home, rooms: [] }] },
  };
  const empty = await WIDGETS[WIDGET_KEYS.HEATING].get(noRoom, { settings: {} });
  assertRenderedAsSent(empty);
  assert.deepEqual(
    empty.components.map((component) => component.type),
    ['text', 'value', 'button', 'button', 'button'],
  );
});

// --- Cameras -------------------------------------------------------------------

test('one camera: its snapshot, its monitoring and a toggle, rendered as sent', async () => {
  const content = await getContent(WIDGET_KEYS.CAMERAS, { camera: 'ext:netatmo:camera-1' });
  assertRenderedAsSent(content);
  const [image] = componentsOf(content, 'image');
  assert.match(image.key, /^cam-camera1-[0-9a-f]{16}$/);
  // The bytes behind the key are a valid widget image (JPEG, ≤ 300 KB).
  const rawBase64 = getWidgetImage(image.key);
  assert.deepEqual(validateWidgetImage(rawBase64), []);
  assert.equal(Buffer.from(rawBase64, 'base64').compare(netatmo.state.snapshotJpeg), 0);
  // camera-1 monitoring is "off" in the fixtures: the button turns it on.
  const [status] = componentsOf(content, 'status');
  assert.equal(status.items[0].value.en, 'Off');
  const [button] = componentsOf(content, 'button');
  assert.deepEqual(button.action, { key: 'monitoring_on', params: { cameras: ['camera-1'] } });
});

test('a new snapshot gets a new image key, and the old key keeps its bytes', async () => {
  const first = componentsOf(
    await getContent(WIDGET_KEYS.CAMERAS, { camera: 'ext:netatmo:camera-1' }),
    'image',
  )[0].key;
  const kinds = [];
  telemetry.onUpdate((kind) => kinds.push(kind));
  netatmo.state.snapshotJpeg = tinyJpeg(30);
  await telemetry.refreshValues(config);
  // The telemetry reports the change: index.js nudges the cameras widget.
  assert.deepEqual(kinds, ['cameras']);
  const second = componentsOf(
    await getContent(WIDGET_KEYS.CAMERAS, { camera: 'ext:netatmo:camera-1' }),
    'image',
  )[0].key;
  assert.notEqual(second, first);
  assert.deepEqual(validateWidgetImage(getWidgetImage(first)), []);
  assert.throws(() => getWidgetImage('cam-unknown-0000'), /Unknown widget image/);
});

test('several cameras: one row each with its thumbnail and monitoring badge', async () => {
  const content = await getContent(WIDGET_KEYS.CAMERAS);
  assertRenderedAsSent(content);
  const [list] = componentsOf(content, 'card-list');
  assert.deepEqual(
    list.items.map((item) => [item.title, item.badge.text.en, /^cam-/.test(item.image)]),
    [
      ['Caméra salon', 'Off', true],
      ['Caméra jardin', 'On', true],
    ],
  );
  assert.deepEqual(
    componentsOf(content, 'button').map((button) => button.action.key),
    ['monitoring_on', 'monitoring_off'],
  );
});

test('the Indoor Camera Advance joins the cameras widget, with its picture (issue #55)', async () => {
  addIndoorCameraAdvance(netatmo.state);
  gladys.devices = await telemetry.syncDiscovery(config);
  await telemetry.refreshValues(config);
  const content = await getContent(WIDGET_KEYS.CAMERAS);
  assertRenderedAsSent(content);
  const [list] = componentsOf(content, 'card-list');
  assert.deepEqual(
    list.items.map((item) => [item.title, item.badge.text.en, /^cam-/.test(item.image)]),
    [
      ['Caméra salon', 'Off', true],
      ['Caméra jardin', 'On', true],
      ['Hall', 'On', true],
    ],
  );
  const [allOn] = componentsOf(content, 'button');
  assert.ok(allOn.action.params.cameras.includes(NPC_ID));
});

test('every camera button is handled: setstate on each camera, then a toast', async () => {
  const content = await getContent(WIDGET_KEYS.CAMERAS);
  for (const { action } of componentsOf(content, 'button')) {
    const message = await WIDGETS[WIDGET_KEYS.CAMERAS].action(ctx({ refresh: async () => {} }), {
      actionKey: action.key,
      params: action.params,
      settings: {},
    });
    assert.ok(message.en.length > 0 && message.en.length <= 200);
  }
  assert.deepEqual(
    netatmo.state.setStateRequests.map(({ home }) => [
      home.modules[0].id,
      home.modules[0].monitoring,
    ]),
    [
      ['camera-1', 'on'],
      ['noc-1', 'on'],
      ['camera-1', 'off'],
      ['noc-1', 'off'],
    ],
  );
});

test('an unknown camera action or camera fails, and the scope error is actionable', async () => {
  const { action } = WIDGETS[WIDGET_KEYS.CAMERAS];
  await assert.rejects(action(ctx(), { actionKey: 'reboot', params: {} }), /Unknown widget action/);
  await assert.rejects(
    action(ctx(), { actionKey: 'monitoring_on', params: { cameras: ['ghost'] } }),
    /not a Netatmo camera/,
  );
  netatmo.state.failSetStateWith = { status: 403, body: { error: { code: 13, message: 'scope' } } };
  await assert.rejects(
    action(ctx(), { actionKey: 'monitoring_on', params: { cameras: ['camera-1'] } }),
    /reconnect your Netatmo/,
  );
});

test('the cameras widget explains that no camera exists, and works before any image', async () => {
  const noImage = { ...ctx(), telemetry: { ...telemetry, getCameraImage: () => undefined } };
  const single = await WIDGETS[WIDGET_KEYS.CAMERAS].get(noImage, {
    settings: { camera: 'ext:netatmo:noc-1' },
  });
  assertRenderedAsSent(single);
  assert.equal(componentsOf(single, 'image').length, 0);
  assert.equal(componentsOf(single, 'button')[0].action.key, 'monitoring_off'); // noc-1 is on
  const list = await WIDGETS[WIDGET_KEYS.CAMERAS].get(noImage, { settings: {} });
  assertRenderedAsSent(list);

  gladys.devices = gladys.devices.filter((device) => !['NACamera', 'NOC'].includes(device.model));
  const empty = await getContent(WIDGET_KEYS.CAMERAS);
  assertRenderedAsSent(empty);
  assert.match(componentsOf(empty, 'text')[0].text.en, /No Netatmo camera/);
});

test('cameraImageKey matches the core image-key regex for any camera id', () => {
  const key = cameraImageKey('70:EE:50:AA:BB:CC', 'abc');
  assert.match(key, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.notEqual(cameraImageKey('70:EE:50:AA:BB:CC', 'abd'), key);
});

// --- Nudges --------------------------------------------------------------------

test('the telemetry nudges the heating widget when the mode moves, not on every cycle', async () => {
  const kinds = [];
  telemetry.onUpdate((kind) => kinds.push(kind));
  telemetry.onUpdate(() => {
    throw new Error('a failing listener never breaks the cycle');
  });
  await telemetry.refreshValues(config);
  assert.ok(!kinds.includes('heating'));
  netatmo.state.homeStatuses['home-1'].home.therm_mode = 'away';
  await telemetry.refreshValues(config);
  assert.ok(kinds.includes('heating'));
});

test('refreshWidgets nudges every widget, defensively', () => {
  refreshWidgets(gladys);
  assert.deepEqual(gladys.nudges.slice(-3), Object.keys(WIDGETS));
  // An older SDK without requestWidgetRefresh never throws.
  requestRefresh({}, WIDGET_KEYS.WEATHER);
});
