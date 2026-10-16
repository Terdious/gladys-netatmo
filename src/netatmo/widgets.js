// -----------------------------------------------------------------------------
// Dashboard widgets (issue #40, manifest `widgets`, Gladys 5.1+).
//
// The manifest declares each widget's identity (key, label, icon, settings);
// at runtime the integration returns a DECLARATIVE content (`text`, `value`,
// `status`, `card-list`, `image`, `button`) that the core renders with its own
// theme. Three widgets:
//   - netatmo_weather: live tiles bound to the station's features (they follow
//     the published states, no TTL involved) + module health rows;
//   - netatmo_heating: one row per heated room (measured → setpoint, tagged
//     when the setpoint is manual or a boost), the home's heating mode and
//     active schedule, one button per mode (setthermmode) and a "Change
//     schedule" button whose form lists the heating schedules
//     (switchhomeschedule, issue #58);
//   - netatmo_cameras: the latest snapshot of each camera, served through
//     onWidgetGetImage under a content-addressed key (when the bytes change,
//     the key changes: the core caches an image one hour by key), the
//     monitoring state and buttons to switch it.
//
// Every content is checked with the SDK's validateWidgetContent in the tests:
// what ships is what the core renders, nothing dropped or truncated.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  WIDGET_COLORS,
} from '@gladysassistant/integration-sdk';

import {
  CAMERA_MODULE_TYPES,
  ENERGY_MODULE_TYPES,
  NETATMO_SETPOINT_MODES,
  NETATMO_THERM_MODES,
  PARAMS,
  SUPPORTED_MODULE_TYPE,
  THERM_MODE_PRESETS,
  THERM_MODE_LABELS,
} from './constants.js';
import { readValues } from './deviceMapping.js';
import { getDeviceParam, rethrowScopeError, setHomeThermMode } from './setValue.js';
import { resolveHome } from './scenes.js';

const logger = createLogger({ name: 'netatmo-widgets' });

// Widget keys, as declared in the manifest `widgets` field (never renamed:
// dashboards store them).
export const WIDGET_KEYS = {
  WEATHER: 'netatmo_weather',
  HEATING: 'netatmo_heating',
  CAMERAS: 'netatmo_cameras',
};

// Which widget a telemetry change kind refreshes (telemetry.onUpdate).
export const WIDGET_OF_UPDATE = {
  weather: WIDGET_KEYS.WEATHER,
  heating: WIDGET_KEYS.HEATING,
  cameras: WIDGET_KEYS.CAMERAS,
};

// A module at or under this battery level is flagged on the weather widget.
export const LOW_BATTERY_PERCENT = 20;

// Images the cameras widget declared, by key (bounded): an image is always
// served with the exact bytes its key was computed from.
const MAX_IMAGE_KEYS = 32;
const IMAGE_PREFIX_REGEX = /^image\/[a-z]+;base64,/;

const text = (en, fr, de, es) => ({ en, fr, de, es });

const TEXTS = {
  waitingForData: text(
    'Waiting for the Netatmo data…',
    'En attente des données Netatmo…',
    'Warte auf die Netatmo-Daten…',
    'Esperando los datos de Netatmo…',
  ),
  noStation: text(
    'No Netatmo weather station created in Gladys yet.',
    "Aucune station météo Netatmo n'est encore créée dans Gladys.",
    'Noch keine Netatmo-Wetterstation in Gladys angelegt.',
    'Aún no hay ninguna estación meteorológica Netatmo creada en Gladys.',
  ),
  noHeating: text(
    'No Netatmo heating found in this account.',
    'Aucun chauffage Netatmo dans ce compte.',
    'Keine Netatmo-Heizung in diesem Konto gefunden.',
    'No se encontró ninguna calefacción Netatmo en esta cuenta.',
  ),
  chooseHome: text(
    'Several Netatmo homes: choose a thermostat or valve of the home in the widget settings.',
    'Plusieurs maisons Netatmo : choisissez un thermostat ou une vanne de la maison dans les réglages du widget.',
    'Mehrere Netatmo-Zuhause: Wähle in den Widget-Einstellungen ein Thermostat oder Ventil des Zuhauses.',
    'Varias casas Netatmo: elija un termostato o una válvula de la casa en los ajustes del widget.',
  ),
  noCamera: text(
    'No Netatmo camera created in Gladys yet.',
    "Aucune caméra Netatmo n'est encore créée dans Gladys.",
    'Noch keine Netatmo-Kamera in Gladys angelegt.',
    'Aún no hay ninguna cámara Netatmo creada en Gladys.',
  ),
  modules: text('Modules', 'Modules', 'Module', 'Módulos'),
  allModulesOk: text('All OK', 'Tout va bien', 'Alles in Ordnung', 'Todo bien'),
  unreachable: text('Unreachable', 'Injoignable', 'Nicht erreichbar', 'Inaccesible'),
  heatingMode: text('Heating mode', 'Mode du chauffage', 'Heizmodus', 'Modo de calefacción'),
  activeSchedule: text(
    'Active schedule',
    'Planning actif',
    'Aktiver Zeitplan',
    'Programación activa',
  ),
  schedule: text('Schedule', 'Planning', 'Zeitplan', 'Programación'),
  changeSchedule: text(
    'Change schedule',
    'Changer de planning',
    'Zeitplan wechseln',
    'Cambiar programación',
  ),
  setpointManual: text('Manual', 'Manuel', 'Manuell', 'Manual'),
  setpointBoost: text('Boost', 'Boost', 'Boost', 'Boost'),
  updateGladys: text(
    'Update Gladys to choose the schedule from the widget.',
    'Mettez Gladys à jour pour choisir le planning depuis le widget.',
    'Aktualisiere Gladys, um den Zeitplan im Widget auszuwählen.',
    'Actualice Gladys para elegir la programación desde el widget.',
  ),
  unknownMode: text('Unknown', 'Inconnu', 'Unbekannt', 'Desconocido'),
  monitoring: text('Monitoring', 'Surveillance', 'Überwachung', 'Vigilancia'),
  on: text('On', 'Activée', 'Ein', 'Activada'),
  off: text('Off', 'Coupée', 'Aus', 'Desactivada'),
  turnOn: text(
    'Turn monitoring on',
    'Activer la surveillance',
    'Überwachung ein',
    'Activar vigilancia',
  ),
  turnOff: text(
    'Turn monitoring off',
    'Couper la surveillance',
    'Überwachung aus',
    'Desactivar vigilancia',
  ),
  allOn: text('All on', 'Tout activer', 'Alle ein', 'Activar todas'),
  allOff: text('All off', 'Tout couper', 'Alle aus', 'Desactivar todas'),
  monitoringTurnedOn: text(
    'Monitoring turned on',
    'Surveillance activée',
    'Überwachung eingeschaltet',
    'Vigilancia activada',
  ),
  monitoringTurnedOff: text(
    'Monitoring turned off',
    'Surveillance coupée',
    'Überwachung ausgeschaltet',
    'Vigilancia desactivada',
  ),
};

const lowBattery = (percent) =>
  text(
    `Low battery (${percent} %)`,
    `Batterie faible (${percent} %)`,
    `Akku schwach (${percent} %)`,
    `Batería baja (${percent} %)`,
  );

const scheduleSet = (name) =>
  Object.fromEntries(
    Object.entries(TEXTS.activeSchedule).map(([language, label]) => [
      language,
      `${label}: ${bounded(name, 100)}`,
    ]),
  );

const modeSet = (mode) =>
  Object.fromEntries(
    Object.entries(THERM_MODE_LABELS[mode]).map(([language, label]) => [
      language,
      `${TEXTS.heatingMode[language]}: ${label}`,
    ]),
  );

// Color and icon of each heating mode on the widget.
const MODE_STYLE = {
  [NETATMO_THERM_MODES.SCHEDULE]: { color: WIDGET_COLORS.SUCCESS, icon: 'calendar' },
  [NETATMO_THERM_MODES.AWAY]: { color: WIDGET_COLORS.INFO, icon: 'log-out' },
  [NETATMO_THERM_MODES.FROST_GUARD]: { color: WIDGET_COLORS.WARNING, icon: 'cloud-snow' },
};

// Weather tiles: which module and feature suffix, in display order, per view.
const WEATHER_TILES = {
  outdoor_temperature: {
    module: SUPPORTED_MODULE_TYPE.NAMODULE1,
    suffix: 'temperature',
    icon: 'thermometer',
    label: text(
      'Outdoor temperature',
      'Température extérieure',
      'Außentemperatur',
      'Temperatura exterior',
    ),
  },
  outdoor_humidity: {
    module: SUPPORTED_MODULE_TYPE.NAMODULE1,
    suffix: 'humidity',
    icon: 'droplet',
    label: text('Outdoor humidity', 'Humidité extérieure', 'Außenfeuchte', 'Humedad exterior'),
  },
  indoor_temperature: {
    module: SUPPORTED_MODULE_TYPE.NAMAIN,
    suffix: 'temperature',
    icon: 'thermometer',
    label: text(
      'Indoor temperature',
      'Température intérieure',
      'Innentemperatur',
      'Temperatura interior',
    ),
  },
  indoor_humidity: {
    module: SUPPORTED_MODULE_TYPE.NAMAIN,
    suffix: 'humidity',
    icon: 'droplet',
    label: text('Indoor humidity', 'Humidité intérieure', 'Innenfeuchte', 'Humedad interior'),
  },
  co2: {
    module: SUPPORTED_MODULE_TYPE.NAMAIN,
    suffix: 'co2',
    icon: 'cloud',
    label: text('CO2', 'CO2', 'CO2', 'CO2'),
  },
  noise: {
    module: SUPPORTED_MODULE_TYPE.NAMAIN,
    suffix: 'noise',
    icon: 'volume-2',
    label: text('Noise', 'Bruit', 'Lärm', 'Ruido'),
  },
  pressure: {
    module: SUPPORTED_MODULE_TYPE.NAMAIN,
    suffix: 'pressure',
    icon: 'activity',
    label: text('Pressure', 'Pression', 'Luftdruck', 'Presión'),
  },
  rain_1h: {
    module: SUPPORTED_MODULE_TYPE.NAMODULE3,
    suffix: 'sum_rain_1',
    icon: 'cloud-rain',
    label: text('Rain 1 h', 'Pluie 1 h', 'Regen 1 Std.', 'Lluvia 1 h'),
  },
  rain_24h: {
    module: SUPPORTED_MODULE_TYPE.NAMODULE3,
    suffix: 'sum_rain_24',
    icon: 'cloud-rain',
    label: text('Rain 24 h', 'Pluie 24 h', 'Regen 24 Std.', 'Lluvia 24 h'),
  },
  wind: {
    module: SUPPORTED_MODULE_TYPE.NAMODULE2,
    suffix: 'wind_strength',
    icon: 'wind',
    label: text('Wind', 'Vent', 'Wind', 'Viento'),
  },
  gust: {
    module: SUPPORTED_MODULE_TYPE.NAMODULE2,
    suffix: 'wind_gust',
    icon: 'wind',
    label: text('Gusts', 'Rafales', 'Böen', 'Ráfagas'),
  },
};

// At most 6 tiles per widget (content budget): one set per `view` setting.
export const WEATHER_VIEWS = {
  overview: [
    'outdoor_temperature',
    'outdoor_humidity',
    'indoor_temperature',
    'co2',
    'rain_1h',
    'wind',
  ],
  indoor: ['indoor_temperature', 'indoor_humidity', 'co2', 'noise', 'pressure'],
  outdoor: ['outdoor_temperature', 'outdoor_humidity', 'rain_1h', 'rain_24h', 'wind', 'gust'],
};

// --- Helpers -------------------------------------------------------------------

/** Cut a text to a widget bound (the core would add an ellipsis). */
function bounded(value, max) {
  const string = String(value ?? '');
  return string.length <= max ? string : `${string.slice(0, max - 1)}…`;
}

/** Netatmo id of a Gladys device (`ext:netatmo:<id>` → `<id>`). */
function netatmoIdOf(gladys, device) {
  return device.external_id.replace(gladys.externalId(''), '');
}

function createdDevices(gladys, models) {
  return (gladys.devices ?? []).filter((device) => models.includes(device.model));
}

function hasFeature(device, featureExternalId) {
  return (device.features ?? []).some((feature) => feature.external_id === featureExternalId);
}

/** A number in the user's language (decimal separator), one decimal at most. */
function formatNumber(value, language) {
  try {
    return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);
  } catch {
    return String(Math.round(value * 10) / 10);
  }
}

/** A Netatmo temperature (°C) in the user's unit system. */
function formatTemperature(celsius, { language, units }) {
  if (typeof celsius !== 'number' || !Number.isFinite(celsius)) {
    return '–';
  }
  if (units === 'us') {
    return `${formatNumber((celsius * 9) / 5 + 32, language)} °F`;
  }
  return `${formatNumber(celsius, language)} °C`;
}

/** Battery percent of a raw module (NRV-style strings mapped like the states). */
function batteryPercentOf(rawDevice) {
  const raw = rawDevice?.battery_percent ?? rawDevice?.battery_state;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const percent =
    readValues[DEVICE_FEATURE_CATEGORIES.BATTERY][DEVICE_FEATURE_TYPES.BATTERY.INTEGER](raw);
  return Number.isFinite(percent) ? percent : undefined;
}

function textComponent(value, variant = 'body') {
  return { type: 'text', variant, text: value };
}

// --- Weather -------------------------------------------------------------------

/** The station a weather widget shows: the chosen one, else the first created. */
function stationOf(gladys, settings) {
  const stations = createdDevices(gladys, [SUPPORTED_MODULE_TYPE.NAMAIN]);
  return stations.find((device) => device.external_id === settings?.station) ?? stations[0];
}

/** The created modules of a station (their plug_id param is the station id). */
function stationModules(gladys, station) {
  const stationId = netatmoIdOf(gladys, station);
  return (gladys.devices ?? []).filter(
    (device) =>
      device.external_id !== station.external_id &&
      getDeviceParam(device, PARAMS.PLUG_ID) === stationId,
  );
}

async function getWeatherContent({ gladys, telemetry }, { settings }) {
  const station = stationOf(gladys, settings);
  if (!station) {
    return { ttl_seconds: 300, components: [textComponent(TEXTS.noStation)] };
  }
  const devices = [station, ...stationModules(gladys, station)];
  const view = WEATHER_VIEWS[settings?.view] ? settings.view : 'overview';
  const tiles = [];
  for (const tileKey of WEATHER_VIEWS[view]) {
    const tile = WEATHER_TILES[tileKey];
    const device = devices.find((candidate) => candidate.model === tile.module);
    const featureExternalId = device ? `${device.external_id}:${tile.suffix}` : undefined;
    if (device && hasFeature(device, featureExternalId)) {
      tiles.push({
        type: 'value',
        label: tile.label,
        icon: tile.icon,
        device_feature: featureExternalId,
      });
    }
  }
  // Health rows: what no feature tells at a glance — a module whose battery
  // is low, or that Netatmo no longer reaches (its tiles then show old values).
  const items = [];
  for (const device of devices) {
    const rawDevice = telemetry.getRawDevice(netatmoIdOf(gladys, device));
    const label = bounded(device.name, 40);
    if (rawDevice?.reachable === false) {
      items.push({
        label,
        value: TEXTS.unreachable,
        color: WIDGET_COLORS.DANGER,
        icon: 'wifi-off',
      });
      continue;
    }
    const battery = batteryPercentOf(rawDevice);
    if (device.model !== SUPPORTED_MODULE_TYPE.NAMAIN && battery <= LOW_BATTERY_PERCENT) {
      items.push({
        label,
        value: lowBattery(battery),
        color: WIDGET_COLORS.WARNING,
        icon: 'battery',
      });
    }
  }
  if (items.length === 0) {
    items.push({
      label: TEXTS.modules,
      value: TEXTS.allModulesOk,
      color: WIDGET_COLORS.SUCCESS,
      icon: 'check-circle',
    });
  }
  return {
    // The tiles are live; the health rows follow the telemetry nudges.
    ttl_seconds: 300,
    components: [
      textComponent(bounded(station.name, 80), 'caption'),
      ...tiles,
      { type: 'status', items: items.slice(0, 10) },
    ],
  };
}

// --- Heating -------------------------------------------------------------------

const hasHeating = (home) =>
  (home.modules ?? []).some((module) => ENERGY_MODULE_TYPES.includes(module.type));

// Widget action of the schedule button (its form carries the schedule id).
const SWITCH_SCHEDULE_ACTION = 'switch_schedule';
// Above this many schedules the form shows a dropdown instead of radio buttons.
const MAX_RADIO_SCHEDULES = 5;

/** A multi-language text in the request language (English fallback). */
function inLanguage(value, language) {
  return value[language] ?? value[String(language ?? '').slice(0, 2)] ?? value.en;
}

/** Tag of a room whose setpoint is not the schedule's (issue #58). */
function setpointTagOf(room, language) {
  if (room.therm_setpoint_mode === NETATMO_SETPOINT_MODES.MAX) {
    return ` · ${inLanguage(TEXTS.setpointBoost, language)}`;
  }
  if (room.therm_setpoint_mode === NETATMO_SETPOINT_MODES.MANUAL) {
    return ` · ${inLanguage(TEXTS.setpointManual, language)}`;
  }
  return '';
}

function roomIconOf(room) {
  if (room.open_window) {
    return 'wind';
  }
  if (room.therm_setpoint_mode === NETATMO_SETPOINT_MODES.MAX) {
    return 'zap';
  }
  return room.therm_setpoint_mode === NETATMO_SETPOINT_MODES.MANUAL ? 'edit-2' : 'thermometer';
}

/** Same multi-language text in every language (a Netatmo name). */
const sameInEveryLanguage = (value) => text(value, value, value, value);

/**
 * The "Change schedule" button: a form listing the heating schedules of the
 * home (widget action fields, Gladys 5.2+), the active one pre-selected. The
 * content budget allows 4 buttons and the heating modes already take 3: one
 * button with a form serves any number of schedules.
 */
function scheduleButtonOf(home) {
  const schedules = home.schedules ?? [];
  const selected = schedules.find((schedule) => schedule.selected);
  return {
    type: 'button',
    label: TEXTS.changeSchedule,
    icon: 'list',
    style: 'secondary',
    action: {
      key: SWITCH_SCHEDULE_ACTION,
      params: { home_id: home.id },
      fields: [
        {
          key: 'schedule_id',
          type: 'select',
          required: true,
          display: schedules.length > MAX_RADIO_SCHEDULES ? 'dropdown' : 'radio',
          label: TEXTS.schedule,
          options: schedules.map((schedule) => ({
            value: schedule.id,
            label: sameInEveryLanguage(bounded(schedule.name, 40)),
          })),
          ...(selected ? { default: selected.id } : {}),
        },
      ],
    },
  };
}

async function getHeatingContent(ctx, { settings, language, units }) {
  const homes = ctx.telemetry.getHomes();
  if (homes.length === 0) {
    return { ttl_seconds: 60, components: [textComponent(TEXTS.waitingForData)] };
  }
  const candidates = homes.filter(hasHeating);
  if (!settings?.device && candidates.length !== 1) {
    const message = candidates.length === 0 ? TEXTS.noHeating : TEXTS.chooseHome;
    return { ttl_seconds: 300, components: [textComponent(message)] };
  }
  const home = resolveHome(ctx, settings?.device, hasHeating, 'a heating');
  const mode = home.therm_mode;
  const style = MODE_STYLE[mode] ?? { color: WIDGET_COLORS.NEUTRAL, icon: 'help-circle' };
  const schedules = home.schedules ?? [];
  const activeSchedule = schedules.find((schedule) => schedule.selected);
  const items = [
    {
      label: TEXTS.heatingMode,
      value: THERM_MODE_LABELS[mode] ?? TEXTS.unknownMode,
      ...style,
    },
  ];
  if (schedules.length > 0) {
    items.push({
      label: TEXTS.activeSchedule,
      value: activeSchedule ? bounded(activeSchedule.name, 40) : TEXTS.unknownMode,
      icon: 'clock',
      color: WIDGET_COLORS.PRIMARY,
    });
  }
  // One row per heated room: measured → setpoint (status holds 10 rows), with
  // a tag when the setpoint is manual or a boost rather than the schedule's.
  for (const room of (home.rooms ?? []).slice(0, 10 - items.length)) {
    items.push({
      label: bounded(room.name, 40),
      value: bounded(
        `${formatTemperature(room.therm_measured_temperature, { language, units })} → ${formatTemperature(room.therm_setpoint_temperature, { language, units })}${setpointTagOf(room, language)}`,
        40,
      ),
      icon: roomIconOf(room),
      color:
        room.heating_power_request > 0
          ? WIDGET_COLORS.WARNING
          : room.open_window
            ? WIDGET_COLORS.INFO
            : WIDGET_COLORS.NEUTRAL,
    });
  }
  const buttons = THERM_MODE_PRESETS.map(({ mode: buttonMode }) => ({
    type: 'button',
    label: THERM_MODE_LABELS[buttonMode],
    icon: MODE_STYLE[buttonMode].icon,
    style: buttonMode === mode ? 'primary' : 'secondary',
    action: { key: `mode_${buttonMode}`, params: { home_id: home.id, mode: buttonMode } },
  }));
  if (schedules.length > 1) {
    buttons.push(scheduleButtonOf(home));
  }
  return {
    ttl_seconds: 120,
    components: [
      textComponent(bounded(home.name, 80), 'caption'),
      { type: 'status', items },
      ...buttons,
    ],
  };
}

/** The "Change schedule" form was sent: switchhomeschedule on the home. */
async function switchScheduleAction({ client, refresh, telemetry }, { params, values }) {
  const homeId = params?.home_id;
  if (!homeId) {
    throw new Error(`Unknown widget action: ${SWITCH_SCHEDULE_ACTION}`);
  }
  const scheduleId = values?.schedule_id;
  if (typeof scheduleId !== 'string' || scheduleId === '') {
    // An older core drops the action fields and sends no values.
    throw new Error(TEXTS.updateGladys.en);
  }
  const home = telemetry?.getHomes().find((entry) => entry.id === homeId);
  const schedule = home?.schedules?.find((entry) => entry.id === scheduleId);
  if (home && !schedule) {
    throw new Error(`Unknown heating schedule ${scheduleId} for the Netatmo home ${home.name}`);
  }
  logger.info(`Widget action: heating schedule of ${homeId} -> ${scheduleId}`);
  try {
    await client.switchHomeSchedule(homeId, scheduleId);
  } catch (err) {
    rethrowScopeError(err);
  }
  if (refresh) {
    Promise.resolve()
      .then(refresh)
      .catch((err) => logger.warn(`Refresh after the schedule change failed: ${err.message}`));
  }
  return scheduleSet(schedule?.name ?? scheduleId);
}

async function heatingAction(ctx, { actionKey, params, values }) {
  if (actionKey === SWITCH_SCHEDULE_ACTION) {
    return switchScheduleAction(ctx, { params, values });
  }
  const { client, refresh } = ctx;
  const mode = params?.mode;
  if (actionKey !== `mode_${mode}` || !THERM_MODE_LABELS[mode] || !params?.home_id) {
    throw new Error(`Unknown widget action: ${actionKey}`);
  }
  logger.info(`Widget action: heating mode of ${params.home_id} -> ${mode}`);
  await setHomeThermMode(client, params.home_id, mode);
  if (refresh) {
    Promise.resolve()
      .then(refresh)
      .catch((err) => logger.warn(`Refresh after the heating mode change failed: ${err.message}`));
  }
  return modeSet(mode);
}

// --- Cameras -------------------------------------------------------------------

/**
 * Content-addressed key of a camera image: `cam-<id>-<hash>` — the key
 * changes with the bytes, as the core requires (one-hour cache by key).
 * @param {string} cameraId Netatmo camera id (MAC-like)
 * @param {string} rawBase64 the image bytes, base64
 * @returns {string} key matching ^[a-z0-9][a-z0-9-]{0,63}$
 */
export function cameraImageKey(cameraId, rawBase64) {
  const id = cameraId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 32);
  const hash = createHash('sha1').update(rawBase64).digest('hex').slice(0, 16);
  return `cam-${id}-${hash}`;
}

/** Declared image keys -> raw base64, oldest first (bounded). */
const imageStore = new Map();

function rememberImage(key, rawBase64) {
  imageStore.delete(key);
  imageStore.set(key, rawBase64);
  while (imageStore.size > MAX_IMAGE_KEYS) {
    imageStore.delete(imageStore.keys().next().value);
  }
}

/** Image key of the last snapshot of a camera (and remember its bytes), if any. */
function imageKeyOf({ telemetry }, cameraId) {
  const image = telemetry.getCameraImage(cameraId);
  if (!image) {
    return undefined;
  }
  const rawBase64 = image.replace(IMAGE_PREFIX_REGEX, '');
  const key = cameraImageKey(cameraId, rawBase64);
  rememberImage(key, rawBase64);
  return key;
}

/**
 * Bytes of a declared image key (onWidgetGetImage): the raw base64 of the
 * JPEG snapshot, already under the camera-store bound (150 KB), far below
 * the widget bound (300 KB).
 * @param {string} imageKey the key the content declared
 * @returns {string} raw base64 (no data-URI prefix)
 */
export function getWidgetImage(imageKey) {
  const rawBase64 = imageStore.get(imageKey);
  if (!rawBase64) {
    throw new Error(`Unknown widget image ${imageKey}`);
  }
  return rawBase64;
}

function monitoringOf({ gladys, telemetry }, camera) {
  return telemetry.getRawDevice(netatmoIdOf(gladys, camera))?.monitoring;
}

async function getCamerasContent(ctx, { settings }) {
  const { gladys } = ctx;
  const cameras = createdDevices(gladys, CAMERA_MODULE_TYPES);
  if (cameras.length === 0) {
    return { ttl_seconds: 300, components: [textComponent(TEXTS.noCamera)] };
  }
  const chosen = cameras.find((camera) => camera.external_id === settings?.camera);
  if (chosen || cameras.length === 1) {
    // One camera: its snapshot in the 16:9 frame, its monitoring, a toggle.
    const camera = chosen ?? cameras[0];
    const monitoring = monitoringOf(ctx, camera);
    const key = imageKeyOf(ctx, netatmoIdOf(gladys, camera));
    const components = [textComponent(bounded(camera.name, 80), 'caption')];
    if (key) {
      components.push({ type: 'image', key, alt: bounded(camera.name, 100), fit: 'cover' });
    }
    components.push({
      type: 'status',
      items: [
        {
          label: TEXTS.monitoring,
          value: monitoring === 'on' ? TEXTS.on : TEXTS.off,
          color: monitoring === 'on' ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
          icon: monitoring === 'on' ? 'eye' : 'eye-off',
        },
      ],
    });
    const turnOn = monitoring !== 'on';
    components.push({
      type: 'button',
      label: turnOn ? TEXTS.turnOn : TEXTS.turnOff,
      icon: turnOn ? 'eye' : 'eye-off',
      style: turnOn ? 'primary' : 'secondary',
      action: {
        key: turnOn ? 'monitoring_on' : 'monitoring_off',
        params: { cameras: [netatmoIdOf(gladys, camera)] },
      },
    });
    return { ttl_seconds: 120, components };
  }
  // Several cameras: one row each (square thumbnail, monitoring badge).
  const shown = cameras.slice(0, 8);
  const items = shown.map((camera) => {
    const monitoring = monitoringOf(ctx, camera);
    const key = imageKeyOf(ctx, netatmoIdOf(gladys, camera));
    return {
      title: bounded(camera.name, 60),
      subtitle: TEXTS.monitoring,
      ...(key ? { image: key } : {}),
      badge: {
        text: monitoring === 'on' ? TEXTS.on : TEXTS.off,
        color: monitoring === 'on' ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
      },
    };
  });
  const ids = shown.map((camera) => netatmoIdOf(gladys, camera));
  return {
    ttl_seconds: 120,
    components: [
      { type: 'card-list', display: 'list', items },
      {
        type: 'button',
        label: TEXTS.allOn,
        icon: 'eye',
        style: 'primary',
        action: { key: 'monitoring_on', params: { cameras: ids } },
      },
      {
        type: 'button',
        label: TEXTS.allOff,
        icon: 'eye-off',
        style: 'secondary',
        action: { key: 'monitoring_off', params: { cameras: ids } },
      },
    ],
  };
}

async function camerasAction({ gladys, client, refresh }, { actionKey, params }) {
  if (!['monitoring_on', 'monitoring_off'].includes(actionKey)) {
    throw new Error(`Unknown widget action: ${actionKey}`);
  }
  const monitoring = actionKey === 'monitoring_on' ? 'on' : 'off';
  const cameraIds = Array.isArray(params?.cameras) ? params.cameras : [];
  for (const cameraId of cameraIds) {
    const device = (gladys.devices ?? []).find(
      (candidate) => candidate.external_id === gladys.externalId(cameraId),
    );
    const homeId = device ? getDeviceParam(device, PARAMS.HOME_ID) : undefined;
    if (!homeId) {
      throw new Error(`Camera ${cameraId} is not a Netatmo camera of this Gladys`);
    }
    logger.info(`Widget action: monitoring of ${cameraId} -> ${monitoring}`);
    try {
      await client.setState({ homeId, moduleId: cameraId, monitoring });
    } catch (err) {
      rethrowScopeError(err);
    }
  }
  if (refresh) {
    Promise.resolve()
      .then(refresh)
      .catch((err) => logger.warn(`Refresh after the monitoring change failed: ${err.message}`));
  }
  return monitoring === 'on' ? TEXTS.monitoringTurnedOn : TEXTS.monitoringTurnedOff;
}

// --- Registry ------------------------------------------------------------------

// One entry per declared widget: get(ctx, {settings, language, units}) and an
// optional action(ctx, {actionKey, params, settings, values}). ctx is
// {gladys, client, telemetry, refresh}.
export const WIDGETS = {
  [WIDGET_KEYS.WEATHER]: { get: getWeatherContent },
  [WIDGET_KEYS.HEATING]: { get: getHeatingContent, action: heatingAction },
  [WIDGET_KEYS.CAMERAS]: { get: getCamerasContent, action: camerasAction },
};

/**
 * Freshness nudge for every widget (after a (re)connection: nudges are
 * dropped silently while disconnected, rate-limited core-side).
 * @param {object} gladys SDK instance
 */
export function refreshWidgets(gladys) {
  for (const key of Object.keys(WIDGETS)) {
    requestRefresh(gladys, key);
  }
}

/**
 * Freshness nudge for one widget, defensively (an older SDK/core).
 * @param {object} gladys SDK instance
 * @param {string} key widget key
 */
export function requestRefresh(gladys, key) {
  try {
    gladys.requestWidgetRefresh(key);
  } catch (err) {
    logger.debug(`Widget refresh nudge for ${key} skipped: ${err.message}`);
  }
}
