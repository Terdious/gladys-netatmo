# Intégration Netatmo pour Gladys Assistant

Connectez vos appareils **Netatmo** — station météo, thermostats et vannes de
radiateur, caméras intérieure/extérieure et leurs accessoires — à Gladys
Assistant.

Cette intégration communique avec le cloud Netatmo pour vous : vous créez une
fois votre propre application Netatmo Connect, connectez votre compte, et Gladys
découvre vos appareils puis maintient leurs valeurs à jour.

---

## Prérequis

- Un **compte Netatmo**, avec vos appareils déjà installés et fonctionnels dans
  l'application Netatmo (Gladys lit ce que Netatmo expose — un appareil doit
  d'abord être en ligne dans Netatmo).
- Gladys Assistant **4.86 ou plus récent**.

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
écriture, couvrant l'Énergie, la Météo et la Sécurité y compris les caméras) au
moment de la connexion, et gère lui-même la redirection OAuth2.

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

| Interrupteur | Découvre                                                                      |
| ------------ | ----------------------------------------------------------------------------- |
| **Énergie**  | Thermostat (`NATherm1`), relais (`NAPlug`), vannes de radiateur (`NRV`)       |
| **Météo**    | Station (`NAMain`) + modules extérieur, vent, pluie et intérieurs             |
| **Sécurité** | Caméras intérieure (`NACamera`) et extérieure (`NOC`), plus leurs accessoires |

Activer une famille et **enregistrer** relance la découverte automatiquement —
pas besoin de re-scanner. Les nouveaux appareils apparaissent sur l'écran
**Découverte**, où vous créez ceux que vous voulez.

**Qualité du flux vidéo des caméras** (`poor` / `low` / `medium` / `high`, par
défaut `high`) règle la qualité du flux vidéo en direct.

Les valeurs sont rafraîchies toutes les **2 minutes** (limites d'API Netatmo).

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

| Appareil                        | Fonctionnalité        | Déclenchée par                   |
| ------------------------------- | --------------------- | -------------------------------- |
| Caméra intérieure et extérieure | **Mouvement**         | un mouvement détecté             |
| Caméra intérieure et extérieure | **Personne détectée** | une personne détectée / reconnue |
| Caméra extérieure (Presence)    | **Animal détecté**    | un animal détecté                |
| Caméra extérieure (Presence)    | **Véhicule détecté**  | un véhicule détecté              |
| Détecteur de fumée              | **Fumée**             | une détection de fumée           |

Chaque détection passe à **Oui** puis revient automatiquement à **Non** au bout
d'une minute (Netatmo n'envoie pas d'événement de « fin de détection »). Dans
une scène, utilisez donc le déclencheur « la valeur passe à Oui ».

> ⚠️ **Si vos caméras existaient déjà dans Gladys**, ces nouvelles
> fonctionnalités n'apparaissent pas toutes seules : allez sur l'écran
> **Découverte** et cliquez sur **Mettre à jour** sur chaque caméra (ou
> détecteur de fumée) pour les ajouter. Sans webhooks configurés, ces
> fonctionnalités restent simplement à « Non ».

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
- **Une valeur de caméra ou une commande monitoring échoue une fois avec un
  message « reconnecter » :** votre autorisation Netatmo n'a pas le scope
  caméra — reconnectez votre compte.
- **Pas de son sur la caméra :** voir l'astuce microphone dans la section
  Caméras ci-dessus.
