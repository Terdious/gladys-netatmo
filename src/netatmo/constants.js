// -----------------------------------------------------------------------------
// Netatmo API constants.
//
// Mirrors the Gladys core service constants
// (server/services/netatmo/lib/utils/netatmo.constants.js) so the two
// implementations stay easy to diff, plus the camera scopes added by the
// Home + Security work (core PR #2621).
// -----------------------------------------------------------------------------

export const NETATMO_BASE_URL = 'https://api.netatmo.com';

export const OAUTH2 = {
  AUTHORIZE_PATH: '/oauth2/authorize',
  TOKEN_PATH: '/oauth2/token',
};

export const API_PATHS = {
  HOMESDATA: '/api/homesdata',
  HOMESTATUS: '/api/homestatus',
  GET_THERMOSTATS: '/api/getthermostatsdata',
  GET_WEATHER_STATIONS: '/api/getstationsdata?get_favorites=false',
  SET_ROOM_THERMPOINT: '/api/setroomthermpoint',
  SET_STATE: '/api/setstate',
};

// Netatmo module types supported by the discovery (same enum as the core).
export const SUPPORTED_MODULE_TYPE = {
  THERMOSTAT: 'NATherm1',
  PLUG: 'NAPlug',
  NRV: 'NRV',
  NAMAIN: 'NAMain',
  NAMODULE1: 'NAModule1',
  NAMODULE2: 'NAModule2',
  NAMODULE3: 'NAModule3',
  NAMODULE4: 'NAModule4',
  NACAMERA: 'NACamera',
  NOC: 'NOC',
};

export const SUPPORTED_CATEGORY_TYPE = {
  ENERGY: 'Energy',
  WEATHER: 'Weather',
  SECURITY: 'Security',
  UNKNOWN: 'unknown',
};

export const ENERGY_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.THERMOSTAT,
  SUPPORTED_MODULE_TYPE.PLUG,
  SUPPORTED_MODULE_TYPE.NRV,
];

export const WEATHER_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.NAMAIN,
  SUPPORTED_MODULE_TYPE.NAMODULE1,
  SUPPORTED_MODULE_TYPE.NAMODULE2,
  SUPPORTED_MODULE_TYPE.NAMODULE3,
  SUPPORTED_MODULE_TYPE.NAMODULE4,
];

// Cameras: indoor (NACamera) and outdoor Presence (NOC), core PR #2621.
export const SECURITY_MODULE_TYPES = [SUPPORTED_MODULE_TYPE.NACAMERA, SUPPORTED_MODULE_TYPE.NOC];

// Device params persisted on the Gladys device (same names as the core:
// home_id/room_id are required by setroomthermpoint).
export const PARAMS = {
  HOME_ID: 'home_id',
  ROOM_ID: 'room_id',
  ROOM_NAME: 'room_name',
  PLUG_ID: 'plug_id',
  PLUG_NAME: 'plug_name',
  MODULES_BRIDGE_ID: 'modules_bridge_id',
};

// The `errors` array of /homestatus flags a powered-off module with this code.
export const API_ERROR_CODE_UNREACHABLE = 6;

// Telemetry refresh cadence: one batched load of every home/station per cycle
// (the core polls at the same rate). The devices are created with
// should_poll:false — one global loop costs 3-4 API calls per cycle instead of
// one call per device, which matters against the Netatmo rate limits.
export const REFRESH_VALUES_INTERVAL_MS = 120 * 1000;

// A state whose value did not change is re-published at most every 30 minutes
// (keep-alive), so Gladys still sees the device alive without flooding the
// state history at every 120s cycle.
export const STATE_KEEP_ALIVE_MS = 30 * 60 * 1000;

// How many homes are detailed concurrently (mirrors the core Promise.map).
export const HOMES_CONCURRENCY = 2;

// POST /state and POST /device/transport accept at most 100 entries per
// request (host API contract; the SDK does not export the constant).
export const MAX_ENTRIES_PER_REQUEST = 100;

// The full scope set is requested in one go — like the core, where a single
// (re)connection covers every device family, including the camera scopes the
// Security milestone needs (read/write/access on camera + presence).
export const OAUTH_SCOPES = [
  // Energy
  'read_thermostat',
  'write_thermostat',
  // Weather
  'read_station',
  // Home + Security (cameras) — includes the write/access scopes from core PR #2621
  'read_camera',
  'write_camera',
  'access_camera',
  'read_presence',
  'write_presence',
  'access_presence',
  'read_carbonmonoxidedetector',
  'read_smokedetector',
  // Aircare
  'read_homecoach',
];

// Refresh the access token at 80% of its lifetime (core PR #2618 hardening),
// never sooner than 30 seconds from now.
export const TOKEN_REFRESH_RATIO = 0.8;
export const TOKEN_REFRESH_MIN_DELAY_MS = 30 * 1000;

// Consider the access token stale when it expires within this margin, so an
// API call never leaves with a token about to die mid-flight.
export const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

// Retry timings of the token refresh engine (mirrors the core reconnect
// engine): exponential-ish backoff, then a recurrent retry, and a 24h grace
// window during which a fatal-looking refresh error (Netatmo sometimes answers
// bogus 400s during outages) keeps the stored tokens instead of wiping them.
export const RECONNECT_BACKOFF_MS = [30 * 1000, 60 * 1000, 120 * 1000, 300 * 1000];
export const RECONNECT_RECURRENT_MS = 300 * 1000;
export const FATAL_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Multi-language messages for the application-level connection status shown
// on the integration Configuration screen in Gladys.
export const CONNECTION_MESSAGES = {
  MISSING_CLIENT_CONFIG: {
    en: 'Netatmo client id and client secret are not configured yet.',
    fr: "L'identifiant et le secret client Netatmo ne sont pas encore configurés.",
  },
  SAVE_CREDENTIALS_FIRST: {
    en: 'Fill in AND SAVE the Netatmo client id / client secret, then click Connect again.',
    fr: "Renseignez ET SAUVEGARDEZ l'identifiant / secret client Netatmo, puis cliquez à nouveau sur Se connecter.",
  },
  NOT_CONNECTED: {
    en: 'Netatmo account is not connected yet — use the Connect button.',
    fr: "Le compte Netatmo n'est pas encore connecté — utilisez le bouton Se connecter.",
  },
  RECONNECT_REQUIRED: {
    en: 'Netatmo session expired, please reconnect your Netatmo account.',
    fr: 'La session Netatmo a expiré, veuillez reconnecter votre compte Netatmo.',
  },
  NETATMO_UNREACHABLE: {
    en: 'Netatmo cloud is unreachable, retrying automatically.',
    fr: 'Le cloud Netatmo est injoignable, nouvelle tentative automatique.',
  },
};
