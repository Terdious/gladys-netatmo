// -----------------------------------------------------------------------------
// WebRTC live view of the video doorbell and the Indoor Camera Advance (issue
// #70), against the fake Netatmo cloud and a fake SDK exposing (or not) the
// onCameraWebRtcOffer / onCameraWebRtcStop registrations of the SDK branch
// (GladysAssistant/integration-sdk-js#43):
//   - offer relayed to /api/webrtc/offer, answer mapped to the SDK typings;
//   - stop relayed to /api/webrtc/terminate (an already-ended session is fine);
//   - errors: scope refusal, camera unreachable, unknown device, timeout;
//   - discovery: the GLADYS_CAMERA_STREAM_PROTOCOL param on NDB / NPC only,
//     dropped (and retried without) when the core refuses it;
//   - an SDK without the handlers: nothing registered, no param, no crash.
// -----------------------------------------------------------------------------

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../src/config.js';
import { createNetatmoClient } from '../../src/netatmo/client.js';
import { createTelemetry } from '../../src/netatmo/telemetry.js';
import {
  createWebRtc,
  sdkSupportsWebRtc,
  CAMERA_STREAM_PROTOCOL_PARAM,
  CAMERA_STREAM_PROTOCOL_WEBRTC,
} from '../../src/netatmo/webrtc.js';
import { setupIntegration } from '../../index.js';
import {
  startFakeNetatmo,
  addDoorbell,
  addIndoorCameraAdvance,
  NDB_ID,
  NPC_ID,
} from '../helpers/fakeNetatmo.js';

const PREFIX = 'ext:netatmo:';
const SDP_OFFER = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\na=candidate:secret\r\n';
const configSecurity = normalizeConfig({ security_api: 'true' });

let netatmo;
let client;
let gladys;
let telemetry;

/**
 * Fake SDK instance: the slice telemetry uses, plus the two WebRTC handler
 * registrations of the SDK branch when `withWebRtc` (the released SDK 0.15
 * has neither).
 */
function createFakeSdk({ withWebRtc = true } = {}) {
  const sdk = {
    handlers: {},
    discovered: [],
    devices: [],
    rejectParam: false, // answer like a core without the WebRTC relay
    externalId: (suffix) => `${PREFIX}${suffix}`,
    async publishStates() {},
    async publishTransports() {},
    async publishCameraImage() {},
    async publishDiscoveredDevices(devices) {
      const withParam = devices.some((d) =>
        (d.params ?? []).some((p) => p.name === 'GLADYS_CAMERA_STREAM_PROTOCOL'),
      );
      if (sdk.rejectParam && withParam) {
        // GladysApiError of the core setDiscoveredDevices (BadParameters).
        const error = new Error(
          'devices[7].params[3].name: GLADYS_* names are reserved (GLADYS_CAMERA_STREAM_PROTOCOL)',
        );
        error.name = 'GladysApiError';
        error.status = 400;
        error.code = 'BAD_REQUEST';
        throw error;
      }
      sdk.discovered.push(devices);
    },
  };
  if (withWebRtc) {
    sdk.onCameraWebRtcOffer = (callback) => {
      sdk.handlers.offer = callback;
    };
    sdk.onCameraWebRtcStop = (callback) => {
      sdk.handlers.stop = callback;
    };
  }
  return sdk;
}

function wire(sdk) {
  let engine = null;
  const webRtc = createWebRtc({
    gladys: sdk,
    client,
    getRawDevice: (id) => engine.getRawDevice(id),
  });
  engine = createTelemetry({ gladys: sdk, client, loadTtlMs: 0, webRtc });
  return { webRtc, engine };
}

/** A Gladys device as the core sends it in a command (external_id + params). */
function commandDevice(id, homeId = 'home-1') {
  return {
    external_id: `${PREFIX}${id}`,
    selector: `netatmo-${id}`,
    params: [{ name: 'home_id', value: homeId }],
  };
}

function streamParamOf(device) {
  return device?.params.find((p) => p.name === 'GLADYS_CAMERA_STREAM_PROTOCOL')?.value;
}

let webRtc;

beforeEach(async () => {
  netatmo = await startFakeNetatmo();
  netatmo.state.accessTokens.push('seeded-token');
  addDoorbell(netatmo.state);
  addIndoorCameraAdvance(netatmo.state);
  client = createNetatmoClient({
    oauth: { ensureFreshAccessToken: async () => 'seeded-token', refreshTokens: async () => {} },
    baseUrl: netatmo.url,
  });
  gladys = createFakeSdk();
  ({ webRtc, engine: telemetry } = wire(gladys));
  webRtc.register();
});

afterEach(async () => {
  telemetry.stop();
  await netatmo.close();
});

test('the param name and value match the SDK branch and the core (contract C.3)', () => {
  assert.equal(CAMERA_STREAM_PROTOCOL_PARAM, 'GLADYS_CAMERA_STREAM_PROTOCOL');
  assert.equal(CAMERA_STREAM_PROTOCOL_WEBRTC, 'webrtc');
});

test('an SDK with both handlers gets them registered', () => {
  assert.equal(sdkSupportsWebRtc(gladys), true);
  assert.equal(typeof gladys.handlers.offer, 'function');
  assert.equal(typeof gladys.handlers.stop, 'function');
});

test('the offer is relayed to /api/webrtc/offer and the answer mapped for the SDK', async () => {
  const answer = await gladys.handlers.offer(commandDevice(NDB_ID), {
    sessionId: 'af6da83b-1fd5-46ab-bf08-8e5db3cb9725',
    sdp: SDP_OFFER,
  });

  assert.deepEqual(netatmo.state.webRtcRequests, [
    {
      path: '/api/webrtc/offer',
      form: {
        home_id: 'home-1',
        device_id: NDB_ID,
        sdp: SDP_OFFER,
        session_id: 'af6da83b-1fd5-46ab-bf08-8e5db3cb9725',
      },
    },
  ]);
  // Exactly the CameraWebRtcAnswer of the SDK typings.
  assert.deepEqual(answer, {
    sdpAnswer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=fake-netatmo-answer\r\n',
    sessionId: 'af6da83b-1fd5-46ab-bf08-8e5db3cb9725',
    streamId: 'OZzgKVlQCW0=',
  });
});

test('the home id falls back to the last load when the command carries no params', async () => {
  await telemetry.refreshValues(configSecurity);
  const answer = await gladys.handlers.offer(
    { external_id: `${PREFIX}${NPC_ID}` },
    { sessionId: 'session-npc', sdp: SDP_OFFER },
  );
  assert.equal(netatmo.state.webRtcRequests[0].form.home_id, 'home-1');
  assert.equal(netatmo.state.webRtcRequests[0].form.device_id, NPC_ID);
  assert.equal(answer.streamId, 'OZzgKVlQCW0=');
});

test('the stop is relayed to /api/webrtc/terminate with the session and tag ids', async () => {
  await gladys.handlers.stop(commandDevice(NPC_ID), {
    sessionId: 'af6da83b-1fd5-46ab-bf08-8e5db3cb9725',
    streamId: 'OZzgKVlQCW0=',
  });
  assert.deepEqual(netatmo.state.webRtcRequests, [
    {
      path: '/api/webrtc/terminate',
      form: {
        home_id: 'home-1',
        device_id: NPC_ID,
        session_id: 'af6da83b-1fd5-46ab-bf08-8e5db3cb9725',
        tag_id: 'OZzgKVlQCW0=',
      },
    },
  ]);
});

test('stopping a session Netatmo already ended is not an error', async () => {
  // pyatmo fixture webrtc_terminate_no_session.json
  netatmo.state.overrides['/api/webrtc/terminate'] = {
    body: {
      status: 'ok',
      body: { type: 'ack', status: 'error', error: { code: 21, message: 'Nil session' } },
    },
  };
  await gladys.handlers.stop(commandDevice(NDB_ID), { sessionId: 'gone', streamId: null });
  // No tag id: the field is left out rather than sent empty.
  assert.equal(netatmo.state.webRtcRequests[0].form.tag_id, undefined);
});

test('a camera Netatmo cannot reach fails the offer with a clear message', async () => {
  // pyatmo fixture webrtc_offer_unreachable.json (HTTP 200, body.status error)
  netatmo.state.overrides['/api/webrtc/offer'] = {
    body: {
      status: 'ok',
      body: { type: 'ack', status: 'error', error: { code: 41, message: 'Device is unreachable' } },
    },
  };
  await assert.rejects(
    gladys.handlers.offer(commandDevice(NDB_ID), { sessionId: 's', sdp: SDP_OFFER }),
    (err) => {
      assert.match(
        err.message,
        /Netatmo refused the live view of camera .*Device is unreachable \(41\)/,
      );
      assert.ok(!err.message.includes(SDP_OFFER)); // never the SDP
      return true;
    },
  );
});

test('an answer without SDP fails the offer', async () => {
  netatmo.state.overrides['/api/webrtc/offer'] = {
    body: { status: 'ok', body: { type: 'ack', status: 'ok', session_id: 's', tag_id: 't' } },
  };
  await assert.rejects(
    gladys.handlers.offer(commandDevice(NDB_ID), { sessionId: 's', sdp: SDP_OFFER }),
    /without an SDP/,
  );
});

test('a missing scope fails the offer with the reconnect message', async () => {
  netatmo.state.overrides['/api/webrtc/offer'] = {
    status: 403,
    body: { error: { code: 13, message: 'Application does not have the good scope rights' } },
  };
  await assert.rejects(
    gladys.handlers.offer(commandDevice(NPC_ID), { sessionId: 's', sdp: SDP_OFFER }),
    /missing scope rights.*reconnect your Netatmo account/,
  );
  // A scope refusal is not a token problem: one request, no refresh-and-retry.
  assert.equal(netatmo.state.webRtcRequests.length, 1);

  netatmo.state.overrides['/api/webrtc/terminate'] = netatmo.state.overrides['/api/webrtc/offer'];
  await assert.rejects(
    gladys.handlers.stop(commandDevice(NPC_ID), { sessionId: 's', streamId: 't' }),
    /reconnect your Netatmo account/,
  );
});

test('other Netatmo errors are rethrown, the core then keeps the still image', async () => {
  netatmo.state.overrides['/api/webrtc/offer'] = {
    status: 500,
    body: { error: { code: 500, message: 'server error' } },
  };
  await assert.rejects(
    gladys.handlers.offer(commandDevice(NDB_ID), { sessionId: 's', sdp: SDP_OFFER }),
    /Netatmo API \/api\/webrtc\/offer answered 500/,
  );
  netatmo.state.overrides['/api/webrtc/terminate'] = {
    body: { status: 'ok', body: { status: 'error', error: { code: 2, message: 'Internal' } } },
  };
  await assert.rejects(
    gladys.handlers.stop(commandDevice(NDB_ID), { sessionId: 's', streamId: 't' }),
    /Netatmo refused the end of the live view/,
  );
});

test('a Netatmo answer slower than the core deadline fails with a clear message', async () => {
  const slow = createWebRtc({
    gladys,
    client: {
      webRtcOffer: async ({ timeoutMs }) => {
        assert.equal(timeoutMs, 12_000); // under the 15 s the core waits
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    },
    getRawDevice: () => undefined,
  });
  await assert.rejects(
    slow.offer(commandDevice(NDB_ID), { sessionId: 's', sdp: SDP_OFFER }),
    /did not answer the live view of camera .* in time/,
  );
});

test('an unknown device fails before any Netatmo request', async () => {
  // Not one of this integration's external ids.
  await assert.rejects(
    gladys.handlers.offer(
      { external_id: 'other:device', params: [{ name: 'home_id', value: 'home-1' }] },
      { sessionId: 's', sdp: SDP_OFFER },
    ),
    /unknown to the Netatmo account/,
  );
  // Ours, but without home id and never loaded.
  await assert.rejects(
    gladys.handlers.offer({ external_id: `${PREFIX}gone` }, { sessionId: 's', sdp: SDP_OFFER }),
    /unknown to the Netatmo account/,
  );
  await assert.rejects(
    gladys.handlers.stop({ external_id: `${PREFIX}gone` }, { sessionId: 's', streamId: null }),
    /unknown to the Netatmo account/,
  );
  // A loaded camera that does not stream in WebRTC (indoor NACamera: HLS).
  await telemetry.refreshValues(configSecurity);
  await assert.rejects(
    gladys.handlers.offer(commandDevice('camera-1'), { sessionId: 's', sdp: SDP_OFFER }),
    /has no WebRTC live view/,
  );
  // An empty offer.
  await assert.rejects(
    gladys.handlers.offer(commandDevice(NDB_ID), { sessionId: 's', sdp: '' }),
    /empty WebRTC offer/,
  );
  assert.equal(netatmo.state.webRtcRequests.length, 0);
});

test('the discovery declares the WebRTC live view on the doorbell and the Advance only', async () => {
  const devices = await telemetry.syncDiscovery(configSecurity);
  const byId = (id) => devices.find((d) => d.external_id === `${PREFIX}${id}`);
  assert.equal(streamParamOf(byId(NDB_ID)), 'webrtc');
  assert.equal(streamParamOf(byId(NPC_ID)), 'webrtc');
  // HLS cameras keep CAMERA_URL and get no WebRTC param.
  assert.equal(streamParamOf(byId('camera-1')), undefined);
  assert.equal(streamParamOf(byId('noc-1')), undefined);
  assert.ok(byId('camera-1').params.some((p) => p.name === 'CAMERA_URL'));
  // Still no HLS URL on the WebRTC cameras.
  assert.ok(!byId(NDB_ID).params.some((p) => p.name === 'CAMERA_URL'));
});

test('a core without the WebRTC relay gets the discovery again without the param', async () => {
  gladys.rejectParam = true;
  const devices = await telemetry.syncDiscovery(configSecurity);
  assert.equal(gladys.discovered.length, 1);
  assert.equal(
    streamParamOf(devices.find((d) => d.external_id === `${PREFIX}${NDB_ID}`)),
    undefined,
  );
  assert.ok(devices.some((d) => d.external_id === `${PREFIX}${NDB_ID}`));

  // Not offered again on this connection: one publish per discovery.
  gladys.rejectParam = false;
  await telemetry.syncDiscovery(configSecurity);
  assert.equal(gladys.discovered.length, 2);
  assert.ok(gladys.discovered[1].every((d) => streamParamOf(d) === undefined));

  // A new connection (an upgraded core): offered again.
  webRtc.resetCoreSupport();
  await telemetry.syncDiscovery(configSecurity);
  assert.equal(
    streamParamOf(gladys.discovered[2].find((d) => d.external_id === `${PREFIX}${NDB_ID}`)),
    'webrtc',
  );
});

test('other discovery errors are not swallowed by the WebRTC retry', async () => {
  gladys.publishDiscoveredDevices = async () => {
    const error = new Error('devices[0].features[0].type: unknown type');
    error.status = 400;
    throw error;
  };
  await assert.rejects(telemetry.syncDiscovery(configSecurity), /unknown type/);
});

test('an SDK without the handlers: nothing registered, no param, no crash', async () => {
  const oldSdk = createFakeSdk({ withWebRtc: false });
  const { webRtc: inert, engine } = wire(oldSdk);
  assert.equal(sdkSupportsWebRtc(oldSdk), false);
  assert.equal(inert.register(), false);
  assert.equal(inert.discoveryParam(), null);
  const devices = await engine.syncDiscovery(configSecurity);
  assert.ok(devices.some((d) => d.external_id === `${PREFIX}${NDB_ID}`));
  assert.ok(devices.every((d) => streamParamOf(d) === undefined));
  engine.stop();
});

/**
 * A stand-in for a whole SDK instance for setupIntegration: every method is
 * a no-op recorder, the two WebRTC ones left out unless `withWebRtc`.
 */
function createRecordingSdk({ withWebRtc }) {
  const calls = [];
  const target = { calls, externalId: (suffix) => `${PREFIX}${suffix}` };
  return new Proxy(target, {
    get(object, name) {
      if (name in object) {
        return object[name];
      }
      if (!withWebRtc && (name === 'onCameraWebRtcOffer' || name === 'onCameraWebRtcStop')) {
        return undefined;
      }
      if (typeof name !== 'string' || name === 'then') {
        return undefined;
      }
      return () => {
        calls.push(name);
      };
    },
  });
}

test('setupIntegration registers the WebRTC handlers only on an SDK that has them', () => {
  const recent = createRecordingSdk({ withWebRtc: true });
  const wired = setupIntegration(recent, { netatmoBaseUrl: netatmo.url });
  assert.ok(recent.calls.includes('onCameraWebRtcOffer'));
  assert.ok(recent.calls.includes('onCameraWebRtcStop'));
  assert.equal(wired.webRtc.enabled, true);
  wired.oauth.stop();

  const released = createRecordingSdk({ withWebRtc: false });
  const inert = setupIntegration(released, { netatmoBaseUrl: netatmo.url });
  assert.ok(!released.calls.includes('onCameraWebRtcOffer'));
  assert.equal(inert.webRtc.enabled, false);
  // The rest of the wiring is untouched.
  assert.ok(released.calls.includes('onGetImage'));
  inert.oauth.stop();
});
