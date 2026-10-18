// Logique de la page d'options.

const $ = (id) => document.getElementById(id);

function send(type, extra) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), resolve)
  );
}

// Nettoie une liste de domaines "exceptions".
function cleanDomains(text) {
  return text
    .split("\n")
    .map((s) =>
      s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "")
    )
    .filter(Boolean);
}

// Garde les liens/débuts de liens tels quels (host ou host+chemin).
function cleanLinks(text) {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function load() {
  const d = await grGet();
  $("enabled").checked = !!d.enabled;
  $("watchedLinks").value = (d.watchedLinks || []).join("\n");
  $("includeSubdomains").checked = !!d.includeSubdomains;
  $("allowlist").value = (d.allowlist || []).join("\n");
  $("logging").checked = !!d.logging;
  $("deviceTag").value = d.deviceTag || "";
  $("serverUrl").value = d.serverUrl || "";
  $("passphrase").value = d.passphrase || "";
  $("serverKey").value = d.serverKey || "";
  $("syncIntervalMin").value = d.syncIntervalMin;
  $("maxLog").value = d.maxLog;
}

async function save() {
  await grSet({
    enabled: $("enabled").checked,
    watchedLinks: cleanLinks($("watchedLinks").value),
    includeSubdomains: $("includeSubdomains").checked,
    allowlist: cleanDomains($("allowlist").value),
    logging: $("logging").checked,
    deviceTag: $("deviceTag").value.trim(),
    serverUrl: $("serverUrl").value.trim(),
    passphrase: $("passphrase").value,
    serverKey: $("serverKey").value.trim(),
    syncIntervalMin: Math.max(0, parseInt($("syncIntervalMin").value, 10) || 0),
    maxLog: Math.max(100, parseInt($("maxLog").value, 10) || 2000),
  });
  await send("settingsChanged");
  $("status").textContent = "Enregistré.";
  setTimeout(() => ($("status").textContent = ""), 2000);
}

$("showPass").addEventListener("change", (e) => {
  $("passphrase").type = e.target.checked ? "text" : "password";
});

$("save").addEventListener("click", save);

$("test").addEventListener("click", async () => {
  await save();
  $("status").textContent = "Test en cours…";
  const r = await send("testServer");
  $("status").textContent = r && r.ok ? "Serveur joignable et phrase secrète valide ✔" : "Échec : " + (r ? r.reason : "inconnu");
});

$("sendHistory").addEventListener("click", async () => {
  await save();
  if (!confirm("Envoyer TOUT l'historique de ce navigateur (chiffré) vers ton serveur ?")) return;
  $("status").textContent = "Envoi de l'historique…";
  const r = await send("sendHistory");
  $("status").textContent =
    r && r.ok ? r.sent + " entrée(s) d'historique envoyée(s) ✔" : "Échec : " + (r ? r.reason : "inconnu");
});

load();
