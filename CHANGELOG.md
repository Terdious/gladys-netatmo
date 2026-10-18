# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- A room setpoint sent from Gladys is re-read 3, 10 and 30 seconds after
  Netatmo acknowledged it, stopping as soon as `homestatus` reports it: the
  relay reaches the thermostat or valve after the cloud answered, so a single
  early read could still see the old value. Until then the old value is never
  published (no snap back on the device page, no false manual override in the
  Gladys Thermostat service); past the last read, the next cycle publishes
  whatever Netatmo reports.
- An Energy webhook event (`set_point`, `cancel_set_point`, `therm_mode`,
  `schedule`, matched on `event_type` like pyatmo) re-reads the state on the
  same 3 / 10 / 30 s ladder instead of a single refresh after 2 seconds, so a
  change made from the Netatmo app is not missed when the relay lags.

## [2.5.0] - 2026-10-17

### Added

- Netatmo heating fully usable by the Gladys **Thermostat** integration and
  its dashboard widget (Gladys 5.2+, core PR GladysAssistant/Gladys#3178):
  one device per heated room — its thermostat (`NATherm1`, `OTM`, `BNS`),
  else the valve (`NRV`) with the smallest id — carries two features named
  after the room. **Heating state** (`thermostat`/`operating-state`,
  read-only): heating while the room's `heating_power_request` is above 0 or
  a boiler thermostat's `boiler_status` is on, cooling while a Smarther's
  `cooler_status` is on, idle otherwise. **Thermostat mode**
  (`thermostat`/`mode`, writable, `supported_options` Off / Heating): off
  when the room's `therm_setpoint_mode` is `off`, heating otherwise; writing
  it sends `setroomthermpoint` mode `off` or `home` (back to the room's
  schedule), nothing when the room is already in that mode, and a token
  without the write scope gets the "reconnect" message. The window sensor is
  the existing **Detecting open window** (`open_window`) of any thermostat or
  valve of the room, now also created on the `OTM` and `BNS` thermostats.
  Existing devices get them with **Update** on the Discovery screen; no new
  permission ([#77](https://github.com/Terdious/gladys-netatmo/issues/77)).
- A room switched off keeps it: a setpoint written while the room is off is
  not sent (a `manual` setpoint would switch it back on — the Thermostat
  service stops a room with Off then its frost setpoint, and starts it with
  Heating before the setpoint), and the setpoint of an off room is no longer
  published, so whatever Netatmo reports then never looks like a change made
  on the thermostat. After a command, the next cycle re-publishes the value
  Netatmo reports even when unchanged since the last publish. Docs: "Use the
  Gladys Thermostat widget" in the four languages — one external thermostat
  per room, which features to pick, what the widget brings, and the Netatmo
  schedule that keeps running under Gladys's manual setpoints
  ([#77](https://github.com/Terdious/gladys-netatmo/issues/77)).
- Legrand Home + Control (Céliane / dooxie / Mosaic with Netatmo), first three
  groups ([#60](https://github.com/Terdious/gladys-netatmo/issues/60)), behind
  a new opt-in toggle **Legrand Home + Control — preview** (`legrand_api`,
  off by default). Its `read_magellan` / `write_magellan` scopes are requested
  only while it is on: turning it on asks to click Connect again, and a
  refused command says so on the Configuration screen. One device per module
  of a Home + Control gateway; the gateway (`NLG` / `NLGS`) is not a device,
  it is the `bridge` of every `/api/setstate` command (plug_id param).
  Lighting (`NLM`, `NLL`, each gang `<id>#n` of the `NLIS` double switch,
  dimmers `NLF`, `NLFN`, `NLFE`, `NLUF`, `NLUO`): a writable light, plus a
  writable brightness (0-100, Netatmo's scale) when the dimmer reports one.
  Plugs and relays (`NLP`, `NLPM`, `NLPBS`, `NLC`, `NLUP`, `NLUI`, contactor
  `NLPO`, latching relay `NLPT`, dry contact `NLPD`): a writable switch. A
  read-only power (W) when homestatus reports it. Netatmo reports the state
  back: after a command, the commanded value is kept by the dedup and ONE
  refresh about 2 s later publishes what Netatmo reports (a slider burst
  shares it). Unreachable badge: a gang follows its switch, a module its
  gateway; homestatus wins over a homesdata entry carrying a state. The
  Device diagnostic reports the Legrand family, the modules and their unused
  fields, and why the gateway and the `NLIS` parent are no device. Built on
  the pyatmo fixtures: not yet tested on real Legrand hardware. Docs in the
  four languages (supported modules, reconnection, what is not supported
  yet).

### Changed

- `open_window` (thermostats, valves) and `opening` (door / window tags) now
  follow the Gladys convention — 0 open, 1 closed — instead of 1 when open;
  the dashboard showed an open window or door as closed. A scene that tested
  `= 1` for open must now test `= 0`. Absent or unreliable values (no
  `open_window` in the room, a tag `status` other than `open` / `closed`)
  still publish nothing
  ([#77](https://github.com/Terdious/gladys-netatmo/issues/77)).
- The delayed one-shot refreshes after a command (shutters 30 s, Legrand
  2 s) keep one timer each and start from a fresh account load.

## [2.4.0] - 2026-10-17

### Added

- Detections without webhooks: every refresh cycle (and every
  webhook-triggered refresh) also reads the last events of each home with a
  camera, doorbell, smoke / CO alarm (Security family) or BTicino door entry
  gateway (BTicino toggle) — `GET /api/getevents`, one call per home and per
  cycle, at most one per home within 30 s (pyatmo `async_update_events`,
  fixture `getevents.json`). The new events go through the same path as the
  webhooks (factored out of `events.js`): motion, person, outdoor camera
  human / animal / vehicle sub-events, doorbell and door entry ring,
  smoke / CO with their "cleared" events, the known-person and siren scene
  events, the same 60 s reset. The events already there at startup are only
  recorded (history is never replayed on a restart), an event older than
  10 minutes when read is never published, and a detection the webhook
  already published (same Netatmo event id, or the same feature within 90 s)
  is not published again, and vice versa. A failure is logged at warn once
  per streak (a scope refusal says to click Connect again), never breaks the
  cycle and is counted in a new `events` family of the health; it never
  marks devices degraded. No new permission: the camera, doorbell, alarm and
  BTicino read scopes already requested cover it.
- Device diagnostic: an **Events poll (getevents)** health line, the **Last
  events seen by getevents** per module (time, type / sub type, ids, what was
  done with it — no URL, no message) and the last 5 overall, next to the
  webhook ones: events in getevents and no webhook means Netatmo does not
  deliver the webhooks. Docs: detections within ~2 minutes without webhooks,
  troubleshooting in the four languages.

### Fixed

- The motion, person, animal, vehicle, smoke, carbon monoxide and ring
  features (and the known-person / siren scene triggers) stayed empty when
  the Gladys Plus webhooks did not reach the integration — even with Netatmo
  holding the integration's URL — while the Netatmo app showed the alerts:
  they now arrive within about 2 minutes from `getevents`
  ([#5](https://github.com/Terdious/gladys-netatmo/issues/5)).
- Docs: when the webhook URL held by Netatmo is the integration's and nothing
  arrives, create a new Gladys Plus Open API key — an older one (for instance
  taken from the former core Netatmo service URL) authenticated yet never
  delivered the webhooks on a real installation.

## [2.3.1] - 2026-10-17

### Added

- Webhook delivery checks: each event Netatmo delivers through Gladys Plus is
  now logged at info level, as
  `Netatmo webhook event received: <push type> (<module ids>)` (never the
  payload), and the **Device diagnostic** report says which webhook URL
  Netatmo actually holds for the application (`GET webhooks/v1/`, key
  redacted): the integration's, none, or another one that overwrote it
  (developer portal field, former core service). Docs: "registered but
  nothing arrives" troubleshooting in the four languages.

## [2.3.0] - 2026-10-17

### Added

- BTicino door entry, step 2: the **staircase / outdoor light** (`BNSL`) is a
  standard writable light, switched through `/api/setstate` `on` with its
  `BNCX` bridge (Netatmo Home + Security documentation: "Modifying the
  staircase light status (on/off)", pyatmo `SwitchMixin`). Netatmo does not
  report its state ("not retrievable"): the commanded value is published once
  Netatmo acknowledged it, a module error in the answer fails the command,
  and a homestatus `on` would win. A missing BTicino scope says "click
  Connect again" on the Configuration screen. The **ring**
  (`incoming_call`, documented by Netatmo for the BNCX webhooks) is a
  doorbell feature of the door entry device, usable as a scene trigger, like
  the video doorbell; it lands there whichever bridged module the event
  names. Opening the door (`BNDL`) is **not** offered: Netatmo blocks it for
  third-party applications
  ([#59](https://github.com/Terdious/gladys-netatmo/issues/59)).
- **Device diagnostic** action on the Configuration screen, for any Netatmo
  module (like gladys-tuya): pick a device created in Gladys, or type the
  name / Netatmo id of a module not created, or leave both empty for the
  account summary. The plain-text report gives the version, enabled
  families, granted / missing scopes, the health of each API family (last
  success, consecutive failures, degraded state) and of the Gladys Plus
  webhook, then for the module its type, home, bridge, support status, the
  Gladys device and features it maps to, its raw homesdata / homestatus
  entries, the Netatmo fields the integration does not use yet and its last
  webhook events (a redacted in-memory history: last 20, last 10 per
  module). Redaction is shared with the `[bticino-diagnostic]` log; the
  report is also logged at info level
  ([#59](https://github.com/Terdious/gladys-netatmo/issues/59)).

### Changed

- BTicino door entry: **one Gladys device per door entry** — the `BNCX`
  gateway — instead of one per module. The modules it bridges (`BNEU`,
  `BNDL`, `BNSL`, `BNCS`, `BNXM`) add their features to it, keyed by their
  own ids (`ext:netatmo:<module id>:<suffix>`) and named after them; a
  bridged module whose gateway is missing is published alone only if it has
  a feature, never as an empty device. The unreachable badge follows the
  gateway; a bridged module reported offline (or behind an offline gateway)
  publishes no value. The 2.2.0 preview devices are regrouped: delete any
  you created and create the door entry device again. Test fixtures are now
  the real payloads of a Classe 300 EOS
  ([#59](https://github.com/Terdious/gladys-netatmo/issues/59)).

## [2.2.0] - 2026-10-16

### Added

- BTicino Classe 300X / Classe 300 EOS door entry, **preview** (step 1:
  discovery and diagnostic log), behind a new toggle **BTicino door entry**,
  off by default: the `BNCX` indoor unit, `BNEU` street panel, `BNDL` door
  lock, `BNSL` staircase light, `BNCS` controlled socket and `BNXM` X module
  are discovered with only what their payload carries (WiFi / RF quality, the
  read-only on / off of `BNSL` / `BNCS`) and the **unreachable** badge.
  While the toggle is on, a `[bticino-diagnostic]` log writes the raw
  homesdata / homestatus entries of these modules (first load, then on change
  only) and every webhook event about them, with tokens, keys, URLs and
  e-mail addresses redacted and each line bounded to 8 KB, so the real
  formats can be collected for the ring, door lock and staircase light
  commands. Its `read_bfi` / `write_bfi` / `read_mx` / `write_mx` scopes
  are requested **only while the toggle is on**: turning it on asks to click
  **Connect** again (the Configuration screen says so until then); accounts
  without a door entry are not affected
  ([#59](https://github.com/Terdious/gladys-netatmo/issues/59)).
- WebRTC live view of the video doorbell (`NDB`) and the Indoor Camera Advance
  (`NPC`): both are published with the `GLADYS_CAMERA_STREAM_PROTOCOL` =
  `webrtc` device param, and the browser's SDP offer relayed by Gladys goes to
  the Netatmo `/api/webrtc/offer` (answer, session id and tag id back), the
  stop to `/api/webrtc/terminate`. Needs a Gladys version newer than 5.2.1
  with the WebRTC camera live view (GladysAssistant/Gladys#3215) and the SDK
  handlers (GladysAssistant/integration-sdk-js#43): inert until then, the
  dashboard keeps the still image — an older core refusing the param gets the
  discovery again without it. No new Netatmo permission; a refused one fails
  with the "reconnect" message
  ([#70](https://github.com/Terdious/gladys-netatmo/issues/70)).

## [2.1.0] - 2026-10-16

### Added

- Netatmo modulating / OpenTherm thermostat, in the Energy family: the `OTM`
  thermostat gets the room temperature, the writable setpoint
  (`setroomthermpoint`), the heating mode preset (`therm_preset`), the boiler
  status, battery and RF quality, like the `NATherm1`, with the
  **unreachable** badge when out of reach; the `OTH` OpenTherm relay gets its
  WiFi quality, the outdoor temperature (`outdoor_temperature`) and a
  **Boiler fault** binary (`boiler_fault`: 1 while homestatus reports a
  `boiler_error`, 0 when it reports the relay without one). The thermostat's
  room joins the heating widget and the heating mode scene action. No
  reconnection needed ([#53](https://github.com/Terdious/gladys-netatmo/issues/53)).
- BTicino Smarther with Netatmo thermostat (`BNS`), in the Energy family:
  room temperature, writable setpoint, heating mode preset, boiler status,
  cooler status (`cooler_status`), the reported comfort boost
  (`boiler_valve_comfort_boost`, read-only) and WiFi quality; its room joins
  the heating widget and the heating mode scene action. It needs the new
  `read_smarther` / `write_smarther` scopes: **an account connected before
  must click Connect again** (the Configuration screen says so until then)
  ([#54](https://github.com/Terdious/gladys-netatmo/issues/54)).
- Advanced heating: four new scene actions — "Set a room setpoint" (7 to 30 °C,
  optional duration), "Boost a room" (optional duration), "Back to the
  schedule" (room of the chosen thermostat or valve, setroomthermpoint `manual`
  / `max` / `home` with `endtime`) and "Choose the heating schedule" (by its
  Netatmo name, switchhomeschedule; an unknown name lists the available ones).
  The Netatmo heating widget shows the active schedule, marks the rooms whose
  setpoint is manual or a boost, and gets a "Change schedule" button listing the
  heating schedules of the home
  ([#58](https://github.com/Terdious/gladys-netatmo/issues/58)).
- Netatmo Indoor Camera Advance (`NPC`), discovered with the Security family:
  the same features as the indoor camera — **dashboard image**, writable
  **monitoring** switch (`/api/setstate`), **Motion** and **Person detected**
  from the Gladys Plus webhooks (`NPC-` events) — and it joins the **Netatmo
  cameras** widget. As a WebRTC camera (like the video doorbell), its snapshot
  is fetched on the Netatmo VPN URL only and it gets no live stream
  (`CAMERA_URL`). It needs three new Netatmo permissions (`read_camerapro`,
  `write_camerapro`, `access_camerapro`): an account connected before must
  click **Connect** again, which the connection status asks for
  ([#55](https://github.com/Terdious/gladys-netatmo/issues/55)).
- Floodlight of the outdoor camera (`NOC`): Netatmo's on / off / auto mode
  becomes two writable features, **Floodlight** (a Gladys light: on = forced
  on, so the light scene actions work) and **Floodlight automatic mode** (a
  switch: on = auto), sent through `/api/setstate`. Turning one of them off
  only acts when it is the current mode, so a "lights off" scene never
  disables the automatic lighting. Read from the home status, and published at
  once from the webhook `light_mode` event; a command refused for a missing
  permission asks to reconnect. Existing cameras get the features with
  **Update** on the Discovery screen
  ([#56](https://github.com/Terdious/gladys-netatmo/issues/56)).
- Presence of the persons known to the Netatmo cameras: with the Security
  family enabled, each home gets a "<home> - Known persons" device with one
  presence feature per person named in the Netatmo app (Presence detected =
  at home, from the homestatus `out_of_sight`). Unnamed faces are skipped, a
  person Netatmo does not report publishes nothing, and the state refreshes
  every cycle and at once on the webhook events
  ([#57](https://github.com/Terdious/gladys-netatmo/issues/57)).

### Changed

- The "some Netatmo permissions are missing" connection message now gives the
  BTicino Smarther and the Indoor Camera Advance as examples
  ([#54](https://github.com/Terdious/gladys-netatmo/issues/54)).

### Fixed

- A webhook-triggered refresh now always starts from a fresh Netatmo load: a
  cycle in flight or a load still in the 10 s burst cache could hide the state
  the event announced ([#57](https://github.com/Terdious/gladys-netatmo/issues/57)).

## [2.0.1] - 2026-10-16

### Fixed

- Feature names of a weather module without a room no longer read "Minimum in
  undefined" / "Temperature - room undefined": the device name is used instead
  (display names only, feature external ids are unchanged)
  ([#12](https://github.com/Terdious/gladys-netatmo/issues/12)).

### Changed

- Test coverage of the post-1.0 review backlog ([#12](https://github.com/Terdious/gladys-netatmo/issues/12)).

## [2.0.0] - 2026-10-16

### Added

- Netatmo Smart Indoor Air Quality Monitor (Home Coach, `NHC`): new opt-in
  **Air quality devices (Home Coach)** toggle (`aircare_api`, off by default)
  loading `gethomecoachsdata` as its own API family — its failure keeps the
  previous discovery list but never blocks the other families. Each Home
  Coach brings temperature (with the day's minimum and maximum), humidity,
  CO2, noise, pressure, absolute pressure and WiFi quality, with the same
  feature suffixes as the weather indoor modules, plus an **Air quality**
  feature (`airquality-sensor` / `aqi`, suffix `health_idx`). The Home Coach
  rates the room on five levels (healthy, fine, fair, poor, unhealthy): as
  Gladys reads an AQI (0-500) for its dashboard colours and HomeKit, each
  level is published as the middle of the matching AQI band (25, 75, 125,
  175, 250). An **Air quality level** feature (`text` / `select`, suffix
  `health_level`) shows the same rating in words (Sain … Malsain: Gladys
  option labels are not translated yet) on the dashboard. An offline Home Coach is badged unreachable and publishes no
  stale value. No reconnection needed (`read_homecoach` was already
  requested) ([#37](https://github.com/Terdious/gladys-netatmo/issues/37)).
- **Heating mode** of the Netatmo home (schedule / away / frost protection) on
  every thermostat and valve, readable and writable from Gladys as a
  thermostat preset: the command goes through `setthermmode` and applies to
  the whole home, then an immediate refresh shows the new mode on every device
  of the home. Existing thermostats get the feature through **Update** on the
  Discovery screen ([#38](https://github.com/Terdious/gladys-netatmo/issues/38)).
- **Scene triggers** (Gladys Plus webhooks): "A known person arrives" (an
  indoor camera recognized a known face), "A known person leaves" and "The
  siren sounds", with the person, camera / siren and home names passed on to
  the scene and optional camera and person filters
  ([#39](https://github.com/Terdious/gladys-netatmo/issues/39)).
- **Scene actions**: "Change the heating mode" (schedule / away / frost
  protection, optional duration), "Mark a person as away" (or the whole home
  empty) and "Mark a person as at home" (or every known person), on the home
  of the chosen device or the account's single home
  ([#39](https://github.com/Terdious/gladys-netatmo/issues/39)).
- **Dashboard widgets**: _Netatmo weather_ (live tiles of the station, a
  health row for a module with a low battery or out of reach, three views),
  _Netatmo heating_ (heating mode, one row per room with the measured and set
  temperatures, Schedule / Frost protection / Away buttons) and _Netatmo
  cameras_ (latest picture of each camera served by the integration under a
  content-addressed key, monitoring state and on / off buttons). The widgets
  are nudged to refresh when the heating mode, the module health, the
  monitoring or a picture changes
  ([#40](https://github.com/Terdious/gladys-netatmo/issues/40)).
- Bubendorff / iDiamant roller shutters (`NBR` radio, `NBO` wired, `NBS`
  solar), behind a new **Roller shutters (Bubendorff / iDiamant)** toggle (off
  by default): open / close / stop, a writable position (0-100 %, read from
  `current_position`) and the RF quality, commanded through `/api/setstate`
  via the iDiamant gateway, with a values refresh 30 seconds after each
  command. The `read_bubendorff` / `write_bubendorff` scopes are requested:
  already connected users click **Connect** again to grant them — a refused
  shutter command says so on the Configuration screen, in the four languages
  ([#34](https://github.com/Terdious/gladys-netatmo/issues/34)).
- Netatmo video doorbell (`NDB`), behind the Security toggle: dashboard image
  (snapshot fetched on the Netatmo VPN URL — the doorbell serves nothing on the
  local network), Wifi quality and a **Doorbell** ring fed by the webhooks
  (`incoming_call` event), usable as an "If the doorbell rings" scene trigger
  and reset after 60 s. No monitoring switch (none in the Netatmo API for the
  doorbell) and no live stream button (WebRTC only)
  ([#35](https://github.com/Terdious/gladys-netatmo/issues/35)).
- New `read_doorbell` and `access_doorbell` OAuth scopes: an account connected
  before must click **Connect** again. The integration reads the scopes
  Netatmo granted to the token and, while some are missing, the Configuration
  screen shows "click Connect again" next to the connected status
  ([#35](https://github.com/Terdious/gladys-netatmo/issues/35)).
- Netatmo carbon monoxide alarm (`NCO`), behind the Security toggle and
  modelled on the smoke alarm: battery and signal (published when Netatmo
  reports them), plus a **Carbon monoxide** detection fed by the webhooks
  (`co_detected` event: pre-alarm and alarm are detections, "back to normal"
  returns it to No), usable as a scene trigger and reset after 60 s. The
  `read_carbonmonoxidedetector` scope was already requested: no reconnection
  needed ([#36](https://github.com/Terdious/gladys-netatmo/issues/36)).

### Changed

- Gladys Assistant 5.2.0 or later is required: the thermostat preset feature
  type does not exist before, and an older core would refuse the whole
  discovery list ([#38](https://github.com/Terdious/gladys-netatmo/issues/38)).
- Documentation: the troubleshooting section and the README point to the
  forum topic
  [Intégration externe - Netatmo](https://community.gladysassistant.com/t/integration-externe-netatmo/11308);
  the roadmap lists what shipped and what is planned.
- GitHub Release notes, like gladys-tuya: the version's changelog section,
  one line per bullet (no more hard line breaks), followed by the notes GitHub
  generates — "What's Changed" with the merged pull requests and their
  authors, and the "Full Changelog" comparison. A manual run of the GitHub
  releases workflow with "refresh" rewrites the notes of the existing
  Releases.
- The Release workflow refuses to release when the Unreleased section of
  `CHANGELOG.md` lists no change.
- User documentation (en, fr, de, es): the update section describes the
  catalog update (Update button, new configuration fields applied on their
  own) instead of re-pasting the manifest, now only needed in developer mode;
  the migration section gives the procedure of the Gladys **Migrate** button
  (4.84.1+), which keeps the history, scenes and dashboards of the devices of
  the built-in Netatmo service.

### Fixed

- Weather values no longer freeze when the Netatmo weather service
  (getstationsdata) fails: the station and module measures also come from the
  home status, now loaded whenever a device family is enabled
  ([#33](https://github.com/Terdious/gladys-netatmo/issues/33)).
- A Netatmo API failing for 3 refresh cycles in a row no longer goes unnoticed:
  the devices it leaves without fresh values get a degraded badge with the
  reason, the Configuration screen shows it under the Connected status, and
  both clear on the first complete refresh
  ([#33](https://github.com/Terdious/gladys-netatmo/issues/33)).
- The "smoke cleared" webhook event (`sub_type` 0) no longer raises a smoke
  detection: it returns the Smoke feature to No at once, so a scene triggered
  by smoke does not fire a second time when the smoke clears.

## [1.3.0] - 2026-10-16

### Added

- **Cloud** tag in the Gladys catalog: the manifest declares the `cloud`
  transport (catalog card badge on Gladys 4.85+, Cloud filter on 4.86+)
  ([#23](https://github.com/Terdious/gladys-netatmo/issues/23)).
- German and Spanish: the configuration screen (labels, descriptions, select
  options, links), the catalog description, the connection status messages
  and the user documentation (`docs/de.md`, `docs/es.md`) now ship in the
  four languages of Gladys (en, fr, de, es).
- Catalog categories (Gladys 4.86+): the integration sits on the _Climate_,
  _Security_ and _Environment_ shelves of the integration catalog.
- The thermostat and valve setpoints declare their half-degree `step`.
- Manifest tests: `version` matches `package.json`, `docker_image` is tagged
  with it, categories are known and coupled to Gladys 4.86, descriptions hold
  10 to 100 characters, config defaults match the code.
- `CHANGELOG.md`, rolled by the Release workflow.
- A GitHub Release for every version, with its changelog section as notes: the
  Gladys Supervision page links each version to the repository's releases.
- CI runs the tests on Node 22 and 24, and builds the Docker image.
- Dependabot keeps the npm dependencies and the GitHub Actions up to date.
- `SECURITY.md` (how to report a vulnerability).

### Changed

- Gladys Assistant 4.86.0 or later is required: older releases reject the
  `categories` field (and 4.83.0 had no external integrations at all).
- Integration SDK 0.15.0.
- Node.js 22 or later is required (Node 20 is end-of-life).
- The Release workflow rewrites the manifest `version` and `docker_image` in
  place: the release commit keeps the Prettier layout.

### Fixed

- The `/data` volume belongs to the `node` user: Docker creates a new volume
  with the owner of the image's mount point, which was `root`.

## [1.2.0] - 2026-08-08

### Added

- Real-time detections from the Netatmo webhook events: cameras gain Motion
  and Person detected (the outdoor NOC also Animal and Vehicle), the NSD smoke
  alarm gains Smoke. Published from the event payload and reset after 60 s.

## [1.1.3] - 2026-08-08

### Changed

- Documentation of the Gladys Plus webhooks (setup, scope and current limits).

## [1.1.2] - 2026-08-08

### Fixed

- Camera snapshots: the 150 KB image budget is back, and a snapshot too heavy
  even at the lowest quality is downscaled instead of dropped.

## [1.1.1] - 2026-07-23

### Fixed

- The manifest requires Gladys 4.83.0, the published version.

## [1.1.0] - 2026-07-23

### Added

- User documentation (`docs/en.md`, `docs/fr.md`) and configuration sections.
- Gladys Plus webhooks: a Netatmo event triggers an immediate refresh.
- Camera-bridged security accessories: door/window tag (NACamDoorTag), indoor
  siren (NIS) and smoke alarm (NSD).

### Changed

- Integration SDK 0.9.0.

## [1.0.1] - 2026-07-22

### Fixed

- Review and bench feedback: transient startup recovery, snapshot budget with
  last-image fallback, request timeouts, token persistence hardening, partial
  load protection; unreachable modules no longer republish stale values.

### Added

- `camera_quality` configuration select.

## [1.0.0] - 2026-07-21

### Added

- First stable release: OAuth2 connection, Weather and Energy devices,
  thermostat setpoint, cameras (image, monitoring, live stream).

[Unreleased]: https://github.com/Terdious/gladys-netatmo/compare/v2.5.0...HEAD
[2.5.0]: https://github.com/Terdious/gladys-netatmo/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/Terdious/gladys-netatmo/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/Terdious/gladys-netatmo/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/Terdious/gladys-netatmo/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/Terdious/gladys-netatmo/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/Terdious/gladys-netatmo/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/Terdious/gladys-netatmo/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/Terdious/gladys-netatmo/compare/v1.3.0...v2.0.0
[1.3.0]: https://github.com/Terdious/gladys-netatmo/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Terdious/gladys-netatmo/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/Terdious/gladys-netatmo/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/Terdious/gladys-netatmo/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/Terdious/gladys-netatmo/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Terdious/gladys-netatmo/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Terdious/gladys-netatmo/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Terdious/gladys-netatmo/releases/tag/v1.0.0
