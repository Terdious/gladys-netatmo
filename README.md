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
  the homestatus `errors` array and badged **unreachable**) — plus the
  modulating OpenTherm thermostat (`OTM`) and its relay (`OTH`), and the
  BTicino Smarther with Netatmo thermostat (`BNS`).
- **Telemetry**: one global refresh loop every 120 s (3-4 API calls per cycle
  for the whole account), declarative per-module mappings, legitimate zeros
  kept, unchanged values deduped with a 30-minute keep-alive.
- **Thermostat control**: the setpoint is writable (`setroomthermpoint`,
  mode `manual`), with a clear "reconnect" message on missing scope rights.
- **Heating mode**: the home's mode (schedule / away / frost guard) as a
  writable thermostat preset on every thermostat and valve (`setthermmode`,
  then an immediate refresh).
- **Gladys Thermostat widget** (Gladys 5.2+, core Thermostat service): one
  device per heated room (its thermostat, else one of its valves) carries the
  room's **Heating state** (`thermostat`/`operating-state`, from the room's
  `heating_power_request` or the boiler status), a writable **Thermostat
  mode** off / heating (`thermostat`/`mode`, setroomthermpoint `off` /
  `home`, skipped when the room is already so) and **Window open**
  (`opening-sensor`, 0 open / 1 closed): an external thermostat of the
  Thermostat integration gets the heating halo, the Gladys schedule and
  presets, a real stop and the window cut on every Netatmo room. A setpoint
  reaching an off room is not sent (it would switch the room back on).
- **Scene triggers and actions** (Gladys 5.1+): "a known person arrives /
  leaves" and "the siren sounds" fired from the webhook events with the
  person, camera and home names; "change the heating mode" (optional
  duration) and "mark a person as away / at home" (`setpersonsaway` /
  `setpersonshome`).
- **Dashboard widgets** (Gladys 5.1+): Netatmo weather (live tiles + module
  health), Netatmo heating (rooms, mode, mode buttons) and Netatmo cameras
  (latest picture served by the integration, monitoring toggle).
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
- **Indoor Camera Advance** (`NPC`, opt-in with the cameras, own
  `read_camerapro` / `write_camerapro` / `access_camerapro` scopes): the
  NACamera feature set (monitoring switch, dashboard image, motion / person
  detections, cameras widget). It is a WebRTC camera like the doorbell: the
  snapshot is fetched on the VPN URL only, and it gets no `CAMERA_URL` (live
  view in WebRTC, see below).
- **Outdoor camera floodlight** (`NOC`): the homestatus `floodlight` mode
  (on / off / auto) split over a `light` / `binary` **Floodlight** and a
  `switch` / `binary` **Floodlight automatic mode**, both writable through
  `/api/setstate`; the webhook `light_mode` event publishes the new mode at
  once.
- **Video doorbell** (`NDB`, opt-in with the cameras): dashboard image
  (snapshot on the VPN URL only — WebRTC cameras serve nothing locally),
  WiFi quality and a **doorbell ring** feature fed by the webhooks
  (`incoming_call`). No monitoring switch and no `CAMERA_URL` (WebRTC-only
  stream). Requests the `read_doorbell` / `access_doorbell` scopes: a token
  lacking them keeps working, with a "click Connect again" status.
- **WebRTC live view** of the doorbell and the Indoor Camera Advance
  ([#70](https://github.com/Terdious/gladys-netatmo/issues/70)): both carry
  the reserved `GLADYS_CAMERA_STREAM_PROTOCOL` = `webrtc` device param, and
  the `onCameraWebRtcOffer` / `onCameraWebRtcStop` handlers relay the
  browser's SDP offer to `/api/webrtc/offer` (answer, `session_id`,
  `tag_id`) and end it with `/api/webrtc/terminate`. Feature-detected: inert
  (still image) with an SDK without these handlers (0.15) — needs
  GladysAssistant/integration-sdk-js#43 — and with a Gladys core without the
  relay (GladysAssistant/Gladys#3215), which refuses the param: the discovery
  is published again without it. No new scope (`access_doorbell` /
  `access_camerapro`).
- **Camera-bridged security accessories** (opt-in with the cameras): the
  door/window tag (`NACamDoorTag`) as an opening sensor, the indoor siren
  (`NIS`) as a read-only sounding sensor, both with battery + RF quality; the
  smoke alarm (`NSD`) and the carbon monoxide alarm (`NCO`) are discovered
  with battery + signal — their smoke / CO state is webhook-driven. Net-new vs
  the core service.
- **Known persons** (opt-in with the cameras): one virtual device per home
  (`ext:netatmo:persons-<home id>`) with a `presence-sensor`/`binary` feature
  per person named in the Netatmo app (1 = at home, from the homestatus
  `out_of_sight`), refreshed every cycle and at once on the webhook events.
- **Roller shutters** (opt-in via the `shutter_api` toggle): Bubendorff
  shutters of an iDiamant gateway (`NBR`, `NBO`, `NBS`) with open / close /
  stop, a writable position and RF quality (`/api/setstate` through the
  gateway; new `read_bubendorff` / `write_bubendorff` scopes — existing users
  reconnect once).
- **Home Coach / Smart Indoor Air Quality Monitor** (`NHC`, opt-in via the
  `aircare_api` toggle): loaded from the legacy `gethomecoachsdata` API as an
  independent family, with temperature (+ min/max), humidity, CO2, noise,
  pressure, absolute pressure, WiFi quality and the Netatmo health index as an
  `airquality-sensor`/`aqi` feature — the 0-4 level is published as the middle
  of the matching AQI band (25 / 75 / 125 / 175 / 250) because Gladys reads
  that feature on the 0-500 AQI scale (dashboard colours, HomeKit), plus the
  same rating in words as a read-only `text`/`select` feature.
- **BTicino Classe 300X / Classe 300 EOS door entry — preview** (opt-in via
  the `bticino_api` toggle, issue #59): ONE device per door entry, the `BNCX`
  indoor unit, carrying the features of the modules it bridges — its WiFi
  quality, the doorbell ring (`incoming_call` webhook, scene trigger), the
  `BNSL` staircase / outdoor light (writable, optimistic: Netatmo does not
  report its state), the read-only `on` of a `BNCS` socket — and the
  unreachable badge. Opening the door is not available through the Netatmo
  API. A `[bticino-diagnostic]` log writes their raw homesdata / homestatus
  entries (on change) and webhook events, secrets redacted. Its `read_bfi` /
  `write_bfi` / `read_mx` / `write_mx` scopes are requested only while the
  toggle is on (turning it on asks to click Connect again).
- **Device diagnostic** action on the Configuration screen: a plain-text
  report on one module (or the whole account) to paste in an issue — what
  Netatmo sends, what the integration publishes, the unused Netatmo fields,
  scopes, API health, recent webhook events and the events `getevents`
  returns, secrets redacted.
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
- **Detections without webhooks**: every refresh cycle also reads the last
  events of each home with a camera, doorbell, alarm or door entry
  (`getevents`, one call per home), so motion / person / animal / vehicle,
  smoke / CO and rings reach the same features and scene triggers within
  ~2 minutes when the webhooks deliver nothing — deduplicated against them,
  never replaying history on a restart, stale events (> 10 min) skipped.

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
| `aircare_api`     | Discover Air quality devices (Home Coach / Smart Indoor Air Quality Monitor) — opt-in                                                         |
| `bticino_api`     | Discover the BTicino Classe 300 door entry as one device (ring, light) and write its raw payloads to the logs (preview) — opt-in              |
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
│  │  ├─ discovery.js                # raw device loading + API families merge (id/_id)
│  │  ├─ features.js                 # Gladys feature builders (core parity)
│  │  ├─ convert.js                  # raw device → Gladys discovery payload
│  │  ├─ updateMappings.js           # declarative suffix → value table (core PR #2619)
│  │  ├─ deviceMapping.js            # value transforms (read/write)
│  │  ├─ telemetry.js                # 120s refresh loop, dedup, transport badges
│  │  ├─ camera.js                   # snapshots: local-first URL, ≤150KB pipeline
│  │  ├─ scenes.js                   # scene actions (heating mode, persons)
│  │  ├─ widgets.js                  # dashboard widgets (weather, heating, cameras)
│  │  ├─ bticino.js                  # BTicino door entry diagnostic log (redacted)
│  │  ├─ redact.js                   # redaction shared by the diagnostic log and report
│  │  ├─ diagnostic.js               # "Device diagnostic" action report + webhook history
│  │  ├─ eventsPoll.js               # getevents poll: detections when webhooks deliver nothing
│  │  └─ setValue.js                 # setpoint, heating mode, camera monitoring, BTicino light
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

- Forum topic (announcements, help, feedback):
  [Intégration externe - Netatmo](https://community.gladysassistant.com/t/integration-externe-netatmo/11308).
- Gladys core Netatmo service (deprecated in favour of this integration; its
  devices migrate here with their history through the Gladys **Migrate**
  button, see the user docs): `server/services/netatmo` in
  [GladysAssistant/Gladys](https://github.com/GladysAssistant/Gladys). Parity
  map: [#15](https://github.com/Terdious/gladys-netatmo/issues/15).
- Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md) and
  [#7](https://github.com/Terdious/gladys-netatmo/issues/7).
- Sibling external integrations:
  [gladys-tuya](https://github.com/Terdious/gladys-tuya),
  [gladys-zendure](https://github.com/Terdious/gladys-zendure)
