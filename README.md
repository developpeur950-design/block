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
- Lors d'un blocage : page avec **« Retour au site »** / **« Ouvrir quand même »**.
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

Depuis ton réseau Tailscale : `http://<ton-magicdns>:8787/` (tableau de bord, filtrable
par appareil) ou `http://<ton-magicdns>:8787/api/visits` (JSON).

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
