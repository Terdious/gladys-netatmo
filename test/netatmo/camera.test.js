// -----------------------------------------------------------------------------
// Unit tests of the snapshot image pipeline: pass-through under the image
// budget (72 KB, so the device page can still save a camera), jpeg-js re-encode above it (the container has no
// ffmpeg), downscale as a last resort (a heavy camera must never have every
// frame skipped), and rejection of undecodable oversized payloads.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';

import {
  createCameraImages,
  encodeUnderLimit,
  MAX_IMAGE_STRING_SIZE,
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
  assert.ok(image.length <= MAX_IMAGE_STRING_SIZE);
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
  assert.ok(image.length <= MAX_IMAGE_STRING_SIZE);
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
  assert.ok(image.length <= MAX_IMAGE_STRING_SIZE);
  // And it is still a decodable JPEG, just smaller.
  const decoded = jpeg.decode(Buffer.from(image.replace('image/jpg;base64,', ''), 'base64'), {
    maxMemoryUsageInMB: 128,
  });
  assert.ok(decoded.width < 1920 && decoded.width > 0);
});

test('a camera device with its image stays under the 100 KB body of a device save', () => {
  // The Devices tab posts the whole device to POST /api/v1/device (default
  // 100 KB parser, until GladysAssistant/Gladys#3228): the image must leave
  // room for the other features of the richest camera (NOC, 13 features).
  // Worst case: an image exactly at the budget.
  const image = `image/jpg;base64,${'A'.repeat(MAX_IMAGE_STRING_SIZE - 'image/jpg;base64,'.length)}`;
  const feature = (index, value) => ({
    id: '00000000-0000-0000-0000-000000000000',
    device_id: '00000000-0000-0000-0000-000000000000',
    name: `Floodlight automatic mode ${index} - Caméra Ext Appentis`,
    selector: `ext-netatmo-70-ee-50-00-00-00-floodlight-automatic-mode-${index}`,
    external_id: `ext:netatmo:70:ee:50:00:00:00:floodlight_automatic_mode_${index}`,
    category: 'camera',
    type: 'image',
    read_only: false,
    keep_history: true,
    has_feedback: true,
    min: 0,
    max: 1,
    unit: null,
    last_value: 1,
    last_value_string: value,
    last_value_changed: '2026-10-19T07:20:37.448Z',
    created_at: '2026-10-19T07:20:37.448Z',
    updated_at: '2026-10-19T07:20:37.448Z',
  });
  const device = {
    id: '00000000-0000-0000-0000-000000000000',
    name: 'Caméra Ext Appentis',
    selector: 'ext-netatmo-70-ee-50-00-00-00',
    external_id: 'ext:netatmo:70:ee:50:00:00:00',
    room_id: '00000000-0000-0000-0000-000000000000',
    service_id: '00000000-0000-0000-0000-000000000000',
    features: [feature(0, image), ...Array.from({ length: 12 }, (_, i) => feature(i + 1, null))],
    params: Array.from({ length: 6 }, (_, i) => ({
      name: `PARAM_${i}`,
      value: `https://prodvpn-eu-0.netatmo.net/restricted/10.255.0.0/${'x'.repeat(64)}/MTc2MDg2/live/files/high/index.m3u8`,
    })),
  };
  const body = Buffer.byteLength(JSON.stringify(device));
  assert.ok(body < 100 * 1024, `device save body is ${body} bytes`);
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
