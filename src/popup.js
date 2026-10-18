// Logique du popup : interrupteur, journal récent, envoi manuel.

const $ = (id) => document.getElementById(id);

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString();
}

function esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

async function render() {
  const data = await grGet();

  $("enabled").checked = !!data.enabled;
  $("stateLabel").textContent = data.enabled ? "Actif" : "Inactif";

  const log = (data.visitLog || []).slice().reverse().slice(0, 30);
  const ul = $("log");
  ul.innerHTML = "";
  if (log.length === 0) {
    ul.innerHTML = '<li style="color:var(--muted)">Aucune visite enregistrée.</li>';
  }
  for (const e of log) {
    const li = document.createElement("li");
    const tag =
      e.type === "blocked"
        ? '<span class="tag blocked">bloqué</span>'
        : e.type === "redirect"
        ? '<span class="tag">redirection</span>'
        : "";
    li.innerHTML =
      '<div class="row"><span class="host">' +
      esc(e.host) +
      "</span>" +
      '<span class="time">' +
      fmtTime(e.ts) +
      "</span></div>" +
      '<div class="row"><span class="ttl">' +
      esc(e.title || e.url) +
      "</span>" +
      tag +
      "</div>";
    ul.appendChild(li);
  }

  const unsent = (data.visitLog || []).filter((e) => !e.sent).length;
  if (data.serverUrl) {
    $("serverInfo").innerHTML =
      "Serveur : <strong>" + esc(data.serverUrl) + "</strong> — " + unsent + " en attente.";
  } else {
    $("serverInfo").textContent =
      "Aucun serveur configuré — tout reste en local. Ouvre les Options pour en ajouter un.";
  }
}

function send(type, extra) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), resolve)
  );
}

$("enabled").addEventListener("change", async (e) => {
  await grSet({ enabled: e.target.checked });
  render();
});

$("sync").addEventListener("click", async () => {
  $("status").textContent = "Envoi en cours…";
  const r = await send("syncNow");
  if (r && r.ok) $("status").textContent = r.sent + " entrée(s) envoyée(s).";
  else $("status").textContent = "Échec : " + (r ? r.reason : "inconnu");
  render();
});

$("clear").addEventListener("click", async () => {
  await send("clearLog");
  $("status").textContent = "Journal vidé.";
  render();
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

render();
