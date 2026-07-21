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
  GET_WEATHER_STATIONS: '/api/getstationsdata?get_favorites=false',
  SET_ROOM_THERMPOINT: '/api/setroomthermpoint',
};

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
