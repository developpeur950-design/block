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

// Un fichier séparé PAR APPAREIL.
//   <appareil>.visits.ndjson   et   <appareil>.history.ndjson
function safe(name) {
  return (
    String(name || "inconnu").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 60) ||
    "inconnu"
  );
}
function deviceOf(payload) {
  const tag = payload && payload.deviceTag && String(payload.deviceTag).trim();
  return tag || (payload && payload.clientId) || "inconnu";
}
function visitsFile(device) {
  return path.join(DATA_DIR, safe(device) + ".visits.ndjson");
}
function historyFile(device) {
  return path.join(DATA_DIR, safe(device) + ".history.ndjson");
}

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
      const device = deviceOf(payload);
      const meta = { clientId: payload.clientId, deviceTag: payload.deviceTag };
      let saved = 0;
      if (payload.kind === "visits") saved = appendItems(visitsFile(device), payload.items, meta);
      else if (payload.kind === "history") saved = appendItems(historyFile(device), payload.items, meta);
      // "ping" : rien à stocker, mais le déchiffrement a réussi => clé OK.
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, kind: payload.kind, saved }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  // Réception uniquement : aucune autre route. On ne montre/renvoie rien.
  // (page vide pour un visiteur qui tomberait sur l'adresse du serveur)
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log("Garde-Redirections — serveur de RÉCEPTION (privé, chiffré)");
  console.log("  Écoute        : http://" + HOST + ":" + PORT);
  console.log("  Endpoint POST : http://" + HOST + ":" + PORT + "/collect  (réception seule)");
  console.log("  Données       : " + DATA_DIR + "  (un fichier .ndjson par appareil)");
  console.log("  Jeton Bearer  : " + (SERVER_KEY ? "oui" : "non"));
  console.log("  Chiffrement   : AES-256-GCM (PASSPHRASE requise)");
  console.log("  Aucune page web : visiter l'adresse ne montre rien.");
});
