# Garde-Redirections

Extension de navigateur (**Chrome, Edge, Opera** — Manifest V3) qui bloque les
redirections hors des sites que tu protèges, avec un serveur privé **optionnel** (sur
Tailscale) pour recevoir un journal chiffré de tes visites.

> ⚠️ Usage personnel, sur **tes** navigateurs uniquement.

Le dépôt est séparé en deux :

```
extension/   ← l'extension seule (c'est CE dossier qu'on charge dans le navigateur)
server/      ← serveur privé optionnel (pour recevoir les données)
setup.js     ← configuration automatique optionnelle (relie extension + serveur)
```

---

## Option 1 — l'extension seule (sans serveur, sans Node)

C'est le plus simple. Rien à installer d'autre.

1. Ouvre `chrome://extensions` (ou `edge://extensions`, `opera://extensions`).
2. Active le **Mode développeur**.
3. **« Charger l'extension non empaquetée »** → sélectionne le dossier **`extension/`**.
4. Clique l'icône de l'extension → **Options** → renseigne les **sites à protéger**
   (un par ligne, ex. `ma-banque.fr`). Enregistre.

C'est tout. L'extension bloque désormais les sorties de ces sites. Aucune donnée n'est
envoyée nulle part (tout reste en local ; tu vois le journal dans le popup).

**Règles de blocage :**
- Toujours **tout le site** : même si tu colles `https://mon-site.fr/compte`, c'est tout
  `mon-site.fr` qui est protégé.
- Le blocage ne s'active **que lorsque tu es sur un site protégé**. Ailleurs : rien.
- **Nouveaux onglets / pop-ups** : si un site protégé tente d'ouvrir un onglet ou une
  pop-up vers un autre domaine (pubs, « Anonymous Proxy detected », etc.), il est **fermé
  immédiatement** — il ne s'ouvre pas.
- Lors d'un blocage (onglet courant) : page avec **« Retour au site »** / **« Ouvrir quand même »**.
- Options : inclure les **sous-domaines**, et **exceptions** toujours autorisées.

---

## Option 2 — ajouter ton serveur privé (envoi chiffré)

Si tu veux recevoir le journal de tes visites sur ton PC. Nécessite **Node.js** et
(recommandé) **Tailscale**.

### a) Configure tout en une commande

Sur ton PC, à la racine du dépôt :

```bash
node setup.js --watch ma-banque.fr --watch mon-autre-site.fr
```

`setup.js` détecte ton IP/nom Tailscale, génère une **phrase secrète** + un **jeton
Bearer**, écrit la config serveur (`server/config.json`) et **pré-remplit l'extension**
(`extension/src/config.js`). Il n'y a alors rien à saisir dans les Options.

### b) Démarre le serveur

```bash
node server/server.js
```

Il écoute sur ton IP Tailscale (injoignable hors de ton réseau Tailscale) et n'accepte
que les messages qu'il peut déchiffrer.

### c) (Re)charge l'extension

Charge le dossier `extension/` comme à l'option 1. Elle est déjà configurée.

### Consulter tes données

Le serveur **ne fait que recevoir** : il n'affiche aucune page. Visiter son adresse ne
montre rien (page vide). Les données sont écrites en clair sur le disque du serveur, **un
fichier par appareil** :

```
server/data/<appareil>.visits.ndjson    ← liens visités
server/data/<appareil>.history.ndjson   ← historique (au démarrage du navigateur)
```

Ouvre ces fichiers directement (une ligne JSON par entrée) pour consulter les données.

### Mettre l'extension sur un autre PC (et envoyer au même serveur)

Sur le 2ᵉ PC, **ne lance pas `setup.js`** (il générerait de nouveaux secrets et pointerait
vers lui-même). À la place, donne-lui la même config que le serveur, au choix :

- **Simple** : copie le fichier `extension/src/config.js` du PC serveur vers le même
  emplacement sur le 2ᵉ PC (il contient l'URL du serveur, la phrase secrète et le jeton).
- **Ou à la main** : charge l'extension, ouvre ses **Options**, et saisis la même **URL de
  serveur**, la même **phrase secrète** et le même **jeton** que sur le serveur.

Puis change l'**étiquette d'appareil** (Options) pour un nom différent → ses données
arriveront dans son propre fichier `<appareil>.visits.ndjson`. L'extension enverra bien au
PC serveur, depuis n'importe quel appareil de ton réseau Tailscale.

---

## Sécurité & confidentialité (option 2)

- **Chiffrement de bout en bout** : AES-256-GCM, clé dérivée de la phrase secrète
  (PBKDF2-SHA256, 150 000 itérations), sel + IV aléatoires par message. Seul ton serveur
  déchiffre.
- **Serveur privé (Tailscale)** : non exposé à Internet/au LAN.
- **Jeton Bearer** : seconde couche d'authentification.
- **Tag d'appareil** : chaque message porte l'étiquette de l'appareil (chiffrée).

Sans phrase secrète/serveur configurés, l'extension n'envoie rien.

---

## Structure

```
extension/
  manifest.json          Manifest MV3
  icons/                 icônes (lien barré) + générateur
  src/
    config.js            config intégrée (générée par setup.js — hors git, optionnelle)
    config.example.js    modèle de config
    common.js            paramètres, zones protégées, chiffrement
    background.js        service worker (blocage ciblé + journal + envoi chiffré)
    popup.html / .js     fenêtre de la barre d'outils
    options.html / .js   réglages
    blocked.html / .js   page affichée lors d'un blocage
server/
  server.js              serveur privé qui déchiffre et stocke
  config.json            config + secrets (générée par setup.js — hors git)
  package.json
setup.js                 configuration automatique (Tailscale + secrets)
```

## Variables d'environnement du serveur (optionnelles, l'emportent sur config.json)

| Variable | Rôle | Défaut |
|----------|------|--------|
| `PASSPHRASE` | phrase secrète (obligatoire si pas de config.json) | *(config.json)* |
| `PORT` | port d'écoute | `8787` |
| `HOST` | interface d'écoute | *(IP Tailscale)* |
| `SERVER_KEY` | jeton Bearer | *(config.json)* |
| `DATA_DIR` | dossier de stockage | `server/data` |

## Limites connues

- Sur une redirection automatique, la page cible peut clignoter brièvement avant d'être
  coupée (limitation Manifest V3).
- Comparaison par nom d'hôte (sous-domaines inclus en option), sans liste publique des
  suffixes — suffisant pour un usage personnel.
