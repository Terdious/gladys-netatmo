# Netatmo integration for Gladys Assistant

Connect your **Netatmo** devices — weather station, thermostats and radiator
valves, indoor/outdoor cameras and their accessories, Bubendorff roller
shutters — to Gladys Assistant.

This integration talks to the Netatmo cloud on your behalf: you create your own
Netatmo Connect application once, connect your account, and Gladys discovers
your devices and keeps their values up to date.

---

## Prerequisites

- A **Netatmo account**, with your devices already installed and working in the
  Netatmo app (Gladys reads what Netatmo exposes — a device must be online in
  Netatmo first).
- Gladys Assistant **4.86 or later**.

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
requests the required scopes (read + write, covering Energy, Weather, Security
including cameras and the video doorbell, and the roller shutters)
automatically during the connection, and handles the OAuth2 redirect itself.

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

| Toggle              | Discovers                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| **Energy**          | Thermostat (`NATherm1`), relay plug (`NAPlug`), radiator valves (`NRV`)                         |
| **Weather**         | Station (`NAMain`) + outdoor, wind, rain and extra indoor modules                               |
| **Security**        | Indoor (`NACamera`) and outdoor (`NOC`) cameras, video doorbell (`NDB`), plus their accessories |
| **Roller shutters** | Bubendorff shutters of an iDiamant gateway (`NBR`, `NBO`, `NBS`)                                |

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

## Video doorbell

When the Security family is enabled, the Netatmo video doorbell (`NDB`) is
created with:

- a **dashboard image** (a snapshot, refreshed automatically) — fetched through
  the Netatmo VPN URL: the doorbell does not serve it on the local network;
- a **Doorbell** feature that shows **Ringing** when someone presses the button,
  usable as a scene trigger (**If the doorbell rings**) — it needs the Gladys
  Plus webhooks (see below): polling alone cannot report a ring;
- its **Wifi** link quality.

There is no monitoring switch (Netatmo offers none for the doorbell) and no live
stream button: the doorbell streams over WebRTC only, which the Gladys camera
live view cannot play.

> ⚠️ **Netatmo account connected before this version?** The doorbell needs two
> new Netatmo permissions (`read_doorbell`, `access_doorbell`): click
> **Connect** again on the Configuration screen and accept them. Until then the
> connection status shows a "click Connect again" hint.

---

## Gladys Plus webhooks (real time) — optional

By default Gladys polls Netatmo **every 2 minutes**. With webhooks, Netatmo
**tells** Gladys as soon as something happens: values are then refreshed in
**2-3 seconds** instead of waiting for the next cycle — without increasing the
number of Netatmo API calls.

Since a local Gladys is not reachable from the Internet, **Gladys Plus** relays
the events, so an active Gladys Plus subscription is required.

### Setup (a single step)

1. On the integration **Configuration** screen, find the **"Gladys Plus
   webhooks"** block (shown automatically).
2. Paste your Gladys Plus **Open API key** there. That's it.

**Nothing to paste on the Netatmo website:** the integration registers the URL
at Netatmo itself, and re-registers it on every reconnection. To check, open the
integration **Logs**: you should see

```
Netatmo webhook registered — events will trigger an immediate refresh
```

Without a key (or without Gladys Plus), the integration behaves exactly as
before, polling every 2 minutes.

### What it brings

- **Values land almost instantly** — for example a thermostat setpoint changed
  from the Netatmo app, or a camera monitoring state.
- **Detections you can use in your scenes** (see below).

### Real-time detections (scene triggers)

Some events are **momentary**: they exist only in the event stream, no API poll
can report them. They are published as dedicated features, usable as **scene
triggers**:

| Device                     | Feature              | Fired by                       |
| -------------------------- | -------------------- | ------------------------------ |
| Indoor and outdoor cameras | **Motion**           | motion detected                |
| Indoor and outdoor cameras | **Person detected**  | a person detected / recognized |
| Outdoor camera (Presence)  | **Animal detected**  | an animal detected             |
| Outdoor camera (Presence)  | **Vehicle detected** | a vehicle detected             |
| Smoke alarm                | **Smoke**            | a smoke detection              |
| Carbon monoxide alarm      | **Carbon monoxide**  | a carbon monoxide detection    |
| Video doorbell             | **Doorbell**         | someone rings                  |

Each detection goes to **Yes** and returns to **No** by itself after one minute
(Netatmo sends no "detection over" event, except for smoke and carbon monoxide:
the "cleared" / "back to normal" event returns it to **No** at once). In a
scene, use the "value becomes Yes" trigger — for the doorbell, the **If the
doorbell rings** trigger. A ring fires once: the follow-up "call answered" /
"call missed" events of the Netatmo app are not separate triggers.

> ⚠️ **If your cameras already existed in Gladys**, these new features do not
> appear on their own: go to the **Discovery** screen and click **Update** on
> each camera (or smoke alarm) to add them. Without webhooks configured, these
> features simply stay at "No".

---

## Security accessories (camera-bridged)

When the Security family is enabled, the accessories linked to your cameras are
discovered too:

- **Door / window tag** (`NACamDoorTag`) — an opening sensor (open/closed), plus
  battery and RF signal.
- **Indoor siren** (`NIS`) — a read-only sounding sensor, plus battery and RF.
- **Smoke alarm** (`NSD`) — discovered with its battery and signal, plus a
  **Smoke** feature fed by the webhooks (see the section above): polling alone
  cannot report that state.
- **Carbon monoxide alarm** (`NCO`) — same as the smoke alarm: battery and
  signal (when Netatmo reports them), plus a **Carbon monoxide** feature fed by
  the webhooks.

---

## Roller shutters (Bubendorff / iDiamant)

Enable **Roller shutters (Bubendorff / iDiamant)** under **Devices to
discover** (off by default) to discover the Bubendorff shutters linked to your
iDiamant gateway: radio (`NBR`), wired (`NBO`) and solar (`NBS`) models. Each
shutter is created with:

- an **open / close / stop** control;
- a **position** (0% = closed, 100% = open), which you can also set;
- its **RF signal** quality.

The iDiamant gateway itself is not created as a device: its id is kept as the
shutter's `plug_id` parameter, every command goes through it. After a command,
Gladys refreshes the values about 30 seconds later so the new position shows
up without waiting for the next 2-minute cycle.

> ⚠️ **Already connected before shutter support?** The shutters need two new
> Netatmo permissions. Click **Connect** again on the Configuration screen and
> authorize Gladys — your devices and settings are kept. Until then, a shutter
> command fails and the Configuration screen asks you to reconnect.

**Intermediate positions:** depending on the model and motor, some Bubendorff
shutters only open or close fully. An intermediate position may then be
ignored or rounded by the shutter, and the reported position may only reflect
the last command — use open / close / stop on those.

---

## Updating the integration

**Installed from the catalog** (the usual case): Gladys checks the store
regularly. When a new version is out, the integration shows an **"Update
available"** badge (also counted next to **Integrations** in the menu), and its
**Supervision** tab names the version offered, with a link to its release
notes. Click **Update**: Gladys pulls the new image **and** applies the new
manifest — new configuration fields appear on their own, there is nothing to
re-paste. Your configuration and your devices are kept.

Gladys can take up to about an hour and a half to notice a new release (store
index refresh). **"Force update"** checks right away: it reads the latest
published version and pulls its image.

**Installed in developer mode** (manifest pasted by hand): **"Force update"**
only re-pulls the image of the tag you installed, and the version shown and the
configuration fields come from the pasted manifest — re-paste the updated
manifest to pick up new fields.

---

## Migrating from the built-in Netatmo service

This external integration replaces the Netatmo service built into Gladys. Its
devices get new identifiers (`netatmo:*` → `ext:netatmo:*`), so they are created
as new devices — but since **Gladys 4.84.1** you can **migrate** each old device
to its new counterpart and keep its **state history**, its **scenes** and its
**dashboards**.

### Before you start

- **Do not delete your old Netatmo devices**: the migration starts from them.
- **Migrate soon after creating the new devices.** When both devices recorded
  values over the same period, only the old history _older than the new
  device's first value_ is moved, so nothing is counted twice: the old device's
  values of the overlap period are dropped.

### Steps

1. Install and connect this integration, then create your devices from the
   **Discover** tab: the destination must exist before you migrate.
2. Open **Integrations → Netatmo** — the built-in integration, flagged as
   deprecated — then its **Devices** tab.
3. On an old device, click **Migrate**.
4. Pick the **Destination device**: the new device, listed under the external
   Netatmo integration (the list can be filtered by integration, room and
   name).
5. Check the **Feature matching** table. Gladys pre-fills it (same category,
   type and unit, then same name to tell twins apart); each old feature can be
   matched by hand, or set to **Do not migrate** — its history is then deleted.
   Look closely at the temperature rows of thermostats and stations, which
   carry several temperature features.
6. Click **Migrate and delete the old device**.

Gladys moves the history, rewrites the scenes and dashboards that used the old
device, moves the new device into the old one's room if it has none, re-points
the energy links, then deletes the old device. The result shows the number of
states moved and of scenes / dashboards updated. Repeat for each device.

A long history can take several minutes: follow it in **Settings → Tasks**. If
the page loses the connection, the migration keeps running in the background —
check that page before trying again. A failed migration can be re-run: it only
moves what is left.

---

## Troubleshooting

- **"Save first" when connecting:** save the client id / secret, then click
  Connect again.
- **Session expired:** click Connect again to re-authorize your Netatmo account.
- **A device shows an "unreachable" badge:** Netatmo reports it as offline (dead
  battery, powered off, out of range). Gladys stops publishing its last-known
  values so you are not misled by stale data; the badge clears when the device
  comes back.
- **A device shows a "Degraded" badge, or the status carries a message while
  Connected:** a part of the Netatmo cloud has been failing for several
  minutes (for instance the weather service). Gladys keeps publishing what the
  rest of the cloud still provides — station and module measures come from the
  home status too — and marks the devices left without fresh values. Nothing to
  do: both clear on their own on the first complete refresh. If it lasts, the
  integration **Logs** name the failing API.
- **A camera value or monitoring command fails once with a "reconnect" message:**
  your Netatmo authorization is missing the camera scope — reconnect your
  account.
- **A shutter command fails with a "reconnect" message:** your Netatmo
  authorization predates the shutter support — click Connect again.
- **No camera sound:** see the microphone tip in the Cameras section above.
- **"Some Netatmo permissions are missing" status:** a newer version added
  permissions (video doorbell) — click Connect again and accept them. The
  integration **Logs** list the missing ones.
