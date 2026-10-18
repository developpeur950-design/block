// Popup minimal : liste des sites protégés + ajout / suppression.

const $ = (id) => document.getElementById(id);

function esc(s) {
  return (s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// On n'affiche que le site de base (host), même si on a collé une adresse complète.
function toHost(entry) {
  let e = (entry || "").trim();
  if (!e) return "";
  e = e.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const slash = e.indexOf("/");
  return (slash === -1 ? e : e.slice(0, slash)).toLowerCase();
}

async function getList() {
  const d = await grGet();
  return (d.watchedLinks || []).slice();
}

async function saveList(list) {
  await grSet({ watchedLinks: list });
}

async function render() {
  const list = await getList();
  const ul = $("list");
  ul.innerHTML = "";
  if (list.length === 0) {
    ul.innerHTML = '<li class="empty">Aucun site. Ajoute-en un ci-dessous.</li>';
    return;
  }
  list.forEach((entry, i) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "site";
    span.textContent = toHost(entry) || entry;
    const btn = document.createElement("button");
    btn.className = "del";
    btn.textContent = "×";
    btn.title = "Retirer";
    btn.addEventListener("click", async () => {
      const l = await getList();
      l.splice(i, 1);
      await saveList(l);
      render();
    });
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

async function addSite() {
  const host = toHost($("input").value);
  if (!host) return;
  const list = await getList();
  if (!list.map(toHost).includes(host)) {
    list.push(host);
    await saveList(list);
  }
  $("input").value = "";
  render();
}

$("add").addEventListener("click", addSite);
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSite();
});

render();
