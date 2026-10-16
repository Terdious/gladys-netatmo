# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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

[Unreleased]: https://github.com/Terdious/gladys-netatmo/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Terdious/gladys-netatmo/compare/v1.3.0...v2.0.0
[1.3.0]: https://github.com/Terdious/gladys-netatmo/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Terdious/gladys-netatmo/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/Terdious/gladys-netatmo/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/Terdious/gladys-netatmo/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/Terdious/gladys-netatmo/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Terdious/gladys-netatmo/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Terdious/gladys-netatmo/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Terdious/gladys-netatmo/releases/tag/v1.0.0
