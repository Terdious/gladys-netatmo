# Roadmap — Netatmo external integration

> Tracking lives in the GitHub issues — central roadmap:
> [#7](https://github.com/Terdious/gladys-netatmo/issues/7). This file is the
> technical companion: shipped scope, conventions, and pointers.

## Shipped — v1.0.0 (2026-07-21, validated on a real bench)

- **v0.1 — Account access (OAuth2)**: `oauth2` manifest field through the
  Gladys relay, full scope set in one consent (camera scopes included),
  rotating refresh tokens, refresh at 80% of the TTL, transient backoff,
  24h grace window (core PR #2618 behaviour), single-use anti-CSRF state
  (core PR #2628 equivalent), connection status at every step.
- **v0.2 — Weather + Energy devices** (issue #1): homesdata + per-home
  homestatus (concurrency 2), legacy `getthermostatsdata` /
  `getstationsdata` merges by `id`/`_id`, exact core feature sets (frozen
  suffixes), declarative update mappings (core PR #2619), zeros kept (core
  PR #2617), powered-off modules rebuilt (core PR #2620) with an
  `unreachable` transport badge, one global 120 s refresh loop (dedup +
  30-minute keep-alive), thermostat setpoint (`setroomthermpoint`).
- **v0.3 — Cameras** (issues #2, #3, #4): NACamera/NOC discovery behind the
  opt-in `security_api` toggle, dashboard image (local-first snapshot
  resolution via `/command/ping`, cached, VPN fallback, pure-JS re-encode —
  no ffmpeg in the sandbox), writable monitoring (`/api/setstate`), live
  stream via the `CAMERA_URL`/`camera_quality` params read by the core
  rtsp-camera service (local network first, refreshed through the
  framework's silent param upsert on discovery re-publish).

## Open

- [#5](https://github.com/Terdious/gladys-netatmo/issues/5) Webhooks via
  Gladys Plus (core PR #2627) — ⚠️ blocked upstream (gateway → container
  relay).
- [#9](https://github.com/Terdious/gladys-netatmo/issues/9) Additional
  Security modules: NIS siren, NACamDoorTag door sensors, NSD smoke
  detector — net-new vs the core service.
- [#10](https://github.com/Terdious/gladys-netatmo/issues/10) Stale-module
  detection (dead battery / offline → stop republishing last-known values,
  badge unreachable).
- [#11](https://github.com/Terdious/gladys-netatmo/issues/11) Live stream:
  reduce the 10-15 s latency, bring the audio back (mostly core rtsp-camera
  work; container-side lead: the master `/live/index.m3u8` playlist).
- Upstream (core #2665): raise the host-API JSON body limit (camera images
  between ~100 and 150 KB currently die in a 413 — the integration ships a
  96 KB budget meanwhile), and make the front's oauth2 Connect button save
  the form first.
- Core-side migration helper for users moving from the core service
  (`netatmo:<id>` → `ext:netatmo:<id>`, history not carried over).

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
