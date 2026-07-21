// -----------------------------------------------------------------------------
// Telemetry engine: discovery sync + the global 120s value refresh loop.
//
// The core service refreshes ALL devices with one batched load every 120s
// (`pollRefreshingValues`); this engine keeps that design — devices are
// created with should_poll:false and the whole account costs 3-4 API calls
// per cycle, which matters against the Netatmo rate limits.
//
// State emission follows the declarative UPDATE_MAPPINGS table (core PR
// #2619): suffix by suffix, in key order, skipping absent values (core PR
// #2617 — zeros are values, undefined/null are not), transformed through
// `readValues` by feature category/type.
//
// On top of the core behaviour:
//   - a value unchanged since the last publish is skipped, with a 30-minute
//     keep-alive re-publish (the state history is not flooded every cycle);
//   - the per-device transport badge is published: `cloud` when reachable,
//     `unreachable` for the modules rebuilt from the homestatus errors array
//     (core PR #2620 surfaced as a badge instead of a raw param).
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';

import {
  REFRESH_VALUES_INTERVAL_MS,
  STATE_KEEP_ALIVE_MS,
  MAX_ENTRIES_PER_REQUEST,
  SECURITY_MODULE_TYPES,
} from './constants.js';
import { loadDevices, netatmoId } from './discovery.js';
import { convertDevice } from './convert.js';
import { UPDATE_MAPPINGS } from './updateMappings.js';
import { readValues } from './deviceMapping.js';
import { createCameraImages } from './camera.js';

const logger = createLogger({ name: 'netatmo-telemetry' });

/**
 * Create the telemetry engine.
 * @param {object} deps dependencies
 * @param {object} deps.gladys SDK instance
 * @param {object} deps.client Netatmo API client
 * @param {() => number} [deps.now] clock (tests)
 * @param {number} [deps.refreshIntervalMs] loop cadence override (tests)
 */
export function createTelemetry({
  gladys,
  client,
  now = Date.now,
  refreshIntervalMs = REFRESH_VALUES_INTERVAL_MS,
  fetchImpl = fetch,
}) {
  // Last published value per feature external_id: {state, at}.
  const published = new Map();
  let refreshTimer = null;
  let refreshInFlight = null;

  const cameras = createCameraImages({ fetchImpl });
  // Last raw Netatmo payload per camera id (vpn_url, is_local...), refreshed
  // by every load — the on-demand snapshot handler reads from here instead of
  // paying a full account load per image request.
  const rawCamerasById = new Map();

  function rememberRawCameras(rawDevices) {
    for (const rawDevice of rawDevices) {
      const id = netatmoId(rawDevice);
      if (id && SECURITY_MODULE_TYPES.includes(rawDevice.type) && !rawDevice.apiNotConfigured) {
        rawCamerasById.set(id, rawDevice);
      }
    }
  }

  /** Forget the dedup memory so the next refresh re-publishes every value. */
  function resetDedup() {
    published.clear();
  }

  /** Publish in chunks, respecting the per-request cap of the host API. */
  async function publishStatesChunked(states) {
    for (let i = 0; i < states.length; i += MAX_ENTRIES_PER_REQUEST) {
      await gladys.publishStates(states.slice(i, i + MAX_ENTRIES_PER_REQUEST));
    }
  }

  /**
   * Build the states of one device from the declarative mapping.
   * @param {object} gladysDevice the device as known by Gladys (features)
   * @param {object} rawDevice the raw Netatmo device of this cycle
   * @returns {Array<{device_feature_external_id: string, state: number}>} states
   */
  function buildDeviceStates(gladysDevice, rawDevice) {
    const mapping = UPDATE_MAPPINGS[rawDevice.type];
    if (!mapping) {
      return [];
    }
    const states = [];
    for (const [suffix, extractValue] of Object.entries(mapping)) {
      const featureExternalId = `${gladysDevice.external_id}:${suffix}`;
      const feature = (gladysDevice.features ?? []).find(
        (f) => f.external_id === featureExternalId,
      );
      if (!feature) {
        continue;
      }
      const rawValue = extractValue(rawDevice);
      if (rawValue === undefined || rawValue === null) {
        // No value in this payload: never emit an absent state (core PR #2617).
        continue;
      }
      const transform = readValues[feature.category]?.[feature.type];
      const state = transform ? transform(rawValue) : rawValue;
      if (state === undefined || state === null || Number.isNaN(state)) {
        continue;
      }
      const previous = published.get(featureExternalId);
      if (previous && previous.state === state && now() - previous.at < STATE_KEEP_ALIVE_MS) {
        continue; // unchanged and fresh: dedup
      }
      published.set(featureExternalId, { state, at: now() });
      states.push({ device_feature_external_id: featureExternalId, state });
    }
    return states;
  }

  /** Transport badge of one raw device (unreachable = core PR #2620 rebuild). */
  function transportOf(rawDevice) {
    return rawDevice.reachable === false ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.CLOUD;
  }

  /**
   * Publish the per-device transport badges. Defensive: an older Gladys core
   * without the endpoint must never crash the loop.
   */
  async function publishTransports(rawDevices) {
    const entries = rawDevices
      .filter(
        (rawDevice) =>
          !rawDevice.not_handled && !rawDevice.apiNotConfigured && netatmoId(rawDevice),
      )
      .map((rawDevice) => ({
        external_id: gladys.externalId(netatmoId(rawDevice)),
        transport: transportOf(rawDevice),
      }));
    try {
      for (let i = 0; i < entries.length; i += MAX_ENTRIES_PER_REQUEST) {
        await gladys.publishTransports(entries.slice(i, i + MAX_ENTRIES_PER_REQUEST));
      }
    } catch (err) {
      logger.debug(`publishTransports skipped (older Gladys core?): ${err.message}`);
    }
  }

  /**
   * Discovery pipeline: load every raw device, publish the discovered list
   * and the transport badges.
   * @param {object} config normalized integration config
   * @returns {Promise<Array>} the published Gladys device payloads
   */
  async function syncDiscovery(config) {
    const rawDevices = await loadDevices(client, config);
    rememberRawCameras(rawDevices);
    const devices = rawDevices.map((rawDevice) => convertDevice(gladys, rawDevice)).filter(Boolean);
    await gladys.publishDiscoveredDevices(devices);
    await publishTransports(rawDevices);
    logger.info(`Discovery published ${devices.length} Netatmo device(s)`);
    return devices;
  }

  /**
   * Refresh the dashboard image of every created camera (external counterpart
   * of the core updateCameraImage): snapshot fetched local-first, published
   * through POST /camera/image. Failures are logged and never abort the cycle.
   */
  async function refreshCameraImages() {
    for (const [id, rawDevice] of rawCamerasById) {
      const externalId = gladys.externalId(id);
      const gladysDevice = (gladys.devices ?? []).find(
        (device) => device.external_id === externalId,
      );
      const hasCameraFeature = (gladysDevice?.features ?? []).some(
        (f) => f.external_id === `${externalId}:camera`,
      );
      if (!hasCameraFeature) {
        continue; // not created by the user (yet), or created before the camera feature shipped
      }
      try {
        const image = await cameras.getImage(rawDevice);
        if (image) {
          await gladys.publishCameraImage(externalId, image);
        }
      } catch (err) {
        logger.warn(`Camera image refresh failed for ${id}: ${err.message}`);
      }
    }
  }

  /**
   * On-demand snapshot for the SDK getImage command (user opens the camera
   * in Gladys). Uses the raw camera data of the last load; runs one refresh
   * first when the camera is not known yet (fresh container).
   * @param {object} config normalized integration config
   * @param {object} device the Gladys device of the command
   * @returns {Promise<string>} `image/jpg;base64,...` string
   */
  async function getCameraSnapshot(config, device) {
    const id = device.external_id.replace(gladys.externalId(''), '');
    if (!rawCamerasById.has(id)) {
      await refreshValues(config);
    }
    const rawDevice = rawCamerasById.get(id);
    if (!rawDevice) {
      throw new Error(`Camera ${device.external_id} is unknown to the Netatmo account`);
    }
    const image = await cameras.getImage(rawDevice);
    if (!image) {
      throw new Error(`Camera ${device.external_id} did not return a snapshot`);
    }
    return image;
  }

  /**
   * One refresh cycle (single-flight, like the core refreshNetatmoValues):
   * load every raw device and publish the states of the devices the user
   * created in Gladys.
   * @param {object} config normalized integration config
   * @returns {Promise<number>} number of states published
   */
  function refreshValues(config) {
    if (refreshInFlight) {
      return refreshInFlight;
    }
    refreshInFlight = (async () => {
      const rawDevices = await loadDevices(client, config);
      rememberRawCameras(rawDevices);
      const states = [];
      for (const rawDevice of rawDevices) {
        const id = netatmoId(rawDevice);
        if (!id || rawDevice.not_handled) {
          continue;
        }
        const externalId = gladys.externalId(id);
        const gladysDevice = (gladys.devices ?? []).find(
          (device) => device.external_id === externalId,
        );
        if (!gladysDevice) {
          continue; // not created by the user (yet)
        }
        states.push(...buildDeviceStates(gladysDevice, rawDevice));
      }
      if (states.length > 0) {
        await publishStatesChunked(states);
      }
      await publishTransports(rawDevices);
      await refreshCameraImages();
      logger.debug(`Refresh cycle published ${states.length} state(s)`);
      return states.length;
    })();
    return refreshInFlight.finally(() => {
      refreshInFlight = null;
    });
  }

  /** Start the periodic refresh loop (immediate first cycle). */
  function start(config) {
    stop();
    const run = () =>
      refreshValues(config).catch((err) =>
        logger.error(`Netatmo value refresh failed: ${err.message}`),
      );
    run();
    refreshTimer = setInterval(run, refreshIntervalMs);
    refreshTimer.unref?.();
  }

  /** Stop the periodic refresh loop. */
  function stop() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  return {
    syncDiscovery,
    refreshValues,
    buildDeviceStates,
    getCameraSnapshot,
    resetDedup,
    start,
    stop,
  };
}
