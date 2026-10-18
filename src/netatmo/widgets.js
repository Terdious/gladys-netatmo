// -----------------------------------------------------------------------------
// Dashboard widgets (issue #40, manifest `widgets`, Gladys 5.1+).
//
// The manifest declares each widget's identity (key, label, icon, settings);
// at runtime the integration returns a DECLARATIVE content (`text`, `value`,
// `status`, `card-list`, `image`, `button`) that the core renders with its own
// theme. Three widgets:
//   - netatmo_weather: live tiles bound to the station's features (they follow
//     the published states, no TTL involved) + module health rows;
//   - netatmo_heating: the home's heating mode and how many rooms heat
//     (tiles), its active schedule (caption), one compact row per heated
//     room (measured → setpoint, tagged when manual / boost / off, window
//     open, heating), a button per heating mode but the active one
//     (setthermmode), a "Room setpoint" button whose form sets a room's
//     setpoint, boost, schedule or off for a duration (setroomthermpoint), and
//     a "Change schedule" button whose form lists the heating schedules
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
  ROOM_SETPOINT_MAX_CELSIUS,
  ROOM_SETPOINT_MIN_CELSIUS,
  SUPPORTED_MODULE_TYPE,
  THERM_MODE_PRESETS,
  THERM_MODE_LABELS,
} from './constants.js';
import { readValues } from './deviceMapping.js';
import {
  SETPOINT_DURATIONS,
  SETPOINT_DURATION_LABELS,
  SETPOINT_DURATION_VALUES,
  endtimeForDuration,
  normalizeSetpointDuration,
  sendRoomThermpoint,
} from './roomSetpoint.js';
import { getDeviceParam, rethrowScopeError, setHomeThermMode } from './setValue.js';
import { resolveHome, setpointOf } from './scenes.js';

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
  setpointOff: text('Off', 'Arrêt', 'Aus', 'Apagado'),
  // Short markers of a room row (40 characters with the temperatures).
  windowOpen: text('Window', 'Fenêtre', 'Fenster', 'Ventana'),
  heating: text('Heating', 'Chauffe', 'Heizt', 'Calienta'),
  roomsHeating: text(
    'Rooms heating',
    'Pièces en chauffe',
    'Heizende Räume',
    'Habitaciones calentando',
  ),
  roomSetpoint: text(
    'Room setpoint',
    "Consigne d'une pièce",
    'Raum-Sollwert',
    'Consigna de habitación',
  ),
  room: text('Room', 'Pièce', 'Raum', 'Habitación'),
  roomCommand: text('Action', 'Action', 'Aktion', 'Acción'),
  setpointField: text('Setpoint (°C)', 'Consigne (°C)', 'Sollwert (°C)', 'Consigna (°C)'),
  setpointFieldHelp: text(
    "From 7 to 30 °C, rounded to 0.5 °C. Left empty: the room's current setpoint.",
    'De 7 à 30 °C, arrondie au 0,5 °C. Vide : la consigne actuelle de la pièce.',
    'Von 7 bis 30 °C, auf 0,5 °C gerundet. Leer: der aktuelle Sollwert des Raums.',
    'De 7 a 30 °C, redondeada a 0,5 °C. Vacía: la consigna actual de la habitación.',
  ),
  currentSetpoint: text(
    'Current setpoint',
    'Consigne actuelle',
    'Aktueller Sollwert',
    'Consigna actual',
  ),
  duration: text('Duration', 'Durée', 'Dauer', 'Duración'),
  durationHelp: text(
    "Of a setpoint, a boost or an off room. A boost with Netatmo's default or no end lasts Netatmo's boost duration.",
    "D'une consigne, d'un boost ou d'une pièce éteinte. Un boost par défaut ou sans fin dure la durée de boost de Netatmo.",
    'Eines Sollwerts, eines Boosts oder eines ausgeschalteten Raums. Ein Boost mit Standarddauer oder ohne Ende dauert die Netatmo-Boostdauer.',
    'De una consigna, un boost o una habitación apagada. Un boost predeterminado o sin fin dura la duración de boost de Netatmo.',
  ),
  backToSchedule: text(
    'back to the schedule',
    'retour au planning',
    'zurück zum Zeitplan',
    'vuelta a la programación',
  ),
  updateGladys: text(
    'Update Gladys to choose the schedule from the widget.',
    'Mettez Gladys à jour pour choisir le planning depuis le widget.',
    'Aktualisiere Gladys, um den Zeitplan im Widget auszuwählen.',
    'Actualice Gladys para elegir la programación desde el widget.',
  ),
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

/** Caption of the heating widget: the home and its active schedule. */
const scheduleCaption = (homeName, scheduleName) =>
  Object.fromEntries(
    Object.entries(TEXTS.schedule).map(([language, label]) => [
      language,
      bounded(`${homeName} · ${label}: ${scheduleName}`, 80),
    ]),
  );

const moreRooms = (count) =>
  text(`+${count} rooms`, `+${count} pièces`, `+${count} Räume`, `+${count} habitaciones`);

// What the room form does, as its radio buttons read.
const ROOM_COMMAND_LABELS = {
  setpoint: text(
    'Set the setpoint',
    'Régler la consigne',
    'Sollwert einstellen',
    'Fijar la consigna',
  ),
  boost: text('Boost', 'Boost', 'Boost', 'Boost'),
  schedule: text(
    'Back to schedule',
    'Retour au planning',
    'Zurück zum Zeitplan',
    'Volver a la programación',
  ),
  off: text('Off', 'Éteindre', 'Ausschalten', 'Apagar'),
};

/** Toast of the room form: `Salon: 21 °C (3 hours)`, `Salon: Boost`... */
function roomDone(roomName, command, temp, duration) {
  return Object.fromEntries(
    ['en', 'fr', 'de', 'es'].map((language) => {
      let what;
      if (command === 'setpoint') {
        what = `${formatNumber(temp, language)} °C`;
      } else if (command === 'boost') {
        what = TEXTS.setpointBoost[language];
      } else if (command === 'off') {
        what = TEXTS.setpointOff[language];
      } else {
        what = TEXTS.backToSchedule[language];
      }
      const until = duration ? ` (${SETPOINT_DURATION_LABELS[duration][language]})` : '';
      return [language, bounded(`${bounded(roomName, 60)}: ${what}${until}`, 200)];
    }),
  );
}

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

// The heating mode on its tile (a tile value holds 12 characters).
const MODE_TILE_LABELS = {
  [NETATMO_THERM_MODES.SCHEDULE]: text('Schedule', 'Planning', 'Zeitplan', 'Programación'),
  [NETATMO_THERM_MODES.FROST_GUARD]: text('Frost guard', 'Hors-gel', 'Frostschutz', 'Antihielo'),
  [NETATMO_THERM_MODES.AWAY]: text('Away', 'Absence', 'Abwesend', 'Ausencia'),
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
// Widget action of the room button (its form: room, command, setpoint, duration).
const ROOM_SETPOINT_ACTION = 'room_setpoint';
// Above this many schedules (or rooms) the form shows a dropdown instead of
// radio buttons.
const MAX_RADIO_SCHEDULES = 5;
// The status component holds 10 rows: with more rooms, the 10th row sums up
// the others.
const MAX_ROOM_ROWS = 10;
// The content budget allows 4 buttons.
const MAX_BUTTONS = 4;

// What the room form does.
export const ROOM_COMMANDS = {
  SETPOINT: 'setpoint',
  BOOST: 'boost',
  SCHEDULE: 'schedule',
  OFF: 'off',
};

/** A multi-language text in the request language (English fallback). */
function inLanguage(value, language) {
  return value[language] ?? value[String(language ?? '').slice(0, 2)] ?? value.en;
}

/** A Netatmo temperature (°C) as a number in the user's unit system, no unit. */
function temperatureNumber(celsius, { language, units }) {
  if (typeof celsius !== 'number' || !Number.isFinite(celsius)) {
    return '–';
  }
  return formatNumber(units === 'us' ? (celsius * 9) / 5 + 32 : celsius, language);
}

const temperatureUnit = (units) => (units === 'us' ? '°F' : '°C');

/**
 * Value of a room row, compact: `19,5 → 21 °C`, then the markers — the
 * setpoint mode when it is not the schedule's (manual, boost, off: issue
 * #58/#77), an open window, a room heating.
 */
function roomValueOf(room, { language, units }) {
  const off = room.therm_setpoint_mode === NETATMO_SETPOINT_MODES.OFF;
  const measured = temperatureNumber(room.therm_measured_temperature, { language, units });
  const hasSetpoint = typeof room.therm_setpoint_temperature === 'number';
  const temperatures =
    off || !hasSetpoint
      ? `${measured} ${temperatureUnit(units)}`
      : `${measured} → ${temperatureNumber(room.therm_setpoint_temperature, { language, units })} ${temperatureUnit(units)}`;
  const tags = [];
  if (off) {
    tags.push(TEXTS.setpointOff);
  } else if (room.therm_setpoint_mode === NETATMO_SETPOINT_MODES.MAX) {
    tags.push(TEXTS.setpointBoost);
  } else if (room.therm_setpoint_mode === NETATMO_SETPOINT_MODES.MANUAL) {
    tags.push(TEXTS.setpointManual);
  }
  if (room.open_window) {
    tags.push(TEXTS.windowOpen);
  }
  if (room.heating) {
    tags.push(TEXTS.heating);
  }
  return bounded([temperatures, ...tags.map((tag) => inLanguage(tag, language))].join(' · '), 40);
}

function roomIconOf(room) {
  if (room.open_window) {
    return 'wind';
  }
  if (room.therm_setpoint_mode === NETATMO_SETPOINT_MODES.OFF) {
    return 'power';
  }
  if (room.therm_setpoint_mode === NETATMO_SETPOINT_MODES.MAX) {
    return 'zap';
  }
  if (room.therm_setpoint_mode === NETATMO_SETPOINT_MODES.MANUAL) {
    return 'edit-2';
  }
  return room.heating ? 'sun' : 'thermometer';
}

function roomColorOf(room) {
  if (room.therm_setpoint_mode === NETATMO_SETPOINT_MODES.OFF) {
    return WIDGET_COLORS.NEUTRAL;
  }
  if (room.heating) {
    return WIDGET_COLORS.WARNING;
  }
  return room.open_window ? WIDGET_COLORS.INFO : WIDGET_COLORS.NEUTRAL;
}

/**
 * One row per heated room (status: 10 rows). With more rooms, nine rows and a
 * tenth that sums up the others (name and measured temperature).
 */
function roomRowsOf(rooms, request) {
  const rowOf = (room) => ({
    label: bounded(room.name, 40),
    value: roomValueOf(room, request),
    icon: roomIconOf(room),
    color: roomColorOf(room),
  });
  if (rooms.length <= MAX_ROOM_ROWS) {
    return rooms.map(rowOf);
  }
  const shown = rooms.slice(0, MAX_ROOM_ROWS - 1);
  const others = rooms.slice(MAX_ROOM_ROWS - 1);
  return [
    ...shown.map(rowOf),
    {
      label: moreRooms(others.length),
      value: bounded(
        others
          .map(
            (room) => `${room.name} ${temperatureNumber(room.therm_measured_temperature, request)}`,
          )
          .join(' · '),
        40,
      ),
      icon: 'more-horizontal',
      color: others.some((room) => room.heating) ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    },
  ];
}

/** Same multi-language text in every language (a Netatmo name). */
const sameInEveryLanguage = (value) => text(value, value, value, value);

/**
 * The "Change schedule" button: a form listing the heating schedules of the
 * home (widget action fields, Gladys 5.2+), the active one pre-selected. One
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

const isSetpoint = (value) =>
  typeof value === 'number' &&
  value >= ROOM_SETPOINT_MIN_CELSIUS &&
  value <= ROOM_SETPOINT_MAX_CELSIUS;

/**
 * The "Room setpoint" button: a form (widget action fields, at most 4) to
 * choose a room, what to do — set a setpoint, boost, back to the schedule,
 * off —, the setpoint and how long it lasts. Status rows cannot be tapped and
 * the content budget allows 4 buttons: one form serves every room. The room
 * pre-selected is the one of the thermostat or valve chosen in the widget
 * settings (else the first); the setpoint is pre-filled when the home has a
 * single room (left empty, the room's current setpoint is kept); the duration
 * is the `setpoint_duration` setting.
 */
function roomButtonOf(ctx, home, settings) {
  const rooms = home.rooms ?? [];
  const chosen = (ctx.gladys.devices ?? []).find(
    (device) => device.external_id === settings?.device,
  );
  const chosenRoomId = chosen ? getDeviceParam(chosen, PARAMS.ROOM_ID) : undefined;
  const defaultRoom = rooms.find((room) => room.id === chosenRoomId) ?? rooms[0];
  const duration = normalizeSetpointDuration(ctx.config?.setpoint_duration);
  const single = rooms.length === 1 ? rooms[0].therm_setpoint_temperature : undefined;
  return {
    type: 'button',
    label: TEXTS.roomSetpoint,
    icon: 'sliders',
    style: 'primary',
    action: {
      key: ROOM_SETPOINT_ACTION,
      params: { home_id: home.id },
      fields: [
        {
          key: 'room_id',
          type: 'select',
          required: true,
          display: rooms.length > MAX_RADIO_SCHEDULES ? 'dropdown' : 'radio',
          label: TEXTS.room,
          options: rooms.map((room) => ({
            value: room.id,
            label: sameInEveryLanguage(bounded(room.name, 40)),
          })),
          default: defaultRoom.id,
        },
        {
          key: 'command',
          type: 'select',
          required: true,
          display: 'radio',
          label: TEXTS.roomCommand,
          options: Object.values(ROOM_COMMANDS).map((command) => ({
            value: command,
            label: ROOM_COMMAND_LABELS[command],
          })),
          default: ROOM_COMMANDS.SETPOINT,
        },
        {
          key: 'temperature',
          type: 'number',
          required: false,
          min: ROOM_SETPOINT_MIN_CELSIUS,
          max: ROOM_SETPOINT_MAX_CELSIUS,
          label: TEXTS.setpointField,
          description: TEXTS.setpointFieldHelp,
          placeholder: TEXTS.currentSetpoint,
          ...(isSetpoint(single) ? { default: single } : {}),
        },
        {
          key: 'duration',
          type: 'select',
          required: true,
          display: 'dropdown',
          label: TEXTS.duration,
          description: TEXTS.durationHelp,
          options: SETPOINT_DURATION_VALUES.map((value) => ({
            value,
            label: SETPOINT_DURATION_LABELS[value],
          })),
          default: duration,
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
  const rooms = home.rooms ?? [];
  const components = [
    textComponent(
      activeSchedule ? scheduleCaption(home.name, activeSchedule.name) : bounded(home.name, 80),
      'caption',
    ),
    // The heating mode of the home, and how many rooms heat right now.
    {
      type: 'value',
      label: TEXTS.heatingMode,
      value: MODE_TILE_LABELS[mode] ? inLanguage(MODE_TILE_LABELS[mode], language) : '?',
      ...style,
    },
  ];
  if (rooms.length > 0) {
    const heating = rooms.filter((room) => room.heating).length;
    components.push({
      type: 'value',
      label: TEXTS.roomsHeating,
      value: `${heating}/${rooms.length}`,
      icon: 'sun',
      color: heating > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    });
    components.push({ type: 'status', items: roomRowsOf(rooms, { language, units }) });
  }
  // Buttons: the heating modes but the active one (the tile shows it), the
  // room form, the schedule form — 4 at most.
  const buttons = THERM_MODE_PRESETS.filter(({ mode: buttonMode }) => buttonMode !== mode).map(
    ({ mode: buttonMode }) => ({
      type: 'button',
      label: THERM_MODE_LABELS[buttonMode],
      icon: MODE_STYLE[buttonMode].icon,
      style: 'secondary',
      action: { key: `mode_${buttonMode}`, params: { home_id: home.id, mode: buttonMode } },
    }),
  );
  if (rooms.length > 0) {
    buttons.push(roomButtonOf(ctx, home, settings));
  }
  if (schedules.length > 1) {
    buttons.push(scheduleButtonOf(home));
  }
  return { ttl_seconds: 120, components: [...components, ...buttons.slice(0, MAX_BUTTONS)] };
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
  refreshSoon(refresh, 'schedule');
  return scheduleSet(schedule?.name ?? scheduleId);
}

/** The setpoint typed in the room form, else the room's current one. */
function typedSetpointOf(values, room) {
  const typed = values.temperature;
  if (typed !== undefined && typed !== null && typed !== '') {
    return setpointOf(typed);
  }
  if (typeof room?.therm_setpoint_temperature !== 'number') {
    throw new Error('No current setpoint known for this room: type the setpoint');
  }
  return setpointOf(room.therm_setpoint_temperature);
}

/**
 * The room form was sent: setroomthermpoint on the room — a manual setpoint,
 * a boost (`max`), back to the schedule (`home`) or off — for the chosen
 * duration. A boost keeps Netatmo's own boost duration for "Netatmo default"
 * and "No end" (a boost without end would heat at full power for weeks).
 */
async function roomSetpointAction(ctx, { params, values }) {
  const { client, refresh, telemetry, now = Date.now } = ctx;
  const homeId = params?.home_id;
  if (!homeId) {
    throw new Error(`Unknown widget action: ${ROOM_SETPOINT_ACTION}`);
  }
  const roomId = values?.room_id;
  if (typeof roomId !== 'string' || roomId === '') {
    throw new Error(TEXTS.updateGladys.en);
  }
  const home = telemetry?.getHomes().find((entry) => entry.id === homeId);
  const room = home?.rooms?.find((entry) => entry.id === roomId);
  if (home && !room) {
    throw new Error(`Unknown room ${roomId} for the Netatmo home ${home.name}`);
  }
  const command = values.command ?? ROOM_COMMANDS.SETPOINT;
  if (!Object.values(ROOM_COMMANDS).includes(command)) {
    throw new Error(`Unknown room command "${command}"`);
  }
  const duration = normalizeSetpointDuration(values.duration ?? ctx.config?.setpoint_duration);
  const timing =
    command === ROOM_COMMANDS.SCHEDULE ||
    (command === ROOM_COMMANDS.BOOST &&
      [SETPOINT_DURATIONS.DEFAULT, SETPOINT_DURATIONS.NO_END].includes(duration))
      ? {}
      : endtimeForDuration(duration, { home, roomId, now });
  const setpoint = { homeId, roomId, ...timing, now };
  if (command === ROOM_COMMANDS.SETPOINT) {
    setpoint.mode = NETATMO_SETPOINT_MODES.MANUAL;
    setpoint.temp = typedSetpointOf(values, room);
  } else {
    setpoint.mode = {
      [ROOM_COMMANDS.BOOST]: NETATMO_SETPOINT_MODES.MAX,
      [ROOM_COMMANDS.SCHEDULE]: NETATMO_SETPOINT_MODES.HOME,
      [ROOM_COMMANDS.OFF]: NETATMO_SETPOINT_MODES.OFF,
    }[command];
  }
  logger.info(`Widget action: room ${roomId} of ${homeId} -> ${command} (${duration})`);
  try {
    await sendRoomThermpoint(client, setpoint);
  } catch (err) {
    rethrowScopeError(err);
  }
  refreshSoon(refresh, 'room setpoint');
  const timed = timing.endtime !== undefined || timing.noEnd;
  return roomDone(room?.name ?? roomId, command, setpoint.temp, timed ? duration : undefined);
}

async function heatingAction(ctx, { actionKey, params, values }) {
  if (actionKey === SWITCH_SCHEDULE_ACTION) {
    return switchScheduleAction(ctx, { params, values });
  }
  if (actionKey === ROOM_SETPOINT_ACTION) {
    return roomSetpointAction(ctx, { params, values });
  }
  const { client, refresh } = ctx;
  const mode = params?.mode;
  if (actionKey !== `mode_${mode}` || !THERM_MODE_LABELS[mode] || !params?.home_id) {
    throw new Error(`Unknown widget action: ${actionKey}`);
  }
  logger.info(`Widget action: heating mode of ${params.home_id} -> ${mode}`);
  await setHomeThermMode(client, params.home_id, mode);
  refreshSoon(refresh, 'heating mode');
  return modeSet(mode);
}

/** The refresh after a command: not awaited (it costs a full account load). */
function refreshSoon(refresh, what) {
  if (refresh) {
    Promise.resolve()
      .then(refresh)
      .catch((err) => logger.warn(`Refresh after the ${what} change failed: ${err.message}`));
  }
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
// {gladys, client, telemetry, config, refresh} (config: the room form duration).
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
