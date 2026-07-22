// -----------------------------------------------------------------------------
// Telemetry engine: discovery sync + the global 120s value refresh loop.
//
// The core service refreshes ALL devices with one batched load every 120s
// (`pollRefreshingValues`); this engine keeps that design — devices are
// created with should_poll:false and the whole account costs 3-4 API calls
// per cycle, which matters against the Netatmo rate limits. Bursty callers
// (config save = connection sync + discovery re-publish, scan spam) share ONE
// account load through a short-TTL single-flight cache.
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
//     (core PR #2620 surfaced as a badge instead of a raw param);
//   - a PARTIAL load (an API family failed) never replaces the published
//     discovery list: devices must not vanish during a Netatmo hiccup.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';

import {
  REFRESH_VALUES_INTERVAL_MS,
  STATE_KEEP_ALIVE_MS,
  MAX_ENTRIES_PER_REQUEST,
  SECURITY_MODULE_TYPES,
  CAMERA_LIVE_QUALITIES,
  DEFAULT_CAMERA_LIVE_QUALITY,
  ROOM_DERIVED_SUFFIXES,
  PARAMS,
} from './constants.js';
import { loadAccount, netatmoId } from './discovery.js';
import { convertDevice } from './convert.js';
import { UPDATE_MAPPINGS } from './updateMappings.js';
import { readValues } from './deviceMapping.js';
import { createCameraImages, buildLiveUrl } from './camera.js';

const logger = createLogger({ name: 'netatmo-telemetry' });

// Bursts (config save, double scan) within this window share one account load.
const DEFAULT_LOAD_TTL_MS = 10 * 1000;
// The SDK acks the camera get-image command within 15s: budget the on-demand
// snapshot under it and fall back to the last published image when exceeded.
const ON_DEMAND_SNAPSHOT_BUDGET_MS = 12 * 1000;

/** Reject after `ms` while the underlying work keeps running. */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Create the telemetry engine.
 * @param {object} deps dependencies
 * @param {object} deps.gladys SDK instance
 * @param {object} deps.client Netatmo API client
 * @param {() => number} [deps.now] clock (tests)
 * @param {number} [deps.refreshIntervalMs] loop cadence override (tests)
 * @param {number} [deps.loadTtlMs] account-load cache TTL override (tests)
 * @param {typeof fetch} [deps.fetchImpl] fetch used for the camera endpoints
 */
export function createTelemetry({
  gladys,
  client,
  now = Date.now,
  refreshIntervalMs = REFRESH_VALUES_INTERVAL_MS,
  loadTtlMs = DEFAULT_LOAD_TTL_MS,
  fetchImpl = fetch,
}) {
  // Last published value per feature external_id: {state, at}.
  const published = new Map();
  let refreshTimer = null;
  let refreshInFlight = null;

  const cameras = createCameraImages({ fetchImpl, now });
  // Last raw Netatmo payload per camera id (vpn_url, is_local...), refreshed
  // by every load — the on-demand snapshot handler reads from here instead of
  // paying a full account load per image request.
  const rawCamerasById = new Map();
  // Live URL last published per camera id: a change (VPN rotation, local/VPN
  // switch, user-edited quality) triggers a discovery re-publish so the
  // framework upserts the CAMERA_URL param of the created device.
  const lastLiveUrls = new Map();
  // Last successfully published image per camera id: served as a fallback
  // when an on-demand snapshot cannot complete within the ack budget.
  const lastImages = new Map();

  // --- Account load (single-flight + short TTL) ------------------------------
  let loadCache = null; // {key, at, promise}

  function loadCacheKey(config) {
    return `${config.energy_api}|${config.weather_api}|${config.security_api}`;
  }

  /**
   * Load the account, sharing one in-flight/recent load between bursty
   * callers (config save = sync + discovery, scan bursts).
   * @param {object} config normalized integration config
   * @returns {Promise<{devices: Array, partial: boolean}>} raw devices + flag
   */
  function loadAccountCached(config) {
    const key = loadCacheKey(config);
    if (loadCache && loadCache.key === key && now() - loadCache.at < loadTtlMs) {
      return loadCache.promise;
    }
    const promise = loadAccount(client, config).then((result) => {
      afterLoad(result);
      return result;
    });
    loadCache = { key, at: now(), promise };
    promise.catch(() => {
      // Never cache a failed load.
      if (loadCache?.promise === promise) {
        loadCache = null;
      }
    });
    return promise;
  }

  // Last "devices not supported" count: logged at info only when it changes.
  let lastNotHandledCount = null;

  /** Post-load bookkeeping: camera cache upkeep + stale-entry pruning. */
  function afterLoad({ devices: rawDevices, partial }) {
    const notHandledCount = rawDevices.filter((rawDevice) => rawDevice.not_handled).length;
    if (!partial && notHandledCount !== lastNotHandledCount) {
      logger.info(`Netatmo devices not supported: ${notHandledCount}`);
      lastNotHandledCount = notHandledCount;
    }
    const cameraIds = new Set();
    for (const rawDevice of rawDevices) {
      const id = netatmoId(rawDevice);
      if (id && SECURITY_MODULE_TYPES.includes(rawDevice.type) && !rawDevice.apiNotConfigured) {
        cameraIds.add(id);
        rawCamerasById.set(id, rawDevice);
      }
    }
    if (partial) {
      // An incomplete load must not evict anything: absence is not proof.
      return;
    }
    for (const id of rawCamerasById.keys()) {
      if (!cameraIds.has(id)) {
        rawCamerasById.delete(id);
        lastLiveUrls.delete(id);
        lastImages.delete(id);
      }
    }
    cameras.prune(cameraIds);
    // Devices removed from the account must not pin dedup entries forever.
    const devicePrefixes = new Set(
      rawDevices
        .map((rawDevice) => netatmoId(rawDevice))
        .filter(Boolean)
        .map((id) => `${gladys.externalId(id)}:`),
    );
    for (const key of published.keys()) {
      const prefix = key.slice(0, key.lastIndexOf(':') + 1);
      if (!devicePrefixes.has(prefix)) {
        published.delete(key);
      }
    }
  }

  /** Forget the dedup memory so the next refresh re-publishes every value. */
  function resetDedup() {
    published.clear();
    loadCache = null;
  }

  // --- Publish helpers -------------------------------------------------------

  /** Run `publish` in chunks, respecting the per-request cap of the host API. */
  async function publishChunked(publish, entries) {
    for (let i = 0; i < entries.length; i += MAX_ENTRIES_PER_REQUEST) {
      await publish(entries.slice(i, i + MAX_ENTRIES_PER_REQUEST));
    }
  }

  /** The created Gladys device matching a Netatmo id, if any. */
  function findGladysDevice(id) {
    const externalId = gladys.externalId(id);
    return (gladys.devices ?? []).find((device) => device.external_id === externalId);
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
    // Stale-module detection (issue #10): Netatmo keeps returning the
    // LAST-KNOWN module values (battery, rf, measures) for a dead/offline
    // module, with `reachable: false` set. Never republish those — only the
    // room-derived values stay meaningful (fed by the other room sensors).
    const unreachable = rawDevice.reachable === false;
    const states = [];
    for (const [suffix, extractValue] of Object.entries(mapping)) {
      if (unreachable && !ROOM_DERIVED_SUFFIXES.includes(suffix)) {
        continue;
      }
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
      await publishChunked((chunk) => gladys.publishTransports(chunk), entries);
    } catch (err) {
      logger.debug(`publishTransports skipped (older Gladys core?): ${err.message}`);
    }
  }

  // --- Camera live stream ----------------------------------------------------

  /**
   * Resolve the live-stream enrichment of every known camera: base URL
   * (LOCAL network first, from the snapshot cache), quality read back from
   * the created device so a user edit is never overwritten.
   * @returns {Promise<Map<string, {liveUrl: string, quality: string}>>} by camera id
   */
  async function buildCameraEnrichments(config) {
    const enrichments = new Map();
    for (const [id, rawDevice] of rawCamerasById) {
      try {
        const baseUrl = await cameras.resolveBaseUrl(rawDevice);
        if (!baseUrl) {
          continue;
        }
        // Quality resolution: per-device param first (once the front lets
        // users edit device params), then the global configuration select.
        const qualityParam = (findGladysDevice(id)?.params ?? []).find(
          (param) => param.name === PARAMS.CAMERA_QUALITY,
        )?.value;
        const quality = CAMERA_LIVE_QUALITIES.includes(qualityParam)
          ? qualityParam
          : CAMERA_LIVE_QUALITIES.includes(config?.camera_quality)
            ? config.camera_quality
            : DEFAULT_CAMERA_LIVE_QUALITY;
        enrichments.set(id, { liveUrl: buildLiveUrl(baseUrl, quality), quality });
      } catch (err) {
        logger.debug(`Live URL resolution failed for camera ${id}: ${err.message}`);
      }
    }
    return enrichments;
  }

  // --- Discovery -------------------------------------------------------------

  /** Publish the discovered devices + transport badges for the given load. */
  async function publishDiscovery({ devices: rawDevices, partial }, config) {
    const enrichments = await buildCameraEnrichments(config);
    const devices = rawDevices
      .map((rawDevice) => convertDevice(gladys, rawDevice, enrichments))
      .filter(Boolean);
    if (partial) {
      // publishDiscoveredDevices REPLACES the previous list: a partial load
      // would make devices vanish from the Discovery screen. Keep the last
      // complete list; badges still reflect what was loaded.
      logger.warn('Partial Netatmo load — keeping the previously published discovery list');
    } else {
      await gladys.publishDiscoveredDevices(devices);
      for (const [id, enrichment] of enrichments) {
        lastLiveUrls.set(id, enrichment.liveUrl);
      }
      logger.info(`Discovery published ${devices.length} Netatmo device(s)`);
    }
    await publishTransports(rawDevices);
    return devices;
  }

  /**
   * Discovery pipeline: load every raw device, publish the discovered list
   * and the transport badges.
   * @param {object} config normalized integration config
   * @returns {Promise<Array>} the published Gladys device payloads
   */
  async function syncDiscovery(config) {
    return publishDiscovery(await loadAccountCached(config), config);
  }

  // --- Camera images ---------------------------------------------------------

  /**
   * Refresh the dashboard image of every created camera (external counterpart
   * of the core updateCameraImage): snapshot fetched local-first, published
   * through POST /camera/image. Failures are logged and never abort the cycle.
   */
  async function refreshCameraImages() {
    for (const [id, rawDevice] of rawCamerasById) {
      const externalId = gladys.externalId(id);
      const hasCameraFeature = (findGladysDevice(id)?.features ?? []).some(
        (f) => f.external_id === `${externalId}:camera`,
      );
      if (!hasCameraFeature) {
        continue; // not created by the user (yet), or created before the camera feature shipped
      }
      try {
        const image = await cameras.getImage(rawDevice);
        if (image) {
          lastImages.set(id, image);
          await gladys.publishCameraImage(externalId, image);
        }
      } catch (err) {
        logger.warn(`Camera image refresh failed for ${id}: ${err.message}`);
      }
    }
  }

  /** Fetch a fresh on-demand snapshot, loading the account when needed. */
  async function fetchFreshSnapshot(config, device, id) {
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
   * On-demand snapshot for the SDK getImage command (user opens the camera
   * in Gladys). Bounded under the command ack window: when the fresh snapshot
   * cannot land in time (cold start, slow LAN resolution), the last published
   * image is served instead of an error.
   * @param {object} config normalized integration config
   * @param {object} device the Gladys device of the command
   * @returns {Promise<string>} `image/jpg;base64,...` string
   */
  async function getCameraSnapshot(config, device) {
    const id = device.external_id.replace(gladys.externalId(''), '');
    try {
      const image = await withTimeout(
        fetchFreshSnapshot(config, device, id),
        ON_DEMAND_SNAPSHOT_BUDGET_MS,
        `Camera ${device.external_id} snapshot timed out`,
      );
      lastImages.set(id, image);
      return image;
    } catch (err) {
      const fallback = lastImages.get(id);
      if (fallback) {
        logger.warn(
          `On-demand snapshot failed for ${id} (${err.message}) — serving the last image`,
        );
        return fallback;
      }
      throw err;
    }
  }

  // --- Refresh loop ----------------------------------------------------------

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
      const load = await loadAccountCached(config);
      const rawDevices = load.devices;
      const states = [];
      for (const rawDevice of rawDevices) {
        const id = netatmoId(rawDevice);
        if (!id || rawDevice.not_handled) {
          continue;
        }
        const gladysDevice = findGladysDevice(id);
        if (!gladysDevice) {
          continue; // not created by the user (yet)
        }
        states.push(...buildDeviceStates(gladysDevice, rawDevice));
      }
      if (states.length > 0) {
        await publishChunked((chunk) => gladys.publishStates(chunk), states);
      }
      await refreshCameraImages();
      // Live stream upkeep (core PR #2625): when a camera's live URL moved
      // (VPN rotation, local/VPN switch, user-edited quality), re-publish the
      // discovery so the framework upserts the CAMERA_URL param of the
      // created device — read by the core rtsp-camera service.
      const enrichments = await buildCameraEnrichments(config);
      const liveUrlChanged = [...enrichments].some(
        ([id, enrichment]) => lastLiveUrls.get(id) !== enrichment.liveUrl,
      );
      if (liveUrlChanged) {
        logger.info('Camera live URL changed — re-publishing the discovery to refresh CAMERA_URL');
        await publishDiscovery(load, config);
      } else {
        await publishTransports(rawDevices);
      }
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

  return { syncDiscovery, refreshValues, getCameraSnapshot, resetDedup, start, stop };
}
