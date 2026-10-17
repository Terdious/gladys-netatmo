// -----------------------------------------------------------------------------
// Netatmo device loading (raw devices, before conversion to Gladys payloads).
//
// Port of the core `loadDevices` / `loadDeviceDetails` / `loadThermostatDetails`
// / `loadWeatherStationDetails` orchestration (with the core PR #2620
// behaviour: modules referenced in homesdata but absent from the homestatus
// `modules` array — e.g. powered-off devices reported in the `errors` array —
// are rebuilt from homesdata with `reachable: false` so they can still be
// discovered and saved).
//
// Four API families, gated by the manifest toggles:
//   - Home topology: homesdata + per-home homestatus (concurrency 2) — the
//     Energy modules, the cameras, and the current Weather measures too;
//   - Energy legacy: getthermostatsdata, merged by id/_id (adds
//     `modules_bridged` on plugs and richer thermostat data);
//   - Weather: getstationsdata, merged the same way (dashboard_data etc.);
//   - Aircare: gethomecoachsdata (Home Coach air quality monitors, issue #37),
//     merged the same way.
// The legacy APIs use `_id` while homesdata/homestatus use `id`: every lookup
// goes through `id || _id`, like the core.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import {
  SUPPORTED_MODULE_TYPE,
  SUPPORTED_CATEGORY_TYPE,
  ENERGY_MODULE_TYPES,
  HEATED_ROOM_MODULE_TYPES,
  WEATHER_MODULE_TYPES,
  SECURITY_MODULE_TYPES,
  SHUTTER_MODULE_TYPES,
  AIRCARE_MODULE_TYPES,
  BTICINO_MODULE_TYPES,
  BTICINO_GATEWAY_TYPES,
  BTICINO_BRIDGED_MODULE_TYPES,
  LEGRAND_MODULE_TYPES,
  HOMES_CONCURRENCY,
  HEATING_SCHEDULE_TYPE,
  VIRTUAL_DEVICE_TYPE,
  KNOWN_PERSONS_ID_PREFIX,
} from './constants.js';
import { bticinoEntriesOf } from './bticino.js';
import { resolveLegrandReachability } from './legrand.js';

const logger = createLogger({ name: 'netatmo-discovery' });

/** Stable id of a Netatmo payload (homesdata uses `id`, legacy APIs `_id`). */
export function netatmoId(payload) {
  return payload?.id ?? payload?._id;
}

/**
 * Resolve support flag and API category of a Netatmo module type
 * (port of the core `getModuleCategory`).
 * @param {string} model Netatmo module type
 * @param {object} config normalized integration config
 * @returns {{moduleSupported: boolean, categoryAPI: string, apiNotConfigured: boolean}}
 */
export function getModuleCategory(model, config) {
  if (ENERGY_MODULE_TYPES.includes(model)) {
    return {
      moduleSupported: true,
      categoryAPI: SUPPORTED_CATEGORY_TYPE.ENERGY,
      apiNotConfigured: !config.energy_api,
    };
  }
  if (WEATHER_MODULE_TYPES.includes(model)) {
    return {
      moduleSupported: true,
      categoryAPI: SUPPORTED_CATEGORY_TYPE.WEATHER,
      apiNotConfigured: !config.weather_api,
    };
  }
  if (SECURITY_MODULE_TYPES.includes(model)) {
    return {
      moduleSupported: true,
      categoryAPI: SUPPORTED_CATEGORY_TYPE.SECURITY,
      apiNotConfigured: !config.security_api,
    };
  }
  if (AIRCARE_MODULE_TYPES.includes(model)) {
    return {
      moduleSupported: true,
      categoryAPI: SUPPORTED_CATEGORY_TYPE.AIRCARE,
      apiNotConfigured: !config.aircare_api,
    };
  }
  if (SHUTTER_MODULE_TYPES.includes(model)) {
    return {
      moduleSupported: true,
      categoryAPI: SUPPORTED_CATEGORY_TYPE.SHUTTER,
      apiNotConfigured: !config.shutter_api,
    };
  }
  if (BTICINO_MODULE_TYPES.includes(model)) {
    return {
      moduleSupported: true,
      categoryAPI: SUPPORTED_CATEGORY_TYPE.BTICINO,
      apiNotConfigured: !config.bticino_api,
    };
  }
  if (LEGRAND_MODULE_TYPES.includes(model)) {
    return {
      moduleSupported: true,
      categoryAPI: SUPPORTED_CATEGORY_TYPE.LEGRAND,
      apiNotConfigured: !config.legrand_api,
    };
  }
  return {
    moduleSupported: false,
    categoryAPI: SUPPORTED_CATEGORY_TYPE.UNKNOWN,
    apiNotConfigured: false,
  };
}

/** Map with a bounded number of in-flight promises (core used bluebird). */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Detail one home through /homestatus: merge homesdata + homestatus per
 * module, rebuild the modules missing from homestatus (unreachable), and add
 * the virtual device of the home's known persons (issue #57).
 * @param {object} client Netatmo API client
 * @param {object} config normalized integration config
 * @param {object} homeData one entry of the homesdata `homes` array
 * @param {Array} [bticinoDiagnostics] when given (BTicino toggle on), receives
 *   the raw homesdata / homestatus entries of the home's BTicino modules
 *   (issue #59 diagnostic log)
 * @param {Array} [rawHomes] when given, receives the raw homesdata /
 *   homestatus entries of EVERY module of the home, as Netatmo sent them (the
 *   "Device diagnostic" action)
 * @returns {Promise<Array>} raw devices of the home
 */
export async function loadDeviceDetails(client, config, homeData, bticinoDiagnostics, rawHomes) {
  const { rooms: roomsHomeData = [], modules: modulesHomeData = [], id: homeId } = homeData;
  const { home, errors } = await client.getHomeStatus(homeId);
  if (!home) {
    // null (not []) so the caller can tell "home unavailable" from "no
    // modules" and flag the load as partial.
    logger.warn(`homestatus of home ${homeId} unavailable — skipping`);
    return null;
  }
  const { rooms: roomsHomestatus = [], modules: modulesHomestatus = [] } = home;
  if (rawHomes) {
    rawHomes.push({
      id: homeId,
      name: homeData.name || homeId,
      homesdata: modulesHomeData,
      homestatus: modulesHomestatus,
      errors: Array.isArray(errors) ? errors : [],
    });
  }
  if (bticinoDiagnostics) {
    // Raw entries, BEFORE any merge: the diagnostic log must show exactly
    // what Netatmo sent for each source.
    const entries = bticinoEntriesOf(homeId, modulesHomeData, modulesHomestatus, errors);
    if (entries) {
      bticinoDiagnostics.push(entries);
    }
  }
  // Heating mode of the home (issue #38): live in homestatus, also carried by
  // homesdata (topology snapshot) — kept on every device of the home so the
  // declarative mapping can read it like any other value.
  const thermMode = home.therm_mode ?? homeData.therm_mode;
  const thermModeEndtime = home.therm_mode_endtime ?? homeData.therm_mode_endtime;

  function buildDevice(module, moduleHomeData, extra = {}) {
    const { moduleSupported, categoryAPI, apiNotConfigured } = getModuleCategory(
      module.type,
      config,
    );
    const roomDevice = {
      ...roomsHomeData.find((room) => room.id === moduleHomeData?.room_id),
      ...roomsHomestatus.find((room) => room.id === moduleHomeData?.room_id),
    };
    const plugDevice = {
      ...modulesHomeData.find((mod) => mod.id === module.bridge),
      ...modulesHomestatus.find((mod) => mod.id === module.bridge),
    };
    const device = {
      ...module,
      ...moduleHomeData,
      // Legrand (issue #60): the live state is homestatus' — a homesdata
      // entry carrying `on` / `brightness` too (pyatmo fixture) never hides it.
      ...(LEGRAND_MODULE_TYPES.includes(module.type) && module !== moduleHomeData ? module : {}),
      home: homeId,
      room: Object.keys(roomDevice).length === 0 ? {} : roomDevice,
      plug: Object.keys(plugDevice).length === 0 ? undefined : plugDevice,
      categoryAPI,
      apiNotConfigured,
      therm_mode: thermMode,
      therm_mode_endtime: thermModeEndtime,
      ...extra,
    };
    return moduleSupported ? device : { ...device, not_handled: true };
  }

  // `homestatus: true` marks the modules whose current values came with this
  // homestatus: a Weather module keeps fresh measures from it even when
  // getstationsdata fails (issue #33).
  const reachableDevices = modulesHomestatus.map((module) =>
    buildDevice(
      module,
      modulesHomeData.find((mod) => mod.id === module.id),
      { homestatus: true },
    ),
  );

  // Core PR #2620: modules referenced in homesdata but absent from the
  // homestatus `modules` array (powered off → `errors` array) are rebuilt from
  // homesdata so they can still be discovered and saved.
  const unreachableDevices = modulesHomeData
    .filter(
      (moduleHomeData) => !modulesHomestatus.some((module) => module.id === moduleHomeData.id),
    )
    .map((moduleHomeData) => {
      const moduleError = errors.find((error) => error.id === moduleHomeData.id);
      return buildDevice(moduleHomeData, moduleHomeData, {
        reachable: false,
        apiErrorCode: moduleError ? moduleError.code : undefined,
      });
    });

  const knownPersons = buildKnownPersonsDevice(config, homeData, home);
  // Legrand (issue #60): the gangs of a double switch follow their parent's
  // reachability, the modules of an unreachable gateway are unreachable.
  return [
    ...groupBticinoModules(
      markRoomThermostats(resolveLegrandReachability([...reachableDevices, ...unreachableDevices])),
    ),
    ...(knownPersons ? [knownPersons] : []),
  ];
}

// Thermostats first: in a room with a thermostat and valves, the room's
// thermostat features ride on the thermostat.
const ROOM_THERMOSTAT_PRIORITY = [
  SUPPORTED_MODULE_TYPE.THERMOSTAT,
  SUPPORTED_MODULE_TYPE.OTM,
  SUPPORTED_MODULE_TYPE.BNS,
  SUPPORTED_MODULE_TYPE.NRV,
];

/**
 * Elect ONE device per heated room to carry the room's thermostat features
 * (issue #77: heating state, mode, window — the Gladys Thermostat widget),
 * flagged `room_thermostat: true`: the room's thermostat (NATherm1, modulating
 * OTM, Smarther BNS), else one of its valves (NRV). Ties go to the smallest
 * Netatmo id, so the choice stays the same from one load to the next — the
 * powered-off modules rebuilt from homesdata take part, so a valve going
 * offline does not move the features to another device.
 * @param {Array} devices raw devices of one home
 * @returns {Array} the same devices, the elected ones flagged
 */
export function markRoomThermostats(devices) {
  const elected = new Map();
  const rank = (device) => ROOM_THERMOSTAT_PRIORITY.indexOf(device.type);
  for (const device of devices) {
    const roomId = device.room?.id;
    if (!roomId || !HEATED_ROOM_MODULE_TYPES.includes(device.type) || !netatmoId(device)) {
      continue;
    }
    const current = elected.get(roomId);
    const better =
      !current ||
      rank(device) < rank(current) ||
      (rank(device) === rank(current) && String(netatmoId(device)) < String(netatmoId(current)));
    if (better) {
      elected.set(roomId, device);
    }
  }
  const carriers = new Set(elected.values());
  return devices.map((device) =>
    carriers.has(device) ? { ...device, room_thermostat: true } : device,
  );
}

/**
 * One Gladys device per BTicino door entry (issue #59): every module bridged
 * by a BNCX of the same home (street panel, door lock, staircase light,
 * controlled socket, X module) leaves the device list and rides on its
 * gateway, in `grouped_modules` — the gateway's conversion adds their
 * features, keyed by their own ids. A bridged module whose gateway is not in
 * the list stays a device of its own (published only if it has features).
 * @param {Array} devices raw devices of one home
 * @returns {Array} the devices, bridged BTicino modules grouped
 */
export function groupBticinoModules(devices) {
  const gateways = new Map(
    devices
      .filter((device) => BTICINO_GATEWAY_TYPES.includes(device.type) && netatmoId(device))
      .map((device) => [netatmoId(device), device]),
  );
  if (gateways.size === 0) {
    return devices;
  }
  const grouped = new Map();
  const kept = [];
  for (const device of devices) {
    const gateway =
      BTICINO_BRIDGED_MODULE_TYPES.includes(device.type) && typeof device.bridge === 'string'
        ? gateways.get(device.bridge)
        : undefined;
    if (gateway) {
      const modules = grouped.get(gateway) ?? [];
      modules.push(device);
      grouped.set(gateway, modules);
    } else {
      kept.push(device);
    }
  }
  return kept.map((device) =>
    grouped.has(device) ? { ...device, grouped_modules: grouped.get(device) } : device,
  );
}

/**
 * Virtual device of the persons known to the cameras of a home (issue #57):
 * the NAMED persons of homesdata (`pseudo` — an unrecognized face is stored
 * without one), each with its homestatus presence (`out_of_sight`: true =
 * away). A person homestatus does not report keeps `out_of_sight` undefined:
 * nothing is published for it. Gated by the Security toggle (the faces come
 * from the cameras) through `apiNotConfigured`, like the camera modules.
 * @param {object} config normalized integration config
 * @param {object} homeData one entry of the homesdata `homes` array
 * @param {object} homeStatus the homestatus `home` of the same home
 * @returns {object|null} raw device, null when the home has no named person
 */
export function buildKnownPersonsDevice(config, homeData, homeStatus = {}) {
  const statuses = new Map(
    (homeStatus.persons ?? [])
      .filter((person) => person && typeof person.id === 'string')
      .map((person) => [person.id, person]),
  );
  const persons = (homeData.persons ?? [])
    .filter(
      (person) =>
        person &&
        typeof person.id === 'string' &&
        typeof person.pseudo === 'string' &&
        person.pseudo.trim() !== '',
    )
    .map((person) => ({
      id: person.id,
      pseudo: person.pseudo.trim(),
      out_of_sight: statuses.get(person.id)?.out_of_sight,
      last_seen: statuses.get(person.id)?.last_seen,
    }));
  if (persons.length === 0) {
    return null;
  }
  return {
    id: `${KNOWN_PERSONS_ID_PREFIX}${homeData.id}`,
    type: VIRTUAL_DEVICE_TYPE.KNOWN_PERSONS,
    name: `${homeData.name || homeData.id} - Known persons`,
    home: homeData.id,
    persons,
    categoryAPI: SUPPORTED_CATEGORY_TYPE.SECURITY,
    apiNotConfigured: !config.security_api,
    homestatus: true,
  };
}

/**
 * Legacy Energy details: relay plugs + their thermostat modules
 * (port of the core `loadThermostatDetails`).
 * @param {object} client Netatmo API client
 * @param {object} config normalized integration config
 * @returns {Promise<{plugs: Array, thermostats: Array}>} legacy devices
 */
export async function loadThermostatDetails(client, config) {
  const plugs = await client.getThermostatsData();
  const thermostats = [];
  for (const plug of plugs) {
    plug.apiNotConfigured = !config.energy_api;
    plug.categoryAPI = SUPPORTED_CATEGORY_TYPE.ENERGY;
    for (const module of plug.modules ?? []) {
      const { modules: _modules, ...rest } = plug;
      module.plug = rest;
      module.apiNotConfigured = !config.energy_api;
      module.categoryAPI = SUPPORTED_CATEGORY_TYPE.ENERGY;
      thermostats.push(module);
    }
  }
  return { plugs, thermostats };
}

/**
 * Weather stations + their modules (port of the core
 * `loadWeatherStationDetails`).
 * @param {object} client Netatmo API client
 * @param {object} config normalized integration config
 * @returns {Promise<{weatherStations: Array, modulesWeatherStations: Array}>} stations
 */
export async function loadWeatherStationDetails(client, config) {
  const weatherStations = await client.getStationsData();
  const modulesWeatherStations = [];
  for (const station of weatherStations) {
    station.apiNotConfigured = !config.weather_api;
    station.categoryAPI = SUPPORTED_CATEGORY_TYPE.WEATHER;
    for (const module of station.modules ?? []) {
      const { modules: _modules, ...rest } = station;
      module.plug = rest;
      module.home_id = station.home_id;
      module.apiNotConfigured = !config.weather_api;
      module.categoryAPI = SUPPORTED_CATEGORY_TYPE.WEATHER;
      modulesWeatherStations.push(module);
    }
  }
  return { weatherStations, modulesWeatherStations };
}

/**
 * Home Coach / Smart Indoor Air Quality Monitors (issue #37). Standalone wifi
 * devices: no modules, no home_id in this legacy payload.
 * @param {object} client Netatmo API client
 * @param {object} config normalized integration config
 * @returns {Promise<Array>} Home Coach devices
 */
export async function loadHomeCoachDetails(client, config) {
  const homeCoachs = await client.getHomeCoachsData();
  for (const homeCoach of homeCoachs) {
    homeCoach.apiNotConfigured = !config.aircare_api;
    homeCoach.categoryAPI = SUPPORTED_CATEGORY_TYPE.AIRCARE;
  }
  return homeCoachs;
}

/** Netatmo 403 "scope rights" refusal (error code 13), see client.js. */
function isScopeRefusal(err) {
  return err?.status === 403 && err?.body?.error?.code === 13;
}

/**
 * The heating schedules of a homesdata home (issue #58), in the Netatmo order:
 * `type: "therm"` — or no type at all, the shape of the accounts that only
 * know heating schedules — never the cooling / electricity / event ones.
 * @param {object} homeData one entry of the homesdata `homes` array
 * @returns {Array<{id: string, name: string, selected: boolean}>} the schedules
 */
export function heatingSchedulesOf(homeData) {
  return (homeData.schedules ?? [])
    .filter(
      (schedule) =>
        schedule &&
        typeof schedule.id === 'string' &&
        (schedule.type === undefined || schedule.type === HEATING_SCHEDULE_TYPE),
    )
    .map((schedule) => ({
      id: schedule.id,
      name: schedule.name || schedule.id,
      selected: schedule.selected === true,
    }));
}

/**
 * Summary of one homesdata home for the features that are not device states
 * (issue #39 scene triggers and actions, issue #40 widgets): its name, its
 * known persons (face recognition, homesdata `persons`), its modules, its
 * heated rooms, its heating schedules (issue #58) and its heating mode — live
 * from homestatus through the home's devices, homesdata snapshot otherwise.
 * @param {object} homeData one entry of the homesdata `homes` array
 * @param {Array} devices raw devices loaded for this home
 * @returns {{id: string, name: string, persons: Array<{id: string, pseudo: string}>,
 *   modules: Array<{id: string, name: string, type: string, bridge?: string}>,
 *   rooms: Array<object>,
 *   schedules: Array<{id: string, name: string, selected: boolean}>,
 *   therm_mode: string|undefined, therm_mode_endtime: number|undefined}} the home summary
 */
export function summarizeHome(homeData, devices = []) {
  const withMode = devices.find((device) => device.therm_mode !== undefined);
  // Heated rooms (issue #40 heating widget): the rooms of the thermostats
  // (NATherm1, modulating OTM, Smarther BNS) and valves, with their live
  // homestatus values, once per room.
  const rooms = new Map();
  for (const device of devices) {
    const room = device.room ?? {};
    const heated = HEATED_ROOM_MODULE_TYPES.includes(device.type);
    if (heated && room.id && !rooms.has(room.id)) {
      rooms.set(room.id, {
        id: room.id,
        name: room.name || room.id,
        therm_measured_temperature: room.therm_measured_temperature,
        therm_setpoint_temperature: room.therm_setpoint_temperature,
        heating_power_request: room.heating_power_request,
        open_window: room.open_window,
        // Where the setpoint comes from (issue #58): `schedule`, `manual`,
        // `max` (boost), or the home mode (`away`, `hg`, `off`), and until when.
        therm_setpoint_mode: room.therm_setpoint_mode,
        therm_setpoint_end_time: room.therm_setpoint_end_time,
      });
    }
  }
  return {
    id: homeData.id,
    name: homeData.name || homeData.id,
    persons: (homeData.persons ?? [])
      .filter((person) => person && typeof person.id === 'string')
      .map((person) => ({ id: person.id, pseudo: person.pseudo })),
    modules: (homeData.modules ?? []).map((module) => ({
      id: module.id,
      name: module.name,
      type: module.type,
      bridge: module.bridge,
    })),
    rooms: [...rooms.values()],
    schedules: heatingSchedulesOf(homeData),
    therm_mode: withMode ? withMode.therm_mode : homeData.therm_mode,
    therm_mode_endtime: withMode ? withMode.therm_mode_endtime : homeData.therm_mode_endtime,
  };
}

/**
 * Load every raw Netatmo device, merging the API families
 * (port of the core `loadDevices`).
 * @param {object} client Netatmo API client
 * @param {object} config normalized integration config
 * @returns {Promise<Array>} raw devices
 */
export async function loadDevices(client, config) {
  const { devices } = await loadAccount(client, config);
  return devices;
}

/**
 * Same load, with a `partial` flag: true when any API family failed (or a
 * home's status was unavailable). A partial load must never REPLACE the
 * published discovery list — devices would vanish from the Discovery screen
 * for the duration of a Netatmo hiccup. `failed` names the families that
 * failed: `homes` (homesdata/homestatus), `energy` (getthermostatsdata),
 * `weather` (getstationsdata), `aircare` (gethomecoachsdata).
 * With the BTicino toggle on, `bticino` carries the raw BTicino module
 * entries of every home whose homestatus loaded (issue #59 diagnostic log).
 * `rawHomes` carries the raw homesdata / homestatus entries of every home
 * whose homestatus loaded (the "Device diagnostic" action).
 * @param {object} client Netatmo API client
 * @param {object} config normalized integration config
 * @returns {Promise<{devices: Array, partial: boolean, failed: string[], homes: Array,
 *   rawHomes: Array, bticino?: Array}>} raw devices + flags + the homesdata
 *   homes summaries (see summarizeHome) + the raw entries per home + the
 *   BTicino diagnostic entries
 */
export async function loadAccount(client, config) {
  let listDevices = [];
  const failed = [];
  let homeSummaries = [];
  const bticinoDiagnostics = config.bticino_api ? [] : undefined;
  const rawHomes = [];

  // Cameras and roller shutters ride in the same homesdata/homestatus payloads
  // as the Energy modules (no dedicated API call), and homestatus carries the
  // current Weather measures as well: the topology load runs whenever any
  // family is enabled, so a getstationsdata outage no longer freezes the
  // station values (issue #33). NOTE — divergence from the core `loadDevices`
  // gating, on purpose: the core treats "no API configured at all" as "load
  // everything" (its variables may simply be unset); the manifest toggles are
  // always defined with sensible defaults, so here OFF means OFF.
  if (
    config.energy_api ||
    config.security_api ||
    config.weather_api ||
    config.shutter_api ||
    config.bticino_api ||
    config.legrand_api
  ) {
    try {
      const homes = await client.getHomesData();
      const results = await mapWithConcurrency(homes, HOMES_CONCURRENCY, async (home) =>
        home.modules && home.modules.length > 0
          ? loadDeviceDetails(client, config, home, bticinoDiagnostics, rawHomes)
          : [],
      );
      if (results.includes(null)) {
        failed.push('homes');
      }
      homeSummaries = homes.map((home, index) => summarizeHome(home, results[index] ?? []));
      listDevices = results.filter(Boolean).flat();
    } catch (err) {
      failed.push('homes');
      logger.error(`homesdata load failed: ${err.message}`);
    }
  }

  if (config.energy_api) {
    try {
      const { plugs, thermostats } = await loadThermostatDetails(client, config);
      if (listDevices.length > 0) {
        // Merge the legacy Energy properties into the homesdata devices.
        listDevices = listDevices.map((device) => {
          let merged = device;
          const id = netatmoId(device);
          const plugEnergy = plugs.find((plug) => plug._id === id);
          const thermostat = thermostats.find((t) => t._id === id);
          if (plugEnergy) {
            merged = { ...merged, ...plugEnergy };
          }
          if (thermostat) {
            const plugThermostat = plugs
              .map(({ modules: _modules, ...rest }) => rest)
              .find((plug) => plug._id === merged.bridge);
            merged = { ...merged, ...thermostat, plug: { ...merged.plug, ...plugThermostat } };
          }
          return merged;
        });
        // Then add the plugs/thermostats living in a home unknown to homesdata.
        listDevices = [
          ...listDevices,
          ...plugs.filter((plug) => !listDevices.some((device) => netatmoId(device) === plug._id)),
          ...thermostats.filter((t) => !listDevices.some((device) => netatmoId(device) === t._id)),
        ];
      } else {
        listDevices = [...plugs, ...thermostats];
      }
      for (const plug of listDevices.filter(
        (device) => device.type === SUPPORTED_MODULE_TYPE.PLUG,
      )) {
        if (!plug.modules_bridged) {
          plug.modules_bridged = (plug.modules ?? []).map((module) => netatmoId(module));
        }
      }
    } catch (err) {
      failed.push('energy');
      logger.error(`getthermostatsdata load failed: ${err.message}`);
    }
  }

  if (config.weather_api) {
    try {
      const { weatherStations, modulesWeatherStations } = await loadWeatherStationDetails(
        client,
        config,
      );
      if (listDevices.length > 0) {
        listDevices = listDevices.map((device) => {
          const id = netatmoId(device);
          const weatherStation = weatherStations.find((station) => station._id === id);
          if (weatherStation) {
            return { ...device, ...weatherStation };
          }
          const moduleWeatherStation = modulesWeatherStations.find((mod) => mod._id === id);
          if (moduleWeatherStation) {
            const plugModuleWeatherStation = weatherStations
              .map(({ modules: _modules, ...rest }) => rest)
              .find((station) => station._id === device.bridge);
            return {
              ...device,
              ...moduleWeatherStation,
              plug: { ...device.plug, ...plugModuleWeatherStation },
            };
          }
          return device;
        });
        listDevices = [
          ...listDevices,
          ...weatherStations.filter(
            (station) => !listDevices.some((device) => netatmoId(device) === station._id),
          ),
          ...modulesWeatherStations.filter(
            (mod) => !listDevices.some((device) => netatmoId(device) === mod._id),
          ),
        ];
      } else {
        listDevices = [...weatherStations, ...modulesWeatherStations];
      }
      for (const station of listDevices.filter(
        (device) => device.type === SUPPORTED_MODULE_TYPE.NAMAIN,
      )) {
        if (!station.modules_bridged) {
          station.modules_bridged = (station.modules ?? []).map((module) => netatmoId(module));
        }
      }
    } catch (err) {
      failed.push('weather');
      logger.error(`getstationsdata load failed: ${err.message}`);
    }
  }

  if (config.aircare_api) {
    try {
      const homeCoachs = await loadHomeCoachDetails(client, config);
      // Merged by id like the Weather family, should a Home Coach ever ride in
      // the homesdata topology too; otherwise appended.
      listDevices = listDevices.map((device) => {
        const homeCoach = homeCoachs.find((coach) => coach._id === netatmoId(device));
        return homeCoach ? { ...device, ...homeCoach } : device;
      });
      listDevices = [
        ...listDevices,
        ...homeCoachs.filter(
          (coach) => !listDevices.some((device) => netatmoId(device) === coach._id),
        ),
      ];
    } catch (err) {
      if (isScopeRefusal(err)) {
        // A missing read_homecoach right is durable, not a hiccup: flagging
        // the load partial would freeze the discovery list of EVERY family
        // until the user reconnects. Report it and go on without Home Coach.
        logger.warn(
          'gethomecoachsdata refused (missing read_homecoach scope rights) — reconnect your Netatmo account to discover the Home Coach devices',
        );
      } else {
        failed.push('aircare');
        logger.error(`gethomecoachsdata load failed: ${err.message}`);
      }
    }
  }

  logger.debug(`${listDevices.length} Netatmo devices loaded`);
  const notHandled = listDevices.filter((device) => device.not_handled).length;
  if (notHandled > 0) {
    // Info-level reporting on CHANGE lives in the telemetry afterLoad hook:
    // logging it here would repeat the same line every 120s cycle.
    logger.debug(`Netatmo devices not supported: ${notHandled}`);
  }
  return {
    devices: listDevices,
    partial: failed.length > 0,
    failed,
    homes: homeSummaries,
    rawHomes,
    ...(bticinoDiagnostics ? { bticino: bticinoDiagnostics } : {}),
  };
}
