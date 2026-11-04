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
import {
  WEBHOOK_KEY,
  CONNECTION_MESSAGES,
  DEGRADED_MESSAGES,
  DEVICE_DIAGNOSTIC_ACTION_KEY,
} from '../src/netatmo/constants.js';
import * as featureBuilders from '../src/netatmo/features.js';
import { SCENE_ACTIONS } from '../src/netatmo/scenes.js';
import { SCENE_TRIGGER_KEYS } from '../src/netatmo/events.js';
import { WIDGETS, WIDGET_OF_UPDATE } from '../src/netatmo/widgets.js';
import { SETPOINT_DURATION_LABELS } from '../src/netatmo/roomSetpoint.js';

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
// Feature types older Gladys releases do not know, with the first release
// accepting them: an older core refuses the WHOLE discovery list (400) as
// soon as one feature carries an unknown category/type.
// Capability fields (scene triggers / actions, widgets): older cores reject
// them as unknown manifest fields.
const CAPABILITY_FIELDS = ['scene_triggers', 'scene_actions', 'widgets'];
const CAPABILITY_MIN_GLADYS_VERSION = [5, 1, 0];
// Manifest `actions` (Configuration screen buttons): validated by the core
// since 4.85.0; a `source: "devices"` select in their fields since 4.86.1
// (checked in the Gladys history: externalIntegration.validateManifest.js).
const ACTIONS_MIN_GLADYS_VERSION = [4, 85, 0];
const DEVICES_SOURCE_MIN_GLADYS_VERSION = [4, 86, 1];
const FEATURE_TYPE_MIN_GLADYS_VERSION = {
  'thermostat/preset': [5, 2, 0],
  'text/select': [5, 1, 1],
  // Room thermostat features (issue #77): both types appeared in 4.85.0
  // (checked in the Gladys history, server/utils/constants.js), with
  // supported_options since 4.82.0; the Thermostat widget reading them ships
  // in 5.2.0 (core PR #3178), already the minimum.
  'thermostat/mode': [4, 85, 0],
  'thermostat/operating-state': [4, 85, 0],
};
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

test('catalog categories: 1 to 3 known keys, coupled to Gladys >= 4.86.0', () => {
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

test('the setpoint_duration options are the durations the code handles, labelled alike', () => {
  const field = manifest.config_schema.find((entry) => entry.key === 'setpoint_duration');
  assert.equal(field.type, 'select');
  assert.deepEqual(
    Object.fromEntries(field.options.map((option) => [option.value, option.label])),
    SETPOINT_DURATION_LABELS,
  );
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

test('every feature type the code publishes is known to the minimum Gladys version', () => {
  // Every builder of src/netatmo/features.js, called with placeholder
  // arguments: the category/type pair does not depend on them.
  const published = new Set(
    Object.values(featureBuilders)
      .filter((build) => typeof build === 'function')
      .map((build) => {
        const feature = build('name', 'ext:netatmo:id', 'suffix');
        return `${feature.category}/${feature.type}`;
      }),
  );
  assert.ok(published.has('thermostat/preset'), 'the heating mode is a thermostat preset');
  assert.ok(published.has('thermostat/mode'), 'the room mode is a thermostat mode');
  assert.ok(published.has('thermostat/operating-state'), 'the room heating state');
  for (const [featureType, minVersion] of Object.entries(FEATURE_TYPE_MIN_GLADYS_VERSION)) {
    if (published.has(featureType)) {
      assert.ok(
        isAtLeast(minGladysVersion(), minVersion),
        `${featureType} requires gladys_version >= ${minVersion.join('.')}, got "${manifest.gladys_version}"`,
      );
    }
  }
});

const keysOf = (list) => (list ?? []).map((entry) => entry.key);

test('declaring scene triggers, scene actions or widgets requires Gladys >= 5.1.0', () => {
  const declared = CAPABILITY_FIELDS.filter((field) => manifest[field] !== undefined);
  assert.ok(declared.length > 0, 'the manifest declares capability fields');
  assert.ok(
    isAtLeast(minGladysVersion(), CAPABILITY_MIN_GLADYS_VERSION),
    `${declared.join(', ')} requires gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

test('every scene_actions key has an onSceneAction handler, and vice versa', () => {
  const declared = keysOf(manifest.scene_actions);
  for (const key of declared) {
    assert.equal(typeof SCENE_ACTIONS[key], 'function', `scene action "${key}" has no handler`);
  }
  for (const key of Object.keys(SCENE_ACTIONS)) {
    assert.ok(declared.includes(key), `handler "${key}" is not declared in scene_actions`);
  }
});

test('every scene trigger the code fires is declared in scene_triggers, and vice versa', () => {
  // An undeclared key is a 404 on publishSceneEvent; a declared key nobody
  // fires is a dead card in the scene editor.
  const declared = keysOf(manifest.scene_triggers);
  assert.deepEqual([...SCENE_TRIGGER_KEYS].sort(), [...declared].sort());
});

test('scene declarations: unique keys, allowed field types, scalar variables and outputs', () => {
  for (const list of ['scene_triggers', 'scene_actions']) {
    const keys = keysOf(manifest[list]);
    assert.equal(new Set(keys).size, keys.length, `${list} keys are unique`);
    for (const entry of manifest[list]) {
      assert.match(entry.key, /^[a-z0-9_]{1,40}$/);
      // boolean has no "any" state: trigger filters cannot use it (spec §3).
      const allowed = ['string', 'number', 'select', 'multi_select', 'section'];
      if (list === 'scene_actions') {
        allowed.push('boolean');
      }
      for (const field of entry.fields ?? []) {
        assert.ok(allowed.includes(field.type), `${list}.${entry.key}.${field.key} type`);
      }
      for (const output of [...(entry.variables ?? []), ...(entry.outputs ?? [])]) {
        assert.ok(['string', 'number', 'boolean'].includes(output.type));
      }
    }
  }
});

test('every widgets key has an onWidgetGet handler, and vice versa', () => {
  const declared = keysOf(manifest.widgets);
  for (const key of declared) {
    assert.equal(typeof WIDGETS[key]?.get, 'function', `widget "${key}" has no content handler`);
  }
  for (const key of Object.keys(WIDGETS)) {
    assert.ok(declared.includes(key), `widget "${key}" is not declared in widgets`);
  }
  // Every telemetry nudge targets a declared widget (an undeclared key throws).
  for (const key of Object.values(WIDGET_OF_UPDATE)) {
    assert.ok(declared.includes(key), `nudged widget "${key}" is not declared`);
  }
});

test('widget declarations: key, label and description bounds, allowed setting types', () => {
  assert.ok(manifest.widgets.length <= 5);
  for (const widget of manifest.widgets) {
    assert.match(widget.key, /^[a-z0-9_]{2,32}$/);
    for (const label of Object.values(widget.label)) {
      assert.ok(label.length >= 3 && label.length <= 30, `${widget.key} label "${label}"`);
    }
    for (const description of Object.values(widget.description ?? {})) {
      assert.ok(description.length <= 100, `${widget.key} description "${description}"`);
    }
    for (const setting of widget.settings ?? []) {
      assert.ok(['string', 'number', 'boolean', 'select', 'multi_select'].includes(setting.type));
    }
  }
});

test('the declared actions are the ones index.js handles, within the contract bounds', () => {
  assert.deepEqual(keysOf(manifest.actions), [DEVICE_DIAGNOSTIC_ACTION_KEY]);
  assert.ok(
    isAtLeast(minGladysVersion(), ACTIONS_MIN_GLADYS_VERSION),
    `actions requires gladys_version >= 4.85.0, got "${manifest.gladys_version}"`,
  );
  assert.ok(manifest.actions.length <= 10);
  for (const action of manifest.actions) {
    assert.match(action.key, /^[a-z0-9_]+$/);
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
    for (const field of action.fields ?? []) {
      assert.ok(['string', 'select'].includes(field.type), `${action.key}.${field.key} type`);
      if (field.source !== undefined) {
        assert.equal(field.source, 'devices');
        assert.equal(field.type, 'select', 'a source is only allowed on a select');
        assert.equal(field.options, undefined, 'source and options are exclusive');
        assert.equal(field.default, undefined, 'no default with a dynamic source');
        assert.ok(
          isAtLeast(minGladysVersion(), DEVICES_SOURCE_MIN_GLADYS_VERSION),
          `source "devices" requires gladys_version >= 4.86.1, got "${manifest.gladys_version}"`,
        );
      }
    }
  }
  // Both diagnostic fields are optional: empty means the account summary.
  const diagnostic = manifest.actions.find((a) => a.key === DEVICE_DIAGNOSTIC_ACTION_KEY);
  assert.deepEqual(
    diagnostic.fields.map((field) => [field.key, field.required]),
    [
      ['device', false],
      ['device_ref', false],
    ],
  );
});
