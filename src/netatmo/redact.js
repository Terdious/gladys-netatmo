// -----------------------------------------------------------------------------
// Redaction of Netatmo payloads before they reach a log line or a diagnostic
// report (issue #59): both may end up pasted in a public issue.
//
// Secrets go — secret-named keys (tokens, keys, signatures, passwords),
// e-mail addresses, every URL (a VPN or snapshot URL embeds its access key:
// only its scheme and host are kept), bearer tokens and long opaque strings —
// while the ids a maintainer needs (module, bridge, home, event ids) stay.
// Shared by the BTicino diagnostic log (src/netatmo/bticino.js) and the
// "Device diagnostic" action (src/netatmo/diagnostic.js).
// -----------------------------------------------------------------------------

// A key whose value is a secret, whatever the value looks like.
const SECRET_KEY_PATTERN = /token|secret|passw|signature|cookie|auth|credential|key|sig$/i;
// A key whose value is (or may be) an e-mail address or a URL.
const EMAIL_KEY_PATTERN = /e?mail/i;
const URL_KEY_PATTERN = /(^|_)(url|uri|link)s?$/i;
const URL_VALUE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const EMAIL_VALUE_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const BEARER_PATTERN = /bearer\s+\S+/i;
// A long string made of key-like characters only (base64, hex, JWT…): an
// access key rather than a Netatmo id. The ids stay well below 40 characters
// (MAC 17, home / event id 24, UUID 36 — the UUID shape is kept explicitly).
const OPAQUE_MIN_LENGTH = 40;
const OPAQUE_PATTERN = /^[A-Za-z0-9+/=_.:,-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Nesting deeper than this is not walked (and a cycle cannot loop forever).
const MAX_DEPTH = 10;

const REDACTED = '<redacted>';

/** Keep only the scheme and host of a URL: its path / query carry the keys. */
function redactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/${REDACTED}`;
  } catch {
    return `<redacted url>`;
  }
}

/** Redact one string value according to its shape. */
function redactString(value) {
  if (URL_VALUE_PATTERN.test(value)) {
    return redactUrl(value);
  }
  if (EMAIL_VALUE_PATTERN.test(value)) {
    return '<redacted email>';
  }
  if (BEARER_PATTERN.test(value)) {
    return REDACTED;
  }
  if (
    value.length >= OPAQUE_MIN_LENGTH &&
    OPAQUE_PATTERN.test(value) &&
    !UUID_PATTERN.test(value)
  ) {
    return REDACTED;
  }
  return value;
}

/**
 * Deep copy of a payload with its secrets redacted (see the file header):
 * secret-named keys, URLs, e-mail addresses, bearer tokens and long opaque
 * strings. Ids, types, states and numbers are kept as they are.
 * @param {unknown} value payload (object, array or scalar)
 * @param {number} [depth] current nesting depth
 * @returns {unknown} redacted copy
 */
export function redactForDiagnostic(value, depth = 0) {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '<too deep>';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForDiagnostic(item, depth + 1));
  }
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined || typeof item === 'boolean') {
      copy[key] = item;
    } else if (SECRET_KEY_PATTERN.test(key)) {
      copy[key] = REDACTED;
    } else if (EMAIL_KEY_PATTERN.test(key) && typeof item === 'string') {
      copy[key] = '<redacted email>';
    } else if (URL_KEY_PATTERN.test(key) && typeof item === 'string') {
      copy[key] = URL_VALUE_PATTERN.test(item) ? redactUrl(item) : REDACTED;
    } else {
      copy[key] = redactForDiagnostic(item, depth + 1);
    }
  }
  return copy;
}
