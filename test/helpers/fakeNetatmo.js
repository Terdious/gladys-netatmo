// -----------------------------------------------------------------------------
// Minimal fake of the Netatmo cloud (OAuth2 token endpoint + homesdata),
// implementing just enough of the contract for the OAuth manager and the API
// client:
//   - POST /oauth2/token: authorization_code and refresh_token grants,
//     with rotating refresh tokens (like the real Netatmo);
//   - GET /api/homesdata: Bearer-protected homes topology.
// Behaviour toggles (`failTokenWith`, `rejectAccessToken`) let the tests
// exercise the transient/fatal and 401-retry paths.
// -----------------------------------------------------------------------------

import http from 'node:http';

export const FAKE_CLIENT_ID = 'fake-client-id';
export const FAKE_CLIENT_SECRET = 'fake-client-secret';
export const FAKE_AUTH_CODE = 'fake-auth-code';

export async function startFakeNetatmo({ expiresIn = 10800 } = {}) {
  const state = {
    tokenRequests: [], // every parsed form POSTed to /oauth2/token
    apiRequests: [], // every {path, authorization} hitting /api/*
    accessTokens: [], // every access token issued
    validRefreshToken: 'refresh-0', // rotated on every refresh grant
    failTokenWith: null, // set to an HTTP status to make /oauth2/token fail
    rejectAccessToken: null, // set to a token value to answer 401 for it
    homes: [{ id: 'home-1', name: 'Maison', modules: [] }],
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

      if (req.method === 'GET' && req.url.startsWith('/api/')) {
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
        respond({ error: { code: 404, message: 'not found' } }, 404);
        return;
      }

      respond({ error: 'not found' }, 404);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
