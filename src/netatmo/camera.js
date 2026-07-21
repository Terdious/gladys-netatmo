// -----------------------------------------------------------------------------
// Camera snapshots (port of the core netatmo.getCameraImage.js).
//
// Base URL resolution, like the core: prefer the LOCAL network when the
// camera reports `is_local` — ask the VPN `/command/ping` for the local URL,
// validate it by pinging it directly (Netatmo's recommendation), cache it per
// camera; fall back to the VPN URL. A failing snapshot on a cached local URL
// invalidates the cache and retries once on the VPN URL.
//
// Image pipeline: the core re-encodes through ffmpeg (`-qscale:v 15`) to fit
// the 150 KB camera-store bound. The container has no ffmpeg (read-only
// rootfs, noexec tmpfs): the snapshot is fetched in memory and published
// as-is when it fits the bound; larger snapshots are re-encoded with jpeg-js
// (pure JS) at decreasing quality until they fit.
// -----------------------------------------------------------------------------

import jpeg from 'jpeg-js';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'netatmo-camera' });

const SNAPSHOT_PATH = '/live/snapshot_720.jpg';
const PING_PATH = '/command/ping';
const PING_TIMEOUT_MS = 5 * 1000;
const SNAPSHOT_TIMEOUT_MS = 20 * 1000;

// POST /camera/image accepts at most 150 KB (application bound, measured on
// the FULL `image/jpg;base64,...` string) — BUT the core mounts its routes
// behind `express.json()` whose DEFAULT body limit is 100 KB: any JSON body
// between ~100 and 150 KB dies in the parser with a 413 before reaching the
// camera route (seen on the real bench). Until the core raises the parser
// limit (fix proposed on the external-integrations framework PR), the
// budget targets the WHOLE JSON body under 100 KB: 96 KB of image string
// leaves room for the envelope. The raw JPEG budget accounts for the
// base64 expansion (4/3) and the prefix.
const IMAGE_PREFIX = 'image/jpg;base64,';
const MAX_IMAGE_STRING_SIZE = 96 * 1024;
export const MAX_RAW_JPEG_SIZE = Math.floor(
  ((MAX_IMAGE_STRING_SIZE - IMAGE_PREFIX.length) * 3) / 4,
);

const REENCODE_QUALITIES = [70, 50, 30, 15];

/**
 * Build the HLS live manifest URL of a camera. The `files/{quality}` variant
 * (the one used by pyatmo/Home Assistant) works on both the local and the
 * VPN URLs, unlike the documented `index_local.m3u8` which 404s on current
 * firmwares (core PR #2625 finding).
 * @param {string} baseUrl camera base URL (local-first, from resolveBaseUrl)
 * @param {string} quality one of CAMERA_LIVE_QUALITIES
 * @returns {string} the live manifest URL
 */
export function buildLiveUrl(baseUrl, quality) {
  return `${baseUrl}/live/files/${quality}/index.m3u8`;
}

/**
 * Fit a raw JPEG buffer into the camera-store bound, re-encoding with
 * decreasing quality when needed.
 * @param {Buffer} buffer raw JPEG bytes
 * @returns {string|null} `image/jpg;base64,...` string, or null when it cannot fit
 */
export function encodeUnderLimit(buffer) {
  if (buffer.length <= MAX_RAW_JPEG_SIZE) {
    return `${IMAGE_PREFIX}${buffer.toString('base64')}`;
  }
  let decoded;
  try {
    decoded = jpeg.decode(buffer, { maxMemoryUsageInMB: 128 });
  } catch (err) {
    logger.warn(`Camera snapshot re-encode failed (not a decodable JPEG?): ${err.message}`);
    return null;
  }
  for (const quality of REENCODE_QUALITIES) {
    const { data } = jpeg.encode(decoded, quality);
    if (data.length <= MAX_RAW_JPEG_SIZE) {
      logger.debug(
        `Camera snapshot re-encoded at quality ${quality} (${buffer.length} -> ${data.length} bytes)`,
      );
      return `${IMAGE_PREFIX}${Buffer.from(data).toString('base64')}`;
    }
  }
  logger.warn(
    'Camera snapshot still exceeds the 150 KB bound after re-encoding — skipping this frame',
  );
  return null;
}

/**
 * Create the camera snapshot engine.
 * @param {object} [deps] dependencies
 * @param {typeof fetch} [deps.fetchImpl] fetch implementation (tests)
 */
export function createCameraImages({ fetchImpl = fetch } = {}) {
  // Per-camera resolved local base URL (id -> url), like the core cache.
  const baseUrls = new Map();

  async function pingJson(url) {
    const response = await fetchImpl(`${url}${PING_PATH}`, {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return response.json();
  }

  /**
   * Resolve the base URL of a camera, preferring the local network
   * (port of the core `getCameraBaseUrl`).
   * @param {object} rawDevice raw Netatmo camera (`vpn_url`, `is_local`)
   * @returns {Promise<string|undefined>} base URL, or undefined without VPN URL
   */
  async function resolveBaseUrl(rawDevice) {
    const { vpn_url: vpnUrl, is_local: isLocal } = rawDevice;
    const id = rawDevice.id ?? rawDevice._id;
    if (!vpnUrl) {
      return undefined;
    }
    if (!isLocal) {
      return vpnUrl;
    }
    const cachedUrl = baseUrls.get(id);
    if (cachedUrl) {
      return cachedUrl;
    }
    try {
      const { local_url: localUrl } = await pingJson(vpnUrl);
      if (localUrl) {
        // Netatmo recommends validating the local URL by pinging it directly.
        const localPingBody = await pingJson(localUrl);
        if (localPingBody.local_url === localUrl) {
          logger.info(
            `Netatmo camera ${id}: local URL resolved, snapshots will use the local network`,
          );
          baseUrls.set(id, localUrl);
          return localUrl;
        }
      }
    } catch (err) {
      logger.debug(
        `Netatmo camera ${id}: local URL resolution failed, using VPN URL: ${err.message}`,
      );
    }
    logger.info(`Netatmo camera ${id}: snapshots will use the VPN URL`);
    return vpnUrl;
  }

  async function fetchSnapshot(baseUrl) {
    const response = await fetchImpl(`${baseUrl}${SNAPSHOT_PATH}`, {
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`snapshot answered ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Get the current image of a camera, trying the local network first then
   * the VPN (port of the core `getCameraImage`, stale-cache invalidation
   * included).
   * @param {object} rawDevice raw Netatmo camera
   * @returns {Promise<string|undefined>} `image/jpg;base64,...`, or undefined
   */
  async function getImage(rawDevice) {
    const { vpn_url: vpnUrl } = rawDevice;
    const id = rawDevice.id ?? rawDevice._id;
    const baseUrl = await resolveBaseUrl(rawDevice);
    if (!baseUrl) {
      return undefined;
    }
    try {
      return encodeUnderLimit(await fetchSnapshot(baseUrl)) ?? undefined;
    } catch (err) {
      logger.debug(`Netatmo camera ${id}: snapshot failed on ${baseUrl}: ${err.message}`);
    }
    if (baseUrl === vpnUrl) {
      return undefined;
    }
    // The cached local URL is stale: forget it and fall back to the VPN URL.
    baseUrls.delete(id);
    try {
      return encodeUnderLimit(await fetchSnapshot(vpnUrl)) ?? undefined;
    } catch (err) {
      logger.debug(`Netatmo camera ${id}: snapshot failed on VPN URL: ${err.message}`);
      return undefined;
    }
  }

  return { resolveBaseUrl, getImage };
}
