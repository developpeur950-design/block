#!/usr/bin/env node
// Serveur de collecte pour l'extension Garde-Redirections.
// Aucune dépendance externe : uniquement les modules intégrés de Node.js.
//
// Démarrage :   node server/server.js
// Configuration par variables d'environnement :
//   PORT        port d'écoute               (défaut : 8787)
//   SERVER_KEY  jeton attendu (optionnel)   -> doit correspondre au jeton de l'extension
//   DATA_DIR    dossier de stockage          (défaut : ./server/data)
//
// L'extension doit pointer vers :  http://localhost:8787/collect
// (ou l'URL publique de ta machine).

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT, 10) || 8787;
const SERVER_KEY = process.env.SERVER_KEY || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

fs.mkdirSync(DATA_DIR, { recursive: true });

const VISITS_FILE = path.join(DATA_DIR, "visits.ndjson");
const HISTORY_FILE = path.join(DATA_DIR, "history.ndjson");

// En-têtes CORS (permet à l'extension d'envoyer depuis n'importe quelle page).
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Vérifie le jeton si SERVER_KEY est défini.
function authorized(req) {
  if (!SERVER_KEY) return true;
  const h = req.headers["authorization"] || "";
  return h === "Bearer " + SERVER_KEY;
}

// Lit le corps JSON d'une requête (limité à 25 Mo).
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) {
        reject(new Error("corps trop volumineux"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Ajoute des lignes NDJSON dans un fichier.
function appendItems(file, items, meta) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const lines = items
    .map((it) => JSON.stringify({ ...it, clientId: meta.clientId, receivedAt: Date.now() }))
    .join("\n");
  fs.appendFileSync(file, lines + "\n");
  return items.length;
}

// Renvoie les N dernières lignes d'un fichier NDJSON, parsées.
function tailJson(file, limit) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  const lines = text.split("\n");
  const slice = lines.slice(Math.max(0, lines.length - limit));
  return slice
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// Petit tableau de bord HTML.
function dashboard() {
  const visits = tailJson(VISITS_FILE, 500);
  const rows = visits
    .map((v) => {
      const when = new Date(v.ts || v.receivedAt).toLocaleString();
      const tag =
        v.type === "blocked"
          ? '<span class="t b">bloqué</span>'
          : v.type === "redirect"
          ? '<span class="t">redirection</span>'
          : "";
      return (
        "<tr><td>" +
        esc(when) +
        "</td><td>" +
        esc(v.host) +
        "</td><td class=ttl title=\"" +
        esc(v.url) +
        '">' +
        esc(v.title || v.url) +
        "</td><td>" +
        tag +
        "</td></tr>"
      );
    })
    .join("");
  return `<!DOCTYPE html><html lang=fr><head><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>Garde-Redirections — collecte</title>
<style>
  :root{color-scheme:light dark}
  body{font:14px/1.5 system-ui,sans-serif;max-width:1000px;margin:0 auto;padding:20px}
  h1{font-size:18px}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #8884;font-size:13px}
  td.ttl{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .t{font-size:11px;border:1px solid #8886;border-radius:10px;padding:1px 6px}
  .t.b{color:#dc2626;border-color:#dc2626}
  .muted{color:#888}
</style></head><body>
<h1>Garde-Redirections — dernières visites reçues</h1>
<p class=muted>${visits.length} entrée(s) affichée(s). Données brutes : <code>${esc(
    VISITS_FILE
  )}</code></p>
<table><thead><tr><th>Date</th><th>Site</th><th>Titre / URL</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan=4 class=muted>Rien encore.</td></tr>'}</tbody></table>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, "http://localhost");

  // Réception des données depuis l'extension.
  if (req.method === "POST" && url.pathname === "/collect") {
    if (!authorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "non autorisé" }));
    }
    try {
      const body = await readBody(req);
      const meta = { clientId: body.clientId || "inconnu" };
      let saved = 0;
      if (body.kind === "visits") saved = appendItems(VISITS_FILE, body.items, meta);
      else if (body.kind === "history") saved = appendItems(HISTORY_FILE, body.items, meta);
      // "ping" ne stocke rien.
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, kind: body.kind, saved }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  // API JSON pour consulter les visites.
  if (req.method === "GET" && url.pathname === "/api/visits") {
    const limit = Math.min(5000, parseInt(url.searchParams.get("limit"), 10) || 500);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(tailJson(VISITS_FILE, limit)));
  }

  // Tableau de bord.
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(dashboard());
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "introuvable" }));
});

server.listen(PORT, () => {
  console.log("Garde-Redirections — serveur de collecte");
  console.log("  Écoute        : http://localhost:" + PORT);
  console.log("  Endpoint POST : http://localhost:" + PORT + "/collect");
  console.log("  Tableau de bord: http://localhost:" + PORT + "/");
  console.log("  Données       : " + DATA_DIR);
  console.log("  Jeton requis  : " + (SERVER_KEY ? "oui" : "non"));
});
