# Intégration Netatmo pour Gladys Assistant

Connectez vos appareils **Netatmo** — station météo, thermostats et vannes de
radiateur, caméras intérieure/extérieure et leurs accessoires, volets roulants
Bubendorff, capteurs de qualité de l'air — à Gladys Assistant.

Cette intégration communique avec le cloud Netatmo pour vous : vous créez une
fois votre propre application Netatmo Connect, connectez votre compte, et Gladys
découvre vos appareils puis maintient leurs valeurs à jour.

---

## Prérequis

- Un **compte Netatmo**, avec vos appareils déjà installés et fonctionnels dans
  l'application Netatmo (Gladys lit ce que Netatmo expose — un appareil doit
  d'abord être en ligne dans Netatmo).
- Gladys Assistant **5.2 ou plus récent**.

---

## Étape 1 — Créez votre application Netatmo Connect

Gladys n'embarque aucune clé Netatmo partagée : vous utilisez **votre propre**
application Netatmo Connect, pour que vos données restent entre votre Gladys et
votre compte Netatmo.

1. Rendez-vous sur **[Netatmo Connect](https://dev.netatmo.com/)** et
   connectez-vous avec votre compte Netatmo.
2. Ouvrez **[My Apps → Créer](https://dev.netatmo.com/apps/)** et créez une
   nouvelle application (nom et description libres — par ex. « Gladys »).
3. Une fois créée, la page de l'application affiche deux valeurs à copier dans
   Gladys :
   - le **client id** (identifiant client)
   - le **client secret** (secret client)

Vous n'avez **pas** besoin de configurer de scopes ni d'URL de redirection sur
le portail : Gladys demande automatiquement les scopes requis (lecture +
écriture, couvrant l'Énergie, la Météo, la Sécurité y compris les caméras et la
sonnette vidéo, et les volets roulants) au moment de la connexion, et gère
lui-même la redirection OAuth2.

---

## Étape 2 — Configurez et connectez dans Gladys

Sur l'écran **Configuration** de l'intégration :

1. Collez votre **client id** et votre **client secret**.
2. Cliquez sur **Enregistrer**.
3. Cliquez sur **Connecter** : une fenêtre Netatmo s'ouvre, connectez-vous et
   autorisez Gladys. Vous êtes redirigé et le statut passe à **Connecté**.

> **Astuce :** **Enregistrez** toujours le client id / secret _avant_ de cliquer
> sur Connecter. Si la connexion indique qu'il faut d'abord sauvegarder les
> identifiants, enregistrez le formulaire et recliquez sur Connecter.

Les jetons d'accès et de rafraîchissement sont stockés par l'intégration
elle-même et n'apparaissent jamais dans le formulaire. Gladys les rafraîchit
automatiquement ; si la session expire définitivement, l'écran Configuration
vous invite à vous reconnecter.

---

## Étape 3 — Choisissez les familles d'appareils

Sous **Appareils à découvrir**, activez les familles que vous possédez :

| Interrupteur           | Découvre                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Énergie**            | Thermostat (`NATherm1`), relais (`NAPlug`), vannes de radiateur (`NRV`), thermostat modulant (`OTM` + `OTH`), BTicino Smarther (`BNS`)                     |
| **Météo**              | Station (`NAMain`) + modules extérieur, vent, pluie et intérieurs                                                                                          |
| **Sécurité**           | Caméras intérieure (`NACamera`), intérieure Advance (`NPC`) et extérieure (`NOC`), sonnette vidéo (`NDB`), plus leurs accessoires et les personnes connues |
| **Volets roulants**    | Volets Bubendorff d'une passerelle iDiamant (`NBR`, `NBO`, `NBS`)                                                                                          |
| **Qualité de l'air**   | Capteur de qualité de l'air intérieur — Home Coach (`NHC`), désactivé par défaut                                                                           |
| **Interphone BTicino** | Interphone BTicino Classe 300X / Classe 300 EOS, un seul appareil (`BNCX` + ses `BNEU`, `BNDL`, `BNSL`, `BNCS`, `BNXM`) — aperçu, désactivé par défaut     |

Activer une famille et **enregistrer** relance la découverte automatiquement —
pas besoin de re-scanner. Les nouveaux appareils apparaissent sur l'écran
**Découverte**, où vous créez ceux que vous voulez.

**Qualité du flux vidéo des caméras** (`poor` / `low` / `medium` / `high`, par
défaut `high`) règle la qualité du flux vidéo en direct.

Les valeurs sont rafraîchies toutes les **2 minutes** (limites d'API Netatmo).

---

## Mode du chauffage (planning / absence / hors-gel)

Chaque thermostat (`NATherm1`, modulant `OTM`, BTicino Smarther `BNS`) et vanne
de radiateur (`NRV`) porte une fonctionnalité **Mode du chauffage** (un
_préréglage_ de thermostat dans Gladys), avec trois choix :

| Dans Gladys  | Dans l'application Netatmo      |
| ------------ | ------------------------------- |
| **Planning** | suivre le planning hebdomadaire |
| **Absence**  | mode absent                     |
| **Hors-gel** | hors-gel (`hg`)                 |

Chez Netatmo, le mode est celui de **toute la maison** : le changer sur un
appareil bascule tout le logement, et chaque thermostat et vanne de la maison
affiche le nouveau mode juste après (l'intégration rafraîchit immédiatement).
Un mode changé depuis l'application Netatmo apparaît au rafraîchissement
suivant (2 minutes, ou 2-3 secondes avec les webhooks Gladys Plus).

Utilisez-le dans une scène (« tout le monde est parti → chauffage en Absence »)
avec l'action standard « Contrôler un appareil ».

> ⚠️ **Si vos thermostats existaient déjà dans Gladys**, la fonctionnalité
> n'apparaît pas toute seule : allez sur l'écran **Découverte** et cliquez sur
> **Mettre à jour** sur chaque thermostat et vanne. Gladys **5.2** ou plus
> récent est requis (le préréglage de thermostat n'existe pas avant).

---

## Thermostat modulant (OpenTherm)

Le thermostat Netatmo vendu aujourd'hui, le modèle **modulant** (OpenTherm),
fait partie de la famille Énergie. Ses deux modules sont chacun créés comme un
appareil :

- le **thermostat** (`OTM`) : température de la pièce, **consigne** pilotable,
  **Mode du chauffage** (voir ci-dessus), **état de la chaudière** (allumé
  quand la chaudière chauffe), batterie et signal radio, comme l'ancien
  `NATherm1` ;
- le **relais OpenTherm** (`OTH`) branché à la chaudière : sa qualité WiFi, la
  **température extérieure** sur laquelle Netatmo module le chauffage, et une
  fonctionnalité **Défaut chaudière** : 1 tant que la chaudière signale un
  défaut à Netatmo (pression d'eau, flamme, entretien…), 0 sinon.
  L'application Netatmo indique de quel défaut il s'agit.

La pièce du thermostat apparaît dans le widget **Chauffage Netatmo**, et le
thermostat peut être choisi dans l'action de scène **Changer le mode du
chauffage**. Un thermostat injoignable reçoit le badge **injoignable** et sa
batterie et son signal ne sont plus publiés. Aucune reconnexion n'est
nécessaire : les autorisations des thermostats font partie de la connexion
depuis la première version.

---

## Thermostat BTicino Smarther

Le thermostat **BTicino Smarther with Netatmo** (`BNS`) fait partie de la
famille Énergie. Il est créé avec la température de sa pièce, une **consigne**
pilotable, le **Mode du chauffage** (voir ci-dessus), l'**état de la
chaudière** (allumé quand il chauffe), l'**état de la climatisation** (allumé
quand la climatisation tourne), un état **Boost confort** en lecture seule (le
champ Netatmo `boiler_valve_comfort_boost`, tel que rapporté) et sa qualité
WiFi. Sa pièce apparaît dans le widget **Chauffage Netatmo** et le thermostat
peut être choisi dans l'action de scène **Changer le mode du chauffage**.

> ⚠️ **Compte Netatmo connecté avant cette version ?** Le Smarther a besoin de
> deux nouvelles autorisations Netatmo (`read_smarther`, `write_smarther`) :
> cliquez à nouveau sur **Connecter** dans l'écran Configuration et acceptez-les
> — vos appareils et réglages sont conservés. D'ici là, l'état de la connexion
> affiche « cliquez à nouveau sur Connecter », et une commande de consigne ou
> de mode du chauffage sur le Smarther échoue avec un message « reconnectez
> votre compte Netatmo ».

---

## Caméras

Quand la famille Sécurité est activée, chaque caméra est créée avec :

- une **image de tableau de bord** (un instantané, rafraîchi automatiquement) —
  Gladys la récupère **en priorité sur le réseau local** (avec repli sur l'URL
  VPN Netatmo) ;
- un interrupteur **monitoring** (activer/désactiver la surveillance de la
  caméra) ;
- un bouton **flux en direct** (HLS), construit lui aussi en local d'abord.

### Flux en direct — latence et son

- **Latence (~10 s) :** elle est inhérente au flux HLS en direct de Netatmo — le
  même décalage existe sur les applications web et mobile officielles de
  Netatmo. Préférez une latence `low` sur la box caméra du tableau de bord, et
  une qualité `medium` (720p) pour plus de fluidité.
- **Pas de son ?** Le microphone de la caméra doit être **activé** dans
  l'application Netatmo : _Gérer ma maison → sélectionner la pièce de la caméra
  → Caméra → Paramètres avancés → activer le Microphone_. S'il est désactivé
  là, aucun client (Gladys, web Netatmo, app Netatmo) n'a de son. Gladys
  transporte l'audio dès que le flux en contient — il n'y a rien à configurer
  côté Gladys.

### Éclairage de la caméra extérieure

La caméra extérieure (`NOC`) reçoit aussi deux fonctionnalités pour son
éclairage, que Netatmo règle sur **Allumé**, **Éteint** ou **Auto** (s'allume
sur une détection) :

| Mode Netatmo | **Floodlight** (lumière) | **Floodlight automatic mode** (interrupteur) |
| ------------ | ------------------------ | -------------------------------------------- |
| Allumé       | Allumé                   | Éteint                                       |
| Éteint       | Éteint                   | Éteint                                       |
| Auto         | Éteint                   | Allumé                                       |

- Allumer **Floodlight** force l'éclairage ; allumer le **mode automatique**
  revient en Auto.
- Éteindre l'une des deux n'agit que si c'est le mode en cours, et règle alors
  l'éclairage sur Éteint : une scène qui éteint les lumières laisse tranquille
  un éclairage en Auto, et couper le mode automatique n'éteint jamais un
  éclairage forcé.
- L'éclairage est une lumière Gladys : les actions de scène des lumières
  (allumer / éteindre) fonctionnent avec lui.

Un mode changé depuis l'application Netatmo apparaît au rafraîchissement suivant
(2 minutes, ou tout de suite avec les webhooks Gladys Plus).

> ⚠️ **Si votre caméra extérieure existait déjà dans Gladys**, l'éclairage
> n'apparaît pas tout seul : allez sur l'écran **Découverte** et cliquez sur
> **Mettre à jour** sur la caméra.

### Caméra intérieure Advance (`NPC`)

La caméra intérieure Advance est créée comme la caméra intérieure : une **image
de tableau de bord**, un interrupteur **monitoring**, les détections
**Mouvement** et **Personne détectée** (webhooks Gladys Plus), et elle apparaît
dans le widget **Caméras Netatmo**. Deux différences, toutes deux côté Netatmo :

- son instantané est récupéré via l'URL VPN Netatmo : comme la sonnette vidéo,
  cette caméra ne le sert pas sur le réseau local ;
- son direct est négocié en **WebRTC** (voir _Direct WebRTC_ plus bas) : avec
  un Gladys plus ancien, la box caméra affiche l'image fixe.

> ⚠️ **Compte Netatmo connecté avant cette version ?** Cette caméra demande
> trois nouvelles autorisations Netatmo (`read_camerapro`, `write_camerapro`,
> `access_camerapro`) : cliquez à nouveau sur **Connecter** sur l'écran
> Configuration et acceptez-les. D'ici là, le statut de connexion affiche une
> invitation à recliquer sur Connecter, la caméra peut manquer ou être
> injoignable, et une commande de monitoring refusée par Netatmo échoue avec un
> message « reconnecter ».

---

## Sonnette vidéo

Quand la famille Sécurité est activée, la sonnette vidéo Netatmo (`NDB`) est
créée avec :

- une **image de tableau de bord** (un instantané, rafraîchi automatiquement) —
  récupérée via l'URL VPN Netatmo : la sonnette ne la sert pas sur le réseau
  local ;
- une fonctionnalité **Sonnette** qui affiche **Sonne** quand quelqu'un appuie
  sur le bouton, utilisable comme déclencheur de scène (**Si la sonnette
  sonne**) — elle nécessite les webhooks Gladys Plus (voir ci-dessous) : le
  polling seul ne peut pas remonter un coup de sonnette ;
- la qualité de son lien **Wifi**.

Il n'y a pas d'interrupteur monitoring (Netatmo n'en propose pas pour la
sonnette). Son direct est négocié en **WebRTC** (voir _Direct WebRTC_
ci-dessous) : avec un Gladys plus ancien, la box caméra affiche l'image fixe.

> ⚠️ **Compte Netatmo connecté avant cette version ?** La sonnette nécessite
> deux nouvelles autorisations Netatmo (`read_doorbell`, `access_doorbell`) :
> cliquez à nouveau sur **Connecter** sur l'écran Configuration et acceptez-les.
> D'ici là, le statut de connexion affiche une invitation à recliquer sur
> Connecter.

### Direct WebRTC (sonnette et caméra intérieure Advance)

La sonnette vidéo et la caméra intérieure Advance diffusent **uniquement en
WebRTC**, via le cloud Netatmo : ni HLS, ni rien sur le réseau local. Avec une
version de Gladys postérieure à 5.2.1 qui inclut le direct WebRTC des caméras
([Gladys#3215](https://github.com/GladysAssistant/Gladys/pull/3215)), la box
caméra du tableau de bord affiche leur vidéo en direct. Le navigateur établit
le flux ; Gladys et l'intégration ne font que relayer cet établissement vers
Netatmo, et la vidéo va directement du cloud Netatmo au navigateur, à la maison
comme via Gladys Plus.

- **Gladys plus ancien :** la box caméra affiche l'image fixe, rafraîchie
  automatiquement, comme avant. Après la mise à jour de Gladys, sauvegardez une
  fois la configuration de l'intégration (ou relancez un scan sur l'écran
  **Découverte**) : la sonnette et la caméra existantes passent au direct, rien
  à recréer.
- **Arrêt :** le direct s'arrête quand vous le mettez en pause, quittez le
  tableau de bord ou fermez l'onglet (Gladys termine une session oubliée au
  bout de 30 secondes).
- **Le direct ne démarre pas :** la box affiche un message et la dernière image.
  Vérifiez que la caméra est en ligne dans l'application Netatmo et que le
  navigateur prend en charge WebRTC. Un pare-feu strict ou un VPN peut bloquer
  le trafic WebRTC vers le cloud Netatmo. Si le statut de connexion ou les
  **Journaux** de l'intégration demandent de reconnecter le compte,
  l'autorisation n'a pas `access_doorbell` / `access_camerapro` : cliquez à
  nouveau sur **Connecter**.

---

## Webhooks Gladys Plus (temps réel) — optionnel

Par défaut, Gladys interroge Netatmo **toutes les 2 minutes**. Avec les
webhooks, Netatmo **prévient** Gladys dès qu'il se passe quelque chose : les
valeurs sont alors rafraîchies en **2-3 secondes** au lieu d'attendre le
prochain cycle — sans augmenter le nombre d'appels à l'API Netatmo.

Comme une installation Gladys locale n'est pas joignable depuis Internet, c'est
**Gladys Plus** qui relaie les événements. Il faut donc un abonnement Gladys
Plus actif.

### Mise en place (une seule étape)

1. Sur l'écran **Configuration** de l'intégration, repérez le bloc
   **« Webhooks Gladys Plus »** (affiché automatiquement).
2. Collez-y votre **clé Open API** Gladys Plus. C'est tout.

**Vous n'avez rien à coller sur le site Netatmo :** l'intégration enregistre
elle-même l'URL auprès de Netatmo, et la ré-enregistre à chaque reconnexion.
Pour vérifier, ouvrez les **Journaux** de l'intégration : vous devez y voir

```
Netatmo webhook registered — events will trigger an immediate refresh
```

Ensuite, chaque événement livré par Netatmo ajoute une ligne comme
`Netatmo webhook event received: NACamera-movement (70:ee:50:…)`.

**Enregistré mais rien n'arrive ?** Lancez l'action **Diagnostic d'un
appareil** (écran Configuration, les deux champs vides) : la ligne **Webhook URL
held by Netatmo** indique si Netatmo détient toujours l'URL de l'intégration.
Un seul webhook par application Netatmo : si un autre client l'a remplacé (le
champ « webhook URI » de dev.netatmo.com, l'ancien service Netatmo du core),
enregistrez à nouveau la clé Gladys Plus. Netatmo suspend aussi les envois
pendant 24 heures pour une application dont le webhook a échoué 5 fois de suite
(seul dev.netatmo.com l'affiche et permet de lever la suspension). Les
détections n'existent que si la surveillance de la caméra est activée.

Sans clé (ou sans Gladys Plus), l'intégration fonctionne exactement comme avant,
en interrogation toutes les 2 minutes.

### Ce que ça apporte

- **Les valeurs remontent quasi instantanément** — par exemple une consigne de
  thermostat changée depuis l'application Netatmo, ou l'état de surveillance
  d'une caméra.
- **Des détections utilisables dans vos scènes** (voir ci-dessous).

### Détections en temps réel (déclencheurs de scène)

Certains événements sont **ponctuels** : ils n'existent que dans le flux
d'événements, aucune interrogation de l'API ne peut les remonter. Ils sont
publiés comme des fonctionnalités dédiées, utilisables comme **déclencheurs de
scène** :

| Appareil                         | Fonctionnalité          | Déclenchée par                       |
| -------------------------------- | ----------------------- | ------------------------------------ |
| Caméra intérieure et extérieure  | **Mouvement**           | un mouvement détecté                 |
| Caméra intérieure et extérieure  | **Personne détectée**   | une personne détectée / reconnue     |
| Caméra extérieure (Presence)     | **Animal détecté**      | un animal détecté                    |
| Caméra extérieure (Presence)     | **Véhicule détecté**    | un véhicule détecté                  |
| Détecteur de fumée               | **Fumée**               | une détection de fumée               |
| Détecteur de monoxyde de carbone | **Monoxyde de carbone** | une détection de monoxyde de carbone |
| Sonnette vidéo                   | **Sonnette**            | quelqu'un sonne                      |

Chaque détection passe à **Oui** puis revient automatiquement à **Non** au bout
d'une minute (Netatmo n'envoie pas d'événement de « fin de détection », sauf
pour la fumée et le monoxyde de carbone : l'événement « fumée dissipée » /
« retour à la normale » la remet aussitôt à **Non**). Dans une scène, utilisez
donc le déclencheur « la valeur passe à Oui » — pour la sonnette, le
déclencheur **Si la sonnette sonne**. Un coup de sonnette déclenche une seule
fois : les événements « appel accepté » / « appel manqué » de l'application
Netatmo ne sont pas des déclencheurs à part.

> ⚠️ **Si vos caméras existaient déjà dans Gladys**, ces nouvelles
> fonctionnalités n'apparaissent pas toutes seules : allez sur l'écran
> **Découverte** et cliquez sur **Mettre à jour** sur chaque caméra (ou
> détecteur de fumée) pour les ajouter. Sans webhooks configurés, ces
> fonctionnalités restent simplement à « Non ».

---

## Scènes : déclencheurs et actions Netatmo

L'intégration ajoute ses propres cartes à l'éditeur de scènes (Gladys **5.1** ou
plus récent) : choisissez **Déclencheur d'intégration** ou **Action
d'intégration**, puis l'entrée Netatmo.

### Déclencheurs (nécessitent les webhooks Gladys Plus)

| Déclencheur                    | Se déclenche quand                               | Informations transmises aux actions |
| ------------------------------ | ------------------------------------------------ | ----------------------------------- |
| **Une personne connue arrive** | une caméra intérieure reconnaît un visage connu  | Personne, Caméra, Maison            |
| **Une personne connue part**   | Netatmo marque une personne connue comme absente | Personne, Caméra, Maison            |
| **La sirène sonne**            | une sirène intérieure se met à sonner            | Sirène, Maison                      |

Filtres optionnels : la **caméra** (ou la sirène) — vide = n'importe laquelle —
et la **personne** : tapez le nom **exactement comme dans l'application
Netatmo** (l'éditeur de scènes ne peut pas lister les personnes Netatmo ; un
champ vide = n'importe quelle personne connue). Un visage non reconnu ne
déclenche jamais « Une personne connue arrive » — la fonctionnalité **Personne
détectée** de la caméra couvre toutes les personnes.

### Actions

| Action                               | Ce qu'elle fait                                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Changer le mode du chauffage**     | Planning, Absence ou Hors-gel pour toute la maison ; durée optionnelle en minutes (Absence et Hors-gel : retour au planning ensuite)                                                                                  |
| **Marquer une personne absente**     | une personne connue, ou — personne laissée vide — toute la maison vide (réarme la surveillance des caméras réglée pour suivre la présence)                                                                            |
| **Marquer une personne présente**    | une personne connue, ou — personne laissée vide — toutes les personnes connues                                                                                                                                        |
| **Régler la consigne d'une pièce**   | consigne manuelle (7 à 30 °C) de la pièce du thermostat ou de la vanne choisi ; durée optionnelle en minutes, puis retour au planning (vide : la durée par défaut d'une consigne manuelle dans l'application Netatmo) |
| **Booster une pièce**                | chauffe à pleine puissance (boost) la pièce du thermostat ou de la vanne choisi ; durée optionnelle en minutes (vide : la durée par défaut du boost dans l'application Netatmo)                                       |
| **Revenir au planning**              | met fin à la consigne manuelle ou au boost de la pièce : elle suit à nouveau le planning                                                                                                                              |
| **Choisir le planning de chauffage** | active l'un des plannings de chauffage de la maison                                                                                                                                                                   |

La **maison** est celle de l'appareil choisi dans l'action (un thermostat ou une
vanne pour le chauffage, une caméra pour les personnes). Laissez-le vide si
votre compte n'a qu'une maison. Le champ personne accepte une variable de scène
: « Une personne connue arrive → Marquer une personne présente » avec
l'information **Personne**. Chaque action renvoie le nom de la **Maison** aux
étapes suivantes.

Les trois actions de **pièce** s'appliquent à la pièce du thermostat ou de la
vanne choisi (obligatoire) et renvoient aussi le nom de la **Pièce**.
**Choisir le planning de chauffage** prend le **nom du planning exactement comme
dans l'application Netatmo** (majuscules / minuscules ignorées) : l'éditeur de
scènes ne peut pas lister les plannings Netatmo. Un nom inexistant fait échouer
l'action, et les journaux de la scène citent les plannings de la maison. Elle
renvoie aussi le nom du **Planning**.

---

## Widgets de tableau de bord

Trois widgets rejoignent le choix des widgets du tableau de bord (Gladys **5.1**
ou plus récent) : **Éditer le tableau de bord**, ajoutez un widget et cherchez «
Netatmo ».

| Widget                | Affiche                                                                                                                                                                                                                                                                                                   | Réglages                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Météo Netatmo**     | les tuiles en direct de la station (températures, humidité, CO2, bruit, pression, pluie, vent) et une ligne d'état par module à la batterie faible ou injoignable                                                                                                                                         | la station (vide : la première) et les mesures affichées : Vue d'ensemble, Intérieur, ou Extérieur, pluie et vent |
| **Chauffage Netatmo** | le mode du chauffage et le planning actif de la maison, une ligne par pièce (température mesurée → consigne, marquée Manuel ou Boost quand la consigne ne vient pas du planning), les boutons Planning / Hors-gel / Absence et, avec plusieurs plannings, un bouton **Changer de planning** qui les liste | un thermostat ou une vanne de la maison (vide : votre unique maison)                                              |
| **Caméras Netatmo**   | la dernière image de chaque caméra, sa surveillance, et des boutons pour l'activer / la couper                                                                                                                                                                                                            | une caméra affichée en grand (vide : toutes les caméras en liste)                                                 |

Les tuiles suivent les valeurs en direct ; le reste se rafraîchit avec
l'intégration (2 minutes, ou dès que le mode du chauffage, la surveillance ou
une image change). Les images des caméras sont servies par l'intégration
elle-même — le tableau de bord ne charge jamais d'image depuis les serveurs
Netatmo. Un widget n'affiche que les appareils créés dans Gladys.

---

## Accessoires de sécurité (bridgés par caméra)

Quand la famille Sécurité est activée, les accessoires liés à vos caméras sont
également découverts :

- **Capteur porte / fenêtre** (`NACamDoorTag`) — un capteur d'ouverture
  (ouvert/fermé), plus la batterie et le signal RF.
- **Sirène intérieure** (`NIS`) — un capteur sirène en lecture seule, plus la
  batterie et le signal RF.
- **Détecteur de fumée** (`NSD`) — découvert avec sa batterie et son signal,
  plus la fonctionnalité **Fumée** alimentée par les webhooks (voir la section
  ci-dessus) : le polling seul ne peut pas remonter cet état.
- **Détecteur de monoxyde de carbone** (`NCO`) — comme le détecteur de fumée :
  batterie et signal (quand Netatmo les remonte), plus la fonctionnalité
  **Monoxyde de carbone** alimentée par les webhooks.

---

## Personnes connues

Quand la famille Sécurité est activée, chaque maison dont les caméras
reconnaissent des visages obtient un appareil **« <maison> - Known persons »**,
avec une fonctionnalité **Presence** par personne nommée dans l'application
Netatmo : **Présence détectée** quand Netatmo considère la personne à la maison,
**Pas de présence** quand elle est absente — l'état affiché par l'application
Netatmo. Utilisez-la dans vos scènes comme n'importe quel détecteur de présence.

- Seules les personnes **nommées** ont une fonctionnalité : un visage inconnu
  (sans nom dans l'application Netatmo) est ignoré.
- La présence est actualisée toutes les 2 minutes, et **immédiatement** avec les
  webhooks Gladys Plus (une personne connue arrive / part) ou après les actions
  de scène **Marquer une personne absente / présente**.
- Quand Netatmo ne remonte pas la présence d'une personne, rien n'est publié :
  la dernière valeur connue reste.
- Une personne ajoutée, renommée ou supprimée dans l'application Netatmo :
  cliquez sur **Mettre à jour** sur l'appareil dans l'écran **Découverte** pour
  ajouter, renommer ou retirer la fonctionnalité. La fonctionnalité suit
  l'identifiant Netatmo de la personne : un renommage conserve son historique.

---

## Volets roulants (Bubendorff / iDiamant)

Activez **Volets roulants (Bubendorff / iDiamant)** sous **Appareils à
découvrir** (désactivé par défaut) pour découvrir les volets Bubendorff reliés
à votre passerelle iDiamant : modèles radio (`NBR`), filaires (`NBO`) et
solaires (`NBS`). Chaque volet est créé avec :

- une commande **ouvrir / fermer / stop** ;
- une **position** (0 % = fermé, 100 % = ouvert), que vous pouvez aussi régler ;
- la qualité de son **signal RF**.

La passerelle iDiamant elle-même n'est pas créée comme appareil : son
identifiant est conservé dans le paramètre `plug_id` du volet, chaque commande
passe par elle. Après une commande, Gladys rafraîchit les valeurs environ
30 secondes plus tard pour que la nouvelle position s'affiche sans attendre le
prochain cycle de 2 minutes.

> ⚠️ **Déjà connecté avant la prise en charge des volets ?** Les volets
> demandent deux nouvelles autorisations Netatmo. Recliquez sur **Connecter**
> dans l'écran de configuration et autorisez Gladys — vos appareils et
> réglages sont conservés. D'ici là, une commande de volet échoue et l'écran de
> configuration vous invite à vous reconnecter.

**Positions intermédiaires :** selon le modèle et le moteur, certains volets
Bubendorff ne savent que s'ouvrir ou se fermer complètement. Une position
intermédiaire peut alors être ignorée ou arrondie par le volet, et la position
remontée peut ne refléter que la dernière commande — utilisez ouvrir / fermer /
stop sur ces modèles.

---

## Capteur de qualité de l'air (Home Coach)

Quand la famille **Appareils Qualité de l'air (Home Coach)** est activée, chaque
capteur de qualité de l'air intérieur Netatmo (Home Coach, `NHC`) est découvert
avec sa température (plus le minimum et le maximum du jour), son humidité, son
CO2, son bruit, sa pression et sa pression absolue, la qualité de son WiFi, et
une fonctionnalité **Qualité de l'air**. Il porte le nom que vous lui avez donné
dans l'application Netatmo.

Le Home Coach ne mesure pas un indice de qualité de l'air : il note la pièce sur
cinq niveaux, à partir de son CO2, de son humidité, de son bruit et de sa
température. Gladys lit une fonctionnalité de qualité de l'air comme un indice
AQI (de 0 à 500) pour la colorer sur le tableau de bord et la transmettre à
HomeKit : chaque niveau est donc publié au milieu de la tranche AQI
correspondante :

| Niveau Home Coach | Valeur dans Gladys | Couleur du tableau de bord | HomeKit   |
| ----------------- | ------------------ | -------------------------- | --------- |
| Sain              | 25                 | vert                       | Excellent |
| Bon               | 75                 | jaune                      | Bon       |
| Moyen             | 125                | orange                     | Moyen     |
| Mauvais           | 175                | rose                       | Médiocre  |
| Malsain           | 250                | violet                     | Mauvais   |

Dans une scène, comparez avec ces valeurs : par exemple « Qualité de l'air
supérieure à 150 » signifie mauvais ou malsain.

Une fonctionnalité **Air quality level** affiche le même niveau en toutes
lettres sur le tableau de bord : Sain, Correct, Moyen, Mauvais, Malsain. Elle ne
garde pas d'historique : c'est la fonctionnalité
numérique **Qualité de l'air** qui garde l'historique, les couleurs et HomeKit.

Un Home Coach hors ligne reçoit le badge **injoignable** et ses dernières
valeurs connues ne sont pas publiées. Aucune reconnexion n'est nécessaire : la
permission Home Coach (`read_homecoach`) fait partie de la connexion depuis la
première version.

---

## Interphone BTicino (Classe 300X / Classe 300 EOS) — aperçu

Les interphones vidéo **BTicino Classe 300X** et **Classe 300 EOS with
Netatmo** passent par l'API Netatmo, qui en expose bien moins que l'application
Netatmo ([issue #59](https://github.com/Terdious/gladys-netatmo/issues/59)). Activez **Interphone BTicino (Classe 300) — aperçu**
sous **Appareils à découvrir** (désactivé par défaut) et enregistrez.

L'interphone est découvert comme **un seul appareil**, au nom de son poste
intérieur (la passerelle `BNCX`, ex. « Classe 300EOS with Netatmo »). Les
modules qu'il relie lui ajoutent leurs fonctionnalités, à leur nom :

| Module                           | Type Netatmo | Sur l'appareil interphone                                       |
| -------------------------------- | ------------ | --------------------------------------------------------------- |
| Poste intérieur (passerelle)     | `BNCX`       | qualité WiFi, **sonnerie** (nécessite les webhooks Gladys Plus) |
| Éclairage d'escalier / extérieur | `BNSL`       | **éclairage allumé / éteint** (ex. « Eclairage extérieur »)     |
| Prise commandée                  | `BNCS`       | état allumé / éteint en lecture seule, quand Netatmo le renvoie |
| Platine de rue                   | `BNEU`       | rien (Netatmo ne renvoie aucune valeur pour elle)               |
| Serrure                          | `BNDL`       | rien — voir ci-dessous                                          |
| Module X                         | `BNXM`       | sa qualité de signal, quand Netatmo en renvoie une              |

- **Éclairage :** commandé via Netatmo comme dans l'application. Netatmo ne
  renvoie jamais s'il est allumé : Gladys affiche la dernière commande envoyée
  (l'éclairage d'escalier s'éteint en général seul après un délai, Gladys ne
  peut pas savoir quand).
- **Sonnerie :** publiée comme celle de la [sonnette vidéo](#sonnette-vidéo) (« Sonne » puis
  l'heure du dernier appel), utilisable comme déclencheur de scène —
  uniquement avec les [webhooks Gladys Plus](#webhooks-gladys-plus-temps-réel--optionnel). Netatmo documente cet
  événement pour le Classe 300 EOS ; il n'a pas encore été vu sur une
  installation réelle : si vos appels n'apparaissent pas, envoyez un
  diagnostic (ci-dessous).
- **L'ouverture de la porte n'est pas disponible.** L'API Netatmo utilisée par
  les applications tierces ne leur permet pas d'ouvrir une serrure BTicino
  (Netatmo la bloque pour des raisons de sécurité) ; seule l'application
  Netatmo / BTicino le peut.
- Le badge **injoignable** suit le poste intérieur. Un module relié que Netatmo
  signale hors ligne ne publie aucune valeur.
- Si vous aviez créé des appareils avec l'aperçu 2.2.0 (un par module),
  supprimez-les et créez à nouveau l'appareil interphone.

> ⚠️ **Nouvelles autorisations Netatmo — cliquez à nouveau sur Connecter.**
> Activer l'option demande quatre autorisations supplémentaires, demandées
> uniquement quand elle est active : `read_bfi` / `write_bfi` (BTicino IP,
> Classe 300X) et `read_mx` / `write_mx` (Classe 300 EOS). Cliquez à nouveau
> sur **Connecter** dans l'écran de configuration et acceptez-les — vos
> appareils et réglages sont conservés. D'ici là, le statut de connexion
> affiche une invitation à vous reconnecter, et Netatmo peut omettre les
> modules BTicino (une commande d'éclairage échoue alors avec un message
> « reconnectez »).

### Envoyer un diagnostic au mainteneur

Utilisez l'action **Diagnostic d'un appareil** de l'écran de configuration
(voir [Dépannage](#dépannage)) : choisissez l'appareil interphone, ou laissez les
deux champs vides pour tout le compte, et collez le résultat dans
l'[issue #59](https://github.com/Terdious/gladys-netatmo/issues/59). Faites sonner une fois avant de la lancer : le rapport
liste les derniers événements webhook de chaque module.

Tant que l'option est active, l'intégration écrit aussi dans ses journaux, au
premier rafraîchissement après un démarrage puis **uniquement quand quelque
chose change**, les données brutes renvoyées par Netatmo pour chaque module
BTicino et chaque événement webhook Gladys Plus le concernant. Chaque ligne
commence par `[bticino-diagnostic]` ; la même anonymisation s'applique (jetons,
clés, adresses e-mail et URL remplacés par `<redacted>`, identifiants de
module, de passerelle et de maison conservés), et une ligne de plus de 8 Ko est
coupée avec un marqueur `[truncated]`.

---

## Mettre à jour l'intégration

**Installée depuis le catalogue** (le cas habituel) : Gladys consulte
régulièrement le store. Quand une nouvelle version sort, l'intégration affiche
un badge **« Mise à jour disponible »** (également compté à côté de
**Intégrations** dans le menu), et son onglet **Supervision** indique la version
proposée, avec un lien vers ses notes de version. Cliquez sur **Mettre à jour** :
Gladys récupère la nouvelle image **et** applique le nouveau manifest — les
nouveaux champs de configuration apparaissent d'eux-mêmes, il n'y a rien à
recoller. Votre configuration et vos appareils sont conservés.

Gladys peut mettre jusqu'à environ une heure et demie à voir une nouvelle
version (rafraîchissement de l'index du store). **« Forcer la mise à jour »**
vérifie immédiatement : il lit la dernière version publiée et récupère son
image.

**Installée en mode développeur** (manifest collé à la main) : **« Forcer la
mise à jour »** ne fait que récupérer à nouveau l'image du tag installé, et la
version affichée comme les champs de configuration proviennent du manifest
collé — recollez le manifest à jour pour récupérer les nouveaux champs.

---

## Migration depuis le service Netatmo intégré

Cette intégration externe remplace le service Netatmo intégré à Gladys. Ses
appareils ont de nouveaux identifiants (`netatmo:*` → `ext:netatmo:*`) et sont
donc créés comme de nouveaux appareils — mais depuis **Gladys 4.84.1**, vous
pouvez **migrer** chaque ancien appareil vers son remplaçant et conserver son
**historique d'états**, ses **scènes** et ses **tableaux de bord**.

### Avant de commencer

- **Ne supprimez pas vos anciens appareils Netatmo** : la migration part
  d'eux.
- **Migrez peu après avoir créé les nouveaux appareils.** Si les deux appareils
  ont enregistré des valeurs sur la même période, seul l'historique ancien
  _antérieur à la première valeur du nouvel appareil_ est déplacé, pour ne rien
  compter en double : les valeurs de l'ancien appareil sur la période commune
  sont abandonnées.

### Étapes

1. Installez et connectez cette intégration, puis créez vos appareils depuis
   l'onglet **Découverte** : la destination doit exister avant de migrer.
2. Ouvrez **Intégrations → Netatmo** — l'intégration intégrée, signalée comme
   dépréciée — puis son onglet **Appareils**.
3. Sur un ancien appareil, cliquez sur **Migrer**.
4. Choisissez l'**Appareil de destination** : le nouvel appareil, rangé sous
   l'intégration externe Netatmo (la liste se filtre par intégration, pièce et
   nom).
5. Vérifiez le tableau **Correspondance des fonctionnalités**. Gladys le
   pré-remplit (même catégorie, même type et même unité, puis même nom pour
   départager les jumelles) ; chaque ancienne fonctionnalité peut être associée
   à la main, ou réglée sur **Ne pas migrer** — son historique est alors
   supprimé. Regardez bien les lignes de température des thermostats et des
   stations, qui ont plusieurs fonctionnalités de température.
6. Cliquez sur **Migrer et supprimer l'ancien appareil**.

Gladys déplace l'historique, réécrit les scènes et les tableaux de bord qui
utilisaient l'ancien appareil, place le nouvel appareil dans la pièce de
l'ancien s'il n'en a pas, rebranche les liens énergie, puis supprime l'ancien
appareil. Le résultat indique le nombre d'états déplacés et de scènes /
tableaux de bord mis à jour. Répétez pour chaque appareil.

Un long historique peut prendre plusieurs minutes : suivez-le dans
**Paramètres → Tâches**. Si la page perd la connexion, la migration continue en
arrière-plan — vérifiez cette page avant de réessayer. Une migration échouée
peut être relancée : elle ne déplace que ce qui reste.

---

## Dépannage

- **« Enregistrez d'abord » à la connexion :** enregistrez le client id /
  secret, puis recliquez sur Connecter.
- **Session expirée :** recliquez sur Connecter pour réautoriser votre compte
  Netatmo.
- **Un appareil affiche un badge « injoignable » :** Netatmo le signale hors
  ligne (batterie morte, éteint, hors de portée). Gladys cesse de publier ses
  dernières valeurs connues pour ne pas vous induire en erreur ; le badge
  disparaît au retour de l'appareil.
- **Un appareil affiche un badge « Dégradé », ou le statut affiche un message
  alors qu'il est Connecté :** une partie du cloud Netatmo est en panne depuis
  plusieurs minutes (par exemple le service météo). Gladys continue de publier
  ce que le reste du cloud fournit — les mesures de la station et de ses modules
  viennent aussi de l'état de la maison — et signale les appareils restés sans
  valeur fraîche. Rien à faire : les deux disparaissent d'eux-mêmes à la
  première actualisation complète. Si cela dure, les **Logs** de l'intégration
  nomment l'API en échec.
- **Une valeur de caméra ou une commande monitoring échoue une fois avec un
  message « reconnecter » :** votre autorisation Netatmo n'a pas le scope
  caméra — reconnectez votre compte.
- **Une commande de volet échoue avec un message « reconnecter » :** votre
  autorisation Netatmo date d'avant la prise en charge des volets — recliquez
  sur Connecter.
- **Pas de son sur la caméra :** voir l'astuce microphone dans la section
  Caméras ci-dessus.
- **Sonnette ou caméra intérieure Advance sans direct :** voir _Direct WebRTC_
  dans la section Sonnette vidéo (version de Gladys, navigateur, pare-feu).
- **Statut « des autorisations Netatmo manquent » :** une version plus récente
  a ajouté des autorisations (sonnette vidéo, caméra intérieure Advance, interphone BTicino) — recliquez sur Connecter et
  acceptez-les. Les **Journaux** de l'intégration listent celles qui manquent.
- **Diagnostic d'un appareil (signaler un problème ou un appareil non pris en
  charge) :** dans l'écran de configuration, lancez l'action **Diagnostic d'un
  appareil**. Choisissez un appareil créé dans Gladys, ou saisissez le nom ou
  l'identifiant Netatmo d'un module que vous n'avez pas créé (par exemple un
  module pas encore pris en charge) ; laissez les deux champs vides pour un
  résumé de tout le compte. Le rapport montre ce que Netatmo envoie pour le
  module, ce que l'intégration publie pour lui, les champs Netatmo qu'elle
  n'utilise pas encore, les derniers événements webhook, les autorisations et
  l'état de chaque API Netatmo. Il est aussi écrit dans les **Journaux** de
  l'intégration (lignes après `[netatmo-diagnostic]`) si vous ne pouvez pas le
  copier depuis l'écran. **Relisez-le avant de le publier :** jetons, URL et
  adresses e-mail sont retirés, mais les identifiants de modules et de maison
  et les noms donnés à vos modules sont conservés.
- **Toujours bloqué, ou un appareil manque ?** Posez votre question sur le
  sujet du forum [Intégration externe - Netatmo](https://community.gladysassistant.com/t/integration-externe-netatmo/11308),
  ou ouvrez une issue sur [GitHub](https://github.com/Terdious/gladys-netatmo/issues) avec les journaux de
  l'intégration (onglet **Journaux**).
