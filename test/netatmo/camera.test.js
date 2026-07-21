// -----------------------------------------------------------------------------
// Unit tests of the snapshot image pipeline: pass-through under the 150 KB
// camera-store bound, jpeg-js re-encode above it (the container has no
// ffmpeg), and rejection of undecodable oversized payloads.
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

test('an oversized non-JPEG payload is dropped instead of crashing', () => {
  const garbage = Buffer.alloc(MAX_RAW_JPEG_SIZE + 1000, 7);
  assert.equal(encodeUnderLimit(garbage), null);
});
