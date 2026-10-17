# Netatmo-Integration für Gladys Assistant

Verbinde deine **Netatmo**-Geräte — Wetterstation, Thermostate und
Heizkörperventile, Innen- und Außenkameras samt Zubehör, Bubendorff-Rollläden,
Raumluftsensoren — mit Gladys Assistant.

Diese Integration kommuniziert in deinem Namen mit der Netatmo-Cloud: Du
erstellst einmalig deine eigene Netatmo-Connect-Anwendung, verbindest dein
Konto, und Gladys erkennt deine Geräte und hält ihre Werte aktuell.

---

## Voraussetzungen

- Ein **Netatmo-Konto**, bei dem deine Geräte bereits in der Netatmo-App
  installiert sind und funktionieren (Gladys liest, was Netatmo bereitstellt —
  ein Gerät muss zuerst in Netatmo online sein).
- Gladys Assistant **5.2 oder neuer**.

---

## Schritt 1 — Erstelle deine Netatmo-Connect-Anwendung

Gladys liefert niemals einen gemeinsamen Netatmo-Schlüssel mit: Du verwendest
**deine eigene** Netatmo-Connect-Anwendung, sodass deine Daten zwischen deinem
Gladys und deinem Netatmo-Konto bleiben.

1. Gehe zu **[Netatmo Connect](https://dev.netatmo.com/)** und melde dich mit
   deinem Netatmo-Konto an.
2. Öffne **[My Apps → Create](https://dev.netatmo.com/apps/)** und erstelle
   eine neue Anwendung (beliebiger Name und beliebige Beschreibung — z. B.
   „Gladys“).
3. Nach dem Erstellen zeigt die Seite der Anwendung zwei Werte an, die du in
   Gladys kopierst:
   - **client id**
   - **client secret**

Du musst im Portal **keine** Berechtigungen (Scopes) und keine Redirect-URI
konfigurieren: Gladys fordert die benötigten Berechtigungen (Lesen + Schreiben,
für Energie, Wetter, Sicherheit einschließlich Kameras und Video-Türklingel
sowie die Rollläden) beim Verbinden automatisch an und kümmert sich selbst um
die OAuth2-Weiterleitung.

---

## Schritt 2 — In Gladys konfigurieren und verbinden

Im Tab **Konfiguration** der Integration:

1. Füge die **Client-ID der Netatmo-Anwendung** und das **Client-Secret der
   Netatmo-Anwendung** ein.
2. Klicke auf **Konfiguration speichern**.
3. Klicke auf **Verbinden**: Ein Netatmo-Fenster öffnet sich. Melde dich an und
   autorisiere Gladys. Du wirst zurückgeleitet, und der Status wechselt zu
   **Verbunden**.

> **Tipp:** Speichere Client-ID / Client-Secret immer mit **Konfiguration
> speichern**, _bevor_ du auf Verbinden klickst. Meldet Verbinden, dass die
> Zugangsdaten zuerst gespeichert werden müssen, speichere das Formular und
> klicke erneut auf Verbinden.

Das Access-Token und das Refresh-Token werden von der Integration selbst
gespeichert und erscheinen nie im Formular. Gladys erneuert sie automatisch;
sollte die Sitzung einmal endgültig ablaufen, fordert dich der Tab
Konfiguration auf, dich erneut zu verbinden.

---

## Schritt 3 — Wähle die Gerätefamilien

Aktiviere unter **Zu erkennende Geräte** die Familien, die du besitzt:

| Schalter                    | Erkennt                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Energie**                 | Thermostat (`NATherm1`), Relais (`NAPlug`), Heizkörperventile (`NRV`), modulierendes Thermostat (`OTM` + `OTH`), BTicino Smarther (`BNS`)                     |
| **Wetter**                  | Station (`NAMain`) + Außen-, Wind-, Regen- und zusätzliche Innenmodule                                                                                        |
| **Sicherheit**              | Innenkameras (`NACamera`), Innenkamera Advance (`NPC`) und Außenkameras (`NOC`), Video-Türklingel (`NDB`) sowie deren Zubehör und die bekannten Personen      |
| **Rollläden**               | Bubendorff-Rollläden eines iDiamant-Gateways (`NBR`, `NBO`, `NBS`)                                                                                            |
| **Luftqualität**            | Raumluftsensor — Home Coach (`NHC`), standardmäßig deaktiviert                                                                                                |
| **BTicino-Türsprechanlage** | BTicino-Türsprechanlage Classe 300X / Classe 300 EOS, ein Gerät (`BNCX` + seine `BNEU`, `BNDL`, `BNSL`, `BNCS`, `BNXM`) — Vorschau, standardmäßig deaktiviert |

Wenn du eine Familie aktivierst und **speicherst**, wird die Erkennung
automatisch neu gestartet — kein manueller Scan nötig. Neu gefundene Geräte
erscheinen im Tab **Entdecken**, wo du diejenigen erstellst, die du möchtest.

**Qualität des Kamera-Livestreams** (`poor` / `low` / `medium` / `high`,
Standard `high`) legt die Qualität des Kamera-Livestreams fest.

Die Werte werden alle **2 Minuten** aktualisiert (Ratenbegrenzung von Netatmo).

---

## Heizmodus (Zeitplan / abwesend / Frostschutz)

Jedes Thermostat (`NATherm1`, modulierendes `OTM`, BTicino Smarther `BNS`) und
jedes Heizkörperventil (`NRV`) hat eine Funktion **Heizmodus** (ein
Thermostat-_Preset_ in Gladys) mit drei Möglichkeiten:

| In Gladys       | In der Netatmo-App        |
| --------------- | ------------------------- |
| **Zeitplan**    | dem Wochenzeitplan folgen |
| **Abwesend**    | Abwesenheitsmodus         |
| **Frostschutz** | Frostschutz (`hg`)        |

Bei Netatmo gehört der Modus zum **ganzen Zuhause**: Änderst du ihn an einem
Gerät, wechselt das ganze Zuhause, und jedes Thermostat und Ventil des Zuhauses
zeigt den neuen Modus gleich danach an (die Integration aktualisiert sofort).
Ein in der Netatmo-App geänderter Modus erscheint bei der nächsten
Aktualisierung (2 Minuten, oder 2-3 Sekunden mit den Gladys-Plus-Webhooks).

Nutze ihn in einer Szene („alle sind weg → Heizung auf Abwesend“) mit der
Standardaktion „Gerätewert setzen“.

> ⚠️ **Wenn deine Thermostate bereits in Gladys existierten**, erscheint die
> Funktion nicht von selbst: Öffne den Bildschirm **Erkennung** und klicke bei
> jedem Thermostat und Ventil auf **Aktualisieren**. Gladys **5.2** oder neuer
> ist erforderlich (das Thermostat-Preset gibt es vorher nicht).

---

## Modulierendes Thermostat (OpenTherm)

Das aktuelle Netatmo-Thermostat, das **modulierende** Modell (OpenTherm),
gehört zur Familie Energie. Seine beiden Module werden jeweils als Gerät
angelegt:

- das **Thermostat** (`OTM`): Raumtemperatur, ein steuerbarer **Sollwert**, der
  **Heizmodus** (siehe oben), der **Kesselstatus** (an, während der Kessel
  heizt), Akku und Funksignal, wie beim älteren `NATherm1`;
- das **OpenTherm-Relais** (`OTH`), das mit dem Kessel verbunden ist: seine
  WLAN-Qualität, die **Außentemperatur**, nach der Netatmo die Heizung
  moduliert, und eine Funktion **Kesselstörung**: 1, solange der Kessel
  Netatmo eine Störung meldet (Wasserdruck, Flamme, Wartung…), sonst 0. Die
  Netatmo-App zeigt, um welche Störung es sich handelt.

Der Raum des Thermostats erscheint im Widget **Netatmo-Heizung**, und das
Thermostat kann in der Szenenaktion **Heizmodus ändern** gewählt werden. Ein
nicht erreichbares Thermostat erhält das Badge **nicht erreichbar**, und
Akku und Signal werden nicht mehr veröffentlicht. Du musst dich nicht erneut
verbinden: Die Thermostat-Berechtigungen sind seit der ersten Version Teil der
Verbindung.

---

## Thermostat BTicino Smarther

Das Thermostat **BTicino Smarther with Netatmo** (`BNS`) gehört zur Familie
Energie. Es wird mit seiner Raumtemperatur, einem steuerbaren **Sollwert**, dem
**Heizmodus** (siehe oben), dem **Kesselstatus** (an, während es heizt), dem
**Klimastatus** (an, während die Klimaanlage läuft), einem schreibgeschützten
Zustand **Komfort-Boost** (das Netatmo-Feld `boiler_valve_comfort_boost`, wie
gemeldet) und seiner WLAN-Qualität angelegt. Sein Raum erscheint im Widget
**Netatmo-Heizung**, und das Thermostat kann in der Szenenaktion **Heizmodus
ändern** gewählt werden.

> ⚠️ **Netatmo-Konto vor dieser Version verbunden?** Das Smarther braucht zwei
> neue Netatmo-Berechtigungen (`read_smarther`, `write_smarther`): Klicke auf
> dem Konfigurationsbildschirm erneut auf **Verbinden** und erteile sie — deine
> Geräte und Einstellungen bleiben erhalten. Bis dahin zeigt der
> Verbindungsstatus den Hinweis „erneut auf Verbinden klicken“, und ein
> Sollwert- oder Heizmodus-Befehl am Smarther schlägt mit der Meldung
> „Netatmo-Konto erneut verbinden“ fehl.

---

## Kameras

Wenn die Familie Sicherheit aktiviert ist, wird jede Kamera erstellt mit:

- einem **Dashboard-Bild** (ein Schnappschuss, automatisch aktualisiert) —
  Gladys ruft es **zuerst im lokalen Netzwerk** ab (mit Rückgriff auf die
  Netatmo-VPN-URL);
- einem Schalter **Überwachung** (schaltet die Überwachung der Kamera ein/aus);
- einer Schaltfläche **Livestream** (HLS), ebenfalls lokal zuerst aufgebaut.

### Livestream — Latenz und Ton

- **Latenz (~10 s):** Sie ist dem Netatmo-HLS-Livestream eigen — genau dieselbe
  Verzögerung gibt es auch in Netatmos eigener Web- und Mobil-App. Wähle für
  eine flüssigere Wiedergabe in der Kamerakachel des Dashboards die Latenz
  `low` und die Kameraqualität `medium` (720p).
- **Kein Ton?** Das Kameramikrofon muss in der Netatmo-App **aktiviert** sein:
  _Mein Zuhause verwalten → Raum der Kamera auswählen → Kamera → Erweiterte
  Einstellungen → Mikrofon aktivieren_. Ist es dort ausgeschaltet, erhält kein
  Client (Gladys, Netatmo-Web, Netatmo-App) Ton. Gladys überträgt den Ton,
  sobald der Stream ihn enthält — auf der Seite von Gladys ist nichts zu
  konfigurieren.

### Flutlicht der Außenkamera

Die Außenkamera (`NOC`) erhält außerdem zwei Funktionen für ihr Flutlicht, das
Netatmo auf **Ein**, **Aus** oder **Auto** stellt (leuchtet bei einer
Erkennung):

| Netatmo-Modus | **Floodlight** (Licht) | **Floodlight automatic mode** (Schalter) |
| ------------- | ---------------------- | ---------------------------------------- |
| Ein           | Ein                    | Aus                                      |
| Aus           | Aus                    | Aus                                      |
| Auto          | Aus                    | Ein                                      |

- **Floodlight** einschalten erzwingt das Licht; den **Automatikmodus**
  einschalten kehrt zu Auto zurück.
- Das Ausschalten einer der beiden wirkt nur, wenn es der aktuelle Modus ist,
  und stellt das Flutlicht dann auf Aus: Eine Szene, die die Lichter ausschaltet,
  lässt ein Flutlicht im Modus Auto in Ruhe, und das Ausschalten des
  Automatikmodus schaltet nie ein erzwungenes Licht aus.
- Das Flutlicht ist ein Gladys-Licht: Die Szenenaktionen für Lichter
  (einschalten / ausschalten) funktionieren damit.

Ein in der Netatmo-App geänderter Modus erscheint bei der nächsten
Aktualisierung (2 Minuten, oder sofort mit den Gladys-Plus-Webhooks).

> ⚠️ **Wenn deine Außenkamera bereits in Gladys existierte**, erscheint das
> Flutlicht nicht von selbst: Öffne den Bildschirm **Erkennung** und klicke bei
> der Kamera auf **Aktualisieren**.

### Innenkamera Advance (`NPC`)

Die Innenkamera Advance wird wie die Innenkamera erstellt: ein
**Dashboard-Bild**, ein Schalter **Überwachung**, die Erkennungen **Bewegung**
und **Person erkannt** (siehe _Erkennungen_ unten), und sie erscheint im Widget
**Netatmo-Kameras**. Zwei Unterschiede, beide auf Netatmo-Seite:

- ihr Schnappschuss wird über die Netatmo-VPN-URL abgerufen: Wie die
  Video-Türklingel liefert diese Kamera ihn nicht im lokalen Netzwerk;
- ihr Live-Video wird per **WebRTC** ausgehandelt (siehe _WebRTC-Live-Video_
  unten): Mit einer älteren Gladys-Version zeigt die Kamerakachel das
  Standbild.

> ⚠️ **Netatmo-Konto vor dieser Version verbunden?** Diese Kamera benötigt drei
> neue Netatmo-Berechtigungen (`read_camerapro`, `write_camerapro`,
> `access_camerapro`): Klicke auf dem Konfigurationsbildschirm erneut auf
> **Verbinden** und akzeptiere sie. Bis dahin zeigt der Verbindungsstatus einen
> Hinweis, erneut auf Verbinden zu klicken, die Kamera kann fehlen oder
> unerreichbar sein, und ein von Netatmo abgelehnter Überwachungsbefehl schlägt
> mit einer Meldung „erneut verbinden“ fehl.

---

## Video-Türklingel

Wenn die Familie Sicherheit aktiviert ist, wird die Netatmo-Video-Türklingel
(`NDB`) erstellt mit:

- einem **Dashboard-Bild** (ein Schnappschuss, automatisch aktualisiert) —
  abgerufen über die Netatmo-VPN-URL: Die Türklingel stellt es nicht im lokalen
  Netzwerk bereit;
- einer Funktion **Türklingel**, die **Klingelt** anzeigt, wenn jemand den
  Knopf drückt, nutzbar als Szenen-Auslöser (**Wenn die Türklingel klingelt**)
  — in Echtzeit mit den Gladys-Plus-Webhooks, sonst innerhalb von etwa 2
  Minuten (siehe unten);
- der Qualität ihrer **WLAN**-Verbindung.

Es gibt keinen Überwachungsschalter (Netatmo bietet keinen für die
Türklingel). Ihr Live-Video wird per **WebRTC** ausgehandelt (siehe
_WebRTC-Live-Video_ unten): Mit einer älteren Gladys-Version zeigt die
Kamerakachel das Standbild.

> ⚠️ **Netatmo-Konto vor dieser Version verbunden?** Die Türklingel benötigt
> zwei neue Netatmo-Berechtigungen (`read_doorbell`, `access_doorbell`): Klicke
> auf dem Konfigurationsbildschirm erneut auf **Verbinden** und akzeptiere sie.
> Bis dahin zeigt der Verbindungsstatus einen Hinweis, erneut auf Verbinden zu
> klicken.

### WebRTC-Live-Video (Türklingel und Innenkamera Advance)

Die Video-Türklingel und die Innenkamera Advance streamen **nur per WebRTC**
über die Netatmo-Cloud: kein HLS, nichts im lokalen Netzwerk. Mit einer
Gladys-Version nach 5.2.1, die das WebRTC-Live-Video der Kameras enthält
([Gladys#3215](https://github.com/GladysAssistant/Gladys/pull/3215)), spielt
die Kamerakachel des Dashboards ihr Live-Video ab. Der Browser baut den Stream
auf; Gladys und die Integration leiten diesen Aufbau nur an Netatmo weiter, und
das Video geht direkt von der Netatmo-Cloud zum Browser, zu Hause wie über
Gladys Plus.

- **Ältere Gladys-Version:** Die Kamerakachel zeigt wie bisher das Standbild,
  automatisch aktualisiert. Speichere nach dem Gladys-Update einmal die
  Konfiguration der Integration (oder scanne erneut auf dem Bildschirm
  **Erkennung**): Die vorhandene Türklingel und Kamera wechseln zum
  Live-Video, nichts muss neu erstellt werden.
- **Beenden:** Das Live-Video endet, wenn du es pausierst, das Dashboard
  verlässt oder den Tab schließt (Gladys beendet eine vergessene Sitzung nach
  30 Sekunden).
- **Das Live-Video startet nicht:** Die Kachel zeigt eine Meldung und das letzte
  Bild. Prüfe, ob die Kamera in der Netatmo-App online ist und ob der Browser
  WebRTC unterstützt. Eine strenge Firewall oder ein VPN kann den WebRTC-Verkehr
  zur Netatmo-Cloud blockieren. Fordern der Verbindungsstatus oder die **Logs**
  der Integration dazu auf, das Konto erneut zu verbinden, fehlt der
  Autorisierung `access_doorbell` / `access_camerapro`: Klicke erneut auf
  **Verbinden**.

---

## Gladys-Plus-Webhooks (Echtzeit) — optional

Standardmäßig fragt Gladys Netatmo **alle 2 Minuten** ab. Mit Webhooks
**benachrichtigt** Netatmo Gladys, sobald etwas passiert: Die Werte werden dann
in **2–3 Sekunden** aktualisiert, statt auf den nächsten Zyklus zu warten —
ohne die Zahl der Netatmo-API-Aufrufe zu erhöhen.

Da ein lokales Gladys nicht aus dem Internet erreichbar ist, leitet **Gladys
Plus** die Ereignisse weiter; ein aktives Gladys-Plus-Abonnement ist daher
erforderlich.

### Einrichtung (ein einziger Schritt)

1. Suche im Tab **Konfiguration** der Integration den Block **„Gladys-Plus-
   Webhooks“** (wird automatisch angezeigt).
2. Füge dort deinen Gladys-Plus-**Open-API-Schlüssel** ein. Das war's.

**Auf der Netatmo-Website ist nichts einzufügen:** Die Integration registriert
die URL selbst bei Netatmo und registriert sie bei jeder erneuten Verbindung
neu. Zur Kontrolle öffne die **Protokolle** der Integration: Dort solltest du
Folgendes sehen

```
Netatmo webhook registered — events will trigger an immediate refresh
```

Danach fügt jedes von Netatmo zugestellte Ereignis eine Zeile hinzu, etwa
`Netatmo webhook event received: NACamera-movement (70:ee:50:…)`.

**Registriert, aber es kommt nichts an?** Starte die Aktion **Gerätediagnose**
(Konfigurationsbildschirm, beide Felder leer): Die Zeile **Webhook URL held by
Netatmo** zeigt, ob Netatmo noch die URL der Integration hält. Nur ein Webhook
pro Netatmo-Anwendung: Hat ein anderer Client sie überschrieben (das Feld
„webhook URI“ auf dev.netatmo.com, der frühere Netatmo-Dienst des Cores),
speichere den Gladys-Plus-Schlüssel erneut. Netatmo stellt außerdem 24 Stunden
lang nichts mehr zu, wenn der Webhook einer Anwendung 5-mal hintereinander
fehlgeschlagen ist (nur dev.netatmo.com zeigt das an und hebt es auf).
Erkennungen gibt es nur, solange die Überwachung der Kamera aktiv ist. Unabhängig
von der Ursache kommen die Erkennungen trotzdem an, innerhalb von etwa 2
Minuten (siehe unten).

Ohne Schlüssel (oder ohne Gladys Plus) verhält sich die Integration genau wie
zuvor und fragt alle 2 Minuten ab — Erkennungen inklusive.

### Was es bringt

- **Die Werte kommen fast sofort an** — zum Beispiel ein in der Netatmo-App
  geänderter Thermostat-Sollwert oder der Überwachungsstatus einer Kamera.
- **Erkennungen in Echtzeit** statt innerhalb von etwa 2 Minuten (siehe
  unten).

### Erkennungen (Szenen-Auslöser)

Manche Ereignisse sind **momentan**: Sie existieren nur im Netatmo-
Ereignisstrom, kein Gerätezustand meldet sie. Sie werden als eigene Funktionen
veröffentlicht, die als **Szenen-Auslöser** nutzbar sind:

| Gerät                   | Funktion             | Ausgelöst durch                       |
| ----------------------- | -------------------- | ------------------------------------- |
| Innen- und Außenkameras | **Bewegung**         | erkannte Bewegung                     |
| Innen- und Außenkameras | **Person erkannt**   | eine erkannte / identifizierte Person |
| Außenkamera (Presence)  | **Tier erkannt**     | ein erkanntes Tier                    |
| Außenkamera (Presence)  | **Fahrzeug erkannt** | ein erkanntes Fahrzeug                |
| Rauchmelder             | **Rauch**            | eine Raucherkennung                   |
| Kohlenmonoxidmelder     | **Kohlenmonoxid**    | eine Kohlenmonoxid-Erkennung          |
| Video-Türklingel        | **Türklingel**       | jemand klingelt                       |

Jede Erkennung wechselt auf **Ja** und kehrt nach einer Minute von selbst auf
**Nein** zurück (Netatmo sendet kein Ereignis „Erkennung beendet“, außer bei
Rauch und Kohlenmonoxid: Das Ereignis „Rauch verschwunden“ / „wieder normal“
setzt sie sofort auf **Nein**). Verwende in einer Szene den Auslöser „Wert wird
Ja“ — für die Türklingel den Auslöser **Wenn die Türklingel klingelt**. Ein
Klingeln löst einmal aus: Die Folgeereignisse „Anruf angenommen“ / „Anruf
verpasst“ der Netatmo-App sind keine eigenen Auslöser.

**Wie schnell?** Mit den Gladys-Plus-Webhooks in wenigen Sekunden. Ohne sie —
oder wenn Netatmo sie nicht zustellt — liest die Integration bei jeder
2-Minuten-Aktualisierung auch die letzten Ereignisse jedes Zuhauses
(Netatmo `getevents`, ein Aufruf pro Zuhause): Dieselben Funktionen und
Szenen-Auslöser lösen aus, **innerhalb von etwa 2 Minuten**. Eine Erkennung,
die beide liefern, löst nie zweimal aus, die beim Start der Integration
bereits vorhandenen Ereignisse werden nicht wiederholt, und ein Ereignis, das
beim Lesen älter als 10 Minuten ist (nach einem Ausfall), löst nichts aus.

> ⚠️ **Wenn deine Kameras bereits in Gladys existierten**, erscheinen diese
> neuen Funktionen nicht von selbst: Gehe in den Tab **Entdecken** und klicke
> bei jeder Kamera (oder jedem Rauchmelder) auf **Aktualisieren**, um sie
> hinzuzufügen.

---

## Szenen: Netatmo-Auslöser und -Aktionen

Die Integration fügt dem Szenen-Editor eigene Karten hinzu (Gladys **5.1** oder
neuer): Wähle **Integrations-Auslöser** oder **Integrations-Aktion** und dann
den Netatmo-Eintrag.

### Auslöser (in Echtzeit mit den Gladys-Plus-Webhooks, ohne sie innerhalb von etwa 2 Minuten)

| Auslöser                          | Löst aus, wenn                                     | An die Aktionen weitergegebene Informationen |
| --------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| **Eine bekannte Person kommt an** | eine Innenkamera ein bekanntes Gesicht erkennt     | Person, Kamera, Zuhause                      |
| **Eine bekannte Person geht**     | Netatmo eine bekannte Person als abwesend markiert | Person, Kamera, Zuhause                      |
| **Die Sirene ertönt**             | eine Innensirene zu ertönen beginnt                | Sirene, Zuhause                              |

Optionale Filter: die **Kamera** (oder Sirene) — leer = jede — und die
**Person**: Gib den Namen **genau wie in der Netatmo-App** ein (der
Szenen-Editor kann die Netatmo-Personen nicht auflisten; ein leeres Feld = jede
bekannte Person). Ein unbekanntes Gesicht löst „Eine bekannte Person kommt an“
nie aus — die Funktion **Person erkannt** der Kamera deckt alle Personen ab.

### Aktionen

| Aktion                              | Was sie tut                                                                                                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Heizmodus ändern**                | Zeitplan, Abwesend oder Frostschutz für das ganze Zuhause; optionale Dauer in Minuten (Abwesend und Frostschutz: danach zurück zum Zeitplan)                                                                     |
| **Person als abwesend markieren**   | eine bekannte Person oder — Person leer gelassen — das ganze Zuhause leer (aktiviert die anwesenheitsabhängige Kameraüberwachung wieder)                                                                         |
| **Person als anwesend markieren**   | eine bekannte Person oder — Person leer gelassen — alle bekannten Personen                                                                                                                                       |
| **Sollwert eines Raums einstellen** | manueller Sollwert (7 bis 30 °C) des Raums des gewählten Thermostats oder Ventils; optionale Dauer in Minuten, danach zurück zum Zeitplan (leer: die Standarddauer eines manuellen Sollwerts in der Netatmo-App) |
| **Raum boosten**                    | heizt den Raum des gewählten Thermostats oder Ventils mit voller Leistung (Boost); optionale Dauer in Minuten (leer: die Standarddauer des Boosts in der Netatmo-App)                                            |
| **Zurück zum Zeitplan**             | beendet den manuellen Sollwert oder den Boost des Raums: Er folgt wieder dem Zeitplan                                                                                                                            |
| **Heizzeitplan auswählen**          | aktiviert einen der Heizzeitpläne des Zuhauses                                                                                                                                                                   |

Das **Zuhause** ist das des Geräts, das du in der Aktion wählst (ein Thermostat
oder Ventil für die Heizung, eine Kamera für die Personen). Lass es leer, wenn
dein Konto nur ein Zuhause hat. Das Personenfeld akzeptiert eine
Szenen-Variable: „Eine bekannte Person kommt an → Person als anwesend
markieren“ mit der Information **Person**. Jede Aktion gibt den Namen des
**Zuhauses** an die folgenden Schritte weiter.

Die drei **Raum**-Aktionen gelten für den Raum des gewählten Thermostats oder
Ventils (Pflichtfeld) und geben auch den Namen des **Raums** weiter.
**Heizzeitplan auswählen** erwartet den **Namen des Zeitplans genau wie in der
Netatmo-App** (Groß-/Kleinschreibung egal): Der Szenen-Editor kann die
Netatmo-Zeitpläne nicht auflisten. Ein unbekannter Name lässt die Aktion
fehlschlagen, und die Szenen-Logs nennen die Zeitpläne des Zuhauses. Sie gibt
auch den Namen des **Zeitplans** weiter.

---

## Dashboard-Widgets

Drei Widgets erscheinen in der Widget-Auswahl des Dashboards (Gladys **5.1**
oder neuer): **Dashboard bearbeiten**, ein Widget hinzufügen und nach „Netatmo“
suchen.

| Widget              | Zeigt                                                                                                                                                                                                                                                                                                                                 | Einstellungen                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Netatmo-Wetter**  | Live-Kacheln der Station (Temperaturen, Feuchte, CO2, Lärm, Luftdruck, Regen, Wind) und eine Statuszeile pro Modul mit schwachem Akku oder ohne Verbindung                                                                                                                                                                            | die Station (leer: die erste) und die angezeigten Messwerte: Übersicht, Innen, oder Außen, Regen und Wind |
| **Netatmo-Heizung** | den Heizmodus und den aktiven Zeitplan des Zuhauses, eine Zeile pro Raum (gemessene Temperatur → Sollwert, mit Manuell oder Boost markiert, wenn der Sollwert nicht vom Zeitplan kommt), die Schaltflächen Zeitplan / Frostschutz / Abwesend und, bei mehreren Zeitplänen, eine Schaltfläche **Zeitplan wechseln**, die sie auflistet | ein Thermostat oder Ventil des Zuhauses (leer: dein einziges Zuhause)                                     |
| **Netatmo-Kameras** | das letzte Bild jeder Kamera, ihre Überwachung und Schaltflächen zum Ein- / Ausschalten                                                                                                                                                                                                                                               | eine groß angezeigte Kamera (leer: alle Kameras als Liste)                                                |

Die Kacheln folgen den Werten live; der Rest wird mit der Integration
aktualisiert (2 Minuten, oder sobald sich der Heizmodus, die Überwachung oder
ein Bild ändert). Die Kamerabilder liefert die Integration selbst — das
Dashboard lädt nie ein Bild von den Netatmo-Servern. Ein Widget zeigt nur die in
Gladys angelegten Geräte.

---

## Sicherheitszubehör (über die Kamera angebunden)

Wenn die Familie Sicherheit aktiviert ist, wird auch das mit deinen Kameras
verknüpfte Zubehör erkannt:

- **Tür-/Fenstersensor** (`NACamDoorTag`) — ein Öffnungssensor
  (offen/geschlossen), dazu Batterie und Funksignal (RF).
- **Innensirene** (`NIS`) — ein schreibgeschützter Sirenen-Sensor, dazu
  Batterie und RF.
- **Rauchmelder** (`NSD`) — erkannt mit Batterie und Signal, dazu die
  Erkennung **Rauch** (siehe _Erkennungen_ oben): in Echtzeit mit den
  Webhooks, ohne sie innerhalb von etwa 2 Minuten.
- **Kohlenmonoxidmelder** (`NCO`) — wie der Rauchmelder: Batterie und Signal
  (sofern Netatmo sie meldet), dazu die Erkennung **Kohlenmonoxid**, wie beim
  Rauch.

---

## Bekannte Personen

Wenn die Familie Sicherheit aktiviert ist, erhält jedes Zuhause, dessen Kameras
Gesichter erkennen, ein Gerät **„<Zuhause> - Known persons“** mit einer Funktion
**Presence** pro Person, die in der Netatmo-App einen Namen hat: **Anwesenheit
erkannt**, wenn Netatmo die Person zu Hause sieht, **Keine Anwesenheit**, wenn
sie abwesend ist — der Zustand, den die Netatmo-App anzeigt. Nutze sie in deinen
Szenen wie jeden Anwesenheitssensor.

- Nur Personen **mit Namen** erhalten eine Funktion: Ein unbekanntes Gesicht
  (ohne Namen in der Netatmo-App) wird ignoriert.
- Die Anwesenheit wird alle 2 Minuten aktualisiert, und **sofort** mit den
  Gladys-Plus-Webhooks (eine bekannte Person kommt / geht) oder nach den
  Szenenaktionen **Person als abwesend / anwesend markieren**.
- Meldet Netatmo die Anwesenheit einer Person nicht, wird nichts
  veröffentlicht: Der letzte bekannte Wert bleibt.
- Eine Person wurde in der Netatmo-App hinzugefügt, umbenannt oder gelöscht:
  Klicke im Tab **Entdecken** beim Gerät auf **Aktualisieren**, um die Funktion
  hinzuzufügen, umzubenennen oder zu entfernen. Die Funktion folgt der
  Netatmo-ID der Person: Eine Umbenennung behält ihren Verlauf.

---

## Rollläden (Bubendorff / iDiamant)

Aktiviere **Rollläden (Bubendorff / iDiamant)** unter **Zu erkennende Geräte**
(standardmäßig aus), um die Bubendorff-Rollläden zu erkennen, die mit deinem
iDiamant-Gateway verbunden sind: Funk- (`NBR`), kabelgebundene (`NBO`) und
Solarmodelle (`NBS`). Jeder Rollladen wird erstellt mit:

- einer Steuerung **öffnen / schließen / stoppen**;
- einer **Position** (0 % = geschlossen, 100 % = offen), die du auch einstellen
  kannst;
- der Qualität seines **Funksignals (RF)**.

Das iDiamant-Gateway selbst wird nicht als Gerät erstellt: Seine ID wird im
Parameter `plug_id` des Rollladens gespeichert, jeder Befehl läuft darüber.
Nach einem Befehl aktualisiert Gladys die Werte etwa 30 Sekunden später, damit
die neue Position erscheint, ohne auf den nächsten 2-Minuten-Zyklus zu warten.

> ⚠️ **Schon vor der Rollladen-Unterstützung verbunden?** Die Rollläden
> benötigen zwei neue Netatmo-Berechtigungen. Klicke im Konfigurationsbildschirm
> erneut auf **Verbinden** und autorisiere Gladys — deine Geräte und
> Einstellungen bleiben erhalten. Bis dahin schlägt ein Rollladenbefehl fehl,
> und der Konfigurationsbildschirm fordert dich auf, dich erneut zu verbinden.

**Zwischenpositionen:** Je nach Modell und Motor können manche
Bubendorff-Rollläden nur ganz öffnen oder ganz schließen. Eine Zwischenposition
kann dann vom Rollladen ignoriert oder gerundet werden, und die gemeldete
Position spiegelt eventuell nur den letzten Befehl wider — nutze bei diesen
Modellen öffnen / schließen / stoppen.

---

## Raumluftsensor (Home Coach)

Wenn die Familie **Luftqualitäts-Geräte (Home Coach)** aktiviert ist, wird jeder
Netatmo-Raumluftsensor (Home Coach, `NHC`) mit seiner Temperatur (dazu Minimum
und Maximum des Tages), Luftfeuchtigkeit, CO2, Lärm, Luftdruck und absolutem
Luftdruck, seiner WLAN-Qualität und einer Funktion **Luftqualität** erkannt. Er
trägt den Namen, den du ihm in der Netatmo-App gegeben hast.

Der Home Coach misst keinen Luftqualitätsindex: Er bewertet den Raum in fünf
Stufen, anhand von CO2, Luftfeuchtigkeit, Lärm und Temperatur. Gladys liest eine
Luftqualitäts-Funktion als AQI (0 bis 500), um sie im Dashboard einzufärben und
an HomeKit weiterzugeben. Jede Stufe wird daher als Mitte des passenden
AQI-Bereichs veröffentlicht:

| Home-Coach-Stufe | Wert in Gladys | Farbe im Dashboard | HomeKit       |
| ---------------- | -------------- | ------------------ | ------------- |
| Gesund           | 25             | grün               | Ausgezeichnet |
| Gut              | 75             | gelb               | Gut           |
| Mittel           | 125            | orange             | Mittel        |
| Schlecht         | 175            | rosa               | Minderwertig  |
| Ungesund         | 250            | lila               | Schlecht      |

Vergleiche in einer Szene mit diesen Werten: „Luftqualität über 150“ bedeutet
zum Beispiel schlecht oder ungesund.

Eine Funktion **Air quality level** zeigt dieselbe Stufe im Dashboard in Worten.
Gladys übersetzt Optionsbezeichnungen noch nicht: Sie sind französisch (Sain,
Correct, Moyen, Mauvais, Malsain — gesund, gut, mittel, schlecht, ungesund).
Sie speichert keinen Verlauf: Die numerische Funktion **Luftqualität** behält den
Verlauf, die Farben und HomeKit.

Ein Home Coach, der offline ist, erhält das Badge **nicht erreichbar**, und
seine zuletzt bekannten Werte werden nicht veröffentlicht. Eine erneute
Verbindung ist nicht nötig: Die Home-Coach-Berechtigung (`read_homecoach`) ist
seit der ersten Version Teil der Verbindung.

---

## BTicino-Türsprechanlage (Classe 300X / Classe 300 EOS) — Vorschau

Die Video-Türsprechanlagen **BTicino Classe 300X** und **Classe 300 EOS with
Netatmo** laufen über die Netatmo-API, die viel weniger bereitstellt als die
Netatmo-App ([Issue #59](https://github.com/Terdious/gladys-netatmo/issues/59)). Aktiviere **BTicino-Türsprechanlage (Classe 300) —
Vorschau** unter **Zu erkennende Geräte** (standardmäßig deaktiviert) und
speichere.

Die Türsprechanlage wird als **ein Gerät** erkannt, benannt nach ihrer
Innenstation (dem Gateway `BNCX`, z. B. „Classe 300EOS with Netatmo“). Die
Module, die sie anbindet, fügen ihm ihre Funktionen hinzu, unter ihrem Namen:

| Modul                           | Netatmo-Typ | Am Gerät der Türsprechanlage                                           |
| ------------------------------- | ----------- | ---------------------------------------------------------------------- |
| Innenstation (Gateway)          | `BNCX`      | WLAN-Qualität, **Klingeln** (in Echtzeit mit den Gladys-Plus-Webhooks) |
| Treppenhaus- / Außenbeleuchtung | `BNSL`      | **Licht an / aus** (z. B. „Außenbeleuchtung“)                          |
| Geschaltete Steckdose           | `BNCS`      | Zustand an / aus (nur lesend), wenn Netatmo ihn meldet                 |
| Außenstation                    | `BNEU`      | nichts (Netatmo meldet keinen Wert dafür)                              |
| Türschloss                      | `BNDL`      | nichts — siehe unten                                                   |
| X-Modul                         | `BNXM`      | seine Signalqualität, wenn Netatmo eine meldet                         |

- **Licht:** wird über Netatmo geschaltet wie in der App. Netatmo meldet nie,
  ob es an ist: Gladys zeigt den zuletzt gesendeten Befehl (das
  Treppenhauslicht schaltet sich meist nach einer Weile selbst aus, Gladys
  kann nicht wissen, wann).
- **Klingeln:** wird wie das Klingeln der [Video-Türklingel](#video-türklingel) veröffentlicht
  („Klingelt“, dann die Uhrzeit des letzten Klingelns), nutzbar als
  Szenen-Auslöser — in Echtzeit mit den [Gladys-Plus-Webhooks](#gladys-plus-webhooks-echtzeit--optional), ohne sie innerhalb von etwa 2 Minuten. Netatmo dokumentiert
  dieses Ereignis für die Classe 300 EOS; auf einer echten Installation wurde
  es noch nicht beobachtet: Wenn dein Klingeln nicht erscheint, sende eine
  Diagnose (siehe unten).
- **Das Öffnen der Tür ist nicht verfügbar.** Die Netatmo-API für
  Drittanwendungen erlaubt ihnen nicht, ein BTicino-Türschloss zu öffnen
  (Netatmo sperrt es aus Sicherheitsgründen); das kann nur die Netatmo- /
  BTicino-App.
- Das Abzeichen **nicht erreichbar** folgt der Innenstation. Ein angebundenes
  Modul, das Netatmo als offline meldet, veröffentlicht keinen Wert.
- Wenn du mit der Vorschau 2.2.0 Geräte angelegt hast (eines pro Modul),
  lösche sie und lege das Gerät der Türsprechanlage neu an.

> ⚠️ **Neue Netatmo-Berechtigungen — klicke erneut auf Verbinden.** Das
> Einschalten fordert vier zusätzliche Berechtigungen an, nur solange die
> Option aktiv ist: `read_bfi` / `write_bfi` (BTicino IP, Classe 300X) und
> `read_mx` / `write_mx` (Classe 300 EOS). Klicke auf dem
> Konfigurationsbildschirm erneut auf **Verbinden** und akzeptiere sie — deine
> Geräte und Einstellungen bleiben erhalten. Bis dahin zeigt der
> Verbindungsstatus einen Hinweis zum erneuten Verbinden, und Netatmo kann die
> BTicino-Module auslassen (ein Lichtbefehl schlägt dann mit einer Meldung
> „erneut verbinden“ fehl).

### Eine Diagnose an den Maintainer senden

Nutze die Aktion **Gerätediagnose** auf dem Konfigurationsbildschirm (siehe
[Fehlerbehebung](#fehlerbehebung)): Wähle das Gerät der Türsprechanlage, oder lass
beide Felder leer für das ganze Konto, und füge das Ergebnis in
[Issue #59](https://github.com/Terdious/gladys-netatmo/issues/59) ein. Klingle einmal, bevor du sie startest (und warte 2 Minuten): Der Bericht listet
die letzten Webhook-Ereignisse jedes Moduls und die letzten Ereignisse, die Netatmo dafür liefert (`getevents`).

Solange die Option aktiv ist, schreibt die Integration außerdem in ihre
Protokolle, bei der ersten Aktualisierung nach einem Start und danach **nur
bei Änderungen**, die Rohdaten, die Netatmo für jedes BTicino-Modul liefert,
und jedes Gladys-Plus-Webhook-Ereignis dazu. Jede Zeile beginnt mit
`[bticino-diagnostic]`; es gilt dieselbe Schwärzung (Tokens, Schlüssel,
E-Mail-Adressen und URLs werden durch `<redacted>` ersetzt, Modul-, Gateway-
und Haus-IDs bleiben erhalten), und eine Zeile über 8 KB wird mit der Markierung
`[truncated]` gekürzt.

---

## Die Integration aktualisieren

**Aus dem Katalog installiert** (der übliche Fall): Gladys prüft den Store
regelmäßig. Erscheint eine neue Version, zeigt die Integration das Abzeichen
**„Update verfügbar“** (auch neben **Integrationen** im Menü gezählt), und ihr
Tab **Überwachung** nennt die angebotene Version mit einem Link zu ihren
Versionshinweisen. Klicke auf **Aktualisieren**: Gladys lädt das neue Image
**und** übernimmt das neue Manifest — neue Konfigurationsfelder erscheinen von
selbst, es muss nichts erneut eingefügt werden. Deine Konfiguration und deine
Geräte bleiben erhalten.

Gladys kann bis zu etwa anderthalb Stunden brauchen, um eine neue Version zu
bemerken (Aktualisierung des Store-Index). **„Update erzwingen“** prüft sofort:
Es liest die zuletzt veröffentlichte Version und lädt ihr Image.

**Im Entwicklermodus installiert** (Manifest von Hand eingefügt): **„Update
erzwingen“** lädt nur das Image des installierten Tags erneut, und die
angezeigte Version sowie die Konfigurationsfelder stammen aus dem eingefügten
Manifest — füge das aktualisierte Manifest erneut ein, um neue Felder zu
übernehmen.

---

## Migration vom integrierten Netatmo-Dienst

Diese externe Integration ersetzt den in Gladys integrierten Netatmo-Dienst.
Ihre Geräte erhalten neue Kennungen (`netatmo:*` → `ext:netatmo:*`) und werden
daher als neue Geräte angelegt — seit **Gladys 4.84.1** kannst du aber jedes
alte Gerät auf sein neues Gegenstück **migrieren** und dabei seinen
**Zustandsverlauf**, seine **Szenen** und seine **Dashboards** behalten.

### Bevor du beginnst

- **Lösche deine alten Netatmo-Geräte nicht**: Die Migration geht von ihnen aus.
- **Migriere bald nach dem Anlegen der neuen Geräte.** Haben beide Geräte Werte
  über denselben Zeitraum aufgezeichnet, wird nur der alte Verlauf _vor dem
  ersten Wert des neuen Geräts_ verschoben, damit nichts doppelt gezählt wird:
  Die Werte des alten Geräts aus dem gemeinsamen Zeitraum entfallen.

### Schritte

1. Installiere und verbinde diese Integration und lege dann deine Geräte im Tab
   **Entdecken** an: Das Ziel muss vor der Migration existieren.
2. Öffne **Integrationen → Netatmo** — die integrierte, als veraltet
   gekennzeichnete Integration — und dann ihren Tab **Geräte**.
3. Klicke bei einem alten Gerät auf **Migrieren**.
4. Wähle das **Zielgerät**: das neue Gerät, aufgeführt unter der externen
   Netatmo-Integration (die Liste lässt sich nach Integration, Raum und Name
   filtern).
5. Prüfe die Tabelle **Zuordnung der Funktionen**. Gladys füllt sie vor (gleiche
   Kategorie, gleicher Typ und gleiche Einheit, dann gleicher Name, um
   Zwillinge zu unterscheiden); jede alte Funktion kann von Hand zugeordnet oder
   auf **Nicht migrieren** gesetzt werden — ihr Verlauf wird dann gelöscht.
   Achte besonders auf die Temperaturzeilen von Thermostaten und Stationen, die
   mehrere Temperaturfunktionen haben.
6. Klicke auf **Migrieren und altes Gerät löschen**.

Gladys verschiebt den Verlauf, schreibt die Szenen und Dashboards um, die das
alte Gerät verwendet haben, verschiebt das neue Gerät in den Raum des alten,
falls es keinen hat, verknüpft die Energie-Verbindungen neu und löscht dann das
alte Gerät. Das Ergebnis zeigt die Anzahl der verschobenen Zustände und der
aktualisierten Szenen / Dashboards. Wiederhole das für jedes Gerät.

Ein langer Verlauf kann mehrere Minuten dauern: Verfolge ihn unter
**Einstellungen → Aufgaben**. Verliert die Seite die Verbindung, läuft die
Migration im Hintergrund weiter — prüfe diese Seite, bevor du es erneut
versuchst. Eine fehlgeschlagene Migration kann erneut gestartet werden: Sie
verschiebt nur, was noch übrig ist.

---

## Fehlerbehebung

- **„Zuerst speichern“ beim Verbinden:** Speichere Client-ID / Client-Secret und
  klicke dann erneut auf Verbinden.
- **Sitzung abgelaufen:** Klicke erneut auf Verbinden, um dein Netatmo-Konto neu
  zu autorisieren.
- **Ein Gerät zeigt ein Badge „nicht erreichbar“:** Netatmo meldet es als
  offline (leere Batterie, ausgeschaltet, außer Reichweite). Gladys
  veröffentlicht seine zuletzt bekannten Werte nicht mehr, damit du nicht durch
  veraltete Daten getäuscht wirst; das Badge verschwindet, sobald das Gerät
  wieder erreichbar ist.
- **Ein Gerät zeigt ein Badge „Beeinträchtigt“, oder der Status zeigt trotz
  Verbunden eine Meldung:** Ein Teil der Netatmo-Cloud fällt seit einigen
  Minuten aus (zum Beispiel der Wetterdienst). Gladys veröffentlicht weiter,
  was der Rest der Cloud liefert — die Messwerte der Station und ihrer Module
  kommen auch aus dem Hausstatus — und markiert die Geräte, die keine frischen
  Werte mehr erhalten. Nichts zu tun: Beides verschwindet von selbst bei der
  ersten vollständigen Aktualisierung. Hält es an, nennen die **Logs** der
  Integration die ausfallende API.
- **Ein Kamerawert oder ein Überwachungsbefehl schlägt einmal mit einer Meldung
  „erneut verbinden“ fehl:** Deiner Netatmo-Autorisierung fehlt die
  Kamera-Berechtigung — verbinde dein Konto erneut.
- **Ein Rollladenbefehl schlägt mit einer Meldung „erneut verbinden“ fehl:**
  Deine Netatmo-Autorisierung stammt aus der Zeit vor der
  Rollladen-Unterstützung — klicke erneut auf Verbinden.
- **Bewegungs- / Personenerkennungen (oder das Klingeln) kommen etwa 2
  Minuten zu spät an, während die Netatmo-App sofort alarmiert:** Die
  Gladys-Plus-Webhooks erreichen die Integration nicht, die Erkennungen kommen
  aus dem Lesen von `getevents` alle 2 Minuten. Starte die Aktion
  **Gerätediagnose** (beide Felder leer) und vergleiche **Last events seen by
  getevents** mit **Last webhook events**: Ereignisse im ersten und keine im
  zweiten bedeutet, dass Netatmo die Webhooks nicht zustellt — siehe
  _Registriert, aber es kommt nichts an?_ im Abschnitt Webhooks. In beiden
  nichts: Prüfe, ob die Überwachung der Kamera aktiv ist. Die Zeile **Events
  poll (getevents)** zeigt ihren letzten Fehler (zum Beispiel eine fehlende
  Berechtigung: Klicke erneut auf Verbinden).
- **Kein Kameraton:** Siehe den Mikrofon-Tipp im Abschnitt Kameras oben.
- **Türklingel oder Innenkamera Advance ohne Live-Video:** Siehe
  _WebRTC-Live-Video_ im Abschnitt Video-Türklingel (Gladys-Version, Browser,
  Firewall).
- **Status „einige Netatmo-Berechtigungen fehlen“:** Eine neuere Version hat
  Berechtigungen hinzugefügt (Video-Türklingel, Innenkamera Advance, BTicino-Türsprechanlage) — klicke erneut auf Verbinden
  und akzeptiere sie. Die **Logs** der Integration nennen die fehlenden.
- **Gerätediagnose (ein Problem oder ein nicht unterstütztes Gerät melden):**
  Starte auf dem Konfigurationsbildschirm die Aktion **Gerätediagnose**. Wähle
  ein in Gladys angelegtes Gerät, oder gib den Namen oder die Netatmo-ID eines
  Moduls ein, das du nicht angelegt hast (zum Beispiel ein noch nicht
  unterstütztes); lass beide Felder leer für eine Übersicht des ganzen Kontos.
  Der Bericht zeigt, was Netatmo für das Modul sendet, was die Integration
  dafür veröffentlicht, die Netatmo-Felder, die sie noch nicht nutzt, die
  letzten Webhook-Ereignisse und die letzten mit `getevents` gelesenen
  Ereignisse, die Berechtigungen und den Zustand jeder
  Netatmo-API. Er wird auch in die **Protokolle** der Integration geschrieben
  (Zeilen nach `[netatmo-diagnostic]`), falls du ihn nicht vom Bildschirm
  kopieren kannst. **Lies ihn, bevor du ihn öffentlich postest:** Tokens, URLs
  und E-Mail-Adressen werden entfernt, aber Modul- und Haus-IDs und die Namen
  deiner Module bleiben erhalten.
- **Immer noch nicht gelöst oder fehlt ein Gerät?** Frag im Forumsthema
  [Intégration externe - Netatmo](https://community.gladysassistant.com/t/integration-externe-netatmo/11308)
  nach oder eröffne ein Issue auf [GitHub](https://github.com/Terdious/gladys-netatmo/issues) mit den Protokollen der
  Integration (Tab **Protokolle**).
