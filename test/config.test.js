import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults on an empty config', () => {
  const config = normalizeConfig();
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test('normalizeConfig trims strings and coerces form values', () => {
  const config = normalizeConfig({
    client_id: '  abc  ',
    client_secret: ' s3cr3t ',
    energy_api: 'false',
    weather_api: '1',
    security_api: 'true',
    expires_at: '1700000000000',
  });
  assert.equal(config.client_id, 'abc');
  assert.equal(config.client_secret, 's3cr3t');
  assert.equal(config.energy_api, false);
  assert.equal(config.weather_api, true);
  assert.equal(config.security_api, true);
  assert.equal(config.expires_at, 1700000000000);
});

test('normalizeConfig keeps the internal token keys', () => {
  const config = normalizeConfig({ access_token: 'a', refresh_token: 'r', expires_at: 42 });
  assert.equal(config.access_token, 'a');
  assert.equal(config.refresh_token, 'r');
  assert.equal(config.expires_at, 42);
});

test('normalizeConfig survives a broken expires_at', () => {
  const config = normalizeConfig({ expires_at: 'not-a-number' });
  assert.equal(config.expires_at, 0);
});
