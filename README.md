# Garde-Redirections

Extension de navigateur (**Chrome, Edge, Opera** — Manifest V3) + serveur privé, **pour un usage personnel sur tes propres navigateurs**.

1. **Blocage ciblé** : par défaut l'extension **ne fait rien**. Tu ajoutes des **liens / débuts de liens** à protéger ; elle en déduit le **site de base** et bloque toute sortie de ce site **uniquement quand tu es sur ces liens**.
2. **Journal + envoi chiffré** : elle journalise tes visites et peut les envoyer, **chiffrées de bout en bout**, vers **ton** serveur, qui les déchiffre.

> ⚠️ Cet outil enregistre un historique de navigation. À n'installer que sur **tes** navigateurs, pour **tes** données, vers **ton** serveur.

---

## 1. Installer l'extension

1. Ouvre la page des extensions : `chrome://extensions`, `edge://extensions` ou `opera://extensions`.
2. Active le **Mode développeur**.
3. **« Charger l'extension non empaquetée »** → sélectionne le dossier **racine du dépôt** (celui qui contient `manifest.json`).

Les icônes sont dans `icons/` (régénérables avec `node icons/generate-icons.js`).

---

## 2. Choisir ce qui est protégé (Options)

Dans **Liens / débuts de liens à protéger**, ajoute une entrée par ligne :

```
ma-banque.fr                     ← tout le site ma-banque.fr est protégé
https://mon-site.fr/compte       ← protégé seulement sous /compte
```

- **Site de base** = le domaine de l'entrée. Quand tu es sur une page couverte, toute
  navigation/redirection qui **quitte ce domaine** est bloquée (page d'avertissement avec
  « Retour au site » / « Ouvrir quand même »).
- Hors de ces liens, l'extension **ne bloque rien**.
- **Sous-domaines** : option pour traiter `a.site.com` / `b.site.com` comme le même site.
- **Exceptions** : domaines toujours autorisés, même depuis une zone protégée.

---

## 3. Lancer ton serveur (privé + chiffré)

Aucune dépendance (Node.js 18+). La phrase secrète est **obligatoire** :

```bash
PASSPHRASE="une phrase longue et unique" node server/server.js
```

- N'écoute que sur `127.0.0.1:8787` par défaut → **injoignable depuis le réseau**.
- `POST /collect` — n'accepte **que** les messages déchiffrables avec `PASSPHRASE`.
- `GET /` — tableau de bord (données déchiffrées localement), filtrable par appareil.
- `GET /api/visits?limit=500&device=PC%20bureau` — données en JSON.

### Variables d'environnement

| Variable | Rôle | Défaut |
|----------|------|--------|
| `PASSPHRASE` | **obligatoire** — clé du chiffrement, identique à l'extension | — |
| `PORT` | port d'écoute | `8787` |
| `HOST` | interface d'écoute (`0.0.0.0` pour exposer — déconseillé) | `127.0.0.1` |
| `SERVER_KEY` | jeton Bearer attendu (2ᵉ couche) | *(aucun)* |
| `DATA_DIR` | dossier de stockage | `./server/data` |

Données stockées en **NDJSON** après déchiffrement : `server/data/visits.ndjson` et `history.ndjson` (ignorés par git).

---

## 4. Relier l'extension au serveur (Options)

1. **URL de ton serveur** : `http://localhost:8787/collect`
2. **Phrase secrète** : **exactement la même** que `PASSPHRASE` côté serveur.
3. **Étiquette de cet appareil** : ex. `PC bureau` (incluse chiffrée, pour distinguer tes appareils).
4. **Jeton Bearer** (optionnel) : identique à `SERVER_KEY`.
5. **Tester le serveur** → « Serveur joignable et phrase secrète valide ✔ ».

- Popup → **Envoyer au serveur** : pousse les visites en attente.
- Options → **Envoyer tout l'historique maintenant** : envoie tout l'historique du navigateur.

Sans URL de serveur ou sans phrase secrète : **rien n'est envoyé**, tout reste en local.

---

## Sécurité & confidentialité

- **Chiffrement de bout en bout** : AES-256-GCM, clé dérivée de la phrase secrète par
  PBKDF2-SHA256 (150 000 itérations). Chaque message a son propre sel et IV aléatoires.
  Rien ne circule en clair ; le serveur est le seul « bout » capable de déchiffrer.
- **Serveur privé** : écoute locale + rejet de tout message non déchiffrable (la phrase
  secrète fait office de clé d'accès) + jeton Bearer optionnel.
- **Tag d'appareil** : chaque message porte l'étiquette de l'appareil, chiffrée.

---

## Structure

```
manifest.json            Manifest MV3
icons/                   icônes PNG + générateur
src/
  common.js              paramètres, zones protégées, chiffrement
  background.js          service worker (blocage ciblé + journal + envoi chiffré)
  popup.html / .js       fenêtre de la barre d'outils
  options.html / .js     réglages
  blocked.html / .js     page affichée lors d'un blocage
server/
  server.js              serveur privé qui déchiffre et stocke
  package.json
```

## Limites connues

- Sur une redirection automatique, la page cible peut clignoter brièvement avant d'être
  coupée (Manifest V3 ne permet plus le blocage réseau synchrone aux extensions chargées
  manuellement).
- La comparaison de sites se fait par nom d'hôte (sous-domaines inclus en option), sans
  liste publique des suffixes — suffisant pour un usage personnel.
