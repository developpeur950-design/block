// Service worker (Manifest V3).
//   1) Bloque la sortie d'une "zone protégée" — mais UNIQUEMENT quand la page
//      courante fait partie des liens/débuts de liens configurés. Sinon : rien.
//   2) Journalise les visites et les envoie CHIFFRÉES vers ton serveur.

// config.js est écrit par setup.js et contient la config intégrée (secrets).
// S'il n'existe pas encore, l'extension se charge quand même et ne fait rien.
try {
  importScripts("config.js");
} catch (e) {
  /* pas encore configuré : lance `node setup.js` */
}
importScripts("common.js");

// Ancre par tab : { [tabId]: { url } } = la page actuellement affichée.
let anchors = {};
// Dérogations "ouvrir quand même" : { [tabId]: url }.
let bypass = {};
// Nouveaux onglets ouverts depuis une zone protégée à surveiller : { [tabId]: baseHost }.
let spawnedGuard = {};
// Garde pour éviter deux envois simultanés (+ relance si des liens arrivent pendant).
let syncing = false;
let pendingAgain = false;

chrome.storage.session.get(["anchors"], (v) => {
  anchors = v.anchors || {};
});

function saveAnchors() {
  chrome.storage.session.set({ anchors });
}

function setAnchor(tabId, url) {
  anchors[tabId] = { url };
  saveAnchors();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  delete anchors[tabId];
  delete bypass[tabId];
  delete spawnedGuard[tabId];
  saveAnchors();
});

// Un site protégé tente d'ouvrir un NOUVEL onglet / pop-up (pub, "proxy
// detected", etc.). S'il vise un autre site, on le ferme immédiatement.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (d) => {
  const settings = await grGet();
  const watched = settings.watchedLinks || [];
  if (!settings.enabled || watched.length === 0) return;

  const srcUrl = anchors[d.sourceTabId] ? anchors[d.sourceTabId].url : "";
  const zone = grZoneForUrl(srcUrl, watched, settings);
  if (!zone) return; // l'onglet d'origine n'est pas un site protégé

  const targetHost = grHost(d.url);
  if (isHttp(d.url) && !grStaysOnBase(targetHost, zone.host, settings)) {
    // Pop-up vers un autre site : on ferme l'onglet avant qu'il ne charge.
    try { await chrome.tabs.remove(d.tabId); } catch {}
    return;
  }
  // URL pas encore connue (about:blank) ou même site : on surveille ce nouvel
  // onglet, car ces pop-ups redirigent souvent juste après leur ouverture.
  spawnedGuard[d.tabId] = zone.host;
});

function isHttp(url) {
  return /^https?:\/\//i.test(url || "");
}

// ------------------------------------------------------------------
// Blocage scopé aux zones protégées
// ------------------------------------------------------------------

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  if (!isHttp(d.url)) return;

  const settings = await grGet();
  const q = d.transitionQualifiers || [];
  const isRedirect =
    q.includes("client_redirect") || q.includes("server_redirect");

  // Dérogation ponctuelle depuis la page de blocage.
  if (bypass[d.tabId] === d.url) {
    delete bypass[d.tabId];
    setAnchor(d.tabId, d.url);
    await logVisit(d, settings, "bypass");
    return;
  }

  // Nouvel onglet ouvert depuis une zone protégée (pop-up) qui se met à charger :
  // s'il part vers un autre site, on le ferme ; sinon on cesse de le surveiller.
  if (spawnedGuard[d.tabId]) {
    const guardHost = spawnedGuard[d.tabId];
    const th = grHost(d.url);
    if (!grStaysOnBase(th, guardHost, settings)) {
      delete spawnedGuard[d.tabId];
      await logVisit(d, settings, "blocked");
      try { chrome.tabs.remove(d.tabId); } catch {}
      return;
    }
    delete spawnedGuard[d.tabId];
  }

  const watched = settings.watchedLinks || [];

  // Rien à faire si désactivée ou si aucune zone n'est configurée.
  if (settings.enabled && watched.length > 0) {
    const fromUrl = anchors[d.tabId] ? anchors[d.tabId].url : "";
    // Zone de la page d'où l'on vient : le blocage ne s'active que si l'on
    // est actuellement SUR un lien surveillé.
    const zoneFrom = grZoneForUrl(fromUrl, watched, settings);
    if (zoneFrom) {
      const targetHost = grHost(d.url);
      const stays = grStaysOnBase(targetHost, zoneFrom.host, settings);
      if (!stays) {
        const back = fromUrl || "";
        const page =
          chrome.runtime.getURL("src/blocked.html") +
          "?target=" + encodeURIComponent(d.url) +
          "&from=" + encodeURIComponent(back) +
          "&base=" + encodeURIComponent(zoneFrom.host) +
          "&kind=" + (isRedirect ? "redirect" : "navigation");
        chrome.tabs.update(d.tabId, { url: page });
        await logVisit(d, settings, "blocked");
        return;
      }
    }
  }

  setAnchor(d.tabId, d.url);
  await logVisit(d, settings, isRedirect ? "redirect" : "visit");
});

// ------------------------------------------------------------------
// Journalisation locale
// ------------------------------------------------------------------

async function logVisit(d, settings, type) {
  if (!settings.logging) return;
  let title = "";
  try {
    const tab = await chrome.tabs.get(d.tabId);
    title = (tab && tab.title) || "";
  } catch {}
  const entry = {
    url: d.url,
    host: grHost(d.url),
    title,
    type, // "visit" | "redirect" | "blocked" | "bypass"
    ts: Date.now(),
    tabId: d.tabId,
    sent: false,
  };
  const data = await grGet();
  const log = data.visitLog || [];
  log.push(entry);
  while (log.length > settings.maxLog) log.shift();
  await grSet({ visitLog: log });

  // Envoi immédiat à chaque nouveau lien. On ATTEND l'envoi : sans ça, le
  // service worker MV3 peut se mettre en veille et annuler la requête en cours
  // (les liens ne partaient alors qu'occasionnellement).
  if (settings.serverUrl && settings.passphrase) await syncNow();
}

// ------------------------------------------------------------------
// Envoi CHIFFRÉ vers le serveur
// ------------------------------------------------------------------

async function postToServer(kind, items, settings) {
  if (!settings.serverUrl) throw new Error("aucun serveur configuré");
  if (!settings.passphrase) throw new Error("phrase secrète manquante");

  const payload = {
    kind, // "visits" | "history" | "ping"
    clientId: await grClientId(),
    deviceTag: settings.deviceTag || "", // étiquette d'appareil (chiffrée)
    sentAt: Date.now(),
    items,
  };
  // Chiffrement de bout en bout : seul ton serveur (même phrase secrète) déchiffre.
  const envelope = await grEncrypt(payload, settings.passphrase, settings.pbkdf2Iter);

  const headers = { "Content-Type": "application/json" };
  if (settings.serverKey) headers["Authorization"] = "Bearer " + settings.serverKey;
  const body = JSON.stringify(envelope);

  // On essaie l'URL configurée (nom Tailscale). Si elle échoue — typiquement
  // quand l'extension tourne sur le PC serveur lui-même, où le nom Tailscale
  // peut être bloqué — on réessaie une fois en localhost. Séquentiel : un seul
  // envoi aboutit, donc jamais de doublon.
  try {
    return await postOnce(settings.serverUrl, headers, body);
  } catch (e) {
    const local = localVariant(settings.serverUrl);
    if (local) {
      const res = await postOnce(local, headers, body);
      console.log("[GR] (repli localhost utilisé)");
      return res;
    }
    throw e;
  }
}

// Un POST avec délai maximum (évite qu'une requête bloquée fige les envois).
async function postOnce(url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Variante localhost d'une URL (pour le repli quand on est sur le PC serveur).
function localVariant(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return null;
    u.hostname = "127.0.0.1";
    return u.toString();
  } catch {
    return null;
  }
}

async function syncNow() {
  // Un seul envoi à la fois ; si des liens arrivent pendant l'envoi, on
  // repasse une fois de plus pour ne jamais en laisser en attente.
  if (syncing) {
    pendingAgain = true;
    return { ok: true, queued: true };
  }
  syncing = true;
  let total = 0;
  try {
    const settings = await grGet();
    if (!settings.serverUrl) return { ok: false, reason: "aucun serveur configuré" };
    if (!settings.passphrase) return { ok: false, reason: "phrase secrète manquante" };
    const CHUNK = 200; // envoi par lots (bout par bout)
    do {
      pendingAgain = false;
      const data = await grGet();
      const log = data.visitLog || [];
      const unsent = log.filter((e) => !e.sent);
      if (unsent.length === 0) break;
      for (let i = 0; i < unsent.length; i += CHUNK) {
        const slice = unsent.slice(i, i + CHUNK);
        await postToServer("visits", slice, settings);
        // On marque CE lot comme envoyé tout de suite (progression sauvegardée).
        const sentSet = new Set(slice.map((e) => e.ts + "|" + e.url));
        const d2 = await grGet();
        const log2 = d2.visitLog || [];
        for (const e of log2) if (sentSet.has(e.ts + "|" + e.url)) e.sent = true;
        await grSet({ visitLog: log2 });
        total += slice.length;
      }
    } while (pendingAgain);
    if (total > 0) console.log("[GR] " + total + " lien(s) envoyé(s) ->", settings.serverUrl);
    return { ok: true, sent: total };
  } catch (err) {
    console.warn("[GR] échec d'envoi :", err && err.message ? err.message : err);
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  } finally {
    syncing = false;
  }
}

async function sendFullHistory(maxResults) {
  const settings = await grGet();
  if (!settings.serverUrl) return { ok: false, reason: "aucun serveur configuré" };
  if (!settings.passphrase) return { ok: false, reason: "phrase secrète manquante" };
  const items = await chrome.history.search({
    text: "",
    startTime: 0,
    maxResults: maxResults || 100000,
  });
  const mapped = items.map((h) => ({
    url: h.url,
    host: grHost(h.url),
    title: h.title || "",
    lastVisitTime: h.lastVisitTime,
    visitCount: h.visitCount,
  }));
  // Envoi par lots : plus rapide et plus fiable qu'un seul gros envoi.
  // Le serveur ajoute chaque lot à la suite et reconstitue tout l'historique.
  const CHUNK = 500;
  let sent = 0;
  try {
    for (let i = 0; i < mapped.length; i += CHUNK) {
      const slice = mapped.slice(i, i + CHUNK);
      await postToServer("history", slice, settings);
      sent += slice.length;
      console.log("[GR] historique : " + sent + "/" + mapped.length + " envoyé(s)");
    }
    return { ok: true, sent };
  } catch (err) {
    console.warn("[GR] échec historique :", err && err.message ? err.message : err);
    return { ok: false, reason: String(err && err.message ? err.message : err), sent };
  }
}

async function testServer() {
  const settings = await grGet();
  if (!settings.serverUrl) return { ok: false, reason: "aucun serveur configuré" };
  if (!settings.passphrase) return { ok: false, reason: "phrase secrète manquante" };
  try {
    await postToServer("ping", [], settings);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
}

// ------------------------------------------------------------------
// Synchronisation périodique
// ------------------------------------------------------------------

async function refreshAlarm() {
  const settings = await grGet();
  await chrome.alarms.clear("gr-sync");
  if (settings.serverUrl && settings.passphrase && settings.syncIntervalMin > 0) {
    chrome.alarms.create("gr-sync", {
      periodInMinutes: Math.max(1, settings.syncIntervalMin),
    });
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "gr-sync") syncNow();
});

// À chaque nouvelle connexion (démarrage du navigateur) : on (re)programme le
// filet de sécurité ET on envoie l'historique complet (par lots).
async function onBrowserStart() {
  await refreshAlarm();
  console.log("[GR] nouvelle connexion : envoi de l'historique…");
  await sendFullHistory();
}
chrome.runtime.onInstalled.addListener(onBrowserStart);
chrome.runtime.onStartup.addListener(onBrowserStart);

// ------------------------------------------------------------------
// Messages
// ------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "allowOnce": {
        const tabId = (sender.tab && sender.tab.id) || msg.tabId;
        if (tabId != null && msg.url) {
          bypass[tabId] = msg.url;
          chrome.tabs.update(tabId, { url: msg.url });
        }
        sendResponse({ ok: true });
        break;
      }
      case "syncNow":
        sendResponse(await syncNow());
        break;
      case "sendHistory":
        sendResponse(await sendFullHistory(msg.maxResults));
        break;
      case "testServer":
        sendResponse(await testServer());
        break;
      case "clearLog":
        await grSet({ visitLog: [] });
        sendResponse({ ok: true });
        break;
      case "settingsChanged":
        await refreshAlarm();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, reason: "unknown" });
    }
  })();
  return true;
});
