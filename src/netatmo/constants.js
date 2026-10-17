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
  GET_HOME_COACHS: '/api/gethomecoachsdata',
  SET_ROOM_THERMPOINT: '/api/setroomthermpoint',
  SET_THERM_MODE: '/api/setthermmode',
  SWITCH_HOME_SCHEDULE: '/api/switchhomeschedule',
  SET_PERSONS_AWAY: '/api/setpersonsaway',
  SET_PERSONS_HOME: '/api/setpersonshome',
  SET_STATE: '/api/setstate',
  ADD_WEBHOOK: '/api/addwebhook',
  // Lists the URL actually registered for the application (one per app).
  WEBHOOKS_V1: '/webhooks/v1/',
  DROP_WEBHOOK: '/api/dropwebhook',
  // WebRTC live view of the doorbell and the Indoor Camera Advance (issue #70,
  // pyatmo `WebRTCCameraMixin`): SDP offer in, SDP answer out, then terminate.
  WEBRTC_OFFER: '/api/webrtc/offer',
  WEBRTC_TERMINATE: '/api/webrtc/terminate',
  // Last events of a home (pyatmo GETEVENTS_ENDPOINT): the fallback source of
  // the momentary detections when the webhooks deliver nothing.
  GET_EVENTS: '/api/getevents',
};

// The manifest declares ONE webhook (`events`): Netatmo pushes every event
// (Energy setpoint, camera movement/person, siren, smoke…) to a single URL.
export const WEBHOOK_KEY = 'events';
// Doctrine "trigger, not data" (SDK): a webhook event only TRIGGERS a refresh
// through the API — events arrive duplicated/late/out of order. Debounce a
// burst of events into one refresh.
export const WEBHOOK_DEBOUNCE_MS = 2 * 1000;

// MOMENTARY events (motion, person, smoke…) are the documented exception to
// "trigger, not data": they exist ONLY in the event stream — no API state ever
// reports them, so a refresh cannot surface them. They are published as
// dedicated push features, which is what makes "camera detects motion → scene"
// possible.
//
// Netatmo sends `push_type: "<module type>-<event>"` (e.g. "NACamera-movement",
// "NOC-human", "NSD-smoke", "NCO-co_detected"). We key on the EVENT part so
// every module type is handled by one table, and unknown events are ignored
// instead of guessed.
export const EVENT_FEATURE_SUFFIXES = {
  movement: 'motion',
  human: 'human',
  person: 'human',
  animal: 'animal',
  vehicle: 'vehicle',
  smoke: 'smoke',
  co_detected: 'carbon_monoxide',
  // Video doorbell (NDB, issue #35): someone pressed the button. The follow-up
  // `accepted_call` / `missed_call` events describe the SAME ring (answered or
  // not in the Netatmo app): they are deliberately not mapped, so one ring
  // fires a scene once instead of twice.
  // The BTicino door entry (issue #59) sends the same event: Netatmo lists
  // incoming_call for the BNCX in its Home + Security webhook documentation.
  incoming_call: 'ring',
};

// Webhook `sub_type` values that report the END of a detection rather than a
// new one (Netatmo security webhook documentation: smoke 0 = cleared,
// 1 = detected; co_detected 0 = OK, 1 = pre-alarm, 2 = alarm). Such an event
// returns the feature to 0 at once — publishing it as a detection would raise
// a false alarm right after a real one.
export const EVENT_CLEARED_SUB_TYPES = {
  smoke: ['0'],
  co_detected: ['0'],
};

// Scene triggers (issue #39, manifest `scene_triggers`, Gladys 5.1+), fired
// with publishSceneEvent from the webhook event stream. Keys are FOREVER:
// scenes store them, a renamed key is a removed key.
export const SCENE_TRIGGERS = {
  KNOWN_PERSON_ARRIVED: 'known_person_arrived',
  KNOWN_PERSON_LEFT: 'known_person_left',
  SIREN_SOUNDING: 'siren_sounding',
};

// Scene actions (issue #39, manifest `scene_actions`), handled by
// src/netatmo/scenes.js. Same rule: keys are never renamed.
export const SCENE_ACTION_KEYS = {
  SET_HEATING_MODE: 'set_heating_mode',
  SET_PERSONS_AWAY: 'set_persons_away',
  SET_PERSONS_HOME: 'set_persons_home',
  // Advanced heating (issue #58).
  SET_ROOM_SETPOINT: 'set_room_setpoint',
  BOOST_ROOM: 'boost_room',
  ROOM_BACK_TO_SCHEDULE: 'room_back_to_schedule',
  SET_HEATING_SCHEDULE: 'set_heating_schedule',
};

// Webhooks may be re-delivered: the last scene events fired are remembered
// (by Netatmo event id + person) so a duplicate never starts a scene twice.
export const SCENE_EVENT_DEDUP_SIZE = 100;

// A momentary event has no "cleared" counterpart in the Netatmo stream: the
// feature is set to 1 then automatically back to 0 after this delay, like any
// motion sensor (a stuck 1 would make a scene trigger fire once and never again).
export const EVENT_RESET_MS = 60 * 1000;

// The same detection may reach the integration twice: from a webhook and from
// the getevents poll (src/netatmo/eventsPoll.js). It is published once: same
// Netatmo event id, or — the ids missing or different — the same feature
// within this window. What each source published is remembered for the
// retention below (longer than the poll's max age), within a bounded size.
export const EVENT_DEDUP_WINDOW_MS = 90 * 1000;
export const EVENT_DEDUP_RETENTION_MS = 15 * 60 * 1000;
export const EVENT_DEDUP_MAX_ENTRIES = 500;

// getevents poll (the webhook fallback): one call per eligible home and per
// refresh cycle, asking for the last EVENTS_POLL_SIZE events. The webhook-
// triggered refreshes poll too, but a home is never polled twice within
// EVENTS_POLL_MIN_INTERVAL_MS. An event older than EVENTS_POLL_MAX_AGE_MS at
// poll time (an outage, a restart) is recorded as seen but never published:
// no stale trigger. The first answer after a start only seeds what was
// already there. At most EVENTS_POLL_SEEN_SIZE event ids are kept per home.
export const EVENTS_POLL_SIZE = 30;
export const EVENTS_POLL_MIN_INTERVAL_MS = 30 * 1000;
export const EVENTS_POLL_MAX_AGE_MS = 10 * 60 * 1000;
export const EVENTS_POLL_SEEN_SIZE = 500;
// A getevents call never stalls the refresh cycle for long.
export const EVENTS_POLL_TIMEOUT_MS = 15 * 1000;
// Events seen by the poll, kept (redacted) for the Device diagnostic report,
// bounded like the webhook history.
export const EVENTS_POLL_HISTORY_SIZE = 20;
export const EVENTS_POLL_HISTORY_PER_MODULE = 10;
export const EVENTS_POLL_HISTORY_MAX_MODULES = 50;

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
  // Camera-bridged accessories over an internal radio link (no wifi of their
  // own): door/window tag and indoor siren.
  NACAMDOORTAG: 'NACamDoorTag',
  NIS: 'NIS',
  // Smart smoke alarm. Discovered with battery + signal (published only if the
  // homestatus payload carries them); its SMOKE state is webhook-driven and
  // lands with the webhooks milestone (issue #5).
  NSD: 'NSD',
  // Smart carbon monoxide alarm (issue #36): same shape as the smoke alarm —
  // battery + signal when homestatus carries them, CO state webhook-driven.
  NCO: 'NCO',
  // Smart video doorbell (issue #35): a camera of its own (snapshot + wifi),
  // plus the ring, which only exists in the webhook event stream.
  NDB: 'NDB',
  // Indoor Camera Advance (issue #55): an indoor camera like NACamera
  // (monitoring, snapshot, detections), with its own `camerapro` scopes.
  NPC: 'NPC',
  // Bubendorff roller shutters, bridged by the iDiamant gateway (NBG, not
  // exposed as a device): NBR (radio), NBO (wired), NBS (solar), issue #34.
  NBR: 'NBR',
  NBO: 'NBO',
  NBS: 'NBS',
  // Smart Indoor Air Quality Monitor (formerly "Healthy Home Coach"), served
  // by the legacy /api/gethomecoachsdata endpoint (issue #37).
  NHC: 'NHC',
  // Modulating / OpenTherm thermostat (issue #53): a wifi relay wired to the
  // boiler (OTH, the bridge) and its radio room thermostat (OTM).
  OTH: 'OTH',
  OTM: 'OTM',
  // BTicino Smarther with Netatmo (issue #54): wifi thermostat of its own
  // (no relay), served by the same homesdata/homestatus and commands.
  BNS: 'BNS',
  // BTicino Classe 300X / Classe 300 EOS with Netatmo door entry (issue #59),
  // discovery preview: indoor unit = gateway (BNCX), external street panel
  // (BNEU), door lock (BNDL), staircase light (BNSL), controlled socket
  // (BNCS) and X module (BNXM). No public payload exists: their exact state
  // fields are collected through the diagnostic log (src/netatmo/bticino.js).
  BNCX: 'BNCX',
  BNEU: 'BNEU',
  BNDL: 'BNDL',
  BNSL: 'BNSL',
  BNCS: 'BNCS',
  BNXM: 'BNXM',
  // Legrand Home + Control (Céliane / dooxie / Mosaic with Netatmo, issue
  // #60), pyatmo modules/legrand.py: the gateway (NLG, standalone NLGS — not
  // exposed, the `bridge` of the commands), the lighting modules (on/off:
  // micro module NLM, Italian switch NLL, double switch NLIS; dimmers: NLF,
  // NLFN, NLFE, in-wall NLUF, plug-in NLUO) and the plugs / relays (NLP,
  // mobile NLPM, British NLPBS, cable outlet NLC, power outlet NLUP, in-wall
  // switch NLUI, contactor NLPO, latching relay NLPT, dry contact NLPD).
  NLG: 'NLG',
  NLGS: 'NLGS',
  NLM: 'NLM',
  NLL: 'NLL',
  NLIS: 'NLIS',
  NLF: 'NLF',
  NLFN: 'NLFN',
  NLFE: 'NLFE',
  NLUF: 'NLUF',
  NLUO: 'NLUO',
  NLP: 'NLP',
  NLPM: 'NLPM',
  NLPBS: 'NLPBS',
  NLC: 'NLC',
  NLUP: 'NLUP',
  NLUI: 'NLUI',
  NLPO: 'NLPO',
  NLPT: 'NLPT',
  NLPD: 'NLPD',
};

// Virtual devices (issue #57): built by the integration from home-level data
// rather than from a Netatmo module. Their type is lowercase snake_case, which
// no Netatmo module type is (NATherm1, NOC, NBR…), so the convert switch and
// the UPDATE_MAPPINGS table can key on it without any collision.
export const VIRTUAL_DEVICE_TYPE = {
  // The persons known to the cameras of one home (face recognition): one
  // presence feature per named person.
  KNOWN_PERSONS: 'known_persons',
};

// Netatmo id of the known-persons device of a home: `persons-<home id>`, so
// its external_id reads `ext:netatmo:persons-<home id>`. Netatmo module ids
// are MAC addresses (`70:ee:50:…`) or digit strings (shutters): neither ever
// starts with a word followed by a hyphen, and a home id is unique to the
// account — the id can neither collide with a module nor between two homes.
export const KNOWN_PERSONS_ID_PREFIX = 'persons-';

// Feature suffix of a known person's presence: `person_<Netatmo person id>`.
// The person id is the one Netatmo keeps for the face (a UUID, also used by
// setpersonsaway/setpersonshome): stable across renames, never reused.
export const PERSON_PRESENCE_SUFFIX_PREFIX = 'person_';

export const SUPPORTED_CATEGORY_TYPE = {
  ENERGY: 'Energy',
  WEATHER: 'Weather',
  SECURITY: 'Security',
  SHUTTER: 'Shutter',
  AIRCARE: 'Aircare',
  BTICINO: 'BTicino',
  LEGRAND: 'Legrand',
  UNKNOWN: 'unknown',
};

export const ENERGY_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.THERMOSTAT,
  SUPPORTED_MODULE_TYPE.PLUG,
  SUPPORTED_MODULE_TYPE.NRV,
  SUPPORTED_MODULE_TYPE.OTH,
  SUPPORTED_MODULE_TYPE.OTM,
  SUPPORTED_MODULE_TYPE.BNS,
];

// Modules that heat a room: their room (homestatus `rooms`) carries the
// measured and setpoint temperatures — the rooms of the heating widget and
// the heating scene actions (issue #40, #39).
export const HEATED_ROOM_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.THERMOSTAT,
  SUPPORTED_MODULE_TYPE.NRV,
  SUPPORTED_MODULE_TYPE.OTM,
  SUPPORTED_MODULE_TYPE.BNS,
];

export const WEATHER_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.NAMAIN,
  SUPPORTED_MODULE_TYPE.NAMODULE1,
  SUPPORTED_MODULE_TYPE.NAMODULE2,
  SUPPORTED_MODULE_TYPE.NAMODULE3,
  SUPPORTED_MODULE_TYPE.NAMODULE4,
];

// Cameras: indoor (NACamera) and outdoor Presence (NOC), core PR #2621, the
// video doorbell (NDB, issue #35) and the Indoor Camera Advance (NPC, issue
// #55).
export const CAMERA_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.NACAMERA,
  SUPPORTED_MODULE_TYPE.NOC,
  SUPPORTED_MODULE_TYPE.NDB,
  SUPPORTED_MODULE_TYPE.NPC,
];

// Cameras with a monitoring switch, written through /api/setstate
// `monitoring` (the doorbell has none).
export const MONITORING_CAMERA_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.NACAMERA,
  SUPPORTED_MODULE_TYPE.NOC,
  SUPPORTED_MODULE_TYPE.NPC,
];

// Cameras streaming over HLS: the only ones whose live stream the core
// rtsp-camera service can play through the CAMERA_URL param. The doorbell and
// the Indoor Camera Advance stream over WebRTC only (pyatmo
// `WebRTCCameraMixin`): they get no CAMERA_URL rather than a live button that
// cannot work.
export const HLS_CAMERA_MODULE_TYPES = [SUPPORTED_MODULE_TYPE.NACAMERA, SUPPORTED_MODULE_TYPE.NOC];

// Floodlight of the outdoor camera (NOC, issue #56): homestatus `floodlight`,
// written with /api/setstate (pyatmo FloodlightMixin). `auto` lights up on a
// detection.
export const FLOODLIGHT_MODES = {
  ON: 'on',
  OFF: 'off',
  AUTO: 'auto',
};

// WebRTC cameras do not serve their snapshot on the local URL (pyatmo forces
// the VPN URL for them): no `/command/ping` resolution, VPN URL only.
export const VPN_ONLY_CAMERA_MODULE_TYPES = [SUPPORTED_MODULE_TYPE.NDB, SUPPORTED_MODULE_TYPE.NPC];

// Cameras whose live view is negotiated in WebRTC through the Netatmo cloud
// (issue #70): published with the reserved GLADYS_CAMERA_STREAM_PROTOCOL
// device param, their SDP offer relayed to /api/webrtc/offer.
export const WEBRTC_CAMERA_MODULE_TYPES = [SUPPORTED_MODULE_TYPE.NDB, SUPPORTED_MODULE_TYPE.NPC];

// Camera-bridged security accessories (radio-linked to a camera): door/window
// tag (NACamDoorTag) and indoor siren (NIS). Net-new vs the core service — the
// core does not handle these either (issue #9).
export const CAMERA_BRIDGED_SECURITY_TYPES = [
  SUPPORTED_MODULE_TYPE.NACAMDOORTAG,
  SUPPORTED_MODULE_TYPE.NIS,
];

// Aircare: the Home Coach / Smart Indoor Air Quality Monitor (issue #37).
export const AIRCARE_MODULE_TYPES = [SUPPORTED_MODULE_TYPE.NHC];

// Every Security-family module the discovery supports (drives getModuleCategory).
export const SECURITY_MODULE_TYPES = [
  ...CAMERA_MODULE_TYPES,
  ...CAMERA_BRIDGED_SECURITY_TYPES,
  SUPPORTED_MODULE_TYPE.NSD,
  SUPPORTED_MODULE_TYPE.NCO,
];

// Bubendorff / iDiamant roller shutters (issue #34): homesdata/homestatus
// modules like the Energy ones, gated by their own `shutter_api` toggle.
export const SHUTTER_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.NBR,
  SUPPORTED_MODULE_TYPE.NBO,
  SUPPORTED_MODULE_TYPE.NBS,
];

// BTicino door entry modules (issue #59), gated by their own `bticino_api`
// toggle: the indoor unit (BNCX, the gateway) and the modules it bridges.
export const BTICINO_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.BNCX,
  SUPPORTED_MODULE_TYPE.BNEU,
  SUPPORTED_MODULE_TYPE.BNDL,
  SUPPORTED_MODULE_TYPE.BNSL,
  SUPPORTED_MODULE_TYPE.BNCS,
  SUPPORTED_MODULE_TYPE.BNXM,
];

// ONE Gladys device per door entry: the modules bridged by a BNCX (street
// panel, door lock, staircase light, controlled socket, X module) publish no
// device of their own, they add features to the BNCX device — with feature
// external ids built from THEIR id (`ext:netatmo:<module id>:<suffix>`).
export const BTICINO_GATEWAY_TYPES = [SUPPORTED_MODULE_TYPE.BNCX];
export const BTICINO_BRIDGED_MODULE_TYPES = [
  SUPPORTED_MODULE_TYPE.BNEU,
  SUPPORTED_MODULE_TYPE.BNDL,
  SUPPORTED_MODULE_TYPE.BNSL,
  SUPPORTED_MODULE_TYPE.BNCS,
  SUPPORTED_MODULE_TYPE.BNXM,
];

// Controlled socket (pyatmo `Switch`): homestatus `on`, read-only — no source
// documents its command for the public API.
export const BTICINO_SWITCH_MODULE_TYPES = [SUPPORTED_MODULE_TYPE.BNCS];

// Staircase / outdoor light (BNSL): switched through /api/setstate `on`
// (Netatmo Home + Security documentation: "Modifying the staircase light
// status (on/off) | BNSL | /setstate", "ON/OFF light status is not
// retrievable"; pyatmo `SwitchMixin` module entry `{id, on, bridge}`).
// Netatmo does not report the state back: the commanded value is published
// (optimistic) unless homestatus ever carries `on`. Its own suffix — not the
// read-only `on` switch of the 2.2.0 preview: a light is another category.
export const BTICINO_LIGHT_SUFFIX = 'light';

// Legrand Home + Control (issue #60), gated by its own `legrand_api` toggle.
// The gateway is never a Gladys device: it is the `bridge` every command of
// the modules it bridges is routed through (pyatmo SwitchMixin /
// DimmableMixin module entry `{id, on|brightness, bridge}`).
export const LEGRAND_GATEWAY_TYPES = [SUPPORTED_MODULE_TYPE.NLG, SUPPORTED_MODULE_TYPE.NLGS];

// Lighting modules: a Gladys light (`light` / `binary`). pyatmo maps NLM, NLL
// and NLIS to `Switch`, the others to `Dimmer`: those get a brightness when
// homestatus reports one (Home Assistant's rule: a dimmer whose payload
// carries no brightness is an on/off light).
export const LEGRAND_DIMMER_TYPES = [
  SUPPORTED_MODULE_TYPE.NLF,
  SUPPORTED_MODULE_TYPE.NLFN,
  SUPPORTED_MODULE_TYPE.NLFE,
  SUPPORTED_MODULE_TYPE.NLUF,
  SUPPORTED_MODULE_TYPE.NLUO,
];
export const LEGRAND_LIGHT_TYPES = [
  SUPPORTED_MODULE_TYPE.NLM,
  SUPPORTED_MODULE_TYPE.NLL,
  SUPPORTED_MODULE_TYPE.NLIS,
  ...LEGRAND_DIMMER_TYPES,
];

// Plugs and relays (pyatmo `Switch` / SwitchMixin): a Gladys switch
// (`switch` / `binary`).
export const LEGRAND_SWITCH_TYPES = [
  SUPPORTED_MODULE_TYPE.NLP,
  SUPPORTED_MODULE_TYPE.NLPM,
  SUPPORTED_MODULE_TYPE.NLPBS,
  SUPPORTED_MODULE_TYPE.NLC,
  SUPPORTED_MODULE_TYPE.NLUP,
  SUPPORTED_MODULE_TYPE.NLUI,
  SUPPORTED_MODULE_TYPE.NLPO,
  SUPPORTED_MODULE_TYPE.NLPT,
  SUPPORTED_MODULE_TYPE.NLPD,
];

export const LEGRAND_MODULE_TYPES = [
  ...LEGRAND_GATEWAY_TYPES,
  ...LEGRAND_LIGHT_TYPES,
  ...LEGRAND_SWITCH_TYPES,
];

// Multi-gang modules (pyatmo SUB_MODULE_SEPARATOR): the double switch NLIS has
// one homestatus entry per gang, `<parent id>#<n>`, each with its own `on`.
// The gangs are the lights; the parent entry carries no state (pyatmo drops
// its category) and is not exposed. A gang never reports `reachable`: it
// follows its parent.
export const SUB_MODULE_SEPARATOR = '#';
export const LEGRAND_MULTI_GANG_TYPES = [SUPPORTED_MODULE_TYPE.NLIS];

// Feature suffixes of the Legrand modules (homestatus field names): the
// light or the switch (`on`), the dimmer level (`brightness`, 0-100 as
// Netatmo reports it) and the instant power (`power`, W) when reported.
export const LEGRAND_ON_SUFFIX = 'on';
export const LEGRAND_BRIGHTNESS_SUFFIX = 'brightness';
export const LEGRAND_POWER_SUFFIX = 'power';

// Netatmo reports the state of the Legrand modules back in homestatus: after
// a command, ONE refresh lands it after this short delay — a brightness
// slider sends a burst of commands, they share the same refresh.
export const LEGRAND_REFRESH_DELAY_MS = 2 * 1000;

// Diagnostic log of the BTicino payloads (issue #59): every line carries this
// tag (easy to grep in the Gladys logs) and is cut at this many characters.
export const BTICINO_DIAGNOSTIC_TAG = '[bticino-diagnostic]';
export const BTICINO_DIAGNOSTIC_MAX_LINE = 8 * 1024;

// "Device diagnostic" action of the Configuration screen (manifest `actions`):
// a plain-text report on one module (or the whole account), also logged at
// info level under this tag for a user who cannot copy from the screen.
export const DEVICE_DIAGNOSTIC_ACTION_KEY = 'device_diagnostic';
export const DEVICE_DIAGNOSTIC_TAG = '[netatmo-diagnostic]';
// One raw JSON entry of the report is cut at this many characters.
export const DEVICE_DIAGNOSTIC_MAX_ENTRY = 4 * 1024;
// At most this many modules are detailed by one report (a name shared by many).
export const DEVICE_DIAGNOSTIC_MAX_MODULES = 5;
// Recent webhook events kept in memory (redacted) for the report: the last
// ones overall, and the last ones per module id, for a bounded number of ids.
export const WEBHOOK_HISTORY_SIZE = 20;
export const WEBHOOK_HISTORY_PER_MODULE = 10;
export const WEBHOOK_HISTORY_MAX_MODULES = 50;

// Gladys cover states (server/utils/constants.js COVER_STATE — not exported
// by the SDK).
export const COVER_STATE = {
  STOP: 0,
  OPEN: 1,
  CLOSE: -1,
};

// /api/setstate `target_position` values of a roller shutter (pyatmo
// ShutterMixin): fully open, fully closed, stop where it is.
export const SHUTTER_POSITION = {
  OPEN: 100,
  CLOSE: 0,
  STOP: -1,
};

// A shutter command moves a motor for a few dozen seconds: refresh the values
// once after this delay so the position lands without waiting for the next
// 120s cycle.
export const SHUTTER_REFRESH_DELAY_MS = 30 * 1000;

// Device params persisted on the Gladys device (same names as the core:
// home_id/room_id are required by setroomthermpoint).
export const PARAMS = {
  HOME_ID: 'home_id',
  ROOM_ID: 'room_id',
  ROOM_NAME: 'room_name',
  PLUG_ID: 'plug_id',
  PLUG_NAME: 'plug_name',
  MODULES_BRIDGE_ID: 'modules_bridge_id',
  // Read by the core rtsp-camera service (dashboard live button): must point
  // at the current HLS manifest of the camera, refreshed when it changes.
  CAMERA_URL: 'CAMERA_URL',
  // User-editable on the device page; the discovery re-publish always sends
  // back the CURRENT device value so the upsert never overwrites the user.
  CAMERA_QUALITY: 'camera_quality',
};

export const CAMERA_LIVE_QUALITIES = ['poor', 'low', 'medium', 'high'];
export const DEFAULT_CAMERA_LIVE_QUALITY = 'high';

// Feature suffixes whose value comes from the ROOM (fed by every sensor of
// the room), not from the module itself: still current when the module is
// down, so they keep being published for `reachable: false` devices — while
// the module-own values (battery, rf, measures) would only replay Netatmo's
// last-known snapshot (bench finding: a dead anemometer kept "reporting"
// 9% battery and stale wind for months).
export const ROOM_DERIVED_SUFFIXES = [
  'therm_measured_temperature',
  'therm_setpoint_temperature',
  'open_window',
  'heating_power_request',
  // The heating mode belongs to the HOME (homestatus `home.therm_mode`): it
  // stays true whatever the state of the module carrying the feature.
  'therm_preset',
  // The room thermostat features (issue #77): the room's heating request and
  // setpoint mode (an unreachable module's own boiler status is left out by
  // the mapping itself).
  'room_operating_state',
  'room_mode',
];

// Heating mode of a Netatmo home (homestatus `home.therm_mode`, written with
// POST /api/setthermmode). Netatmo also knows other modes on some setups
// (`off`, `manual`…): they are not offered, and read as "no value".
export const NETATMO_THERM_MODES = {
  SCHEDULE: 'schedule',
  AWAY: 'away',
  FROST_GUARD: 'hg',
};

// Setpoint mode of a ROOM (issue #58), the `mode` of POST
// /api/setroomthermpoint: a manual setpoint (optional `temp` + `endtime`), a
// boost at the maximum temperature (`max`, optional `endtime`) or back to the
// home's schedule (`home`). homestatus reports it as `rooms[].therm_setpoint_mode`
// (`schedule` once back on the schedule; `away` / `hg` / `off` follow the home
// mode) with `therm_setpoint_end_time`.
export const NETATMO_SETPOINT_MODES = {
  MANUAL: 'manual',
  MAX: 'max',
  HOME: 'home',
  // The room is switched off (issue #77): written by the room's thermostat
  // mode feature, and reported as is by homestatus.
  OFF: 'off',
};

// Netatmo accepts a room setpoint between these temperatures (°C), by steps
// of 0.5 °C (the Netatmo app's range).
export const ROOM_SETPOINT_MIN_CELSIUS = 7;
export const ROOM_SETPOINT_MAX_CELSIUS = 30;

// homesdata `homes[].schedules[].type` of a heating schedule (the same home
// may also carry cooling, electricity or event schedules).
export const HEATING_SCHEDULE_TYPE = 'therm';

// Gladys THERMOSTAT_PRESET values (server/utils/constants.js), the enum of the
// `thermostat/preset` feature type (Gladys 5.2.0+). The SDK does not export
// it: only the three values Netatmo supports are mirrored.
export const THERMOSTAT_PRESET = {
  SCHEDULE: 0,
  FROST: 1,
  AWAY: 2,
};

// Gladys THERMOSTAT_MODE values (server/utils/constants.js), the enum of the
// `thermostat/mode` feature type: what the machine does. A Netatmo room only
// heats or is off (issue #77), so only these two are mirrored.
export const THERMOSTAT_MODE = {
  OFF: 0,
  HEATING: 1,
};

// Gladys THERMOSTAT_OPERATING_STATE values, the enum of the
// `thermostat/operating-state` feature type: whether the equipment runs.
export const THERMOSTAT_OPERATING_STATE = {
  IDLE: 0,
  HEATING: 1,
  COOLING: 2,
};

// Gladys OPENING_SENSOR_STATE values (server/utils/constants.js): an opening
// sensor reads 0 when open and 1 when closed (the Gladys UI shows the unlock
// icon for 0, the lock for 1). Used by `open_window` and `opening`.
export const OPENING_SENSOR_STATE = {
  OPEN: 0,
  CLOSE: 1,
};

// Names of the room thermostat modes, with the Gladys UI wording
// (deviceFeatureValue.category.thermostat.mode in the front i18n files).
// The supported_options label is a plain string (English): the Gladys UI
// translates the mode values itself.
export const THERMOSTAT_MODE_LABELS = {
  [THERMOSTAT_MODE.OFF]: 'Off',
  [THERMOSTAT_MODE.HEATING]: 'Heating',
};

// Feature suffixes of the heated room (issue #77), carried by ONE device per
// room (see discovery markRoomThermostats): the Gladys Thermostat widget
// reads the heating state and drives the mode (its window sensor is the
// existing `open_window` feature).
export const ROOM_OPERATING_STATE_SUFFIX = 'room_operating_state';
export const ROOM_MODE_SUFFIX = 'room_mode';

// Netatmo heating mode <-> Gladys preset, in display order.
export const THERM_MODE_PRESETS = [
  { mode: NETATMO_THERM_MODES.SCHEDULE, preset: THERMOSTAT_PRESET.SCHEDULE },
  { mode: NETATMO_THERM_MODES.FROST_GUARD, preset: THERMOSTAT_PRESET.FROST },
  { mode: NETATMO_THERM_MODES.AWAY, preset: THERMOSTAT_PRESET.AWAY },
];

// Names of the heating modes, with the Gladys UI wording of the presets
// (deviceFeatureAction.category.thermostat.preset in the front i18n files).
export const THERM_MODE_LABELS = {
  [NETATMO_THERM_MODES.SCHEDULE]: {
    en: 'Schedule',
    fr: 'Planning',
    de: 'Zeitplan',
    es: 'Programación',
  },
  [NETATMO_THERM_MODES.FROST_GUARD]: {
    en: 'Frost protection',
    fr: 'Hors-gel',
    de: 'Frostschutz',
    es: 'Antihielo',
  },
  [NETATMO_THERM_MODES.AWAY]: {
    en: 'Away',
    fr: 'Absence',
    de: 'Abwesend',
    es: 'Ausencia',
  },
};

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

// An API family failing for this many loads in a row (~6 minutes at the
// 120 s cadence) marks the account degraded: one failed cycle is a hiccup.
export const DEGRADED_AFTER_FAILED_LOADS = 3;

// Degraded reasons: shown as the connection status message and in the device
// badge tooltip (at most 200 characters per language).
export const DEGRADED_MESSAGES = {
  WEATHER: {
    en: 'The Netatmo weather service is not responding: values come from the home status when available, retrying automatically.',
    fr: "Le service météo Netatmo ne répond pas : les valeurs viennent de l'état de la maison quand il les fournit, nouvelle tentative automatique.",
    de: 'Der Netatmo-Wetterdienst antwortet nicht: Die Werte kommen, soweit verfügbar, aus dem Hausstatus, neuer Versuch erfolgt automatisch.',
    es: 'El servicio meteorológico de Netatmo no responde: los valores proceden del estado de la casa cuando está disponible, se reintentará automáticamente.',
  },
  PARTIAL: {
    en: 'Part of the Netatmo cloud is not responding: some values are no longer refreshed, retrying automatically.',
    fr: 'Une partie du cloud Netatmo ne répond pas : certaines valeurs ne sont plus actualisées, nouvelle tentative automatique.',
    de: 'Ein Teil der Netatmo-Cloud antwortet nicht: Einige Werte werden nicht mehr aktualisiert, neuer Versuch erfolgt automatisch.',
    es: 'Una parte de la nube de Netatmo no responde: algunos valores ya no se actualizan, se reintentará automáticamente.',
  },
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
  // Video doorbell (issue #35) — added after 1.3.0: an account connected
  // before must click Connect again to grant them (see OAuth missingScopes).
  'read_doorbell',
  'access_doorbell',
  // Indoor Camera Advance (issue #55) — added after 2.0.1, same reconnection
  // rule as the doorbell scopes.
  'read_camerapro',
  'write_camerapro',
  'access_camerapro',
  // Aircare
  'read_homecoach',
  // Bubendorff / iDiamant roller shutters (issue #34)
  'read_bubendorff',
  'write_bubendorff',
  // BTicino Smarther with Netatmo thermostat (issue #54) — added after 2.0.1:
  // an account connected before must click Connect again to grant them.
  'read_smarther',
  'write_smarther',
];

// BTicino door entry (issue #59): BTicino IP (Classe 300X) and Classe 300 EOS,
// the names pyatmo requests (ALL_SCOPES). Requested ONLY while the opt-in
// `bticino_api` toggle is on: an account without a BTicino door entry never
// sees them (no "click Connect again" hint, no consent for scopes it does
// not need). The write scopes are requested together, so the step 2
// commands (door lock, staircase light) need no second reconnection.
export const BTICINO_OAUTH_SCOPES = ['read_bfi', 'write_bfi', 'read_mx', 'write_mx'];

// Legrand Home + Control (issue #60): "Legrand Wiring device or Electrical
// panel products", the names pyatmo requests (ALL_SCOPES). Same rule as the
// BTicino door entry: requested ONLY while the opt-in `legrand_api` toggle is
// on, read and write together.
export const LEGRAND_OAUTH_SCOPES = ['read_magellan', 'write_magellan'];

/**
 * Scopes to request for a configuration: the base set, plus the BTicino door
 * entry ones and the Legrand ones while their toggle is on.
 * @param {object} [config] normalized configuration
 * @returns {string[]} the scopes to request
 */
export function requestedScopes(config) {
  if (!config?.bticino_api && !config?.legrand_api) {
    return OAUTH_SCOPES;
  }
  return [
    ...OAUTH_SCOPES,
    ...(config.bticino_api ? BTICINO_OAUTH_SCOPES : []),
    ...(config.legrand_api ? LEGRAND_OAUTH_SCOPES : []),
  ];
}

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
    de: 'Client-ID und Client-Secret von Netatmo sind noch nicht konfiguriert.',
    es: 'El ID de cliente y el secreto de cliente de Netatmo aún no están configurados.',
  },
  SAVE_CREDENTIALS_FIRST: {
    en: 'Fill in AND SAVE the Netatmo client id / client secret, then click Connect again.',
    fr: "Renseignez ET SAUVEGARDEZ l'identifiant / secret client Netatmo, puis cliquez à nouveau sur Connecter.",
    de: 'Trage die Netatmo-Client-ID / das Client-Secret ein UND SPEICHERE sie, dann klicke erneut auf Verbinden.',
    es: 'Introduzca Y GUARDE el ID / secreto de cliente de Netatmo y luego vuelva a hacer clic en Conectar.',
  },
  NOT_CONNECTED: {
    en: 'Netatmo account is not connected yet — use the Connect button.',
    fr: "Le compte Netatmo n'est pas encore connecté — utilisez le bouton Connecter.",
    de: 'Das Netatmo-Konto ist noch nicht verbunden — nutze die Schaltfläche Verbinden.',
    es: 'La cuenta Netatmo aún no está conectada — use el botón Conectar.',
  },
  RECONNECT_REQUIRED: {
    en: 'Netatmo session expired, please reconnect your Netatmo account.',
    fr: 'La session Netatmo a expiré, veuillez reconnecter votre compte Netatmo.',
    de: 'Die Netatmo-Sitzung ist abgelaufen, bitte verbinde dein Netatmo-Konto erneut.',
    es: 'La sesión de Netatmo ha caducado, vuelva a conectar su cuenta Netatmo.',
  },
  // Connected, but the token lacks requested scopes (typically scopes added by
  // a newer release, like the BTicino door entry, Legrand, Smarther or Indoor
  // Camera Advance ones): the exact list is logged.
  MISSING_SCOPES: {
    en: 'Connected, but some Netatmo permissions added in a recent version are missing (e.g. BTicino door entry, Legrand Home + Control, Smarther thermostat, Indoor Camera Advance): click Connect again to grant them.',
    fr: 'Connecté, mais des autorisations Netatmo ajoutées récemment manquent (ex. interphone BTicino, Legrand Home + Control, thermostat Smarther, caméra intérieure Advance) : cliquez à nouveau sur Connecter pour les accorder.',
    de: 'Verbunden, aber neu hinzugekommene Netatmo-Berechtigungen fehlen (z. B. Türsprechanlage BTicino, Legrand Home + Control, Thermostat Smarther, Innenkamera Advance): Klicke erneut auf Verbinden, um sie zu erteilen.',
    es: 'Conectado, pero faltan permisos de Netatmo añadidos recientemente (p. ej. portero BTicino, Legrand Home + Control, termostato Smarther, cámara de interior Advance): vuelva a hacer clic en Conectar para concederlos.',
  },
  NETATMO_UNREACHABLE: {
    en: 'Netatmo cloud is unreachable, retrying automatically.',
    fr: 'Le cloud Netatmo est injoignable, nouvelle tentative automatique.',
    de: 'Die Netatmo-Cloud ist nicht erreichbar, neuer Versuch erfolgt automatisch.',
    es: 'La nube de Netatmo no está disponible, se reintentará automáticamente.',
  },
  // Connected, but the token predates the shutter scopes (issue #34): shown
  // as an info line on the Configuration screen until the next connection.
  SHUTTER_SCOPE_MISSING: {
    en: 'Netatmo refused the roller shutter command: reconnect your Netatmo account (Connect button) to grant the shutter permissions.',
    fr: 'Netatmo a refusé la commande du volet roulant : reconnectez votre compte Netatmo (bouton Connecter) pour accorder les autorisations des volets.',
    de: 'Netatmo hat den Rollladenbefehl abgelehnt: Verbinde dein Netatmo-Konto erneut (Schaltfläche Verbinden), um die Rollladen-Berechtigungen zu erteilen.',
    es: 'Netatmo rechazó la orden de la persiana: vuelva a conectar su cuenta Netatmo (botón Conectar) para conceder los permisos de las persianas.',
  },
  // Same for the BTicino door entry command (issue #59): the token predates
  // the BTicino scopes (requested only while the toggle is on).
  BTICINO_SCOPE_MISSING: {
    en: 'Netatmo refused the door entry command: reconnect your Netatmo account (Connect button) to grant the BTicino permissions.',
    fr: "Netatmo a refusé la commande de l'interphone : reconnectez votre compte Netatmo (bouton Connecter) pour accorder les autorisations BTicino.",
    de: 'Netatmo hat den Befehl der Türsprechanlage abgelehnt: Verbinde dein Netatmo-Konto erneut (Schaltfläche Verbinden), um die BTicino-Berechtigungen zu erteilen.',
    es: 'Netatmo rechazó la orden del portero: vuelva a conectar su cuenta Netatmo (botón Conectar) para conceder los permisos de BTicino.',
  },
  // Same for a Legrand Home + Control command (issue #60): the token predates
  // the Legrand scopes (requested only while the toggle is on).
  LEGRAND_SCOPE_MISSING: {
    en: 'Netatmo refused the Legrand command: reconnect your Netatmo account (Connect button) to grant the Legrand Home + Control permissions.',
    fr: 'Netatmo a refusé la commande Legrand : reconnectez votre compte Netatmo (bouton Connecter) pour accorder les autorisations Legrand Home + Control.',
    de: 'Netatmo hat den Legrand-Befehl abgelehnt: Verbinde dein Netatmo-Konto erneut (Schaltfläche Verbinden), um die Legrand-Home-+-Control-Berechtigungen zu erteilen.',
    es: 'Netatmo rechazó la orden de Legrand: vuelva a conectar su cuenta Netatmo (botón Conectar) para conceder los permisos de Legrand Home + Control.',
  },
};
