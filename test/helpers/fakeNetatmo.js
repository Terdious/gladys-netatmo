// -----------------------------------------------------------------------------
// Fake of the Netatmo cloud, implementing the contract the integration uses:
//   - POST /oauth2/token: authorization_code and refresh_token grants,
//     with rotating refresh tokens (like the real Netatmo);
//   - Bearer-protected API: homesdata, homestatus, getthermostatsdata,
//     getstationsdata, setroomthermpoint (form), setstate (JSON);
//   - two fake cameras (/vpn/<id> and /local/<id>: command/ping + snapshot).
// Behaviour toggles (`failTokenWith`, `rejectAccessToken`, `failSetpointWith`,
// `failLocalSnapshot`) let the tests exercise the failure paths.
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
        { id: 'siren-1', type: 'NIS', name: 'Sirène' },
      ],
    },
  ];
}

function buildDefaultHomeStatuses() {
  return {
    'home-1': {
      home: {
        id: 'home-1',
        rooms: [
          {
            id: 'room-1',
            therm_measured_temperature: 19.5,
            therm_setpoint_temperature: 21,
            open_window: false,
            heating_power_request: 0,
          },
          {
            id: 'room-2',
            therm_measured_temperature: 17,
            therm_setpoint_temperature: 19,
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
          { id: 'noc-1', type: 'NOC', monitoring: 'on', wifi_strength: 72 },
          { id: 'siren-1', type: 'NIS' },
        ],
        errors: [{ code: 6, id: 'valve-2' }],
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
          dashboard_data: { Temperature: 0, Humidity: 80, min_temp: -2.5, max_temp: 4.2 },
        },
      ],
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
    setStateRequests: [], // every parsed JSON body POSTed to /api/setstate
    failSetStateWith: null, // set to {status, body} to make setstate fail
    failStationsWith: null, // set to an HTTP status to make getstationsdata fail
    cameraRequests: [], // every hit on the fake camera endpoints ({side, camId, path})
    snapshotJpeg: Buffer.from('fake-jpeg-snapshot-bytes'), // served by /live/snapshot_720.jpg
    failLocalSnapshot: false, // make the LOCAL snapshot fail (stale-cache fallback test)
    failAllSnapshots: false, // make EVERY snapshot fail (last-image fallback test)
    baseUrl: '', // filled after listen()
    homes: buildDefaultHomes(),
    homeStatuses: buildDefaultHomeStatuses(),
    thermostatDevices: buildDefaultThermostatDevices(),
    stationDevices: buildDefaultStationDevices(),
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
      scope: ['read_station'],
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
        if (req.url.startsWith('/api/homesdata')) {
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
        if (req.method === 'POST' && req.url.startsWith('/api/setroomthermpoint')) {
          state.setpointRequests.push(Object.fromEntries(new URLSearchParams(body)));
          if (state.failSetpointWith) {
            respond(state.failSetpointWith.body, state.failSetpointWith.status);
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
