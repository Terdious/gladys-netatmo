// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// Besides the schema fields, the config store also carries the OAuth2 tokens
// (`access_token`, `refresh_token`, `expires_at`) written by the integration
// itself via `gladys.setConfig()` — keys outside the schema are free internal
// storage and never reach the configuration form.
//
// The `netatmo_account` schema key is a value-less UI field (type `oauth2`,
// rendered as the Connect button): it carries no configuration value, which
// is why it appears in neither DEFAULT_CONFIG nor normalizeConfig.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined`.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  client_id: '', // Netatmo Connect application client id
  client_secret: '', // Netatmo Connect application client secret, secret
  energy_api: true, // discover Energy devices (thermostats, relay plugs, valves)
  weather_api: true, // discover Weather devices (stations and modules)
  security_api: false, // discover Security devices (cameras), opt-in like the core

  // Internal keys (NOT in the config_schema), persisted through setConfig():
  access_token: '', // OAuth2 access token
  refresh_token: '', // OAuth2 refresh token (rotated by Netatmo on every refresh)
  expires_at: 0, // access token expiry, epoch milliseconds
};

/**
 * Coerce a value coming from a form (which may be a string like "true") into a
 * boolean.
 * @param {unknown} value raw value
 * @param {boolean} fallback default when the value is missing
 * @returns {boolean}
 */
function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    // Force the types: config may arrive as strings from a form.
    client_id: String(raw.client_id ?? DEFAULT_CONFIG.client_id).trim(),
    client_secret: String(raw.client_secret ?? DEFAULT_CONFIG.client_secret).trim(),
    energy_api: toBoolean(raw.energy_api, DEFAULT_CONFIG.energy_api),
    weather_api: toBoolean(raw.weather_api, DEFAULT_CONFIG.weather_api),
    security_api: toBoolean(raw.security_api, DEFAULT_CONFIG.security_api),
    access_token: String(raw.access_token ?? DEFAULT_CONFIG.access_token).trim(),
    refresh_token: String(raw.refresh_token ?? DEFAULT_CONFIG.refresh_token).trim(),
    expires_at: Number(raw.expires_at ?? DEFAULT_CONFIG.expires_at) || 0,
  };
}
