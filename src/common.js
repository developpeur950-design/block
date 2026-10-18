// Paramètres partagés par le service worker, le popup et la page d'options.
// Chargé via importScripts() dans le service worker et via <script> dans les pages.

// Valeurs par défaut. Tout est modifiable dans la page d'options.
const GR_DEFAULTS = {
  enabled: true, // extension active ou non
  mode: "redirects", // "redirects" | "same-domain" | "allowlist"
  includeSubdomains: true, // considérer les sous-domaines comme le même site
  allowlist: [], // domaines toujours autorisés (ex: "paypal.com")
  logging: true, // journaliser les visites
  serverUrl: "", // TON serveur (POST JSON). Vide = tout reste en local.
  serverKey: "", // jeton optionnel envoyé en en-tête Authorization: Bearer ...
  syncIntervalMin: 5, // fréquence d'envoi automatique au serveur (minutes)
  maxLog: 2000, // nombre maximum d'entrées conservées localement
};

// Lit tout le stockage local et complète avec les valeurs par défaut.
function grGet() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (v) => resolve({ ...GR_DEFAULTS, ...v }));
  });
}

// Écrit un objet de clés/valeurs dans le stockage local.
function grSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

// Identifiant aléatoire et stable de ce navigateur (utile côté serveur
// si tu synchronises depuis plusieurs machines). Généré une seule fois.
async function grClientId() {
  const data = await grGet();
  if (data.clientId) return data.clientId;
  const id =
    (crypto.randomUUID && crypto.randomUUID()) ||
    "gr-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  await grSet({ clientId: id });
  return id;
}

// Normalise une URL en nom d'hôte (sans le "www.").
function grHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Décide si un hôte cible est autorisé par rapport à l'hôte "ancre" du tab.
function grHostAllowed(targetHost, anchorHost, settings) {
  if (!targetHost) return true;
  if (!anchorHost) return true; // pas encore d'ancre: on laisse passer
  if (targetHost === anchorHost) return true;
  if (settings.includeSubdomains) {
    if (targetHost.endsWith("." + anchorHost)) return true; // sous-domaine
    if (anchorHost.endsWith("." + targetHost)) return true; // domaine parent
  }
  return grInAllowlist(targetHost, settings.allowlist);
}

// Vrai si l'hôte correspond à un domaine de la liste blanche (ou un sous-domaine).
function grInAllowlist(host, allowlist) {
  return (allowlist || []).some(
    (d) => d && (host === d || host.endsWith("." + d))
  );
}

// Expose les fonctions dans le scope global du service worker.
if (typeof self !== "undefined") {
  self.GR_DEFAULTS = GR_DEFAULTS;
  self.grGet = grGet;
  self.grSet = grSet;
  self.grClientId = grClientId;
  self.grHost = grHost;
  self.grHostAllowed = grHostAllowed;
  self.grInAllowlist = grInAllowlist;
}
