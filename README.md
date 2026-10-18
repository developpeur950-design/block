# Garde-Redirections

Extension de navigateur (**Chrome, Edge, Opera** — Manifest V3) + petit serveur, **pour un usage personnel sur ton propre navigateur**.

Elle fait deux choses :

1. **Bloque les redirections** qui quittent le site sur lequel tu te trouves (anti-phishing / « rester sur le site »).
2. **Journalise les sites que tu visites** et peut les envoyer vers **ton propre serveur** (URL que tu renseignes toi-même).

> ⚠️ Cet outil enregistre un historique de navigation. Ne l'installe que sur **tes** navigateurs, pour **tes** données, vers **ton** serveur. Installer ce type d'outil sur l'appareil de quelqu'un d'autre à son insu est illégal dans la plupart des pays.

---

## 1. Installer l'extension

L'extension se trouve à la racine du dépôt (`manifest.json` + dossier `src/`).

### Chrome / Edge / Opera
1. Ouvre la page des extensions :
   - Chrome : `chrome://extensions`
   - Edge : `edge://extensions`
   - Opera : `opera://extensions`
2. Active le **Mode développeur** (interrupteur en haut à droite).
3. Clique **« Charger l'extension non empaquetée »** (*Load unpacked*).
4. Sélectionne le dossier **racine du dépôt** (celui qui contient `manifest.json`).

L'icône apparaît dans la barre d'outils. Clique dessus pour voir le journal et accéder aux **Options**.

---

## 2. Choisir la règle de blocage (Options)

| Mode | Effet |
|------|-------|
| **Redirections** (défaut) | Laisse passer tes clics et tes saisies d'URL, mais bloque les **redirections automatiques** (JavaScript, `meta refresh`, redirection serveur) vers un autre domaine. |
| **Rester sur le site** | Bloque **toute** sortie du domaine courant, y compris les clics sur des liens externes. |
| **Liste blanche** | N'autorise **que** les domaines que tu as listés. |

- **Sous-domaines** : option pour considérer `a.site.com` et `b.site.com` comme le même site.
- **Liste blanche** : domaines toujours autorisés (un par ligne), quel que soit le mode.

Quand une redirection est bloquée, une page s'affiche avec deux boutons : **Retour au site** ou **Ouvrir quand même** (dérogation ponctuelle).

---

## 3. Lancer ton serveur

Le serveur n'a **aucune dépendance** (Node.js 18+ suffit).

```bash
cd server
node server.js
```

Par défaut il écoute sur `http://localhost:8787` :

- `POST /collect` — endpoint que l'extension appelle.
- `GET /` — tableau de bord pour consulter tes visites.
- `GET /api/visits?limit=500` — les données en JSON.

### Options du serveur (variables d'environnement)

```bash
PORT=8787            # port d'écoute
SERVER_KEY=secret123 # jeton exigé (optionnel mais recommandé)
DATA_DIR=./data      # où stocker les fichiers
```

Exemple avec un jeton :

```bash
SERVER_KEY=secret123 node server/server.js
```

Les données sont stockées en **NDJSON** (une ligne JSON par entrée) :
- `server/data/visits.ndjson` — visites envoyées en continu.
- `server/data/history.ndjson` — envoi manuel de tout l'historique.

Ce dossier est ignoré par git (voir `.gitignore`).

---

## 4. Relier l'extension au serveur

Dans les **Options** de l'extension :

1. **URL de ton serveur** : `http://localhost:8787/collect`
2. **Jeton** : la même valeur que `SERVER_KEY` (si tu en as mis un).
3. **Envoi automatique** : intervalle en minutes (`0` = manuel uniquement).
4. Clique **Tester le serveur** → tu dois voir « Serveur joignable ✔ ».

- Le bouton **Envoyer au serveur** (popup) pousse les visites en attente.
- Le bouton **Envoyer tout l'historique maintenant** (options) envoie l'intégralité de l'historique du navigateur.

Si l'URL du serveur est vide, **rien n'est envoyé** : tout reste dans le navigateur, consultable depuis le popup.

---

## Données collectées

Pour chaque visite : URL, nom d'hôte, titre de la page, type (`visit` / `redirect` / `blocked`), horodatage, identifiant du navigateur.
L'envoi « historique complet » ajoute `lastVisitTime` et `visitCount` fournis par le navigateur.

## Structure

```
manifest.json          Manifest MV3
src/
  common.js            paramètres + utilitaires partagés
  background.js        service worker (blocage + journal + envoi)
  popup.html / .js     fenêtre de la barre d'outils
  options.html / .js   réglages
  blocked.html / .js   page affichée lors d'un blocage
server/
  server.js            serveur de collecte Node.js
  package.json
```

## Limites connues

- Sur une redirection automatique, la page cible peut commencer à se charger très brièvement avant d'être interrompue (limitation de Manifest V3, qui ne permet plus le blocage réseau synchrone aux extensions chargées manuellement).
- La comparaison de domaines se fait par nom d'hôte (`site.com`, sous-domaines inclus en option), sans liste publique des suffixes — suffisant pour un usage personnel.
