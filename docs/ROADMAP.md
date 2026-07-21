# Roadmap — Netatmo external integration

> This file seeds the GitHub tracking issues (one roadmap issue + one issue per
> step, like gladys-zendure#9 / gladys-tuya). It lives in the repo until the
> issues are created, and stays as the technical companion afterwards.

Reference material: the Gladys core Netatmo service (`server/services/netatmo`)
and the open core PR stack being backported —
[#2620](https://github.com/GladysAssistant/Gladys/pull/2620) →
[#2617](https://github.com/GladysAssistant/Gladys/pull/2617) →
[#2618](https://github.com/GladysAssistant/Gladys/pull/2618) →
[#2619](https://github.com/GladysAssistant/Gladys/pull/2619) →
[#2621](https://github.com/GladysAssistant/Gladys/pull/2621) →
[#2624](https://github.com/GladysAssistant/Gladys/pull/2624) →
[#2623](https://github.com/GladysAssistant/Gladys/pull/2623) →
[#2625](https://github.com/GladysAssistant/Gladys/pull/2625) →
[#2627](https://github.com/GladysAssistant/Gladys/pull/2627) (+ front fix
[#2628](https://github.com/GladysAssistant/Gladys/pull/2628)).

## v0.1 — Account access (OAuth2) — this branch

- [x] Scaffold from the external-integration template conventions (shared with
      gladys-tuya / gladys-zendure: quality gates, CI/build/release workflows,
      PR template, Dockerfile, fake-core test helpers).
- [x] OAuth2 connection through the Gladys relay (`oauth2` manifest field,
      `onOAuthAuthorizeUrl` / `onOAuthCallback`): full scope set in one consent,
      **including the camera scopes** added by core PR #2621
      (`write_camera`, `access_camera`, `write_presence`, `access_presence`),
      so the camera milestones need no re-connection.
- [x] Token lifecycle mirrored from core PR #2618: refresh at 80% of the TTL,
      rotating refresh tokens, transient (5xx/429/network) backoff, 24h grace
      window before wiping fatal-looking tokens. Single-use anti-CSRF state
      (replay-proof — the container-side equivalent of core PR #2628).
- [x] Connection status on the Configuration screen at every step.
- [ ] Replace the generated `cover.png` placeholder with real artwork
      (800×534, ≤150 KB, artwork filling the frame).

## v0.2 — Device discovery & telemetry (Weather + Energy)

Backport of the core discovery/polling, benefiting from the cleanup PRs:

- [ ] API client growth: `homesdata` + per-home `homestatus`,
      `getstationsdata`, `getthermostatsdata` (legacy merge by `id`/`_id`),
      concurrency 2 like the core.
- [ ] Converters: Weather (`NAMain`, `NAModule1..4`) and Energy (`NATherm1`,
      `NAPlug`, `NRV`) with the same feature suffixes as the core
      (`temperature`, `co2`, `humidity`, `pressure`, `wind_*`, `rain`,
      `sum_rain_*`, `therm_setpoint_temperature`, `boiler_status`, …).
- [ ] **Declarative update mappings** from day one (the core needed PR #2619 to
      get there — start external with `MODULE_TYPE → {feature_suffix: fn}`).
- [ ] Unreachable modules rebuilt from the `homestatus` `errors` array
      (code 6), core PR #2620 behaviour.
- [ ] Zero-values kept (`??`, not `||`) and absent states skipped — core
      PR #2617 behaviour.
- [ ] `setValue`: thermostat setpoint via `setroomthermpoint`
      (`home_id`/`room_id` params, mode `manual`).
- [ ] Polling: devices created with `should_poll: true` + `poll_frequency`
      60000 ms (closest allowed value to the core 120 s loop), or one internal
      120 s loop like the core — decide with real-rate limits in mind.
- [ ] ⚠️ `external_id` strategy: the SDK mandates `ext:netatmo:<suffix>` while
      the core uses `netatmo:<id>` — a user migrating from the core service
      gets NEW devices (history not carried over). Document it; a core-side
      migration helper is a candidate upstream PR.

## v0.3 — Cameras (backport of core PRs #2621 / #2624 / #2623 / #2625)

- [ ] **Camera discovery** (`NACamera` indoor, `NOC` outdoor), gated by the
      `security_api` toggle (already in the manifest): monitoring + WiFi
      features, bridge/home params — core PR #2621. No extra API call: cameras
      ride in `homesdata`/`homestatus`.
- [ ] **Camera image**: snapshot from `/live/snapshot_720.jpg`, local URL
      resolved via `/command/ping` and cached per camera (VPN fallback),
      re-encoded under the 150 KB limit → SDK `publishCameraImage` +
      `onGetImage` — core PR #2623. Needs ffmpeg in the container image
      (Dockerfile change) or a pure-JS re-encode.
- [ ] **Monitoring command**: `setValue` on the monitoring feature →
      `/api/setstate` (`monitoring: 'on'/'off'`) — core PR #2623.
- [ ] **Live stream**: core PR #2625 feeds the `CAMERA_URL` device param
      (manifest `/live/files/{quality}/index.m3u8`) consumed by the core
      rtsp-camera service, plus a `camera_quality` param. ⚠️ Requires an
      SDK/core path for an external integration to set device params — check
      what the external-integrations framework (core PR #2665) exposes; likely
      a small upstream PR.
- [ ] Discovery of already-created devices with an "update" flow (core
      PR #2624) is core-side UI — verify how the external `publishDiscoveredDevices`
      upsert behaves when features are added to an existing device.

## v0.4 — Webhooks (backport of core PR #2627)

- [ ] Netatmo webhooks relayed through Gladys Plus
      (`api.gladysgateway.com/v1/api/netatmo/:open_api_key` → gateway →
      core). ⚠️ Upstream dependency: the core currently forwards
      `netatmo-webhook` gateway messages to the internal service event bus —
      an equivalent forward to external integration containers does not exist
      yet. To design with @Pierre-Gilles (candidate: relay into the
      integration WebSocket).
- [ ] `addwebhook`/`dropwebhook` registration on connect/disconnect
      (fire-and-forget, like the core PR), events used as triggers only
      (refresh through `homestatus`, 2 s debounce).
- [ ] Camera events (`movement`, `human`, …) reuse the same plumbing — the
      core PR intentionally ignores them until the camera PRs land.

## Upstream dependencies

- [ ] Core PR [#2665](https://github.com/GladysAssistant/Gladys/pull/2665) —
      external integrations framework (phase 1): the whole runtime this
      integration targets.
- [ ] The Netatmo core PR stack above: it still lands in the core service —
      feature parity to maintain between core and external until the
      externalization is complete.
- [ ] Webhook forwarding to external integrations (v0.4, see above).
- [ ] Device-param write path for external integrations (v0.3 live stream).

## Conventions (this fleet of external integrations)

- Default branch: **`master`** (matches the Gladys guide repo).
- Catalog cover: **`cover.png`**, 800×534, ≤150 KB, artwork filling the frame.
- Manifest rules enforced by the core validator (see
  `.github/PULL_REQUEST_TEMPLATE.md`).
- Feature `external_id` keys are FROZEN once shipped (re-discovery would
  duplicate features).
- Quality gates: `npm run format:check` / `npm run lint` / `npm test`.
