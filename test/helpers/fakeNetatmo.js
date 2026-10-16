// -----------------------------------------------------------------------------
// Fake of the Netatmo cloud, implementing the contract the integration uses:
//   - POST /oauth2/token: authorization_code and refresh_token grants,
//     with rotating refresh tokens (like the real Netatmo);
//   - Bearer-protected API: homesdata, homestatus, getthermostatsdata,
//     getstationsdata, setroomthermpoint, switchhomeschedule, setthermmode,
//     setpersonsaway and setpersonshome (form), gethomecoachsdata, setstate
//     (JSON), webrtc/offer and webrtc/terminate (form, issue #70);
//   - two fake cameras (/vpn/<id> and /local/<id>: command/ping + snapshot).
// Behaviour toggles (`failTokenWith`, `rejectAccessToken`, `failSetpointWith`,
// `failSwitchScheduleWith`, `failHomesWith`, `failLocalSnapshot`) let the tests exercise the failure
// paths. `overrides` (path prefix → {status, body}) short-circuits the normal
// routes of /oauth2/token and /api/* with a canned answer (default HTTP 200),
// for the degraded payload shapes (`status: 'error'`, missing fields...).
// -----------------------------------------------------------------------------

import http from 'node:http';

export const FAKE_CLIENT_ID = 'fake-client-id';
export const FAKE_CLIENT_SECRET = 'fake-client-secret';
export const FAKE_AUTH_CODE = 'fake-auth-code';

// -----------------------------------------------------------------------------
// Device fixtures: one Energy home (relay plug + thermostat + one reachable
// valve + one POWERED-OFF valve reported in the homestatus `errors` array)
// and one Weather station with an outdoor module whose temperature is 0
// (legitimate zero — must be published). An unsupported NACamera rides along.
// -----------------------------------------------------------------------------

function buildDefaultHomes() {
  return [
    {
      id: 'home-1',
      name: 'Maison',
      rooms: [
        { id: 'room-1', name: 'Salon' },
        { id: 'room-2', name: 'Chambre' },
      ],
      modules: [
        { id: 'plug-1', type: 'NAPlug', name: 'Relais' },
        {
          id: 'therm-1',
          type: 'NATherm1',
          name: 'Thermostat',
          room_id: 'room-1',
          bridge: 'plug-1',
        },
        { id: 'valve-1', type: 'NRV', name: 'Vanne salon', room_id: 'room-2', bridge: 'plug-1' },
        { id: 'valve-2', type: 'NRV', name: 'Vanne éteinte', room_id: 'room-2', bridge: 'plug-1' },
        { id: 'camera-1', type: 'NACamera', name: 'Caméra salon', room_id: 'room-1' },
        { id: 'noc-1', type: 'NOC', name: 'Caméra jardin' },
        { id: 'siren-1', type: 'NIS', name: 'Sirène', bridge: 'camera-1' },
        {
          id: 'doortag-1',
          type: 'NACamDoorTag',
          name: "Porte d'entrée",
          room_id: 'room-1',
          bridge: 'camera-1',
        },
        // Smoke alarm: discovered with battery + signal; smoke state is
        // webhook-driven (issue #9 / #5).
        { id: 'smoke-1', type: 'NSD', name: 'Détecteur de fumée', bridge: 'camera-1' },
        // Carbon monoxide alarm (issue #36): modelled on the smoke alarm.
        { id: 'co-1', type: 'NCO', name: 'Détecteur de CO', room_id: 'room-1' },
      ],
      // Persons known to the indoor camera (face recognition), homesdata shape.
      persons: [
        { id: 'person-1', pseudo: 'Alice', url: 'https://example.invalid/alice.jpg' },
        { id: 'person-2', pseudo: 'Bob', url: 'https://example.invalid/bob.jpg' },
      ],
      // Schedules (issue #58), pyatmo homesdata.json shape: two heating
      // schedules (one selected) and a cooling one that is not a heating schedule.
      schedules: [
        { id: 'schedule-week', name: 'Semaine', type: 'therm', selected: true, default: false },
        { id: 'schedule-holidays', name: 'Vacances', type: 'therm', default: false },
        { id: 'schedule-cooling', name: 'Default', type: 'cooling', default: false },
      ],
    },
  ];
}

function buildDefaultHomeStatuses() {
  return {
    'home-1': {
      home: {
        id: 'home-1',
        // Heating mode of the home (issue #38), as homestatus reports it.
        therm_mode: 'schedule',
        rooms: [
          {
            id: 'room-1',
            therm_measured_temperature: 19.5,
            therm_setpoint_temperature: 21,
            therm_setpoint_mode: 'schedule',
            open_window: false,
            heating_power_request: 0,
          },
          {
            id: 'room-2',
            therm_measured_temperature: 17,
            therm_setpoint_temperature: 19,
            // A manual setpoint until a given time (issue #58).
            therm_setpoint_mode: 'manual',
            therm_setpoint_end_time: 1800003600,
            open_window: true,
            heating_power_request: 42,
          },
        ],
        modules: [
          { id: 'plug-1', type: 'NAPlug', rf_strength: 70, wifi_strength: 60 },
          {
            id: 'therm-1',
            type: 'NATherm1',
            battery_percent: 76,
            rf_strength: 80,
            boiler_status: true,
          },
          { id: 'valve-1', type: 'NRV', battery_state: 'medium', rf_strength: 65 },
          // wifi_status (not wifi_strength): exercises the ?? fallback.
          { id: 'camera-1', type: 'NACamera', monitoring: 'off', wifi_status: 55 },
          // Floodlight mode as in the pyatmo NOC fixture (issue #56).
          { id: 'noc-1', type: 'NOC', monitoring: 'on', wifi_strength: 72, floodlight: 'auto' },
          // Siren idle; door tag open. battery_state string exercises the map.
          { id: 'siren-1', type: 'NIS', status: 'no_sound', battery_percent: 90, rf_strength: 70 },
          {
            id: 'doortag-1',
            type: 'NACamDoorTag',
            status: 'open',
            battery_state: 'high',
            rf_strength: 68,
          },
          { id: 'smoke-1', type: 'NSD', battery_percent: 88, wifi_strength: 66 },
          // No wifi field: the CO alarm must only publish what homestatus carries.
          { id: 'co-1', type: 'NCO', battery_percent: 92 },
        ],
        errors: [{ code: 6, id: 'valve-2' }],
        // Presence of the known persons (issue #57), pyatmo homestatus shape:
        // out_of_sight true = away.
        persons: [
          { id: 'person-1', last_seen: 1557071156, out_of_sight: false },
          { id: 'person-2', last_seen: 1559282761, out_of_sight: true },
        ],
      },
    },
  };
}

function buildDefaultThermostatDevices() {
  return [
    {
      _id: 'plug-1',
      station_name: 'Relais',
      type: 'NAPlug',
      plug_connected_boiler: true,
      modules: [
        {
          _id: 'therm-1',
          module_name: 'Thermostat',
          type: 'NATherm1',
          measured: { temperature: 19.4 },
        },
      ],
    },
  ];
}

function buildDefaultStationDevices() {
  return [
    {
      _id: 'station-1',
      station_name: 'Station',
      type: 'NAMain',
      home_id: 'home-1',
      wifi_status: 45,
      dashboard_data: {
        Temperature: 21.2,
        CO2: 600,
        Humidity: 55,
        Noise: 38,
        Pressure: 1013,
        AbsolutePressure: 1005,
        min_temp: 18.1,
        max_temp: 23.4,
      },
      modules: [
        {
          _id: 'outdoor-1',
          module_name: 'Extérieur',
          type: 'NAModule1',
          battery_percent: 60,
          rf_status: 70,
          reachable: true,
          dashboard_data: { Temperature: 0, Humidity: 80, min_temp: -2.5, max_temp: 4.2 },
        },
        {
          // Dead-battery module: Netatmo keeps returning the LAST-KNOWN
          // values with reachable:false (bench payload 2026-07-22).
          _id: 'wind-1',
          module_name: 'Anémomètre mort',
          type: 'NAModule2',
          battery_percent: 9,
          rf_status: 120,
          reachable: false,
          last_seen: 1761673485,
          dashboard_data: { WindStrength: 5, WindAngle: 120, GustStrength: 9, GustAngle: 130 },
        },
      ],
    },
  ];
}

// -----------------------------------------------------------------------------
// Bubendorff / iDiamant roller shutters (issue #34), modelled on the pyatmo
// homesdata/homestatus fixtures: an iDiamant gateway (NBG, never exposed as a
// device), a radio shutter (NBR, closed), a wired one (NBO, open — with the
// "target_position:step" key spelling of the pyatmo fixture) and a solar one
// (NBS) missing from homestatus (reported in `errors` → unreachable). Opt-in:
// call it on `state` so the default fixtures (and their counts) stay intact.
// -----------------------------------------------------------------------------

export const SHUTTER_BRIDGE_ID = '12:34:56:30:d5:d4';

export function addShutterFixtures(state, homeId = 'home-1') {
  const home = state.homes.find((h) => h.id === homeId);
  home.modules.push(
    {
      id: SHUTTER_BRIDGE_ID,
      type: 'NBG',
      name: 'module iDiamant',
      room_id: 'room-1',
      modules_bridged: ['0009999992', '0009999993', '0009999994'],
    },
    {
      id: '0009999992',
      type: 'NBR',
      name: 'Entrance Blinds',
      room_id: 'room-1',
      bridge: SHUTTER_BRIDGE_ID,
    },
    {
      id: '0009999993',
      type: 'NBO',
      name: 'Bubendorff blind',
      room_id: 'room-2',
      bridge: SHUTTER_BRIDGE_ID,
    },
    { id: '0009999994', type: 'NBS', name: 'Volet solaire', bridge: SHUTTER_BRIDGE_ID },
  );
  const status = state.homeStatuses[homeId].home;
  status.modules.push(
    {
      id: SHUTTER_BRIDGE_ID,
      type: 'NBG',
      firmware_revision: 39,
      wifi_strength: 65,
      reachable: true,
    },
    {
      id: '0009999992',
      type: 'NBR',
      current_position: 0,
      target_position: 0,
      target_position_step: 100,
      firmware_revision: 16,
      rf_strength: 0,
      last_seen: 1638353156,
      reachable: true,
      bridge: SHUTTER_BRIDGE_ID,
    },
    {
      id: '0009999993',
      type: 'NBO',
      current_position: 100,
      target_position: 100,
      'target_position:step': 100,
      firmware_revision: 22,
      rf_strength: 74,
      last_seen: 1671395511,
      reachable: true,
      bridge: SHUTTER_BRIDGE_ID,
    },
  );
  status.errors.push({ code: 6, id: '0009999994' });
}

// -----------------------------------------------------------------------------
// Modulating / OpenTherm thermostat (issue #53), modelled on the pyatmo
// fixtures homesdata.json + homestatus_91763b24c43d3e344f424e8b.json: a
// second home with the OTH relay (wifi, outdoor temperature, boiler error
// "water_pressure") and its OTM thermostat (battery_state "full", RF, boiler
// status) in the "Bureau" room. The pyatmo homestatus has no entry for that
// room: the measured / setpoint values below are made up. Opt-in, like the
// shutters, so the default fixtures (and their counts) stay intact.
// -----------------------------------------------------------------------------

export const OPENTHERM_HOME_ID = '91763b24c43d3e344f424e8b';
export const OTH_ID = '12:34:56:20:f5:44';
export const OTM_ID = '12:34:56:20:f5:8c';

export function addOpenThermFixtures(state) {
  state.homes.push({
    id: OPENTHERM_HOME_ID,
    name: 'MYHOME',
    therm_mode: 'schedule',
    rooms: [
      {
        id: '222452125',
        name: 'Bureau',
        type: 'electrical_cabinet',
        module_ids: [OTH_ID, OTM_ID],
        therm_relay: OTH_ID,
      },
    ],
    modules: [
      {
        id: OTH_ID,
        type: 'OTH',
        name: 'Modulating Relay',
        setup_date: 1607443936,
        room_id: '222452125',
        reachable: true,
        modules_bridged: [OTM_ID],
      },
      {
        id: OTM_ID,
        type: 'OTM',
        name: 'Bureau Modulate',
        setup_date: 1607443939,
        room_id: '222452125',
        bridge: OTH_ID,
      },
    ],
  });
  state.homeStatuses[OPENTHERM_HOME_ID] = {
    home: {
      id: OPENTHERM_HOME_ID,
      therm_mode: 'schedule',
      rooms: [
        {
          id: '222452125',
          reachable: true,
          therm_measured_temperature: 19.6,
          therm_setpoint_temperature: 20,
          therm_setpoint_mode: 'schedule',
          heating_power_request: 30,
          open_window: false,
        },
      ],
      modules: [
        {
          boiler_control: 'onoff',
          boiler_error: 'water_pressure',
          dhw_control: 'none',
          firmware_revision: 22,
          hardware_version: 222,
          id: OTH_ID,
          outdoor_temperature: 8.2,
          sequence_id: 19764,
          type: 'OTH',
          wifi_strength: 57,
        },
        {
          battery_level: 4176,
          boiler_status: false,
          boiler_valve_comfort_boost: false,
          firmware_revision: 6,
          id: OTM_ID,
          last_message: 1637684297,
          last_seen: 1637684297,
          radio_id: 2,
          reachable: true,
          rf_strength: 64,
          type: 'OTM',
          bridge: OTH_ID,
          battery_state: 'full',
        },
      ],
    },
  };
}

// -----------------------------------------------------------------------------
// BTicino Smarther with Netatmo (issue #54), modelled on the same pyatmo
// fixtures: the BNS module (wifi, boiler heating, cooler idle) in the
// "Corridor" room, whose homestatus values come from the pyatmo fixture too.
// Added to the pyatmo home (created if addOpenThermFixtures did not run).
// -----------------------------------------------------------------------------

export const BNS_ID = '10:20:30:bd:b8:1e';

export function addSmartherFixtures(state) {
  let home = state.homes.find((h) => h.id === OPENTHERM_HOME_ID);
  if (!home) {
    home = {
      id: OPENTHERM_HOME_ID,
      name: 'MYHOME',
      therm_mode: 'schedule',
      rooms: [],
      modules: [],
    };
    state.homes.push(home);
    state.homeStatuses[OPENTHERM_HOME_ID] = {
      home: { id: OPENTHERM_HOME_ID, therm_mode: 'schedule', rooms: [], modules: [] },
    };
  }
  home.rooms.push({ id: '1002003001', name: 'Corridor', type: 'corridor', module_ids: [BNS_ID] });
  home.modules.push({
    id: BNS_ID,
    type: 'BNS',
    name: 'Smarther',
    setup_date: 1638022197,
    room_id: '1002003001',
  });
  const status = state.homeStatuses[OPENTHERM_HOME_ID].home;
  status.rooms.push({
    id: '1002003001',
    reachable: true,
    anticipating: false,
    heating_power_request: 0,
    open_window: false,
    humidity: 67,
    therm_measured_temperature: 22,
    therm_setpoint_temperature: 22,
    therm_setpoint_start_time: 1647462737,
    therm_setpoint_end_time: null,
    therm_setpoint_mode: 'home',
  });
  status.modules.push({
    id: BNS_ID,
    type: 'BNS',
    firmware_revision: 32,
    wifi_strength: 49,
    boiler_valve_comfort_boost: false,
    boiler_status: true,
    cooler_status: false,
  });
}

// -----------------------------------------------------------------------------
// Indoor Camera Advance (NPC, issue #55), shaped like the pyatmo fixtures
// (homesdata.json + homestatus_91763b24c43d3e344f424e8b.json): monitoring,
// SD/power status, a VPN URL and `is_local: true` — which must NOT lead to a
// LAN resolution, the NPC being a WebRTC camera. No wifi field in the pyatmo
// homestatus: one is added so the WiFi quality path is exercised too. Opt-in,
// like the shutters, so the default fixtures (and their counts) stay intact.
// -----------------------------------------------------------------------------

export const NPC_ID = '12:34:56:00:f1:63';

export function addIndoorCameraAdvance(state, homeId = 'home-1') {
  const home = state.homes.find((h) => h.id === homeId);
  home.modules.push({
    id: NPC_ID,
    type: 'NPC',
    name: 'Hall',
    setup_date: 1544828430,
    room_id: 'room-1',
    modules_bridged: [],
  });
  state.homeStatuses[homeId].home.modules.push({
    id: NPC_ID,
    type: 'NPC',
    monitoring: 'on',
    sd_status: 4,
    alim_status: 2,
    locked: false,
    vpn_url: `${state.baseUrl}/vpn/${NPC_ID}`,
    is_local: true,
    wifi_strength: 58,
  });
}

// -----------------------------------------------------------------------------
// BTicino Classe 300X door entry (issue #59). ASSUMED shapes: no public
// payload exists (pyatmo has no BTicino fixture, it only knows the types and
// models BNSL / BNCS as switches with `on`). Built from the generic homesdata
// / homestatus module shape: the indoor unit (BNCX, wifi, bridging the
// others, with a VPN URL and an access token to exercise the diagnostic
// redaction), the street panel (BNEU), the door lock (BNDL), the staircase
// light (BNSL, `on: false`) and a controlled socket (BNCS) missing from
// homestatus (reported in `errors` → unreachable). Opt-in, like the shutters,
// so the default fixtures (and their counts) stay intact. To be replaced by
// the payloads the diagnostic log collects on the real installation.
// -----------------------------------------------------------------------------

export const BNCX_ID = '00:03:50:a1:b2:c3';
export const BNEU_ID = '00:03:50:a1:b2:c4';
export const BNDL_ID = '00:03:50:a1:b2:c5';
export const BNSL_ID = '00:03:50:a1:b2:c6';
export const BNCS_ID = '00:03:50:a1:b2:c7';

export function addBticinoFixtures(state, homeId = 'home-1') {
  const home = state.homes.find((h) => h.id === homeId);
  home.modules.push(
    {
      id: BNCX_ID,
      type: 'BNCX',
      name: 'Poste intérieur',
      setup_date: 1650000000,
      room_id: 'room-1',
      modules_bridged: [BNEU_ID, BNDL_ID, BNSL_ID, BNCS_ID],
    },
    { id: BNEU_ID, type: 'BNEU', name: 'Platine de rue', setup_date: 1650000000, bridge: BNCX_ID },
    { id: BNDL_ID, type: 'BNDL', name: 'Gâche', setup_date: 1650000000, bridge: BNCX_ID },
    { id: BNSL_ID, type: 'BNSL', name: 'Éclairage escalier', bridge: BNCX_ID },
    { id: BNCS_ID, type: 'BNCS', name: 'Prise commandée', bridge: BNCX_ID },
  );
  const status = state.homeStatuses[homeId].home;
  status.modules.push(
    {
      id: BNCX_ID,
      type: 'BNCX',
      firmware_revision: 52,
      wifi_strength: 62,
      reachable: true,
      vpn_url:
        'https://prodvpn-eu-6.netatmo.net/10.255.12.34/0123456789abcdef0123456789abcdef/MTU0ODk0MTY4MDqM,,',
      access_token: 'secret-bticino-token',
    },
    { id: BNEU_ID, type: 'BNEU', bridge: BNCX_ID, firmware_revision: 12, reachable: true },
    { id: BNDL_ID, type: 'BNDL', bridge: BNCX_ID, reachable: true },
    { id: BNSL_ID, type: 'BNSL', bridge: BNCX_ID, reachable: true, on: false },
  );
  status.errors.push({ code: 6, id: BNCS_ID });
}

// Video doorbell (NDB, issue #35), shaped like the pyatmo fixtures (homesdata
// + homestatus): VPN URL, `is_local` claimed but never used (WebRTC camera).
// Opt-in, like the Indoor Camera Advance.
export const NDB_ID = '12:34:56:10:f1:66';

export function addDoorbell(state, homeId = 'home-1') {
  const home = state.homes.find((h) => h.id === homeId);
  home.modules.push({
    id: NDB_ID,
    type: 'NDB',
    name: 'Netatmo-Doorbell',
    setup_date: 1602691361,
    room_id: 'room-1',
    reachable: true,
  });
  state.homeStatuses[homeId].home.modules.push({
    id: NDB_ID,
    type: 'NDB',
    vpn_url: `${state.baseUrl}/vpn/${NDB_ID}`,
    is_local: true,
    alim_status: 2,
    connection: 'wifi',
    sd_status: 4,
    wifi_strength: 66,
    wifi_state: 'medium',
  });
}

// Home Coach / Smart Indoor Air Quality Monitors (issue #37), shaped like the
// pyatmo fixture gethomecoachsdata.json: one UNREACHABLE device without
// dashboard_data, one reachable device whose generic `module_name` ("Indoor")
// must not win over its `station_name`.
function buildDefaultHomeCoachDevices() {
  return [
    {
      _id: '12:34:56:26:69:0c',
      type: 'NHC',
      station_name: 'Bedroom',
      wifi_status: 58,
      reachable: false,
      co2_calibrating: false,
      firmware: 45,
      data_type: ['Temperature', 'CO2', 'Humidity', 'Noise', 'Pressure', 'health_idx'],
      place: { city: 'Frankfurt', country: 'DE', timezone: 'Europe/Berlin' },
    },
    {
      _id: '12:34:56:3e:c5:46',
      type: 'NHC',
      station_name: 'Parents Bedroom',
      module_name: 'Indoor',
      wifi_status: 67,
      reachable: true,
      co2_calibrating: false,
      firmware: 45,
      data_type: ['Temperature', 'CO2', 'Humidity', 'Noise', 'Pressure', 'health_idx'],
      place: { city: 'Frankfurt', country: 'DE', timezone: 'Europe/Berlin' },
      dashboard_data: {
        time_utc: 1572073816,
        Temperature: 20.3,
        CO2: 494,
        Humidity: 63,
        Noise: 42,
        Pressure: 1014.5,
        AbsolutePressure: 1004.1,
        health_idx: 1,
        min_temp: 20.3,
        max_temp: 21.6,
        date_max_temp: 1572059333,
        date_min_temp: 1572073816,
      },
    },
  ];
}

export async function startFakeNetatmo({ expiresIn = 10800 } = {}) {
  const state = {
    tokenRequests: [], // every parsed form POSTed to /oauth2/token
    apiRequests: [], // every {path, authorization} hitting /api/*
    accessTokens: [], // every access token issued
    validRefreshToken: 'refresh-0', // rotated on every refresh grant
    failTokenWith: null, // set to an HTTP status to make /oauth2/token fail
    rejectAccessToken: null, // set to a token value to answer 401 for it
    failSetpointWith: null, // set to {status, body} to make setroomthermpoint fail
    setpointRequests: [], // every parsed form POSTed to /api/setroomthermpoint
    switchScheduleRequests: [], // every parsed form POSTed to /api/switchhomeschedule
    failSwitchScheduleWith: null, // set to {status, body} to make switchhomeschedule fail
    setStateRequests: [], // every parsed JSON body POSTed to /api/setstate
    setThermModeRequests: [], // every parsed form POSTed to /api/setthermmode
    setPersonsAwayRequests: [], // every raw form body POSTed to /api/setpersonsaway
    setPersonsHomeRequests: [], // every raw form body POSTed to /api/setpersonshome
    failPersonsWith: null, // set to {status, body} to make setpersonsaway/home fail
    failSetThermModeWith: null, // set to {status, body} to make setthermmode fail
    failSetStateWith: null, // set to {status, body} to make setstate fail
    addWebhookRequests: [], // every parsed form POSTed to /api/addwebhook
    dropWebhookRequests: [], // every parsed form POSTed to /api/dropwebhook
    // every {path, form} POSTed to /api/webrtc/* — recorded even when an
    // override answers, so the error paths can check what was sent
    webRtcRequests: [],
    failAddWebhookWith: null, // set to an HTTP status to make addwebhook fail
    failHomesWith: null, // set to an HTTP status to make homesdata fail
    failStationsWith: null, // set to an HTTP status to make getstationsdata fail
    failHomeCoachsWith: null, // set to {status, body} to make gethomecoachsdata fail
    cameraRequests: [], // every hit on the fake camera endpoints ({side, camId, path})
    snapshotJpeg: Buffer.from('fake-jpeg-snapshot-bytes'), // served by /live/snapshot_720.jpg
    failLocalSnapshot: false, // make the LOCAL snapshot fail (stale-cache fallback test)
    failAllSnapshots: false, // make EVERY snapshot fail (last-image fallback test)
    // Canned answers by path prefix (e.g. '/api/homestatus'), checked before
    // the normal /oauth2/token and /api/* routes: {status = 200, body}.
    overrides: {},
    // Scopes echoed in the token responses, like the real Netatmo: those
    // requested by the authorization exchange, kept across refreshes. Tests
    // overwrite it to simulate a token granted before new scopes existed.
    grantedScopes: ['read_station'],
    baseUrl: '', // filled after listen()
    homes: buildDefaultHomes(),
    homeStatuses: buildDefaultHomeStatuses(),
    thermostatDevices: buildDefaultThermostatDevices(),
    stationDevices: buildDefaultStationDevices(),
    homeCoachDevices: buildDefaultHomeCoachDevices(),
  };
  let tokenCounter = 0;

  function issueTokens() {
    tokenCounter += 1;
    const accessToken = `access-${tokenCounter}`;
    state.validRefreshToken = `refresh-${tokenCounter}`;
    state.accessTokens.push(accessToken);
    return {
      access_token: accessToken,
      refresh_token: state.validRefreshToken,
      expires_in: expiresIn,
      scope: state.grantedScopes,
    };
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const respond = (payload, status = 200) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      /** Answer with the canned override matching the URL, if any. */
      const respondOverride = () => {
        const prefix = Object.keys(state.overrides).find((p) => req.url.startsWith(p));
        if (!prefix) {
          return false;
        }
        const { status = 200, body: payload } = state.overrides[prefix];
        respond(payload, status);
        return true;
      };

      // --- Fake camera endpoints (unauthenticated, like the real cameras) ---
      // URLs: /vpn/<camId>/... (VPN side) and /local/<camId>/... (LAN side).
      const cameraMatch = req.url.match(/^\/(vpn|local)\/([^/]+)(\/.*)$/);
      if (cameraMatch) {
        const [, side, camId, subPath] = cameraMatch;
        state.cameraRequests.push({ side, camId, path: subPath });
        if (subPath === '/command/ping') {
          // Both sides answer with the LOCAL url, like real firmwares.
          respond({ local_url: `${state.baseUrl}/local/${camId}`, product_name: 'fake-cam' });
          return;
        }
        if (subPath === '/live/snapshot_720.jpg') {
          if (state.failAllSnapshots || (side === 'local' && state.failLocalSnapshot)) {
            respond({ error: 'unreachable' }, 502);
            return;
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'image/jpeg');
          res.end(state.snapshotJpeg);
          return;
        }
        respond({ error: 'not found' }, 404);
        return;
      }

      if (req.method === 'POST' && req.url === '/oauth2/token') {
        const form = Object.fromEntries(new URLSearchParams(body));
        state.tokenRequests.push(form);
        if (respondOverride()) {
          return;
        }
        if (state.failTokenWith) {
          respond({ error: 'server_error' }, state.failTokenWith);
          return;
        }
        if (form.client_id !== FAKE_CLIENT_ID || form.client_secret !== FAKE_CLIENT_SECRET) {
          respond({ error: 'invalid_client' }, 400);
          return;
        }
        if (form.grant_type === 'authorization_code') {
          if (form.code !== FAKE_AUTH_CODE) {
            respond({ error: 'invalid_grant' }, 400);
            return;
          }
          if (form.scope) {
            state.grantedScopes = form.scope.split(' ');
          }
          respond(issueTokens());
          return;
        }
        if (form.grant_type === 'refresh_token') {
          if (form.refresh_token !== state.validRefreshToken) {
            respond({ error: 'invalid_grant' }, 400);
            return;
          }
          respond(issueTokens());
          return;
        }
        respond({ error: 'unsupported_grant_type' }, 400);
        return;
      }

      if (req.url.startsWith('/api/')) {
        const authorization = req.headers.authorization ?? '';
        state.apiRequests.push({ path: req.url, authorization });
        const token = authorization.replace(/^Bearer /, '');
        const known = state.accessTokens.includes(token);
        if (!known || token === state.rejectAccessToken) {
          respond({ error: { code: 2, message: 'Invalid access token' } }, 401);
          return;
        }
        if (req.method === 'POST' && req.url.startsWith('/api/webrtc/')) {
          state.webRtcRequests.push({
            path: req.url,
            form: Object.fromEntries(new URLSearchParams(body)),
          });
        }
        if (respondOverride()) {
          return;
        }
        if (req.url.startsWith('/api/homesdata')) {
          if (state.failHomesWith) {
            respond({ error: { code: 500, message: 'server error' } }, state.failHomesWith);
            return;
          }
          respond({ status: 'ok', body: { homes: state.homes } });
          return;
        }
        if (req.url.startsWith('/api/homestatus')) {
          const homeId = new URL(req.url, 'http://x').searchParams.get('home_id');
          const homeStatus = state.homeStatuses[homeId];
          if (!homeStatus) {
            respond({ error: { code: 21, message: 'Invalid home id' } }, 400);
            return;
          }
          respond({ status: 'ok', body: homeStatus });
          return;
        }
        if (req.url.startsWith('/api/getthermostatsdata')) {
          respond({ status: 'ok', body: { devices: state.thermostatDevices } });
          return;
        }
        if (req.url.startsWith('/api/getstationsdata')) {
          if (state.failStationsWith) {
            respond({ error: { code: 500, message: 'server error' } }, state.failStationsWith);
            return;
          }
          respond({ status: 'ok', body: { devices: state.stationDevices } });
          return;
        }
        if (req.url.startsWith('/api/gethomecoachsdata')) {
          if (state.failHomeCoachsWith) {
            respond(state.failHomeCoachsWith.body, state.failHomeCoachsWith.status);
            return;
          }
          respond({ status: 'ok', body: { devices: state.homeCoachDevices } });
          return;
        }
        if (req.method === 'POST' && req.url.startsWith('/api/setroomthermpoint')) {
          const form = Object.fromEntries(new URLSearchParams(body));
          state.setpointRequests.push(form);
          if (state.failSetpointWith) {
            respond(state.failSetpointWith.body, state.failSetpointWith.status);
            return;
          }
          // Like the real cloud: the next homestatus reports the new setpoint
          // mode of the room (`home` reads back as `schedule`).
          const room = state.homeStatuses[form.home_id]?.home.rooms?.find(
            (entry) => entry.id === form.room_id,
          );
          if (room) {
            room.therm_setpoint_mode = form.mode === 'home' ? 'schedule' : form.mode;
            if (form.temp !== undefined) {
              room.therm_setpoint_temperature = Number(form.temp);
            }
            if (form.endtime !== undefined) {
              room.therm_setpoint_end_time = Number(form.endtime);
            } else {
              delete room.therm_setpoint_end_time;
            }
          }
          respond({ status: 'ok' });
          return;
        }
        if (req.method === 'POST' && req.url.startsWith('/api/switchhomeschedule')) {
          const form = Object.fromEntries(new URLSearchParams(body));
          state.switchScheduleRequests.push(form);
          if (state.failSwitchScheduleWith) {
            respond(state.failSwitchScheduleWith.body, state.failSwitchScheduleWith.status);
            return;
          }
          const home = state.homes.find((entry) => entry.id === form.home_id);
          const schedules = home?.schedules ?? [];
          if (!schedules.some((schedule) => schedule.id === form.schedule_id)) {
            respond({ error: { code: 21, message: 'Invalid schedule id' } }, 400);
            return;
          }
          // Like the real cloud: the next homesdata reports the selected schedule.
          for (const schedule of schedules) {
            if (schedule.type === 'therm' || schedule.type === undefined) {
              schedule.selected = schedule.id === form.schedule_id;
            }
          }
          respond({ status: 'ok' });
          return;
        }
        if (req.method === 'POST' && req.url.startsWith('/api/setthermmode')) {
          const form = Object.fromEntries(new URLSearchParams(body));
          state.setThermModeRequests.push(form);
          if (state.failSetThermModeWith) {
            respond(state.failSetThermModeWith.body, state.failSetThermModeWith.status);
            return;
          }
          // Like the real cloud: the next homestatus reports the new mode.
          const homeStatus = state.homeStatuses[form.home_id];
          if (homeStatus) {
            homeStatus.home.therm_mode = form.mode;
          }
          respond({ status: 'ok' });
          return;
        }
        const personsMatch = req.url.match(/^\/api\/setpersons(away|home)/);
        if (req.method === 'POST' && personsMatch) {
          // Raw body kept: setpersonshome repeats the `person_ids[]` field.
          const requests =
            personsMatch[1] === 'away'
              ? state.setPersonsAwayRequests
              : state.setPersonsHomeRequests;
          requests.push(body);
          if (state.failPersonsWith) {
            respond(state.failPersonsWith.body, state.failPersonsWith.status);
            return;
          }
          respond({ status: 'ok' });
          return;
        }
        if (req.method === 'POST' && req.url.startsWith('/api/setstate')) {
          state.setStateRequests.push(JSON.parse(body));
          if (state.failSetStateWith) {
            respond(state.failSetStateWith.body, state.failSetStateWith.status);
            return;
          }
          respond({ status: 'ok' });
          return;
        }
        if (req.method === 'POST' && req.url.startsWith('/api/addwebhook')) {
          state.addWebhookRequests.push(Object.fromEntries(new URLSearchParams(body)));
          if (state.failAddWebhookWith) {
            respond({ error: { code: 500, message: 'server error' } }, state.failAddWebhookWith);
            return;
          }
          respond({ status: 'ok' });
          return;
        }
        // WebRTC live view (issue #70), pyatmo fixtures webrtc_offer_ok.json /
        // webrtc_terminate_ok.json: the answer rides in `body`, which carries
        // a `status` of its own; the session id given is echoed.
        if (req.method === 'POST' && req.url.startsWith('/api/webrtc/offer')) {
          const form = Object.fromEntries(new URLSearchParams(body));
          respond({
            status: 'ok',
            time_server: 1765234648,
            body: {
              type: 'ack',
              time_server: 1765234642,
              correlation_id: '2775454822782367811',
              session_id: form.session_id,
              tag_id: 'OZzgKVlQCW0=',
              status: 'ok',
              sdpAnswer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=fake-netatmo-answer\r\n',
            },
          });
          return;
        }
        if (req.method === 'POST' && req.url.startsWith('/api/webrtc/terminate')) {
          respond({
            status: 'ok',
            time_server: 1765234822,
            body: {
              type: 'ack',
              time_server: 1765234822,
              correlation_id: '11591074238736810245',
              status: 'ok',
            },
          });
          return;
        }
        if (req.method === 'POST' && req.url.startsWith('/api/dropwebhook')) {
          state.dropWebhookRequests.push(Object.fromEntries(new URLSearchParams(body)));
          respond({ status: 'ok' });
          return;
        }
        respond({ error: { code: 404, message: 'not found' } }, 404);
        return;
      }

      respond({ error: 'not found' }, 404);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  state.baseUrl = `http://127.0.0.1:${port}`;

  // The camera VPN urls must point at this very server: patch the homestatus
  // fixtures now that the port is known. camera-1 reports is_local (the LAN
  // resolution path); the outdoor noc-1 is VPN-only.
  for (const homeStatus of Object.values(state.homeStatuses)) {
    for (const module of homeStatus.home.modules ?? []) {
      if (module.type === 'NACamera' || module.type === 'NOC') {
        module.vpn_url = `${state.baseUrl}/vpn/${module.id}`;
        module.is_local = module.type === 'NACamera';
      }
    }
  }

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
