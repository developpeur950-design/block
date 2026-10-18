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
  saveAnchors();
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

  const res = await fetch(settings.serverUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res;
}

async function syncNow() {
  const settings = await grGet();
  if (!settings.serverUrl) return { ok: false, reason: "aucun serveur configuré" };
  if (!settings.passphrase) return { ok: false, reason: "phrase secrète manquante" };
  const data = await grGet();
  const log = data.visitLog || [];
  const unsent = log.filter((e) => !e.sent);
  if (unsent.length === 0) return { ok: true, sent: 0 };
  try {
    await postToServer("visits", unsent, settings);
    const sentSet = new Set(unsent.map((e) => e.ts + "|" + e.url));
    for (const e of log) if (sentSet.has(e.ts + "|" + e.url)) e.sent = true;
    await grSet({ visitLog: log });
    return { ok: true, sent: unsent.length };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
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
  try {
    await postToServer("history", mapped, settings);
    return { ok: true, sent: mapped.length };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
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
chrome.runtime.onInstalled.addListener(refreshAlarm);
chrome.runtime.onStartup.addListener(refreshAlarm);

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
