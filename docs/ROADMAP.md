# Roadmap — Netatmo external integration

> Tracking lives in the GitHub issues — central roadmap:
> [#7](https://github.com/Terdious/gladys-netatmo/issues/7). This file is the
> technical companion: shipped scope, conventions, and pointers.

## Shipped

- **v1.0.0** (2026-07-21, validated on a real bench): OAuth2 account access
  through the Gladys relay (full scope set in one consent, rotating refresh
  tokens, 24h grace window), Weather + Energy devices (#1, exact core feature
  set, unreachable modules rebuilt, one global 120 s refresh loop),
  thermostat setpoint, cameras NACamera/NOC (#2, #3, #4: dashboard image
  local-first, writable monitoring, live stream via `CAMERA_URL`).
- **v1.0.1**: post-1.0 hardening (#13), stale-module detection (#10),
  `camera_quality` select.
- **v1.1.0**: Gladys Plus webhooks (#5, PR #16), camera-bridged security
  accessories NACamDoorTag / NIS / NSD (#9, PR #16), user documentation
  (#14).
- **v1.1.2**: 150 KB camera image budget restored, downscale instead of
  dropping a frame (PR #20).
- **v1.2.0**: real-time detections from the webhook events — motion, person,
  animal, vehicle, smoke (PR #22).
- **v1.3.0**: Cloud catalog tag (#23, PR #24), catalog categories, SDK
  0.15.0, Gladys >= 4.86.0 (PR #25), German and Spanish (PR #26).
- **v2.0.0** (Gladys >= 5.2.0):
  - reliability: weather values kept when `getstationsdata` fails, degraded
    state for a failing API family (#33, PR #43); "smoke cleared" no longer
    raises a detection (PR #51);
  - new devices: Bubendorff / iDiamant roller shutters (#34, PR #45), video
    doorbell (#35, PR #47), carbon monoxide alarm (#36, PR #46), Home Coach
    (#37, PR #44);
  - Gladys 5.2 wave: heating mode as a thermostat preset (#38, PR #48), scene
    triggers and actions (#39, PR #49), dashboard widgets (#40, PR #50);
  - docs: catalog update and migration (PR #31), GitHub Release notes like
    gladys-tuya (PR #32), roadmap and forum links (PR #42).
- **v2.0.1**: test-coverage backlog closed (#12, PR #52).
- **v2.1.0**:
  - heating: modulating / OpenTherm thermostat OTM + OTH (#53, PR #64),
    BTicino Smarther BNS (#54, PR #65, new scopes), room setpoint with
    duration, boost, back to schedule and schedule selection (#58, PR #63);
  - cameras and security: Indoor Camera Advance NPC (#55, PR #66, new
    scopes, snapshot only), outdoor camera floodlight on / off / auto (#56,
    PR #67), presence of the known persons (#57, PR #62).
- **Unreleased** (next release):
  - BTicino Classe 300 door entry preview: discovery and diagnostic log,
    scopes requested only with its toggle (#59 step 1, PR #72);
  - WebRTC live view of the doorbell and the Indoor Camera Advance, inert
    until Gladys#3215 and SDK#43 ship (#70, PR #71).
- Upstream, shipped in Gladys: live-stream latency (GladysAssistant/Gladys#2698,
  4.84.1, see #11), device migration with history
  (GladysAssistant/Gladys#2737, 4.84.1, hardened in #2778).

## Planned

Tracking: [#7](https://github.com/Terdious/gladys-netatmo/issues/7). Forum
topic:
[Intégration externe - Netatmo](https://community.gladysassistant.com/t/integration-externe-netatmo/11308).

### To confirm on real hardware

The new devices follow the Netatmo API as implemented by pyatmo (Home
Assistant) and openHAB; a few payload details still need a real device:
battery / WiFi field names of the CO alarm, the doorbell id field of
`incoming_call` and its VPN-only snapshot, intermediate shutter positions,
the `person_away` / `siren_sounding` payloads, when the OpenTherm relay
reports (and clears) its `boiler_error`, and what the Smarther
`boiler_valve_comfort_boost` field means. Feedback welcome on the
forum topic.

### Waiting on others

- [#18](https://github.com/Terdious/gladys-netatmo/issues/18) Device photos
  on the Devices tab — core PR GladysAssistant/Gladys#3208.
- [#19](https://github.com/Terdious/gladys-netatmo/issues/19) Battery level
  on the Devices tab — core PR GladysAssistant/Gladys#3207 (nothing to do
  here: the battery feature is already published).
- [#61](https://github.com/Terdious/gladys-netatmo/issues/61) Home Coach
  air quality as a standard level (translated, no more French-only text) —
  core PR GladysAssistant/Gladys#3213.
- [#70](https://github.com/Terdious/gladys-netatmo/issues/70) WebRTC live
  view of the video doorbell (NDB) and the Indoor Camera Advance (NPC) —
  integration side done (offer / terminate relay, stream-protocol param,
  feature-detected), inert until core PR GladysAssistant/Gladys#3215 and SDK
  PR GladysAssistant/integration-sdk-js#43 ship; then bump the SDK and
  validate on a real doorbell. Fallback if the core declines: a WebRTC →
  HTTP bridge inside the integration that `CAMERA_URL` points to.
- Floodlight mode as one feature: proposed core light operating-mode type
  (off / on / auto); the two provisional features (#56) will be migrated.
- [#41](https://github.com/Terdious/gladys-netatmo/issues/41) Siren control
  — blocked: the public API rejects `siren_status`.

### Next

- [#59](https://github.com/Terdious/gladys-netatmo/issues/59) BTicino
  Classe 300 / IP door entry (BNCX, door lock BNDL, staircase light BNSL):
  step 1 (discovery + `[bticino-diagnostic]` log, preview toggle) done;
  step 2 (ring trigger, door lock, staircase light command) waits for the
  real payloads.
- [#60](https://github.com/Terdious/gladys-netatmo/issues/60) Legrand
  Home + Control devices, behind a new toggle.

## external_id conventions (FROZEN)

- Device: `ext:netatmo:<netatmo id>` (the id is the MAC-like module id).
- Feature: `ext:netatmo:<netatmo id>:<suffix>` with the exact core suffixes
  (`temperature`, `therm_setpoint_temperature`, `battery_percent`,
  `monitoring`, `camera`, …). Changing a suffix re-creates features on every
  install: never rename shipped suffixes.

## Fleet conventions

- Default branch: **`master`**; releases from the Actions → Release workflow
  (bump + tag + multi-arch image `:X.Y.Z` + `:latest`, manifest in
  lockstep).
- Catalog cover: **`cover.png`**, 800×534, ≤150 KB, artwork filling the
  frame.
- Quality gates: `npm run format:check` / `npm run lint` / `npm test`.
