# Netatmo integration for Gladys Assistant

Connect your **Netatmo** devices — weather station, thermostats and radiator
valves, indoor/outdoor cameras and their accessories, Bubendorff roller
shutters, air quality monitors — to Gladys Assistant.

This integration talks to the Netatmo cloud on your behalf: you create your own
Netatmo Connect application once, connect your account, and Gladys discovers
your devices and keeps their values up to date.

---

## Prerequisites

- A **Netatmo account**, with your devices already installed and working in the
  Netatmo app (Gladys reads what Netatmo exposes — a device must be online in
  Netatmo first).
- Gladys Assistant **5.2 or later**.

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

| Toggle                 | Discovers                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Energy**             | Thermostat (`NATherm1`), relay plug (`NAPlug`), radiator valves (`NRV`), modulating thermostat (`OTM` + `OTH`), BTicino Smarther (`BNS`)         |
| **Weather**            | Station (`NAMain`) + outdoor, wind, rain and extra indoor modules                                                                                |
| **Security**           | Indoor (`NACamera`), Indoor Camera Advance (`NPC`) and outdoor (`NOC`) cameras, video doorbell (`NDB`), plus their accessories and known persons |
| **Roller shutters**    | Bubendorff shutters of an iDiamant gateway (`NBR`, `NBO`, `NBS`)                                                                                 |
| **Air quality**        | Smart Indoor Air Quality Monitor — Home Coach (`NHC`), off by default                                                                            |
| **BTicino door entry** | BTicino Classe 300X / Classe 300 EOS door entry, one device (`BNCX` + its `BNEU`, `BNDL`, `BNSL`, `BNCS`, `BNXM`) — preview, off by default      |

Enabling a family and **saving** re-runs the discovery automatically — no manual
re-scan needed. Newly surfaced devices appear on the **Discovery** screen, where
you create the ones you want.

**Camera live stream quality** (`poor` / `low` / `medium` / `high`, default
`high`) sets the quality of the camera live stream.

Values refresh every **2 minutes** (Netatmo rate limits).

---

## Heating mode (schedule / away / frost protection)

Each thermostat (`NATherm1`, modulating `OTM`, BTicino Smarther `BNS`) and
radiator valve (`NRV`) carries a **Heating mode** feature (a thermostat _preset_
in Gladys) with three choices:

| In Gladys            | In the Netatmo app         |
| -------------------- | -------------------------- |
| **Schedule**         | follow the weekly schedule |
| **Away**             | away mode                  |
| **Frost protection** | frost guard (`hg`)         |

The mode belongs to the **whole home** in Netatmo: changing it on one device
switches the entire home, and every thermostat and valve of the home shows the
new mode right after (the integration refreshes immediately). A mode changed
from the Netatmo app shows up at the next refresh (2 minutes, or 2-3 seconds
with the Gladys Plus webhooks).

Use it in a scene ("everybody left → heating to Away") with the standard
"Set device value" action.

> ⚠️ **If your thermostats already existed in Gladys**, the feature does not
> appear on its own: go to the **Discovery** screen and click **Update** on each
> thermostat and valve. Gladys **5.2** or later is required (the thermostat
> preset does not exist before).

---

## Modulating thermostat (OpenTherm)

The current Netatmo thermostat, the **modulating** (OpenTherm) model, comes
with the Energy family. Its two modules are each created as a device:

- the **thermostat** (`OTM`): room temperature, a writable **setpoint**, the
  **Heating mode** (see above), the **Boiler status** (on while the boiler
  heats), battery and RF signal, like the older `NATherm1`;
- the **OpenTherm relay** (`OTH`) wired to the boiler: its WiFi quality, the
  **outdoor temperature** Netatmo modulates the heating on, and a **Boiler
  fault** feature: 1 while the boiler reports a fault to Netatmo (water
  pressure, flame, maintenance…), 0 otherwise. The Netatmo app tells which
  fault it is.

The thermostat's room shows up in the **Netatmo heating** widget, and the
thermostat can be chosen in the **Change the heating mode** scene action. A
thermostat out of reach gets the **unreachable** badge and its battery and
signal are no longer published. No reconnection is needed: the thermostat
permissions have been part of the connection since the first version.

---

## BTicino Smarther thermostat

The **BTicino Smarther with Netatmo** thermostat (`BNS`) comes with the Energy
family. It is created with its room temperature, a writable **setpoint**, the
**Heating mode** (see above), the **Boiler status** (on while it heats), a
**Cooler status** (on while the air conditioning runs), a read-only **Comfort
boost** state (the Netatmo `boiler_valve_comfort_boost` field, as reported)
and its WiFi quality. Its room shows up in the **Netatmo heating** widget and
the thermostat can be chosen in the **Change the heating mode** scene action.

> ⚠️ **Netatmo account connected before this version?** The Smarther needs two
> new Netatmo permissions (`read_smarther`, `write_smarther`): click
> **Connect** again on the Configuration screen and accept them — your devices
> and settings are kept. Until then the connection status shows a "click
> Connect again" hint, and a setpoint or heating mode command on the Smarther
> fails with a "reconnect your Netatmo account" message.

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

### Outdoor camera floodlight

The outdoor camera (`NOC`) also gets two features for its floodlight, which
Netatmo sets to **On**, **Off** or **Auto** (lights up on a detection):

| Netatmo mode | **Floodlight** (light) | **Floodlight automatic mode** (switch) |
| ------------ | ---------------------- | -------------------------------------- |
| On           | On                     | Off                                    |
| Off          | Off                    | Off                                    |
| Auto         | Off                    | On                                     |

- Turning the **Floodlight** on forces the light on; turning the **automatic
  mode** on goes back to Auto.
- Turning one of them off only acts when it is the current mode, and then sets
  the floodlight to Off: a scene that turns off the lights leaves a floodlight
  in Auto alone, and switching the automatic mode off never turns off a light
  forced on.
- The floodlight is a Gladys light: the light scene actions (turn on / turn
  off) work with it.

A mode changed from the Netatmo app shows up at the next refresh (2 minutes, or
right away with the Gladys Plus webhooks).

> ⚠️ **If your outdoor camera already existed in Gladys**, the floodlight does
> not appear on its own: go to the **Discovery** screen and click **Update** on
> the camera.

### Indoor Camera Advance (`NPC`)

The Indoor Camera Advance is created like the indoor camera: a **dashboard
image**, a **monitoring** switch, the **Motion** and **Person detected**
detections (see _Detections_ below), and it shows up in the **Netatmo cameras**
widget. Two differences, both on Netatmo's side:

- its snapshot is fetched through the Netatmo VPN URL: like the video doorbell,
  this camera does not serve it on the local network;
- its live view is negotiated in **WebRTC** (see _WebRTC live view_ below):
  with an older Gladys, the camera box shows the still image.

> ⚠️ **Netatmo account connected before this version?** This camera needs three
> new Netatmo permissions (`read_camerapro`, `write_camerapro`,
> `access_camerapro`): click **Connect** again on the Configuration screen and
> accept them. Until then the connection status shows a "click Connect again"
> hint, the camera may be missing or unreachable, and a monitoring command
> refused by Netatmo fails with a "reconnect" message.

---

## Video doorbell

When the Security family is enabled, the Netatmo video doorbell (`NDB`) is
created with:

- a **dashboard image** (a snapshot, refreshed automatically) — fetched through
  the Netatmo VPN URL: the doorbell does not serve it on the local network;
- a **Doorbell** feature that shows **Ringing** when someone presses the button,
  usable as a scene trigger (**If the doorbell rings**) — in real time with
  the Gladys Plus webhooks, otherwise within about 2 minutes (see below);
- its **Wifi** link quality.

There is no monitoring switch (Netatmo offers none for the doorbell). Its live
view is negotiated in **WebRTC** (see _WebRTC live view_ below): with an older
Gladys, the camera box shows the still image.

> ⚠️ **Netatmo account connected before this version?** The doorbell needs two
> new Netatmo permissions (`read_doorbell`, `access_doorbell`): click
> **Connect** again on the Configuration screen and accept them. Until then the
> connection status shows a "click Connect again" hint.

### WebRTC live view (doorbell and Indoor Camera Advance)

The video doorbell and the Indoor Camera Advance stream **only in WebRTC**,
through the Netatmo cloud: no HLS, nothing on the local network. With a Gladys
version newer than 5.2.1 that includes the WebRTC camera live view
([Gladys#3215](https://github.com/GladysAssistant/Gladys/pull/3215)), the
dashboard camera box plays their live video. The browser sets up the stream;
Gladys and the integration only relay that set-up to Netatmo, and the video
goes straight from the Netatmo cloud to the browser, at home as through Gladys
Plus.

- **Older Gladys:** the camera box shows the still image, refreshed
  automatically, as before. After updating Gladys, save the integration
  configuration once (or scan again on the **Discovery** screen): the existing
  doorbell and camera switch to the live view, nothing to recreate.
- **Stopping:** the live view ends when you pause it, leave the dashboard or
  close the tab (Gladys ends a forgotten session after 30 seconds).
- **The live view does not start:** the box shows a message and the last image.
  Check that the camera is online in the Netatmo app and that the browser
  supports WebRTC. A strict firewall or VPN can block the WebRTC traffic to the
  Netatmo cloud. If the connection status or the integration **Logs** ask you to
  reconnect, the authorization lacks `access_doorbell` / `access_camerapro`:
  click **Connect** again.

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

Then every event Netatmo delivers adds a line such as
`Netatmo webhook event received: NACamera-movement (70:ee:50:…)`.

**Registered but nothing arrives?** Run the **Device diagnostic** action
(Configuration screen, both fields empty): the line **Webhook URL held by
Netatmo** says whether Netatmo still holds the integration's URL. One webhook
only per Netatmo application: if another client overwrote it (the "webhook URI"
field of dev.netatmo.com, the former core Netatmo service), save the Gladys Plus
key again. Netatmo also stops delivering for 24 hours to an application whose
webhook failed 5 times in a row (only dev.netatmo.com shows it, and lets you
lift it). Detections only exist while the camera monitoring is on. Whatever the
cause, the detections still arrive, within about 2 minutes (see below).

Without a key (or without Gladys Plus), the integration behaves exactly as
before, polling every 2 minutes — detections included.

### What it brings

- **Values land almost instantly** — for example a thermostat setpoint changed
  from the Netatmo app, or a camera monitoring state.
- **Detections in real time** instead of within about 2 minutes (see below).

### Detections (scene triggers)

Some events are **momentary**: they exist only in the Netatmo event stream,
no device state reports them. They are published as dedicated features,
usable as **scene triggers**:

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

**How fast?** With the Gladys Plus webhooks, in a few seconds. Without them —
or when Netatmo does not deliver them — the integration also reads the last
events of each home at every 2-minute refresh (Netatmo `getevents`, one call
per home): the same features and scene triggers fire, **within about 2
minutes**. A detection is never fired twice when both bring it, the events
already there when the integration starts are not replayed, and an event
older than 10 minutes when read (after an outage) fires nothing.

> ⚠️ **If your cameras already existed in Gladys**, these new features do not
> appear on their own: go to the **Discovery** screen and click **Update** on
> each camera (or smoke alarm) to add them.

---

## Scenes: Netatmo triggers and actions

The integration adds its own cards to the scene editor (Gladys **5.1** or
later): pick **Integration trigger** or **Integration action**, then the Netatmo
entry.

### Triggers (real time with the Gladys Plus webhooks, within about 2 minutes without)

| Trigger                    | Fires when                               | Information passed on to the actions |
| -------------------------- | ---------------------------------------- | ------------------------------------ |
| **A known person arrives** | an indoor camera recognizes a known face | Person, Camera, Home                 |
| **A known person leaves**  | Netatmo marks a known person as away     | Person, Camera, Home                 |
| **The siren sounds**       | an indoor siren starts sounding          | Siren, Home                          |

Optional filters: the **camera** (or siren) — empty means any — and the
**person**: type the name **exactly as shown in the Netatmo app** (the scene
editor cannot list the Netatmo persons; an empty field means any known person).
An unrecognized face never fires "A known person arrives" — the **Person
detected** feature of the camera covers every person.

### Actions

| Action                          | What it does                                                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Change the heating mode**     | Schedule, Away or Frost protection for the whole home; optional duration in minutes (Away and Frost protection: back to the schedule afterwards)                                                          |
| **Mark a person as away**       | one known person, or — person left empty — the whole home empty (re-arms the camera monitoring set to follow the presence)                                                                                |
| **Mark a person as at home**    | one known person, or — person left empty — every known person                                                                                                                                             |
| **Set a room setpoint**         | manual setpoint (7 to 30 °C) of the room of the chosen thermostat or valve; optional duration in minutes, then back to the schedule (empty: the default duration of a manual setpoint in the Netatmo app) |
| **Boost a room**                | full-power heating (boost) of the room of the chosen thermostat or valve; optional duration in minutes (empty: the default boost duration of the Netatmo app)                                             |
| **Back to the schedule**        | ends the manual setpoint or the boost of the room: it follows the schedule again                                                                                                                          |
| **Choose the heating schedule** | makes one of the heating schedules of the home the active one                                                                                                                                             |

The **home** is the one of the device you choose in the action (a thermostat or
valve for the heating, a camera for the persons). Leave it empty when your
account has a single home. The person field accepts a scene variable: "A known
person arrives → Mark a person as at home" with the **Person** information.
Each action returns the **Home** name to the following steps.

The three **room** actions apply to the room of the thermostat or valve you
choose (required) and also return the **Room** name. **Choose the heating
schedule** takes the schedule **name exactly as shown in the Netatmo app**
(upper / lower case ignored): the scene editor cannot list the Netatmo
schedules. A name that does not exist fails the action, and the scene logs name
the schedules of the home. It also returns the **Schedule** name.

---

## Dashboard widgets

Three widgets join the dashboard widget picker (Gladys **5.1** or later): **Edit
dashboard**, add a widget and search for "Netatmo".

| Widget              | Shows                                                                                                                                                                                                                                                                                                     | Settings                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Netatmo weather** | live tiles of the station (temperatures, humidity, CO2, noise, pressure, rain, wind) and a health row per module with a low battery or out of reach                                                                                                                                                       | the station (empty: the first one) and the readings shown: Overview, Indoor, or Outdoor, rain and wind |
| **Netatmo heating** | the heating mode and the active schedule of the home, one row per room (measured → setpoint temperature, marked Manual or Boost when the setpoint does not come from the schedule), the Schedule / Frost protection / Away buttons and, with several schedules, a **Change schedule** button listing them | a thermostat or valve of the home (empty: your single home)                                            |
| **Netatmo cameras** | the latest picture of each camera, its monitoring, and buttons to turn it on / off                                                                                                                                                                                                                        | one camera shown large (empty: every camera in a list)                                                 |

The tiles follow the values live; the rest refreshes with the integration (2
minutes, or as soon as the heating mode, the monitoring or a picture changes).
The camera pictures are served by the integration itself — the dashboard never
loads an image from Netatmo's servers. A widget only shows the devices you
created in Gladys.

---

## Security accessories (camera-bridged)

When the Security family is enabled, the accessories linked to your cameras are
discovered too:

- **Door / window tag** (`NACamDoorTag`) — an opening sensor (open/closed), plus
  battery and RF signal.
- **Indoor siren** (`NIS`) — a read-only sounding sensor, plus battery and RF.
- **Smoke alarm** (`NSD`) — discovered with its battery and signal, plus a
  **Smoke** detection (see _Detections_ above): in real time with the
  webhooks, within about 2 minutes without.
- **Carbon monoxide alarm** (`NCO`) — same as the smoke alarm: battery and
  signal (when Netatmo reports them), plus a **Carbon monoxide** detection,
  like the smoke.

---

## Known persons

When the Security family is enabled, each home whose cameras recognize faces
gets a **"<home> - Known persons"** device, with one **Presence** feature per
person named in the Netatmo app: **Presence detected** when Netatmo considers
the person at home, **No presence** when away — the state the Netatmo app shows.
Use it in your scenes like any presence sensor.

- Only **named** persons get a feature: an unrecognized face (no name in the
  Netatmo app) is ignored.
- The presence refreshes every 2 minutes, and **at once** with the Gladys Plus
  webhooks (a known person arrives / leaves) or after the **Mark a person as
  away / at home** scene actions.
- When Netatmo does not report a person's presence, nothing is published: the
  last known value stays.
- A person added, renamed or deleted in the Netatmo app: click **Update** on
  the device in the **Discovery** screen to add, rename or remove the feature.
  The feature follows the Netatmo person id, so a rename keeps its history.

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

## Air quality monitor (Home Coach)

When the **Air quality devices (Home Coach)** family is enabled, each Netatmo
Smart Indoor Air Quality Monitor (Home Coach, `NHC`) is discovered with its
temperature (plus the day's minimum and maximum), humidity, CO2, noise,
pressure and absolute pressure, its WiFi quality, and an **Air quality**
feature. It is named after the name you gave it in the Netatmo app.

The Home Coach does not measure an air quality index: it rates the room on five
levels, from its CO2, humidity, noise and temperature. Gladys reads an air
quality feature as an AQI (0 to 500) to colour it on the dashboard and to pass
it to HomeKit, so each level is published as the middle of the matching AQI
band:

| Home Coach level | Value in Gladys | Dashboard colour | HomeKit   |
| ---------------- | --------------- | ---------------- | --------- |
| Healthy          | 25              | green            | Excellent |
| Fine             | 75              | yellow           | Good      |
| Fair             | 125             | orange           | Fair      |
| Poor             | 175             | pink             | Inferior  |
| Unhealthy        | 250             | purple           | Poor      |

In a scene, compare with these values: for example "Air quality above 150"
means poor or unhealthy.

An **Air quality level** feature shows the same rating in words on the
dashboard. Gladys does not translate option labels yet: they are in French
(Sain, Correct, Moyen, Mauvais, Malsain — healthy, fine, fair, poor,
unhealthy). It keeps no history: the numeric **Air quality** feature
keeps the history, the colours and HomeKit.

An offline Home Coach gets the **unreachable** badge and its last-known values
are not published. No reconnection is needed: the Home Coach permission
(`read_homecoach`) has been part of the connection since the first version.

---

## BTicino door entry (Classe 300X / Classe 300 EOS) — preview

The **BTicino Classe 300X** and **Classe 300 EOS with Netatmo** video door entry
systems are served by the Netatmo API, with far less than the Netatmo app
shows ([issue #59](https://github.com/Terdious/gladys-netatmo/issues/59)). Enable **BTicino door entry (Classe 300) — preview** under
**Devices to discover** (off by default) and save.

The door entry is discovered as **one device**, named after its indoor unit
(the `BNCX` gateway, e.g. "Classe 300EOS with Netatmo"). The modules it
bridges add their features to it, named after them:

| Module                    | Netatmo type | On the door entry device                                                  |
| ------------------------- | ------------ | ------------------------------------------------------------------------- |
| Indoor unit (gateway)     | `BNCX`       | WiFi quality, **doorbell ring** (real time with the Gladys Plus webhooks) |
| Staircase / outdoor light | `BNSL`       | **light on / off** (e.g. "Outdoor lighting")                              |
| Controlled socket         | `BNCS`       | read-only on / off state, when Netatmo reports it                         |
| Street panel              | `BNEU`       | nothing (Netatmo reports no value for it)                                 |
| Door lock                 | `BNDL`       | nothing — see below                                                       |
| X module                  | `BNXM`       | its signal quality, when Netatmo reports one                              |

- **Light:** switched through Netatmo like in the app. Netatmo never reports
  whether it is on: Gladys shows the last command it sent (the staircase light
  usually switches itself off after a while, Gladys cannot know when).
- **Ring:** published like the [video doorbell](#video-doorbell) ring (`Ringing` then the
  time of the last ring), usable as a scene trigger — in real time with the
  [Gladys Plus webhooks](#gladys-plus-webhooks-real-time--optional), within about 2 minutes without. Netatmo documents this event for the
  Classe 300 EOS; it has not been seen on a real installation yet: if your
  rings do not show, send a diagnostic (below).
- **Opening the door is not available.** The Netatmo API used by third-party
  applications does not let them open a BTicino door lock (Netatmo blocks it
  for security reasons); only the Netatmo / BTicino app can.
- The **unreachable** badge follows the indoor unit. A bridged module Netatmo
  reports offline publishes no value.
- If you created devices with the 2.2.0 preview (one per module), delete them
  and create the door entry device again.

> ⚠️ **New Netatmo permissions — click Connect again.** Turning the toggle on
> asks for four extra permissions, requested only while it is on:
> `read_bfi` / `write_bfi` (BTicino IP, Classe 300X) and `read_mx` /
> `write_mx` (Classe 300 EOS). Click **Connect** again on the Configuration
> screen and accept them — your devices and settings are kept.
> Until then the connection status shows a "click Connect again" hint, and
> Netatmo may leave the BTicino modules out (a light command then fails with a
> "reconnect" message).

### Sending a diagnostic to the maintainer

Use the **Device diagnostic** action of the Configuration screen (see
[Troubleshooting](#troubleshooting)): pick the door entry device, or leave both
fields empty for the whole account, and paste the result in
[issue #59](https://github.com/Terdious/gladys-netatmo/issues/59). Ring once before running it (and wait 2 minutes): the report lists the last webhook
events of each module, and the last events Netatmo returns for it (`getevents`).

While the toggle is on, the integration also writes to its logs, at the first
refresh after a start and then **only when something changes**, the raw data
Netatmo returns for every BTicino module and every Gladys Plus webhook event
about one. Each line starts with `[bticino-diagnostic]`; the same redaction
applies (tokens, keys, e-mail addresses and URLs are replaced by
`<redacted>`, the module, bridge and home ids are kept), and a line longer
than 8 KB is cut with a `[truncated]` marker.

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
- **Motion / person detections (or rings) arrive about 2 minutes late, while
  the Netatmo app alerts at once:** the Gladys Plus webhooks do not reach the
  integration, the detections come from the 2-minute `getevents` reading.
  Run the **Device diagnostic** action (both fields empty) and compare **Last
  events seen by getevents** with **Last webhook events**: events in the first
  and none in the second means Netatmo does not deliver the webhooks — see
  _Registered but nothing arrives?_ in the webhooks section. Nothing in
  either: check that the camera monitoring is on. The **Events poll
  (getevents)** line shows its last error (for instance a missing permission:
  click Connect again).
- **No camera sound:** see the microphone tip in the Cameras section above.
- **Doorbell or Indoor Camera Advance without live video:** see _WebRTC live
  view_ in the Video doorbell section (Gladys version, browser, firewall).
- **"Some Netatmo permissions are missing" status:** a newer version added
  permissions (video doorbell, Indoor Camera Advance, BTicino door entry) — click Connect again and accept them. The
  integration **Logs** list the missing ones.
- **Device diagnostic (report a problem or an unsupported device):** on the
  Configuration screen, run the **Device diagnostic** action. Pick a device
  created in Gladys, or type the name or Netatmo id of a module you did not
  create (e.g. one the integration does not support yet); leave both fields
  empty for a summary of the whole account. The report shows what Netatmo
  sends for the module, what the integration publishes for it, the Netatmo
  fields it does not use yet, the last webhook events and the last events
  read with `getevents`, the permissions and the
  state of each Netatmo API. It is also written to the integration **Logs**
  (lines after `[netatmo-diagnostic]`) if you cannot copy it from the screen.
  **Read it before posting it publicly:** tokens, URLs and e-mail addresses
  are removed, but module and home ids and the names you gave your modules
  are kept.
- **Still stuck, or a device is missing?** Ask on the forum topic
  [Intégration externe - Netatmo](https://community.gladysassistant.com/t/integration-externe-netatmo/11308),
  or open an issue on [GitHub](https://github.com/Terdious/gladys-netatmo/issues) with the integration logs
  (**Logs** tab).
