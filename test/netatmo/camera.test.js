// -----------------------------------------------------------------------------
// Unit tests of the snapshot image pipeline: pass-through under the 150 KB
// camera-store bound, jpeg-js re-encode above it (the container has no
// ffmpeg), downscale as a last resort (a heavy camera must never have every
// frame skipped), and rejection of undecodable oversized payloads.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';

import {
  createCameraImages,
  encodeUnderLimit,
  MAX_RAW_JPEG_SIZE,
} from '../../src/netatmo/camera.js';

function noiseJpeg(width, height, quality) {
  const data = Buffer.alloc(width * height * 4);
  // Deterministic pseudo-noise: compresses badly, so high-quality encodes are big.
  let seed = 42;
  for (let i = 0; i < data.length; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    data[i] = seed % 256;
  }
  return Buffer.from(jpeg.encode({ data, width, height }, quality).data);
}

test('a snapshot under the bound is published as-is', () => {
  const raw = Buffer.from('small-fake-jpeg');
  const image = encodeUnderLimit(raw);
  assert.equal(image, `image/jpg;base64,${raw.toString('base64')}`);
  assert.ok(image.length <= 150 * 1024);
});

test('an oversized snapshot is re-encoded under the bound (no ffmpeg in the container)', () => {
  const oversized = noiseJpeg(640, 480, 100);
  assert.ok(
    oversized.length > MAX_RAW_JPEG_SIZE,
    `fixture must exceed the bound (${oversized.length})`,
  );
  const image = encodeUnderLimit(oversized);
  assert.ok(image, 're-encode must produce an image');
  assert.match(image, /^image\/jpg;base64,/);
  assert.ok(image.length <= 150 * 1024);
});

test('a snapshot too heavy even at the lowest quality is downscaled, never skipped', () => {
  // Bench report: a camera whose snapshots stayed above the budget had EVERY
  // frame skipped, so the dashboard image never appeared. Full-HD pseudo-noise
  // does not fit at quality 15 either — the downscale ladder must save it.
  const huge = noiseJpeg(1920, 1080, 100);
  const lowestQuality = Buffer.from(
    jpeg.encode(jpeg.decode(huge, { maxMemoryUsageInMB: 128 }), 15).data,
  );
  assert.ok(
    lowestQuality.length > MAX_RAW_JPEG_SIZE,
    `fixture must still exceed the bound at quality 15 (${lowestQuality.length})`,
  );

  const image = encodeUnderLimit(huge);
  assert.ok(image, 'the frame must be published, not skipped');
  assert.match(image, /^image\/jpg;base64,/);
  assert.ok(image.length <= 150 * 1024);
  // And it is still a decodable JPEG, just smaller.
  const decoded = jpeg.decode(Buffer.from(image.replace('image/jpg;base64,', ''), 'base64'), {
    maxMemoryUsageInMB: 128,
  });
  assert.ok(decoded.width < 1920 && decoded.width > 0);
});

test('an oversized non-JPEG payload is dropped instead of crashing', () => {
  const garbage = Buffer.alloc(MAX_RAW_JPEG_SIZE + 1000, 7);
  assert.equal(encodeUnderLimit(garbage), null);
});

test('the video doorbell (WebRTC) snapshots on its VPN URL only, never pinging the LAN', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return new Response(Buffer.from('doorbell-jpeg'), { status: 200 });
  };
  const cameras = createCameraImages({ fetchImpl });
  const vpnUrl = 'https://prodvpn-eu-6.netatmo.net/10.20.30.40/1111111111111/2222222222222,,';
  // Even when it claims `is_local`, pyatmo never uses the local URL of a
  // WebRTC camera: no /command/ping resolution.
  const doorbell = { id: '12:34:56:10:f1:66', type: 'NDB', vpn_url: vpnUrl, is_local: true };

  assert.equal(await cameras.resolveBaseUrl(doorbell), vpnUrl);
  const image = await cameras.getImage(doorbell);
  assert.equal(image, `image/jpg;base64,${Buffer.from('doorbell-jpeg').toString('base64')}`);
  assert.deepEqual(requests, [`${vpnUrl}/live/snapshot_720.jpg`]);
});

test('the Indoor Camera Advance (WebRTC) snapshots on its VPN URL only (issue #55)', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return new Response(Buffer.from('npc-jpeg'), { status: 200 });
  };
  const cameras = createCameraImages({ fetchImpl });
  const vpnUrl =
    'https://prodvpn-eu-2.netatmo.net/restricted/10.255.123.45/9fb1814609e27de5697ab47d06846631/MTRPn_BeWCav5RBq4U1OMDruTW4dkQ0NuMwNDAw11g,,';
  // pyatmo fixture: `is_local: true`, yet pyatmo forces the VPN URL of every
  // WebRTC camera (`WebRTCCameraMixin`).
  const npc = { id: '12:34:56:00:f1:63', type: 'NPC', vpn_url: vpnUrl, is_local: true };

  assert.equal(await cameras.resolveBaseUrl(npc), vpnUrl);
  const image = await cameras.getImage(npc);
  assert.equal(image, `image/jpg;base64,${Buffer.from('npc-jpeg').toString('base64')}`);
  assert.deepEqual(requests, [`${vpnUrl}/live/snapshot_720.jpg`]);
});
