# Garde-Redirections

Extension de navigateur (**Chrome, Edge, Opera** — Manifest V3) + serveur privé sur **Tailscale**, **pour un usage personnel sur tes propres navigateurs**.

1. **Blocage ciblé** : par défaut l'extension **ne fait rien**. Tu ajoutes des sites à
   protéger ; dès que tu es sur l'un d'eux, toute sortie vers un **autre site** est bloquée.
2. **Journal + envoi chiffré** : elle journalise tes visites et les envoie, **chiffrées de
   bout en bout**, vers **ton** serveur Tailscale, qui les déchiffre.

> ⚠️ Cet outil enregistre un historique de navigation. À n'installer que sur **tes**
> navigateurs, pour **tes** données, vers **ton** serveur.

---

## Mise en route (toute la config se fait sur ton PC)

### 1. Prérequis : Tailscale

Installe [Tailscale](https://tailscale.com/download) sur ton PC et connecte-toi. Ce PC
devient ton serveur privé, joignable uniquement depuis tes appareils Tailscale.

### 2. Configure tout en une commande

Depuis la racine du dépôt, sur ton PC :

```bash
node setup.js
# ou en précisant les sites à protéger :
node setup.js --watch ma-banque.fr --watch mon-autre-site.fr
```

`setup.js` :
- détecte ton **IP Tailscale** et ton **nom MagicDNS** ;
- génère une **phrase secrète** (chiffrement) et un **jeton Bearer** ;
- écrit la config du serveur → `server/config.json` ;
- **intègre la config dans l'extension** → `src/config.js`.

Rien à recopier : l'extension contient déjà l'URL du serveur, la phrase secrète et le jeton.

### 3. Démarre le serveur

```bash
node server/server.js
```

Il écoute sur ton **IP Tailscale** (injoignable hors de ton réseau Tailscale) et
n'accepte que les messages qu'il peut déchiffrer.

### 4. Charge l'extension

`chrome://extensions` · `edge://extensions` · `opera://extensions` → **Mode développeur**
→ **« Charger l'extension non empaquetée »** → sélectionne le **dossier racine** du dépôt.

**C'est tout.** L'extension est déjà configurée : rien à saisir.

---

## Choisir les sites protégés

Deux possibilités :
- à la configuration : `node setup.js --watch ma-banque.fr` (un `--watch` par site) ;
- ou à tout moment dans les **Options** de l'extension, champ *Liens / débuts de liens à protéger*.

Règles :
- **Toujours tout le site.** Même si tu colles une adresse complète
  (`https://mon-site.fr/compte`), c'est **tout `mon-site.fr`** qui est protégé.
- Le blocage ne s'active **que lorsque tu es sur un site protégé** ; partout ailleurs,
  l'extension ne bloque rien.
- Quand une sortie est bloquée, une page propose **« Retour au site »** ou **« Ouvrir quand même »**.
- Options : traiter les **sous-domaines** comme le même site, et **exceptions** toujours autorisées.

---

## Sécurité & confidentialité

- **Chiffrement de bout en bout** : AES-256-GCM, clé dérivée de la phrase secrète par
  PBKDF2-SHA256 (150 000 itérations), sel + IV aléatoires par message. Rien ne circule en
  clair ; seul ton serveur déchiffre.
- **Serveur privé (Tailscale)** : écoute sur ton IP Tailscale, donc inaccessible depuis
  Internet / le LAN. Seuls tes appareils Tailscale peuvent l'atteindre.
- **Jeton Bearer** : seconde couche d'authentification (`Authorization: Bearer …`).
- **Tag d'appareil** : chaque message porte l'étiquette de l'appareil (chiffrée) pour
  distinguer tes machines.

Le vrai verrou est la **phrase secrète** : sans elle, le serveur rejette tout message
(impossible à déchiffrer).

---

## Consulter tes données

Sur le PC serveur, via Tailscale :
- `http://<ton-magicdns>:8787/` — tableau de bord (déchiffré localement), filtrable par appareil ;
- `http://<ton-magicdns>:8787/api/visits?limit=500&device=...` — données JSON.

Données stockées en NDJSON : `server/data/visits.ndjson` et `history.ndjson` (hors git).

---

## Envoyer les données

- Popup → **Envoyer au serveur** : pousse les visites en attente.
- Options → **Envoyer tout l'historique maintenant** : envoie tout l'historique du navigateur.
- Envoi automatique configurable (intervalle en minutes ; `0` = manuel).

---

## Reconfigurer / plusieurs appareils

- Relance `node setup.js` à tout moment (réutilise les mêmes secrets). Ajoute `--rotate`
  pour régénérer phrase secrète et jeton.
- **Autre appareil** : copie le dépôt déjà configuré (avec `src/config.js`) sur l'autre
  machine et charge l'extension — elle pointera vers le même serveur. Change juste
  l'*étiquette d'appareil* dans les Options pour les distinguer.

---

## Structure

```
setup.js                 configuration en une commande (Tailscale + secrets)
manifest.json            Manifest MV3
icons/                   icônes (lien barré) + générateur
src/
  config.js              config intégrée (générée par setup.js — hors git)
  config.example.js      gabarit de référence
  common.js              paramètres, zones protégées, chiffrement
  background.js          service worker (blocage ciblé + journal + envoi chiffré)
  popup.html / .js       fenêtre de la barre d'outils
  options.html / .js     réglages
  blocked.html / .js     page affichée lors d'un blocage
server/
  server.js              serveur privé qui déchiffre et stocke
  config.json            config + secrets (générée par setup.js — hors git)
  package.json
```

## Variables d'environnement du serveur (optionnelles)

Elles l'emportent sur `server/config.json` :

| Variable | Rôle | Défaut |
|----------|------|--------|
| `PASSPHRASE` | phrase secrète (obligatoire si pas de config.json) | *(config.json)* |
| `PORT` | port d'écoute | `8787` |
| `HOST` | interface d'écoute | *(IP Tailscale via config.json)* |
| `SERVER_KEY` | jeton Bearer | *(config.json)* |
| `DATA_DIR` | dossier de stockage | `server/data` |

## Limites connues

- Sur une redirection automatique, la page cible peut clignoter brièvement avant d'être
  coupée (Manifest V3 ne permet plus le blocage réseau synchrone aux extensions chargées
  manuellement).
- La comparaison de sites se fait par nom d'hôte (sous-domaines inclus en option), sans
  liste publique des suffixes — suffisant pour un usage personnel.
