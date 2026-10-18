// Page affichée quand une redirection est bloquée.

const params = new URLSearchParams(location.search);
const target = params.get("target") || "";
const from = params.get("from") || "";

document.getElementById("target").textContent = target;

document.getElementById("back").addEventListener("click", () => {
  if (from) location.href = from;
  else history.length > 1 ? history.back() : window.close();
});

// "Ouvrir quand même" : on demande au service worker une dérogation
// ponctuelle, puis il navigue le tab vers l'URL cible.
document.getElementById("go").addEventListener("click", async () => {
  const tab = await chrome.tabs.getCurrent();
  chrome.runtime.sendMessage({
    type: "allowOnce",
    url: target,
    tabId: tab && tab.id,
  });
});
