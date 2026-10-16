# Netatmo-Integration für Gladys Assistant

Verbinde deine **Netatmo**-Geräte — Wetterstation, Thermostate und
Heizkörperventile, Innen- und Außenkameras samt Zubehör, Bubendorff-Rollläden —
mit Gladys Assistant.

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

| Schalter       | Erkennt                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| **Energie**    | Thermostat (`NATherm1`), Relais (`NAPlug`), Heizkörperventile (`NRV`)                      |
| **Wetter**     | Station (`NAMain`) + Außen-, Wind-, Regen- und zusätzliche Innenmodule                     |
| **Sicherheit** | Innen- (`NACamera`) und Außenkameras (`NOC`), Video-Türklingel (`NDB`) sowie deren Zubehör |
| **Rollläden**  | Bubendorff-Rollläden eines iDiamant-Gateways (`NBR`, `NBO`, `NBS`)                         |

Wenn du eine Familie aktivierst und **speicherst**, wird die Erkennung
automatisch neu gestartet — kein manueller Scan nötig. Neu gefundene Geräte
erscheinen im Tab **Entdecken**, wo du diejenigen erstellst, die du möchtest.

**Qualität des Kamera-Livestreams** (`poor` / `low` / `medium` / `high`,
Standard `high`) legt die Qualität des Kamera-Livestreams fest.

Die Werte werden alle **2 Minuten** aktualisiert (Ratenbegrenzung von Netatmo).

---

## Heizmodus (Zeitplan / abwesend / Frostschutz)

Jedes Thermostat (`NATherm1`) und jedes Heizkörperventil (`NRV`) hat eine
Funktion **Heizmodus** (ein Thermostat-_Preset_ in Gladys) mit drei
Möglichkeiten:

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

---

## Video-Türklingel

Wenn die Familie Sicherheit aktiviert ist, wird die Netatmo-Video-Türklingel
(`NDB`) erstellt mit:

- einem **Dashboard-Bild** (ein Schnappschuss, automatisch aktualisiert) —
  abgerufen über die Netatmo-VPN-URL: Die Türklingel stellt es nicht im lokalen
  Netzwerk bereit;
- einer Funktion **Türklingel**, die **Klingelt** anzeigt, wenn jemand den
  Knopf drückt, nutzbar als Szenen-Auslöser (**Wenn die Türklingel klingelt**)
  — sie benötigt die Gladys-Plus-Webhooks (siehe unten): Die Abfrage allein kann
  kein Klingeln melden;
- der Qualität ihrer **WLAN**-Verbindung.

Es gibt keinen Überwachungsschalter (Netatmo bietet keinen für die Türklingel)
und keine Livestream-Schaltfläche: Die Türklingel streamt nur über WebRTC, das
die Kamera-Liveansicht von Gladys nicht abspielen kann.

> ⚠️ **Netatmo-Konto vor dieser Version verbunden?** Die Türklingel benötigt
> zwei neue Netatmo-Berechtigungen (`read_doorbell`, `access_doorbell`): Klicke
> auf dem Konfigurationsbildschirm erneut auf **Verbinden** und akzeptiere sie.
> Bis dahin zeigt der Verbindungsstatus einen Hinweis, erneut auf Verbinden zu
> klicken.

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

Ohne Schlüssel (oder ohne Gladys Plus) verhält sich die Integration genau wie
zuvor und fragt alle 2 Minuten ab.

### Was es bringt

- **Die Werte kommen fast sofort an** — zum Beispiel ein in der Netatmo-App
  geänderter Thermostat-Sollwert oder der Überwachungsstatus einer Kamera.
- **Erkennungen, die du in deinen Szenen nutzen kannst** (siehe unten).

### Echtzeit-Erkennungen (Szenen-Auslöser)

Manche Ereignisse sind **momentan**: Sie existieren nur im Ereignisstrom, keine
API-Abfrage kann sie melden. Sie werden als eigene Funktionen veröffentlicht,
die als **Szenen-Auslöser** nutzbar sind:

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

> ⚠️ **Wenn deine Kameras bereits in Gladys existierten**, erscheinen diese
> neuen Funktionen nicht von selbst: Gehe in den Tab **Entdecken** und klicke
> bei jeder Kamera (oder jedem Rauchmelder) auf **Aktualisieren**, um sie
> hinzuzufügen. Ohne konfigurierte Webhooks bleiben diese Funktionen einfach
> auf „Nein“.

---

## Szenen: Netatmo-Auslöser und -Aktionen

Die Integration fügt dem Szenen-Editor eigene Karten hinzu (Gladys **5.1** oder
neuer): Wähle **Integrations-Auslöser** oder **Integrations-Aktion** und dann
den Netatmo-Eintrag.

### Auslöser (erfordern die Gladys-Plus-Webhooks)

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

| Aktion                            | Was sie tut                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Heizmodus ändern**              | Zeitplan, Abwesend oder Frostschutz für das ganze Zuhause; optionale Dauer in Minuten (Abwesend und Frostschutz: danach zurück zum Zeitplan) |
| **Person als abwesend markieren** | eine bekannte Person oder — Person leer gelassen — das ganze Zuhause leer (aktiviert die anwesenheitsabhängige Kameraüberwachung wieder)     |
| **Person als anwesend markieren** | eine bekannte Person oder — Person leer gelassen — alle bekannten Personen                                                                   |

Das **Zuhause** ist das des Geräts, das du in der Aktion wählst (ein Thermostat
oder Ventil für die Heizung, eine Kamera für die Personen). Lass es leer, wenn
dein Konto nur ein Zuhause hat. Das Personenfeld akzeptiert eine
Szenen-Variable: „Eine bekannte Person kommt an → Person als anwesend
markieren“ mit der Information **Person**. Jede Aktion gibt den Namen des
**Zuhauses** an die folgenden Schritte weiter.

---

## Dashboard-Widgets

Drei Widgets erscheinen in der Widget-Auswahl des Dashboards (Gladys **5.1**
oder neuer): **Dashboard bearbeiten**, ein Widget hinzufügen und nach „Netatmo“
suchen.

| Widget              | Zeigt                                                                                                                                                      | Einstellungen                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Netatmo-Wetter**  | Live-Kacheln der Station (Temperaturen, Feuchte, CO2, Lärm, Luftdruck, Regen, Wind) und eine Statuszeile pro Modul mit schwachem Akku oder ohne Verbindung | die Station (leer: die erste) und die angezeigten Messwerte: Übersicht, Innen, oder Außen, Regen und Wind |
| **Netatmo-Heizung** | den Heizmodus des Zuhauses, eine Zeile pro Raum (gemessene Temperatur → Sollwert) und die Schaltflächen Zeitplan / Frostschutz / Abwesend                  | ein Thermostat oder Ventil des Zuhauses (leer: dein einziges Zuhause)                                     |
| **Netatmo-Kameras** | das letzte Bild jeder Kamera, ihre Überwachung und Schaltflächen zum Ein- / Ausschalten                                                                    | eine groß angezeigte Kamera (leer: alle Kameras als Liste)                                                |

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
- **Rauchmelder** (`NSD`) — erkannt mit Batterie und Signal, dazu eine Funktion
  **Rauch**, die von den Webhooks gespeist wird (siehe Abschnitt oben): Die
  Abfrage allein kann diesen Zustand nicht melden.
- **Kohlenmonoxidmelder** (`NCO`) — wie der Rauchmelder: Batterie und Signal
  (sofern Netatmo sie meldet), dazu eine Funktion **Kohlenmonoxid**, die von
  den Webhooks gespeist wird.

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
- **Kein Kameraton:** Siehe den Mikrofon-Tipp im Abschnitt Kameras oben.
- **Status „einige Netatmo-Berechtigungen fehlen“:** Eine neuere Version hat
  Berechtigungen hinzugefügt (Video-Türklingel) — klicke erneut auf Verbinden
  und akzeptiere sie. Die **Logs** der Integration nennen die fehlenden.
