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
// Three API families, gated by the manifest toggles:
//   - Energy topology: homesdata + per-home homestatus (concurrency 2);
//   - Energy legacy: getthermostatsdata, merged by id/_id (adds
//     `modules_bridged` on plugs and richer thermostat data);
//   - Weather: getstationsdata, merged the same way (dashboard_data etc.).
// The legacy APIs use `_id` while homesdata/homestatus use `id`: every lookup
// goes through `id || _id`, like the core.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import {
  SUPPORTED_MODULE_TYPE,
  SUPPORTED_CATEGORY_TYPE,
  ENERGY_MODULE_TYPES,
  WEATHER_MODULE_TYPES,
  SECURITY_MODULE_TYPES,
  HOMES_CONCURRENCY,
} from './constants.js';

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
 * module, and rebuild the modules missing from homestatus (unreachable).
 * @param {object} client Netatmo API client
 * @param {object} config normalized integration config
 * @param {object} homeData one entry of the homesdata `homes` array
 * @returns {Promise<Array>} raw devices of the home
 */
export async function loadDeviceDetails(client, config, homeData) {
  const { rooms: roomsHomeData = [], modules: modulesHomeData = [], id: homeId } = homeData;
  const { home, errors } = await client.getHomeStatus(homeId);
  if (!home) {
    logger.warn(`homestatus of home ${homeId} unavailable — skipping`);
    return [];
  }
  const { rooms: roomsHomestatus = [], modules: modulesHomestatus = [] } = home;

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
      home: homeId,
      room: Object.keys(roomDevice).length === 0 ? {} : roomDevice,
      plug: Object.keys(plugDevice).length === 0 ? undefined : plugDevice,
      categoryAPI,
      apiNotConfigured,
      ...extra,
    };
    return moduleSupported ? device : { ...device, not_handled: true };
  }

  const reachableDevices = modulesHomestatus.map((module) =>
    buildDevice(
      module,
      modulesHomeData.find((mod) => mod.id === module.id),
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

  return [...reachableDevices, ...unreachableDevices];
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
 * Load every raw Netatmo device, merging the three API families
 * (port of the core `loadDevices`).
 * @param {object} client Netatmo API client
 * @param {object} config normalized integration config
 * @returns {Promise<Array>} raw devices
 */
export async function loadDevices(client, config) {
  let listDevices = [];

  // Cameras ride in the same homesdata/homestatus payloads as the Energy
  // modules (no dedicated API call), so the topology load also runs when only
  // the Security API is enabled.
  if (config.energy_api || config.security_api) {
    try {
      const homes = await client.getHomesData();
      const results = await mapWithConcurrency(homes, HOMES_CONCURRENCY, async (home) =>
        home.modules && home.modules.length > 0 ? loadDeviceDetails(client, config, home) : [],
      );
      listDevices = results.flat();
    } catch (err) {
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
      logger.error(`getstationsdata load failed: ${err.message}`);
    }
  }

  logger.debug(`${listDevices.length} Netatmo devices loaded`);
  const notHandled = listDevices.filter((device) => device.not_handled).length;
  if (notHandled > 0) {
    logger.info(`Netatmo devices not supported: ${notHandled}`);
  }
  return listDevices;
}
