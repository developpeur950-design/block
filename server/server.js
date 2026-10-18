#!/usr/bin/env node
// Serveur de collecte pour l'extension Garde-Redirections.
// Aucune dépendance externe. Node.js 18+ (Web Crypto intégré).
//
// Confidentialité :
//   - N'écoute que sur 127.0.0.1 par défaut (HOST) => injoignable depuis le réseau.
//   - N'accepte QUE les messages chiffrés qu'il peut déchiffrer avec PASSPHRASE
//     (chiffrement de bout en bout AES-256-GCM). C'est le vrai verrou d'accès.
//   - Jeton Bearer optionnel en seconde couche (SERVER_KEY).
//
// Variables d'environnement :
//   PASSPHRASE  (OBLIGATOIRE) phrase secrète identique à celle de l'extension
//   PORT        port d'écoute               (défaut : 8787)
//   HOST        interface d'écoute          (défaut : 127.0.0.1)
//   SERVER_KEY  jeton Bearer attendu        (optionnel)
//   DATA_DIR    dossier de stockage         (défaut : ./server/data)
//
// Démarrage :  PASSPHRASE="ma phrase secrète" node server/server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const { subtle } = globalThis.crypto;

// Configuration écrite par setup.js (server/config.json) sur ton PC.
// Les variables d'environnement, si présentes, l'emportent.
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
} catch {}

const PORT = parseInt(process.env.PORT, 10) || cfg.port || 8787;
const HOST = process.env.HOST || cfg.host || "127.0.0.1";
const SERVER_KEY = process.env.SERVER_KEY || cfg.serverKey || "";
const PASSPHRASE = process.env.PASSPHRASE || cfg.passphrase || "";
const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR
  : cfg.dataDir
  ? path.resolve(__dirname, cfg.dataDir)
  : path.join(__dirname, "data");

if (!PASSPHRASE) {
  console.error(
    "ERREUR : aucune phrase secrète.\n" +
      "Lance d'abord la configuration sur ton PC :  node setup.js\n" +
      'Ou fournis-la à la main :  PASSPHRASE="ma phrase secrète" node server/server.js'
  );
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const VISITS_FILE = path.join(DATA_DIR, "visits.ndjson");
const HISTORY_FILE = path.join(DATA_DIR, "history.ndjson");

// --- Déchiffrement (miroir de grEncrypt côté extension) --------------

async function deriveKey(passphrase, salt, iter) {
  const base = await subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

async function decryptEnvelope(env) {
  if (!env || env.alg !== "AES-GCM" || !env.ct || !env.iv || !env.salt) {
    throw new Error("enveloppe invalide");
  }
  const salt = Buffer.from(env.salt, "base64");
  const iv = Buffer.from(env.iv, "base64");
  const ct = Buffer.from(env.ct, "base64");
  const key = await deriveKey(PASSPHRASE, salt, env.iter || 150000);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(Buffer.from(pt).toString("utf8"));
}

// --- Stockage --------------------------------------------------------

function appendItems(file, items, meta) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const lines = items
    .map((it) =>
      JSON.stringify({
        ...it,
        deviceTag: meta.deviceTag || "",
        clientId: meta.clientId || "inconnu",
        receivedAt: Date.now(),
      })
    )
    .join("\n");
  fs.appendFileSync(file, lines + "\n");
  return items.length;
}

function tailJson(file, limit, device) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  let rows = text
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (device) rows = rows.filter((r) => (r.deviceTag || "") === device);
  return rows.slice(Math.max(0, rows.length - limit)).reverse();
}

function esc(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// --- HTTP ------------------------------------------------------------

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function authorized(req) {
  if (!SERVER_KEY) return true;
  return (req.headers["authorization"] || "") === "Bearer " + SERVER_KEY;
}

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

function dashboard(device) {
  const visits = tailJson(VISITS_FILE, 500, device);
  const devices = new Set();
  tailJson(VISITS_FILE, 5000).forEach((v) => devices.add(v.deviceTag || ""));
  const opts = ["", ...[...devices].filter((d) => d && d !== "")]
    .map(
      (d) =>
        `<option value="${esc(d)}"${d === device ? " selected" : ""}>${
          d ? esc(d) : "tous les appareils"
        }</option>`
    )
    .join("");
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
        "<tr><td>" + esc(when) +
        "</td><td>" + esc(v.deviceTag || "—") +
        "</td><td>" + esc(v.host) +
        '</td><td class=ttl title="' + esc(v.url) + '">' + esc(v.title || v.url) +
        "</td><td>" + tag + "</td></tr>"
      );
    })
    .join("");
  return `<!DOCTYPE html><html lang=fr><head><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>Garde-Redirections — collecte</title>
<style>
  :root{color-scheme:light dark}
  body{font:14px/1.5 system-ui,sans-serif;max-width:1000px;margin:0 auto;padding:20px}
  h1{font-size:18px} form{margin:10px 0}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #8884;font-size:13px}
  td.ttl{max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .t{font-size:11px;border:1px solid #8886;border-radius:10px;padding:1px 6px}
  .t.b{color:#dc2626;border-color:#dc2626}
  .muted{color:#888}
</style></head><body>
<h1>Garde-Redirections — dernières visites (déchiffrées localement)</h1>
<form method=get>Appareil : <select name=device onchange="this.form.submit()">${opts}</select></form>
<p class=muted>${visits.length} entrée(s). Données : <code>${esc(VISITS_FILE)}</code></p>
<table><thead><tr><th>Date</th><th>Appareil</th><th>Site</th><th>Titre / URL</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan=5 class=muted>Rien encore.</td></tr>'}</tbody></table>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/collect") {
    if (!authorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "non autorisé" }));
    }
    try {
      const envelope = await readBody(req);
      let payload;
      try {
        payload = await decryptEnvelope(envelope); // verrou de confidentialité
      } catch {
        // Déchiffrement impossible = mauvaise phrase secrète ou intrus : on rejette.
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "déchiffrement impossible" }));
      }
      const meta = { clientId: payload.clientId, deviceTag: payload.deviceTag };
      let saved = 0;
      if (payload.kind === "visits") saved = appendItems(VISITS_FILE, payload.items, meta);
      else if (payload.kind === "history") saved = appendItems(HISTORY_FILE, payload.items, meta);
      // "ping" : rien à stocker, mais le déchiffrement a réussi => clé OK.
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, kind: payload.kind, saved }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  if (req.method === "GET" && url.pathname === "/api/visits") {
    const limit = Math.min(5000, parseInt(url.searchParams.get("limit"), 10) || 500);
    const device = url.searchParams.get("device") || "";
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(tailJson(VISITS_FILE, limit, device)));
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(dashboard(url.searchParams.get("device") || ""));
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "introuvable" }));
});

server.listen(PORT, HOST, () => {
  console.log("Garde-Redirections — serveur de collecte (privé, chiffré)");
  console.log("  Écoute         : http://" + HOST + ":" + PORT);
  console.log("  Endpoint POST  : http://" + HOST + ":" + PORT + "/collect");
  console.log("  Tableau de bord: http://" + HOST + ":" + PORT + "/");
  console.log("  Données        : " + DATA_DIR);
  console.log("  Jeton Bearer   : " + (SERVER_KEY ? "oui" : "non"));
  console.log("  Chiffrement    : AES-256-GCM (PASSPHRASE requise)");
});
