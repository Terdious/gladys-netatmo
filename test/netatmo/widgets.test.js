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
import { startFakeNetatmo } from '../helpers/fakeNetatmo.js';

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

test('the heating content: mode, one row per room, one button per mode', async () => {
  const content = await getContent(WIDGET_KEYS.HEATING, {}, { language: 'fr' });
  assertRenderedAsSent(content);
  const [status] = componentsOf(content, 'status');
  assert.deepEqual(status.items[0].value, {
    en: 'Schedule',
    fr: 'Planning',
    de: 'Zeitplan',
    es: 'Programación',
  });
  // Rooms: measured → setpoint, in the user's language (decimal comma).
  assert.deepEqual(
    status.items.slice(1).map((item) => [item.label, item.value, item.color]),
    [
      ['Salon', '19,5 °C → 21 °C', 'neutral'],
      ['Chambre', '17 °C → 19 °C', 'warning'], // heating (power request 42)
    ],
  );
  const buttons = componentsOf(content, 'button');
  assert.deepEqual(
    buttons.map((button) => [button.action.key, button.style]),
    [
      ['mode_schedule', 'primary'],
      ['mode_hg', 'secondary'],
      ['mode_away', 'secondary'],
    ],
  );
});

test('the heating rows follow the user unit system', async () => {
  const content = await getContent(WIDGET_KEYS.HEATING, {}, { units: 'us' });
  const [status] = componentsOf(content, 'status');
  assert.equal(status.items[1].value, '67.1 °F → 69.8 °F');
});

test('every heating button is handled: setthermmode, then a toast and a refresh', async () => {
  const content = await getContent(WIDGET_KEYS.HEATING);
  let refreshes = 0;
  for (const { action } of componentsOf(content, 'button')) {
    const message = await WIDGETS[WIDGET_KEYS.HEATING].action(
      ctx({ refresh: async () => (refreshes += 1) }),
      { actionKey: action.key, params: action.params, settings: {} },
    );
    assert.ok(message.en.length > 0 && message.en.length <= 200);
    for (const language of ['fr', 'de', 'es']) {
      assert.ok(message[language].length <= 200);
    }
  }
  assert.deepEqual(netatmo.state.setThermModeRequests, [
    { home_id: 'home-1', mode: 'schedule' },
    { home_id: 'home-1', mode: 'hg' },
    { home_id: 'home-1', mode: 'away' },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 3);
  // The next content (after the refresh) shows the new mode as the active button.
  await telemetry.refreshValues(config);
  const after = await getContent(WIDGET_KEYS.HEATING);
  assert.equal(
    componentsOf(after, 'button').find((b) => b.style === 'primary').action.key,
    'mode_away',
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
  assert.equal(componentsOf(chosen, 'text')[0].text, 'Maison');

  const noHeating = {
    ...ctx(),
    telemetry: { ...telemetry, getHomes: () => [{ ...home, modules: [] }] },
  };
  const none = await WIDGETS[WIDGET_KEYS.HEATING].get(noHeating, { settings: {} });
  assert.match(none.components[0].text.en, /No Netatmo heating/);
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
