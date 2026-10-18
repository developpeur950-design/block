// Service worker (Manifest V3).
// Deux rôles :
//   1) Bloquer les redirections qui quittent le site courant.
//   2) Journaliser les visites et les envoyer vers TON serveur.

importScripts("common.js");

// Ancre par tab : { [tabId]: { host, url } }. L'ancre est le "site courant".
let anchors = {};
// Dérogations "ouvrir quand même" en attente : { [tabId]: url }.
let bypass = {};

// Recharge l'état volatile après un redémarrage du service worker.
chrome.storage.session.get(["anchors"], (v) => {
  anchors = v.anchors || {};
});

function saveAnchors() {
  chrome.storage.session.set({ anchors });
}

function setAnchor(tabId, url) {
  const host = grHost(url);
  if (!host) return;
  anchors[tabId] = { host, url };
  saveAnchors();
}

// Nettoyage quand un tab se ferme.
chrome.tabs.onRemoved.addListener((tabId) => {
  delete anchors[tabId];
  delete bypass[tabId];
  saveAnchors();
});

// ------------------------------------------------------------------
// Blocage des redirections
// ------------------------------------------------------------------

function isHttp(url) {
  return /^https?:\/\//i.test(url || "");
}

// Détermine si une navigation doit être bloquée selon le mode choisi.
function shouldBlock(targetHost, anchorHost, isRedirect, settings) {
  switch (settings.mode) {
    case "same-domain":
      // Bloque toute sortie du site courant (clics inclus).
      return !grHostAllowed(targetHost, anchorHost, settings);
    case "allowlist":
      // N'autorise que les domaines de la liste blanche.
      return !grInAllowlist(targetHost, settings.allowlist);
    case "redirects":
    default:
      // Laisse les clics/saisies, bloque les redirections automatiques
      // qui quittent le site courant.
      return isRedirect && !grHostAllowed(targetHost, anchorHost, settings);
  }
}

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return; // uniquement le cadre principal
  if (!isHttp(d.url)) return; // ignore les pages internes de l'extension, etc.

  const settings = await grGet();
  const targetHost = grHost(d.url);
  const anchorHost = anchors[d.tabId] ? anchors[d.tabId].host : "";

  // Dérogation ponctuelle demandée via la page de blocage.
  if (bypass[d.tabId] === d.url) {
    delete bypass[d.tabId];
    setAnchor(d.tabId, d.url);
    await logVisit(d, settings, "bypass");
    return;
  }

  const q = d.transitionQualifiers || [];
  const isRedirect =
    q.includes("client_redirect") || q.includes("server_redirect");

  if (settings.enabled && shouldBlock(targetHost, anchorHost, isRedirect, settings)) {
    // On renvoie le tab vers une page de blocage, sans changer l'ancre.
    const back = anchors[d.tabId] ? anchors[d.tabId].url : "";
    const page =
      chrome.runtime.getURL("src/blocked.html") +
      "?target=" + encodeURIComponent(d.url) +
      "&from=" + encodeURIComponent(back) +
      "&kind=" + (isRedirect ? "redirect" : "navigation");
    chrome.tabs.update(d.tabId, { url: page });
    await logVisit(d, settings, "blocked");
    return;
  }

  // Navigation autorisée : elle devient le nouveau site courant.
  setAnchor(d.tabId, d.url);
  await logVisit(d, settings, isRedirect ? "redirect" : "visit");
});

// ------------------------------------------------------------------
// Journalisation
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
  // On garde au plus maxLog entrées.
  while (log.length > settings.maxLog) log.shift();
  await grSet({ visitLog: log });
}

// ------------------------------------------------------------------
// Envoi vers le serveur
// ------------------------------------------------------------------

async function postToServer(kind, items, settings) {
  const headers = { "Content-Type": "application/json" };
  if (settings.serverKey) headers["Authorization"] = "Bearer " + settings.serverKey;
  const body = JSON.stringify({
    kind, // "visits" | "history" | "ping"
    clientId: await grClientId(),
    sentAt: Date.now(),
    items,
  });
  const res = await fetch(settings.serverUrl, { method: "POST", headers, body });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res;
}

// Envoie les visites non encore transmises.
async function syncNow() {
  const settings = await grGet();
  if (!settings.serverUrl) return { ok: false, reason: "no-server" };
  const data = await grGet();
  const log = data.visitLog || [];
  const unsent = log.filter((e) => !e.sent);
  if (unsent.length === 0) return { ok: true, sent: 0 };
  try {
    await postToServer("visits", unsent, settings);
    // Marque comme envoyées.
    const sentSet = new Set(unsent.map((e) => e.ts + "|" + e.url));
    for (const e of log) {
      if (sentSet.has(e.ts + "|" + e.url)) e.sent = true;
    }
    await grSet({ visitLog: log });
    return { ok: true, sent: unsent.length };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
}

// Envoie tout l'historique du navigateur (action explicite).
async function sendFullHistory(maxResults) {
  const settings = await grGet();
  if (!settings.serverUrl) return { ok: false, reason: "no-server" };
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

// Teste la connexion au serveur.
async function testServer() {
  const settings = await grGet();
  if (!settings.serverUrl) return { ok: false, reason: "no-server" };
  try {
    await postToServer("ping", [], settings);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
}

// ------------------------------------------------------------------
// Alarme de synchronisation périodique
// ------------------------------------------------------------------

async function refreshAlarm() {
  const settings = await grGet();
  await chrome.alarms.clear("gr-sync");
  if (settings.serverUrl && settings.syncIntervalMin > 0) {
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
// Messages depuis le popup / la page d'options / la page de blocage
// ------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "allowOnce": {
        // "Ouvrir quand même" depuis la page de blocage.
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
  return true; // réponse asynchrone
});
