# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- User documentation (en, fr, de, es): the update section describes the
  catalog update (Update button, new configuration fields applied on their
  own) instead of re-pasting the manifest, now only needed in developer mode;
  the migration section gives the procedure of the Gladys **Migrate** button
  (4.84.1+), which keeps the history, scenes and dashboards of the devices of
  the built-in Netatmo service.

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

[Unreleased]: https://github.com/Terdious/gladys-netatmo/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/Terdious/gladys-netatmo/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Terdious/gladys-netatmo/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/Terdious/gladys-netatmo/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/Terdious/gladys-netatmo/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/Terdious/gladys-netatmo/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Terdious/gladys-netatmo/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Terdious/gladys-netatmo/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Terdious/gladys-netatmo/releases/tag/v1.0.0
