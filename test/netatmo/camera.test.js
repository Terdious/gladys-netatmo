// -----------------------------------------------------------------------------
// Unit tests of the snapshot image pipeline: pass-through under the 150 KB
// camera-store bound, jpeg-js re-encode above it (the container has no
// ffmpeg), downscale as a last resort (a heavy camera must never have every
// frame skipped), and rejection of undecodable oversized payloads.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';

import { encodeUnderLimit, MAX_RAW_JPEG_SIZE } from '../../src/netatmo/camera.js';

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
