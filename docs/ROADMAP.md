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
- **Unreleased**: catalog-update and migration docs (PR #31), GitHub Release
  notes like gladys-tuya (PR #32).
- Upstream, shipped in Gladys: live-stream latency (GladysAssistant/Gladys#2698,
  4.84.1, see #11), device migration with history
  (GladysAssistant/Gladys#2737, 4.84.1, hardened in #2778).

## Planned

Tracking: [#7](https://github.com/Terdious/gladys-netatmo/issues/7). Forum
topic:
[Intégration externe - Netatmo](https://community.gladysassistant.com/t/integration-externe-netatmo/11308).

### Reliability

- [#33](https://github.com/Terdious/gladys-netatmo/issues/33) Weather keeps
  working when `getstationsdata` answers 503 (read `homestatus` too) and a
  failing API family is reported as a degraded state.

### New devices

- [#34](https://github.com/Terdious/gladys-netatmo/issues/34) Bubendorff /
  iDiamant roller shutters (NBR, NBO, NBS) — requested on the forum.
- [#35](https://github.com/Terdious/gladys-netatmo/issues/35) Video doorbell
  (NDB): ring, image, live stream.
- [#36](https://github.com/Terdious/gladys-netatmo/issues/36) Carbon monoxide
  alarm (NCO).
- [#37](https://github.com/Terdious/gladys-netatmo/issues/37) Home Coach
  (NHC).

### Enrichments (Gladys 5.2 wave: `gladys_version >= 5.2.0`)

- [#38](https://github.com/Terdious/gladys-netatmo/issues/38) Heating mode
  (schedule / away / frost guard) as `thermostat/preset`.
- [#39](https://github.com/Terdious/gladys-netatmo/issues/39) Scene triggers
  (known person arrives / leaves, siren sounding) and scene actions (heating
  mode, persons home / away).
- [#40](https://github.com/Terdious/gladys-netatmo/issues/40) Dashboard
  widgets: weather, heating, cameras.

### Waiting on others

- [#18](https://github.com/Terdious/gladys-netatmo/issues/18) Device photos
  on the Devices tab — core PR GladysAssistant/Gladys#3208.
- [#19](https://github.com/Terdious/gladys-netatmo/issues/19) Battery level
  on the Devices tab — core PR GladysAssistant/Gladys#3207 (nothing to do
  here: the battery feature is already published).
- [#41](https://github.com/Terdious/gladys-netatmo/issues/41) Siren control
  — blocked: the public API rejects `siren_status`.
- [#12](https://github.com/Terdious/gladys-netatmo/issues/12) Test-coverage
  backlog (good first contributions).

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
