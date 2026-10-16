// -----------------------------------------------------------------------------
// Consistency checks on `gladys-assistant-integration.json`.
//
// The store indexer validates the manifest shape, but it cannot know what the
// code expects (webhook key, config defaults), and some of its rules are easy
// to miss before a release (version coupling, description length): these
// tests catch them in CI.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { DEFAULT_CONFIG } from '../src/config.js';
import { WEBHOOK_KEY, CONNECTION_MESSAGES, DEGRADED_MESSAGES } from '../src/netatmo/constants.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Store catalog vocabulary (Gladys INTEGRATION_CATALOG_CATEGORIES).
const CATALOG_CATEGORIES = [
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
];
// Older Gladys releases reject unknown top-level manifest fields: the store
// validator refuses a manifest whose `gladys_version` minimum is lower than
// the first release accepting every field it declares.
const CATEGORIES_MIN_GLADYS_VERSION = [4, 86, 0];
// The languages of the Gladys interface: every text the user reads ships in
// all of them (Gladys falls back to English for a missing one).
const GLADYS_LANGUAGES = ['en', 'fr', 'de', 'es'];

/** Every multi-language text object ({ en, fr, ... }) of a manifest subtree. */
function multiLanguageTexts(node, path = 'manifest') {
  if (Array.isArray(node)) {
    return node.flatMap((child, index) => multiLanguageTexts(child, `${path}[${index}]`));
  }
  if (node === null || typeof node !== 'object') {
    return [];
  }
  if (typeof node.en === 'string') {
    return [{ path, text: node }];
  }
  return Object.entries(node).flatMap(([key, child]) =>
    multiLanguageTexts(child, `${path}.${key}`),
  );
}

/** Minimum version of the manifest `gladys_version` range, e.g. [4, 86, 0]. */
function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

test('the manifest version is the package version, and the image is tagged with it', () => {
  // The Release workflow writes all three: a mismatch means one was edited by
  // hand, and Gladys would offer a version whose image is another one.
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image must be tagged :${manifest.version}, got "${manifest.docker_image}"`,
  );
});

test('catalog categories: 1 to 3 known keys, and Gladys >= 4.86.0', () => {
  assert.ok(Array.isArray(manifest.categories), 'categories must be declared');
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.equal(new Set(manifest.categories).size, manifest.categories.length, 'unique keys');
  for (const category of manifest.categories) {
    assert.ok(CATALOG_CATEGORIES.includes(category), `unknown catalog category "${category}"`);
  }
  assert.ok(
    isAtLeast(minGladysVersion(), CATEGORIES_MIN_GLADYS_VERSION),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('the catalog description holds 10 to 100 characters per language', () => {
  assert.ok(manifest.description.en, 'the description needs an English text');
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} has ${text.length} characters (10 to 100 allowed)`,
    );
  }
});

test('config_schema keys are snake_case and defaults match DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    assert.match(field.key, /^[a-z0-9_]+$/, `config key "${field.key}"`);
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('section fields are purely presentational', () => {
  for (const section of manifest.config_schema.filter((field) => field.type === 'section')) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.ok(!(section.key in DEFAULT_CONFIG), `section "${section.key}" stores no value`);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the declared webhook is the one the code handles', () => {
  assert.deepEqual(
    (manifest.webhooks ?? []).map((webhook) => webhook.key),
    [WEBHOOK_KEY],
  );
});

test('every manifest text ships in every Gladys language', () => {
  const texts = multiLanguageTexts(manifest);
  assert.ok(texts.length > 0);
  for (const { path, text } of texts) {
    assert.deepEqual(Object.keys(text).sort(), [...GLADYS_LANGUAGES].sort(), `${path} languages`);
    for (const language of GLADYS_LANGUAGES) {
      assert.ok(text[language].trim().length > 0, `${path}.${language} is empty`);
    }
  }
});

test('every connection status message ships in every Gladys language', () => {
  for (const [key, message] of Object.entries(CONNECTION_MESSAGES)) {
    assert.deepEqual(Object.keys(message).sort(), [...GLADYS_LANGUAGES].sort(), `${key} languages`);
  }
});

test('every degraded reason ships in every Gladys language, within the 200-character bound', () => {
  for (const [key, message] of Object.entries(DEGRADED_MESSAGES)) {
    assert.deepEqual(Object.keys(message).sort(), [...GLADYS_LANGUAGES].sort(), `${key} languages`);
    for (const [language, text] of Object.entries(message)) {
      assert.ok(text.length <= 200, `${key}.${language} has ${text.length} characters`);
    }
  }
});
