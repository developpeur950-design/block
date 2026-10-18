// Paramètres partagés par le service worker, le popup et la page d'options.
// Chargé via importScripts() dans le service worker et via <script> dans les pages.

// Valeurs par défaut.
//
// IMPORTANT : par défaut, "watchedLinks" est vide => l'extension ne bloque RIEN.
// Le blocage ne s'active que sur les liens/débuts de liens que tu ajoutes.
const GR_DEFAULTS = {
  enabled: true, // interrupteur général
  watchedLinks: [], // liens ou débuts de liens à protéger (un par entrée). Vide = ne fait rien.
  includeSubdomains: true, // considérer les sous-domaines comme le même site de base
  allowlist: [], // domaines toujours autorisés, même à l'intérieur d'une zone protégée
  logging: true, // journaliser les visites
  serverUrl: "", // TON serveur (POST). Vide = tout reste en local.
  serverKey: "", // jeton optionnel (en-tête Authorization: Bearer ...)
  passphrase: "", // phrase secrète du chiffrement de bout en bout (obligatoire pour envoyer)
  deviceTag: "", // étiquette de cet appareil (ex: "PC bureau", "portable")
  syncIntervalMin: 5, // envoi automatique (minutes). 0 = manuel.
  maxLog: 2000, // nombre maximum d'entrées conservées localement
  pbkdf2Iter: 150000, // itérations de dérivation de clé
};

function grGet() {
  // Ordre de priorité : valeurs par défaut < config intégrée (GR_BAKED, écrite
  // par setup.js sur ton PC) < réglages enregistrés par l'utilisateur.
  const baked = (typeof self !== "undefined" && self.GR_BAKED) || {};
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (v) => resolve({ ...GR_DEFAULTS, ...baked, ...v }));
  });
}

function grSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

// Identifiant aléatoire stable de ce navigateur (généré une fois).
async function grClientId() {
  const data = await grGet();
  if (data.clientId) return data.clientId;
  const id =
    (crypto.randomUUID && crypto.randomUUID()) ||
    "gr-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  await grSet({ clientId: id });
  return id;
}

function grHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// --- Zones protégées -------------------------------------------------
// Une "zone" est définie par une entrée watchedLinks : soit un domaine
// ("ma-banque.fr"), soit un début de lien ("https://ma-banque.fr/compte").

function grParseZone(entry) {
  // On ne retient QUE le site de base (host). Un éventuel chemin collé
  // (https://mon-site.fr/compte) est ignoré : c'est tout le site qui est protégé.
  let e = (entry || "").trim();
  if (!e) return null;
  let rest = e.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const slash = rest.indexOf("/");
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  if (!host) return null;
  return { raw: e, host };
}

function grUrlParts(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname.replace(/^www\./, "").toLowerCase(),
      path: u.pathname + u.search,
    };
  } catch {
    return null;
  }
}

// La page "url" fait-elle partie de la zone décrite par "zone" ?
// (comparaison uniquement sur le site de base, chemin ignoré)
function grMatchZone(url, zone, settings) {
  const p = grUrlParts(url);
  if (!p || !zone) return false;
  return (
    p.host === zone.host ||
    (settings.includeSubdomains && p.host.endsWith("." + zone.host))
  );
}

// Renvoie la zone qui contient cette URL, ou null.
function grZoneForUrl(url, watchedLinks, settings) {
  for (const raw of watchedLinks || []) {
    const z = grParseZone(raw);
    if (z && grMatchZone(url, z, settings)) return z;
  }
  return null;
}

// L'hôte cible reste-t-il sur le site de base (même host, sous-domaine, ou liste blanche) ?
function grStaysOnBase(targetHost, baseHost, settings) {
  if (!targetHost) return true;
  if (targetHost === baseHost) return true;
  if (settings.includeSubdomains) {
    if (targetHost.endsWith("." + baseHost)) return true;
    if (baseHost.endsWith("." + targetHost)) return true;
  }
  return (settings.allowlist || []).some(
    (d) => d && (targetHost === d || targetHost.endsWith("." + d))
  );
}

// --- Chiffrement de bout en bout (AES-256-GCM / PBKDF2-SHA256) --------

function grB64(bytes) {
  const a = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}

async function grDeriveKey(passphrase, salt, iter, usages) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

// Chiffre un objet -> enveloppe JSON transportable.
async function grEncrypt(obj, passphrase, iter) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await grDeriveKey(passphrase, salt, iter, ["encrypt"]);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(JSON.stringify(obj))
  );
  return {
    v: 1,
    alg: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iter,
    salt: grB64(salt),
    iv: grB64(iv),
    ct: grB64(ct),
  };
}

if (typeof self !== "undefined") {
  Object.assign(self, {
    GR_DEFAULTS,
    grGet,
    grSet,
    grClientId,
    grHost,
    grParseZone,
    grUrlParts,
    grMatchZone,
    grZoneForUrl,
    grStaysOnBase,
    grEncrypt,
  });
}
