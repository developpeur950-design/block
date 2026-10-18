#!/usr/bin/env node
// Configuration en une commande, à lancer UNE FOIS sur TON PC.
//
//   node setup.js
//   node setup.js --watch ma-banque.fr --watch mon-autre-site.fr
//
// Ce script :
//   1. détecte ton serveur Tailscale (IP + nom MagicDNS) ;
//   2. génère (ou réutilise) une phrase secrète et un jeton Bearer ;
//   3. écrit la config du serveur  -> server/config.json ;
//   4. écrit la config de l'extension -> src/config.js (intégrée).
//
// Ensuite : lance le serveur (node server/server.js) et charge l'extension.
// Rien d'autre à configurer : l'extension contient déjà tout.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

// --- arguments -------------------------------------------------------
const args = process.argv.slice(2);
function takeAll(flag) {
  const out = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === flag && args[i + 1]) out.push(args[++i]);
  return out;
}
function takeOne(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const PORT = parseInt(takeOne("--port", "8787"), 10);
const WATCH = takeAll("--watch");
const ROTATE = args.includes("--rotate"); // régénère les secrets
const URL_OVERRIDE = takeOne("--url", "");
const HOST_OVERRIDE = takeOne("--host", "");

// --- détection Tailscale --------------------------------------------
function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}
function tailscale() {
  let ip = "";
  let dns = "";
  const ipout = sh("tailscale ip -4");
  if (ipout) ip = ipout.split(/\s+/)[0];
  const js = sh("tailscale status --json");
  if (js) {
    try {
      const s = JSON.parse(js);
      if (s.Self && s.Self.DNSName) dns = s.Self.DNSName.replace(/\.$/, "");
      if (!ip && s.Self && s.Self.TailscaleIPs && s.Self.TailscaleIPs.length) {
        ip = s.Self.TailscaleIPs.find((a) => a.includes(".")) || s.Self.TailscaleIPs[0];
      }
    } catch {}
  }
  return { ip, dns };
}

const ts = tailscale();
if (!ts.ip && !ts.dns && !URL_OVERRIDE) {
  console.warn(
    "⚠️  Tailscale introuvable (commande `tailscale` indisponible).\n" +
      "   Installe Tailscale (https://tailscale.com/download) et connecte-toi,\n" +
      "   puis relance `node setup.js`. Je continue avec 127.0.0.1 en attendant.\n"
  );
}

// Interface d'écoute : l'IP Tailscale (privée, pas exposée au LAN) si dispo.
const host = HOST_OVERRIDE || ts.ip || "127.0.0.1";
// URL que l'extension appellera : priorité au nom MagicDNS.
const base =
  URL_OVERRIDE ||
  (ts.dns
    ? `http://${ts.dns}:${PORT}`
    : ts.ip
    ? `http://${ts.ip}:${PORT}`
    : `http://localhost:${PORT}`);
const serverUrl = URL_OVERRIDE || base + "/collect";

// --- secrets (réutilisés si déjà présents, sauf --rotate) ------------
const serverCfgPath = path.join(__dirname, "server", "config.json");
let prev = {};
try {
  prev = JSON.parse(fs.readFileSync(serverCfgPath, "utf8"));
} catch {}

const passphrase =
  !ROTATE && prev.passphrase ? prev.passphrase : crypto.randomBytes(32).toString("base64url");
const serverKey =
  !ROTATE && prev.serverKey ? prev.serverKey : crypto.randomBytes(24).toString("hex");
const deviceTag = os.hostname();

// --- écriture serveur ------------------------------------------------
const serverCfg = { port: PORT, host, serverKey, passphrase, dataDir: "./data" };
fs.mkdirSync(path.dirname(serverCfgPath), { recursive: true });
fs.writeFileSync(serverCfgPath, JSON.stringify(serverCfg, null, 2) + "\n");

// --- écriture extension ---------------------------------------------
const extCfg = { serverUrl, passphrase, serverKey, deviceTag, watchedLinks: WATCH };
const extCfgPath = path.join(__dirname, "src", "config.js");
const extContent =
  "// Configuration INTÉGRÉE à l'extension — écrite par setup.js le " +
  new Date().toISOString() +
  ".\n" +
  "// Ne pas committer : contient tes secrets.\n" +
  "var GR_BAKED = " +
  JSON.stringify(extCfg, null, 2) +
  ";\n\nif (typeof self !== \"undefined\") self.GR_BAKED = GR_BAKED;\n";
fs.writeFileSync(extCfgPath, extContent);

// --- récap -----------------------------------------------------------
console.log("✅ Configuration terminée.\n");
console.log("  Serveur Tailscale");
console.log("    écoute sur   : " + host + ":" + PORT + (ts.ip ? "  (IP Tailscale)" : ""));
console.log("    URL extension: " + serverUrl);
console.log("    MagicDNS     : " + (ts.dns || "(non détecté)"));
console.log("    jeton Bearer : " + serverKey);
console.log("    appareil     : " + deviceTag);
console.log("    sites protégés: " + (WATCH.length ? WATCH.join(", ") : "(aucun — à ajouter dans les Options)"));
console.log("\n  Fichiers écrits");
console.log("    " + serverCfgPath + "  (config serveur + secrets)");
console.log("    " + extCfgPath + "  (config intégrée à l'extension)");
console.log("\n  Étapes suivantes");
console.log("    1) Démarre le serveur :  node server/server.js");
console.log("    2) Charge l'extension (dossier racine) dans Chrome/Edge/Opera.");
console.log("       Elle est déjà configurée : rien à saisir.");
if (!ts.ip && !ts.dns && !URL_OVERRIDE)
  console.log("\n  ⚠️  Pense à installer Tailscale puis relance `node setup.js`.");
