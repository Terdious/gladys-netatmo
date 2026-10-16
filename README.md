# Gladys Netatmo — external integration

External integration that connects [Netatmo](https://www.netatmo.com) devices
to [Gladys Assistant](https://gladysassistant.com), built with the official
JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

It is the externalized version of the Gladys core Netatmo service. The core
service is being retired in favour of this integration, which is where the new
capabilities land (Home + Security cameras, webhooks, …).

## What it does

- **OAuth2 connection to the Netatmo cloud** through the Gladys relay: the user
  fills the client id / client secret of their [Netatmo Connect](https://dev.netatmo.com)
  application, clicks **Connect**, signs in on netatmo.com and the integration
  exchanges and stores the tokens (single consent covering the Energy, Weather
  and Security scopes — including the camera scopes needed by the next
  milestones).
- **Token lifecycle**: refresh at 80% of the access-token lifetime, rotating
  refresh tokens, transient-failure backoff, and a 24h grace window before a
  fatal-looking failure wipes the stored tokens (mirrors the core hardening).
- **Device discovery** of the Weather family (`NAMain` station, `NAModule1`
  outdoor, `NAModule2` wind, `NAModule3` rain, `NAModule4` indoor) and the
  Energy family (`NATherm1` thermostat, `NAPlug` relay, `NRV` valves) — same
  feature set as the core service, powered-off modules included (rebuilt from
  the homestatus `errors` array and badged **unreachable**).
- **Telemetry**: one global refresh loop every 120 s (3-4 API calls per cycle
  for the whole account), declarative per-module mappings, legitimate zeros
  kept, unchanged values deduped with a 30-minute keep-alive.
- **Thermostat control**: the setpoint is writable (`setroomthermpoint`,
  mode `manual`), with a clear "reconnect" message on missing scope rights.
- **Heating mode**: the home's mode (schedule / away / frost guard) as a
  writable thermostat preset on every thermostat and valve (`setthermmode`,
  then an immediate refresh).
- **Cameras** (opt-in via the `security_api` toggle, like the core): indoor
  `NACamera` and outdoor `NOC` cameras are discovered from the same
  homesdata/homestatus payloads, with WiFi quality, a **writable monitoring
  switch** (`/api/setstate`) and the **dashboard image** — snapshots are
  fetched local-first (`/command/ping` resolution, cached, VPN fallback) and
  re-encoded in pure JS when they exceed the camera-store bound (no ffmpeg
  in the sandboxed container). Enabling only the Security API works too —
  the topology load runs whenever Energy or Security is on.
- **Camera live stream**: each camera carries the `CAMERA_URL` /
  `camera_quality` params read by the core rtsp-camera service (dashboard
  live button). The HLS manifest URL is built **on the local network first**
  (VPN fallback), and re-published automatically when it changes (VPN
  rotation, local/VPN switch, user-edited quality) — the external-integrations
  framework silently upserts the params of created devices on every
  discovery publish.
- **Video doorbell** (`NDB`, opt-in with the cameras): dashboard image
  (snapshot on the VPN URL only — WebRTC cameras serve nothing locally),
  WiFi quality and a **doorbell ring** feature fed by the webhooks
  (`incoming_call`). No monitoring switch and no `CAMERA_URL` (WebRTC-only
  stream). Requests the `read_doorbell` / `access_doorbell` scopes: a token
  lacking them keeps working, with a "click Connect again" status.
- **Camera-bridged security accessories** (opt-in with the cameras): the
  door/window tag (`NACamDoorTag`) as an opening sensor, the indoor siren
  (`NIS`) as a read-only sounding sensor, both with battery + RF quality; the
  smoke alarm (`NSD`) and the carbon monoxide alarm (`NCO`) are discovered
  with battery + signal — their smoke / CO state is webhook-driven. Net-new vs
  the core service.
- **Roller shutters** (opt-in via the `shutter_api` toggle): Bubendorff
  shutters of an iDiamant gateway (`NBR`, `NBO`, `NBS`) with open / close /
  stop, a writable position and RF quality (`/api/setstate` through the
  gateway; new `read_bubendorff` / `write_bubendorff` scopes — existing users
  reconnect once).
- **Connection status** on the Configuration screen at every step (missing
  credentials, not connected, connected, reconnect required), plus the
  **degraded state**: an API family failing 3 cycles in a row is named under
  the Connected status and the devices it leaves without fresh values get a
  degraded badge — the weather measures fall back on homestatus, loaded
  whenever any family is enabled (#33).

- **Gladys Plus webhooks**: Netatmo events are relayed to the integration and
  trigger an immediate refresh (a setpoint change lands in ~2-3 s instead of
  waiting for the next cycle), without shortening the poll. Degrades to poll
  only when Gladys Plus is not linked.

Two behaviours differ from the core service on purpose: modules of an
unsupported type (or whose API toggle is off) are **not listed** in the
discovery (the core lists them greyed-out as "not handled" — the external
discovery screen has no such rendering yet), and an API toggle that is off
really skips its API calls (the core treats "nothing configured" as "load
everything"). Snapshots are bounded to the 150 KB image string the core host
API accepts; heavy snapshots are re-encoded, then downscaled if needed, so a
frame is never dropped.

## Installation & updates

Requires **Gladys Assistant 5.2.0 or later** (`gladys_version` in the
manifest): the heating mode is a thermostat preset, a feature type Gladys knows
since 5.2.0.

The integration is listed in the Gladys integration catalog (categories
_Climate_, _Security_ and _Environment_): open
**Integrations**, search for "Netatmo" and install it. Every release publishes
the multi-arch image `ghcr.io/terdious/gladys-netatmo:<version>` (and
`:latest`) and its GitHub Release, whose notes are the matching section of
[`CHANGELOG.md`](CHANGELOG.md).

To test a development build, paste the manifest
(`gladys-assistant-integration.json`) under **Integrations → Install an
integration → Developer mode**: the summary of a manual run of the **Build and
publish image** workflow prints the manifest already pointing at that build.

> **Developer mode updates.** The **"Force update"** button in the Supervision
> box only pulls a new **Docker image (the runtime)**. The **version shown**
> and the **configuration fields** (`config_schema`) are rendered from the
> **manifest pasted at install time** and do **not** refresh with the image:
> re-paste the manifest to pick them up.

## Configuration

The configuration form is generated by Gladys from the manifest
(`gladys-assistant-integration.json`):

| Key               | Description                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `client_id`       | Netatmo Connect application client id                                                                                                         |
| `client_secret`   | Netatmo Connect application client secret                                                                                                     |
| `netatmo_account` | OAuth2 connect button (opens the Netatmo consent screen)                                                                                      |
| `energy_api`      | Discover Energy devices (thermostats, relay plugs, valves)                                                                                    |
| `weather_api`     | Discover Weather devices (stations and modules)                                                                                               |
| `security_api`    | Discover Security devices (cameras) — opt-in, like in the core                                                                                |
| `camera_quality`  | Camera live-stream quality: `poor` / `low` / `medium` / `high` (default `high`), overridable per camera via the `camera_quality` device param |

The OAuth2 tokens (`access_token`, `refresh_token`, `expires_at`) are stored by
the integration itself in the Gladys config store, outside the schema: they
never appear on the configuration form.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no Netatmo logic)
├─ src/
│  ├─ netatmo/
│  │  ├─ constants.js                # API URLs, scopes, module types, timings
│  │  ├─ oauth.js                    # OAuth2 manager (authorize URL, exchange, refresh)
│  │  ├─ client.js                   # authenticated API client (homesdata, homestatus, …)
│  │  ├─ discovery.js                # raw device loading + 3-API merge (id/_id)
│  │  ├─ features.js                 # Gladys feature builders (core parity)
│  │  ├─ convert.js                  # raw device → Gladys discovery payload
│  │  ├─ updateMappings.js           # declarative suffix → value table (core PR #2619)
│  │  ├─ deviceMapping.js            # value transforms (read/write)
│  │  ├─ telemetry.js                # 120s refresh loop, dedup, transport badges
│  │  ├─ camera.js                   # snapshots: local-first URL, ≤150KB pipeline
│  │  └─ setValue.js                 # setpoint, heating mode, camera monitoring
│  └─ config.js                      # config defaults + normalization
├─ gladys-assistant-integration.json # manifest (name, config schema, image…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ cover.png                         # catalog cover
```

## Development

Node.js 22 or later.

```bash
npm install
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # unit + e2e + manifest + release helpers (node --test)
npx github:GladysAssistant/integration-store .   # store admission rules
```

Describe each change under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md).
A release is cut from **Actions → Release → Run workflow** (patch / minor /
major): it refuses an empty `[Unreleased]` section, bumps `package.json` and
the manifest (`version` + `docker_image`, Prettier layout kept), rolls the
changelog, tags `vX.Y.Z`, publishes the image and the GitHub Release (the
changelog section, then GitHub's "What's Changed" and "Full Changelog"). Dependabot keeps the SDK and the GitHub Actions
up to date.

The e2e test runs the real SDK client against a fake Gladys core and a fake
Netatmo cloud — no account or hardware needed.

## Related

- Gladys core Netatmo service (being retired in favour of this integration):
  `server/services/netatmo` in
  [GladysAssistant/Gladys](https://github.com/GladysAssistant/Gladys). The core
  Netatmo PR stack was closed once reproduced here — disposition & parity map:
  [#15](https://github.com/Terdious/gladys-netatmo/issues/15).
- Sibling external integrations:
  [gladys-tuya](https://github.com/Terdious/gladys-tuya),
  [gladys-zendure](https://github.com/Terdious/gladys-zendure)
