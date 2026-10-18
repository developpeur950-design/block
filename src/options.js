// Logique de la page d'options.

const $ = (id) => document.getElementById(id);

function send(type, extra) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), resolve)
  );
}

async function load() {
  const d = await grGet();
  $("enabled").checked = !!d.enabled;
  $("mode").value = d.mode;
  $("includeSubdomains").checked = !!d.includeSubdomains;
  $("allowlist").value = (d.allowlist || []).join("\n");
  $("logging").checked = !!d.logging;
  $("serverUrl").value = d.serverUrl || "";
  $("serverKey").value = d.serverKey || "";
  $("syncIntervalMin").value = d.syncIntervalMin;
  $("maxLog").value = d.maxLog;
}

async function save() {
  const allowlist = $("allowlist")
    .value.split("\n")
    .map((s) => s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, ""))
    .filter(Boolean);

  await grSet({
    enabled: $("enabled").checked,
    mode: $("mode").value,
    includeSubdomains: $("includeSubdomains").checked,
    allowlist,
    logging: $("logging").checked,
    serverUrl: $("serverUrl").value.trim(),
    serverKey: $("serverKey").value.trim(),
    syncIntervalMin: Math.max(0, parseInt($("syncIntervalMin").value, 10) || 0),
    maxLog: Math.max(100, parseInt($("maxLog").value, 10) || 2000),
  });
  await send("settingsChanged");
  $("status").textContent = "Enregistré.";
  setTimeout(() => ($("status").textContent = ""), 2000);
  load();
}

$("save").addEventListener("click", save);

$("test").addEventListener("click", async () => {
  await save();
  $("status").textContent = "Test en cours…";
  const r = await send("testServer");
  $("status").textContent = r && r.ok ? "Serveur joignable ✔" : "Échec : " + (r ? r.reason : "inconnu");
});

$("sendHistory").addEventListener("click", async () => {
  await save();
  if (!confirm("Envoyer TOUT l'historique de ce navigateur vers ton serveur ?")) return;
  $("status").textContent = "Envoi de l'historique…";
  const r = await send("sendHistory");
  $("status").textContent =
    r && r.ok ? r.sent + " entrée(s) d'historique envoyée(s) ✔" : "Échec : " + (r ? r.reason : "inconnu");
});

load();
