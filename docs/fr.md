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
- Une instance Gladys Assistant compatible avec les intégrations externes.

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
3. Cliquez sur **Se connecter** : une fenêtre Netatmo s'ouvre, connectez-vous et
   autorisez Gladys. Vous êtes redirigé et le statut passe à **Connecté**.

> **Astuce :** **Enregistrez** toujours le client id / secret _avant_ de cliquer
> sur Se connecter. Si la connexion indique qu'il faut d'abord sauvegarder les
> identifiants, enregistrez le formulaire et recliquez sur Se connecter.

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

## Accessoires de sécurité (bridgés par caméra)

Quand la famille Sécurité est activée, les accessoires liés à vos caméras sont
également découverts :

- **Capteur porte / fenêtre** (`NACamDoorTag`) — un capteur d'ouverture
  (ouvert/fermé), plus la batterie et le signal RF.
- **Sirène intérieure** (`NIS`) — un capteur sirène en lecture seule, plus la
  batterie et le signal RF.
- **Détecteur de fumée** (`NSD`) — découvert avec sa batterie et son signal. Son
  **état de fumée** est délivré par les webhooks (événements temps réel), qui
  arriveront dans un jalon ultérieur ; le polling seul ne peut pas le remonter.

---

## Mettre à jour l'intégration

Le bouton **« Forcer la mise à jour »** de l'onglet Supervision récupère une
nouvelle **image Docker (le runtime)**. La **version affichée** et les **champs
de configuration** proviennent du **manifest** que vous avez installé. Si une
mise à jour ajoute de nouveaux champs de configuration, réinstallez / recollez
le manifest à jour pour les récupérer.

---

## Migration depuis le service Netatmo intégré

Si vous utilisiez le service Netatmo intégré à Gladys, cette intégration externe
le remplace. Les appareils sont **redécouverts comme neufs** (leurs
identifiants passent de `netatmo:*` à `ext:netatmo:*`), leur historique n'est
donc pas repris — recréez les appareils depuis l'écran Découverte.

---

## Dépannage

- **« Enregistrez d'abord » à la connexion :** enregistrez le client id /
  secret, puis recliquez sur Se connecter.
- **Session expirée :** recliquez sur Se connecter pour réautoriser votre compte
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
