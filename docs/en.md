# Netatmo integration for Gladys Assistant

Connect your **Netatmo** devices — weather station, thermostats and radiator
valves, indoor/outdoor cameras and their accessories — to Gladys Assistant.

This integration talks to the Netatmo cloud on your behalf: you create your own
Netatmo Connect application once, connect your account, and Gladys discovers
your devices and keeps their values up to date.

---

## Prerequisites

- A **Netatmo account**, with your devices already installed and working in the
  Netatmo app (Gladys reads what Netatmo exposes — a device must be online in
  Netatmo first).
- A Gladys Assistant instance that supports external integrations.

---

## Step 1 — Create your Netatmo Connect application

Gladys never ships a shared Netatmo key: you use **your own** Netatmo Connect
application, so your data stays between your Gladys and your Netatmo account.

1. Go to **[Netatmo Connect](https://dev.netatmo.com/)** and sign in with your
   Netatmo account.
2. Open **[My Apps → Create](https://dev.netatmo.com/apps/)** and create a new
   application (any name and description — e.g. "Gladys").
3. Once created, the application page shows two values you will copy into
   Gladys:
   - **client id**
   - **client secret**

You do **not** need to configure scopes or a redirect URI on the portal: Gladys
requests the required scopes (read + write, covering Energy, Weather and
Security including cameras) automatically during the connection, and handles the
OAuth2 redirect itself.

---

## Step 2 — Configure and connect in Gladys

On the integration's **Configuration** screen:

1. Paste your **client id** and **client secret**.
2. Click **Save**.
3. Click **Connect**: a Netatmo window opens, sign in and authorize Gladys. You
   are redirected back and the status becomes **Connected**.

> **Tip:** always **Save** the client id / secret _before_ clicking Connect. If
> Connect reports that the credentials must be saved first, save the form and
> click Connect again.

The access and refresh tokens are stored by the integration itself and never
appear on the form. Gladys refreshes them automatically; if the session ever
expires beyond repair, the Configuration screen tells you to reconnect.

---

## Step 3 — Choose the device families

Under **Devices to discover**, enable the families you own:

| Toggle       | Discovers                                                               |
| ------------ | ----------------------------------------------------------------------- |
| **Energy**   | Thermostat (`NATherm1`), relay plug (`NAPlug`), radiator valves (`NRV`) |
| **Weather**  | Station (`NAMain`) + outdoor, wind, rain and extra indoor modules       |
| **Security** | Indoor (`NACamera`) and outdoor (`NOC`) cameras, plus their accessories |

Enabling a family and **saving** re-runs the discovery automatically — no manual
re-scan needed. Newly surfaced devices appear on the **Discovery** screen, where
you create the ones you want.

**Camera live stream quality** (`poor` / `low` / `medium` / `high`, default
`high`) sets the quality of the camera live stream.

Values refresh every **2 minutes** (Netatmo rate limits).

---

## Cameras

When the Security family is enabled, each camera is created with:

- a **dashboard image** (a snapshot, refreshed automatically) — Gladys fetches
  it from the **local network first** (falling back to the Netatmo VPN URL);
- a **monitoring** switch (turn the camera's monitoring on/off);
- a **live stream** button (HLS), built local-first as well.

### Live stream — latency and audio

- **Latency (~10 s):** this is inherent to the Netatmo live HLS stream — the
  exact same delay exists on Netatmo's own web and mobile apps. Prefer the
  dashboard camera box latency `low`, and `medium` camera quality (720p) if you
  want smoother playback.
- **No sound?** The camera microphone must be **enabled** in the Netatmo app:
  _Manage my home → select the camera's room → Camera → Advanced settings →
  enable the Microphone_. If it is off there, no client (Gladys, Netatmo web,
  Netatmo app) gets audio. Gladys transports the audio whenever the stream
  carries it — there is nothing to configure on the Gladys side.

---

## Security accessories (camera-bridged)

When the Security family is enabled, the accessories linked to your cameras are
discovered too:

- **Door / window tag** (`NACamDoorTag`) — an opening sensor (open/closed), plus
  battery and RF signal.
- **Indoor siren** (`NIS`) — a read-only sounding sensor, plus battery and RF.
- **Smoke alarm** (`NSD`) — discovered with its battery and signal. Its **smoke
  state** is delivered by webhooks (real-time events), which arrive in a later
  milestone; polling alone cannot report it.

---

## Updating the integration

The **"Force update"** button in the Supervision tab pulls a new **Docker image
(the runtime)**. The **version shown** and the **configuration fields** come
from the **manifest** you installed. If an update adds new configuration fields,
re-install / re-paste the updated manifest to pick them up.

---

## Migrating from the built-in Netatmo service

If you used the Netatmo service built into Gladys, this external integration
replaces it. Devices are **re-discovered as new** (their identifiers changed
from `netatmo:*` to `ext:netatmo:*`), so their history is not carried over —
create the devices again from the Discovery screen.

---

## Troubleshooting

- **"Save first" when connecting:** save the client id / secret, then click
  Connect again.
- **Session expired:** click Connect again to re-authorize your Netatmo account.
- **A device shows an "unreachable" badge:** Netatmo reports it as offline (dead
  battery, powered off, out of range). Gladys stops publishing its last-known
  values so you are not misled by stale data; the badge clears when the device
  comes back.
- **A camera value or monitoring command fails once with a "reconnect" message:**
  your Netatmo authorization is missing the camera scope — reconnect your
  account.
- **No camera sound:** see the microphone tip in the Cameras section above.
