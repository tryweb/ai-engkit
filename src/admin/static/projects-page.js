const CAPABILITIES = [
  { key: "knowledge", glyph: "K", label: "Knowledge" },
  { key: "maintenance", glyph: "M", label: "Maintenance" },
  { key: "openspec", glyph: "OS", label: "OpenSpec" },
  { key: "superpowers", glyph: "SP", label: "SuperPower" },
];

let overviewData = {};
let refreshBusy = false;
let deleteTargetName = null;
let syncData = null;
let drawerName = null;
let remoteName = null;
let menuButton = null;

function formatWhen(value) {
  const t = new Date(value);
  if (isNaN(t.getTime())) return value;
  const diff = Date.now() - t.getTime();
  if (diff < 0) return "now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 30) return days + "d ago";
  return t.toISOString().slice(0, 10);
}

function featureStatsText(f, stats) {
  if (f === "knowledge") {
    const parts = [stats.files + (stats.files === 1 ? " knowledge entry" : " knowledge entries")];
    parts.push(stats.patterns + " patterns · " + stats.architecture + " architecture · " + stats.tooling + " tooling · " + stats.troubleshooting + " troubleshooting");
    if (stats.lastModified) parts.push("Last updated " + formatWhen(stats.lastModified));
    return parts;
  }
  if (f === "maintenance") {
    const parts = [stats.reports + (stats.reports === 1 ? " maintenance report" : " maintenance reports")];
    parts.push("Covers " + stats.months + (stats.months === 1 ? " month" : " months"));
    if (stats.lastReportDate) parts.push("Last report " + formatWhen(stats.lastReportDate));
    return parts;
  }
  return [stats.active + " active · " + stats.archived + " archived", stats.specs + " specs"];
}

function codegraphState(data) {
  if (!data || !data.codegraph) return "unknown";
  if (data.codegraph.initialized && data.codegraph.index && data.codegraph.index.reindexRecommended) return "stale";
  return data.codegraph.initialized ? "indexed" : "missing";
}

function codegraphTooltip(data) {
  const cg = data.codegraph;
  const parts = [];
  if (typeof cg.fileCount === "number") parts.push(cg.fileCount.toLocaleString() + " files");
  if (typeof cg.nodeCount === "number") parts.push(cg.nodeCount.toLocaleString() + " nodes");
  if (typeof cg.edgeCount === "number") parts.push(cg.edgeCount.toLocaleString() + " edges");
  if (cg.index && cg.index.reindexRecommended) parts.push("reindex recommended");
  if (cg.index && typeof cg.index.state === "string") parts.push("state: " + cg.index.state);
  if (typeof cg.lastIndexed === "string") parts.push("Last indexed " + formatWhen(cg.lastIndexed));
  return parts.join(" · ");
}

function projectNames() { return Object.keys(overviewData); }

function sortedNames() {
  return projectNames().slice().sort((a, b) => {
    const da = !!(overviewData[a] && overviewData[a].disabled);
    const db = !!(overviewData[b] && overviewData[b].disabled);
    if (da !== db) return da ? 1 : -1;
    return a.localeCompare(b);
  });
}

async function loadFeatures() {
  const res = await fetch("/api/projects/overview").then(r => r.json()).catch(() => null);
  if (!res) {
    overviewData = {};
    renderList();
    const list = document.getElementById("project-list");
    const note = document.createElement("div");
    note.className = "project-empty text-muted";
    note.textContent = "Could not load project overview.";
    list.appendChild(note);
    return;
  }
  overviewData = res;
  renderList();
}

function renderList() {
  const list = document.getElementById("project-list");
  list.querySelectorAll(".project-row").forEach(r => r.remove());
  const emptyNote = document.getElementById("project-empty");
  if (emptyNote) emptyNote.hidden = projectNames().length > 0;
  for (const name of sortedNames()) {
    list.appendChild(buildRow(name));
  }
  updateSummary();
  applyFilters();
}

function updateSummary() {
  let active = 0;
  let disabled = 0;
  for (const name of projectNames()) {
    if (overviewData[name] && overviewData[name].disabled) disabled++;
    else active++;
  }
  document.getElementById("sum-total").textContent = String(projectNames().length);
  document.getElementById("sum-active").textContent = String(active);
  document.getElementById("sum-disabled").textContent = String(disabled);
}

function buildRow(name) {
  const data = overviewData[name] || {};
  const disabled = !!data.disabled;

  const row = document.createElement("div");
  row.className = "project-row" + (disabled ? " project-row--disabled" : "");
  row.dataset.project = name;
  row.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    openDrawer(name);
  });

  const main = document.createElement("div");
  main.className = "project-main";

  const dot = document.createElement("span");
  dot.className = "project-status-dot" + (disabled ? " project-status-dot--disabled" : "");
  dot.setAttribute("aria-hidden", "true");
  main.appendChild(dot);

  const nameWrap = document.createElement("div");
  nameWrap.className = "project-name-wrap";

  const nameBtn = document.createElement("button");
  nameBtn.className = "project-name-btn";
  nameBtn.textContent = name;
  nameBtn.title = (disabled ? "Disabled project" : "Active project") + " — view details";
  nameBtn.addEventListener("click", () => openDrawer(name));
  nameWrap.appendChild(nameBtn);

  const meta = document.createElement("div");
  meta.className = "project-meta";

  const remoteBtn = document.createElement("button");
  remoteBtn.className = "project-remote";
  if (data.remote) {
    const short = data.remote.length > 50 ? data.remote.substring(0, 47) + "…" : data.remote;
    remoteBtn.textContent = "git: " + short;
    remoteBtn.title = "Edit git remote: " + data.remote;
  } else {
    remoteBtn.textContent = "set remote";
    remoteBtn.title = "Set git remote";
  }
  remoteBtn.addEventListener("click", () => openRemote(name));
  meta.appendChild(remoteBtn);

  const badges = document.createElement("div");
  badges.className = "cap-badges";
  for (const cap of CAPABILITIES) {
    const enabled = !!(data.features && data.features[cap.key]);
    const b = document.createElement("button");
    b.className = "cap-badge " + (enabled ? "cap-badge--on" : "cap-badge--off");
    b.textContent = cap.glyph;
    b.setAttribute("aria-label", cap.label + (enabled ? " (enabled)" : " (not enabled) — view details"));
    b.title = cap.label + (enabled ? " — view details" : " — not enabled, click to enable or view details");
    b.addEventListener("click", () => openDrawer(name));
    badges.appendChild(b);
  }

  const cgBtn = document.createElement("button");
  cgBtn.className = "cap-badge";
  const cgState = codegraphState(data);
  if (cgState === "stale") {
    cgBtn.classList.add("cap-badge--cg-stale");
    cgBtn.textContent = "CG";
    cgBtn.title = "CodeGraph needs reindex — " + (codegraphTooltip(data) || "view details");
    cgBtn.setAttribute("aria-label", "CodeGraph needs reindex — view details");
  } else if (cgState === "indexed") {
    cgBtn.classList.add("cap-badge--cg");
    cgBtn.textContent = "CG";
    cgBtn.title = "CodeGraph indexed — " + (codegraphTooltip(data) || "view details");
    cgBtn.setAttribute("aria-label", "CodeGraph indexed — view details");
  } else if (cgState === "missing") {
    cgBtn.classList.add("cap-badge--cg-off");
    cgBtn.textContent = "CG";
    cgBtn.title = "CodeGraph not indexed — view details";
    cgBtn.setAttribute("aria-label", "CodeGraph not indexed — view details");
  } else {
    cgBtn.classList.add("cap-badge--cg-off");
    cgBtn.textContent = "CG?";
    cgBtn.title = "CodeGraph status unknown — view details";
    cgBtn.setAttribute("aria-label", "CodeGraph status unknown — view details");
  }
  cgBtn.addEventListener("click", () => openDrawer(name));
  badges.appendChild(cgBtn);
  meta.appendChild(badges);

  nameWrap.appendChild(meta);
  main.appendChild(nameWrap);

  const menuWrap = document.createElement("div");
  menuWrap.className = "row-menu-wrap";
  const menuBtn = document.createElement("button");
  menuBtn.className = "btn-menu";
  menuBtn.textContent = "⋯";
  menuBtn.setAttribute("aria-haspopup", "menu");
  menuBtn.setAttribute("aria-expanded", "false");
  menuBtn.setAttribute("aria-label", "Actions for " + name);
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(name, menuBtn);
  });
  menuWrap.appendChild(menuBtn);

  row.appendChild(main);
  row.appendChild(menuWrap);
  return row;
}

function toggleMenu(name, btn) {
  if (btn.closest(".row-menu-wrap").querySelector(".action-menu")) {
    closeMenu();
    return;
  }
  closeMenu();
  const data = overviewData[name] || {};
  const disabled = !!data.disabled;
  const wrap = btn.closest(".row-menu-wrap");
  const menu = document.createElement("div");
  menu.className = "action-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Actions for " + name);

  const items = [];
  const addItem = (label, cls, action) => {
    const it = document.createElement("button");
    it.setAttribute("role", "menuitem");
    it.className = cls || "";
    it.textContent = label;
    it.addEventListener("click", () => { closeMenu(); action(); });
    menu.appendChild(it);
    items.push(it);
  };

  addItem(disabled ? "Enable project" : "Disable project", "", () => toggleProjectState(name, disabled));
  addItem("Set git remote", "", () => openRemote(name));
  addItem("Delete project", "action-menu--danger", () => showDeleteForm(name));

  wrap.appendChild(menu);
  btn.setAttribute("aria-expanded", "true");
  menuButton = btn;
  if (items[0]) items[0].focus();

  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      items[(i + 1) % items.length].focus();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      items[(i - 1 + items.length) % items.length].focus();
    }
  });
  document.addEventListener("click", closeMenuOutside, true);
}

function closeMenuOutside(e) {
  if (menuButton && !menuButton.closest(".row-menu-wrap").contains(e.target)) {
    closeMenu();
  }
}

function closeMenu() {
  const menu = document.querySelector(".action-menu");
  if (menu) menu.remove();
  document.removeEventListener("click", closeMenuOutside, true);
  if (menuButton) {
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.focus();
    menuButton = null;
  }
}

function openDrawer(name) {
  drawerName = name;
  renderDrawer();
  document.getElementById("drawer-overlay").style.display = "block";
  document.getElementById("project-drawer").style.display = "flex";
  document.getElementById("drawer-close").focus();
}

function closeDrawer() {
  drawerName = null;
  document.getElementById("drawer-overlay").style.display = "none";
  document.getElementById("project-drawer").style.display = "none";
}

function renderDrawer() {
  const name = drawerName;
  if (!name) return;
  const data = overviewData[name] || {};
  const disabled = !!data.disabled;

  document.getElementById("drawer-name").textContent = name;
  const pill = document.getElementById("drawer-status");
  pill.className = "status-pill " + (disabled ? "status-pill--warning" : "status-pill--success");
  pill.textContent = disabled ? "Disabled" : "Active";

  const remoteSec = document.getElementById("drawer-remote");
  remoteSec.innerHTML = "";
  const hRemote = document.createElement("h4");
  hRemote.textContent = "Git remote";
  remoteSec.appendChild(hRemote);
  const remoteRow = document.createElement("div");
  remoteRow.className = "drawer-cap";
  const remoteInfo = document.createElement("div");
  remoteInfo.style.flex = "1";
  remoteInfo.style.minWidth = "0";
  const remoteVal = document.createElement("div");
  remoteVal.className = "drawer-cap__stats";
  remoteVal.textContent = data.remote || "No remote set";
  remoteVal.style.wordBreak = "break-all";
  remoteInfo.appendChild(remoteVal);
  remoteRow.appendChild(remoteInfo);
  const remoteEdit = document.createElement("button");
  remoteEdit.className = "btn-outline";
  remoteEdit.textContent = "Edit";
  remoteEdit.addEventListener("click", () => openRemote(name));
  remoteRow.appendChild(remoteEdit);
  remoteSec.appendChild(remoteRow);

  const capsSec = document.getElementById("drawer-caps");
  capsSec.innerHTML = "";
  const hCaps = document.createElement("h4");
  hCaps.textContent = "Capabilities";
  capsSec.appendChild(hCaps);
  for (const cap of CAPABILITIES) {
    const enabled = !!(data.features && data.features[cap.key]);
    const capRow = document.createElement("div");
    capRow.className = "drawer-cap";
    const badge = document.createElement("span");
    badge.className = "cap-badge " + (enabled ? "cap-badge--on" : "cap-badge--off");
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = cap.glyph;
    capRow.appendChild(badge);
    const body = document.createElement("div");
    body.style.flex = "1";
    body.style.minWidth = "0";
    const title = document.createElement("div");
    title.className = "drawer-cap__name";
    title.textContent = cap.label;
    body.appendChild(title);
    const stats = document.createElement("div");
    stats.className = "drawer-cap__stats";
    if (enabled) {
      const s = data.stats && data.stats[cap.key];
      stats.textContent = s ? featureStatsText(cap.key, s).join("\n") : "Enabled";
    } else {
      stats.textContent = "Not enabled";
    }
    body.appendChild(stats);
    capRow.appendChild(body);
    if (!enabled) {
      const enableBtn = document.createElement("button");
      enableBtn.className = "btn-outline drawer-cap__enable";
      enableBtn.textContent = "Enable";
      enableBtn.addEventListener("click", () => enableFeatureFromDrawer(name, cap.key, enableBtn));
      capRow.appendChild(enableBtn);
    } else {
      const disableBtn = document.createElement("button");
      disableBtn.className = "btn-outline drawer-cap__enable";
      disableBtn.textContent = "Disable";
      disableBtn.addEventListener("click", () => disableFeatureFromDrawer(name, cap.key, disableBtn));
      capRow.appendChild(disableBtn);
    }
    capsSec.appendChild(capRow);
  }

  const cgSec = document.getElementById("drawer-codegraph");
  cgSec.innerHTML = "";
  const hCg = document.createElement("h4");
  hCg.textContent = "CodeGraph";
  cgSec.appendChild(hCg);
  const cgRow = document.createElement("div");
  cgRow.className = "drawer-cap";
  const cgBody = document.createElement("div");
  cgBody.style.flex = "1";
  const cgStats = document.createElement("div");
  cgStats.className = "drawer-cap__stats";
  const cg = data.codegraph;
  if (!cg) cgStats.textContent = "Status unknown";
  else if (!cg.initialized) cgStats.textContent = "Not indexed";
  else {
    cgStats.textContent = codegraphTooltip(data) || "Indexed";
    if (codegraphState(data) === "stale") cgStats.classList.add("drawer-cap__stats--warn");
  }
  cgBody.appendChild(cgStats);
  cgRow.appendChild(cgBody);
  
  const reindexBtn = document.createElement("button");
  reindexBtn.className = "btn-outline drawer-cap__enable";
  reindexBtn.textContent = "Reindex";
  reindexBtn.title = "Rebuild CodeGraph index from scratch";
  reindexBtn.addEventListener("click", () => reindexCodegraph(name, reindexBtn));
  cgRow.appendChild(reindexBtn);
  
  cgSec.appendChild(cgRow);

  const act = document.getElementById("drawer-actions");
  act.innerHTML = "";
  const toggle = document.createElement("button");
  toggle.className = disabled ? "btn" : "btn-outline";
  toggle.textContent = disabled ? "Enable project" : "Disable project";
  toggle.title = "Show or hide this project in OpenChamber. Project files are never deleted.";
  toggle.addEventListener("click", () => toggleProjectState(name, disabled));
  act.appendChild(toggle);
  const del = document.createElement("button");
  del.className = "btn-outline btn-outline--danger";
  del.textContent = "Delete project";
  del.addEventListener("click", () => showDeleteForm(name));
  act.appendChild(del);
}

function applyFilters() {
  const q = document.getElementById("filter-search").value.toLowerCase().trim();
  const status = document.getElementById("filter-status").value;
  const cap = document.getElementById("filter-cap").value;
  const remote = document.getElementById("filter-remote").value;
  const cg = document.getElementById("filter-codegraph").value;
  let visible = 0;
  for (const row of document.querySelectorAll("#project-list .project-row")) {
    const name = row.dataset.project;
    const data = overviewData[name] || {};
    let show = true;
    if (q && name.toLowerCase().indexOf(q) === -1) show = false;
    if (show && status === "active" && data.disabled) show = false;
    if (show && status === "disabled" && !data.disabled) show = false;
    if (show && cap !== "all" && !(data.features && data.features[cap])) show = false;
    if (show && remote === "with" && !data.remote) show = false;
    if (show && remote === "none" && data.remote) show = false;
    if (show && cg !== "all" && codegraphState(data) !== cg) show = false;
    row.hidden = !show;
    if (show) visible++;
  }
  const filterEmpty = document.getElementById("filter-empty");
  if (filterEmpty) filterEmpty.hidden = visible !== 0;
  const hasFilters = q || status !== "all" || cap !== "all" || remote !== "all" || cg !== "all";
  document.getElementById("btn-clear-filters").hidden = !hasFilters;
}

function clearFilters() {
  document.getElementById("filter-search").value = "";
  document.getElementById("filter-status").value = "all";
  document.getElementById("filter-cap").value = "all";
  document.getElementById("filter-remote").value = "all";
  document.getElementById("filter-codegraph").value = "all";
  applyFilters();
  document.getElementById("filter-search").focus();
}

function openRemote(name) {
  remoteName = name;
  const data = overviewData[name] || {};
  document.getElementById("remote-project-name").textContent = name;
  document.getElementById("remote-url").value = data.remote || "";
  document.getElementById("remote-error").style.display = "none";
  document.getElementById("remote-modal").style.display = "flex";
  document.getElementById("remote-url").focus();
}

function closeRemote() {
  document.getElementById("remote-modal").style.display = "none";
  remoteName = null;
}

async function saveRemote() {
  const url = document.getElementById("remote-url").value.trim();
  const errEl = document.getElementById("remote-error");
  const res = await fetch("/api/projects/" + encodeURIComponent(remoteName) + "/git-remote", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ remote: url }),
  });
  if (res.ok) { location.reload(); return; }
  let msg = "Failed to set remote";
  try { const d = await res.json(); msg = d.error || msg; } catch (e) { msg = res.status + " " + res.statusText; }
  errEl.textContent = msg;
  errEl.style.display = "block";
}

async function toggleProjectState(name, currentlyDisabled) {
  const action = currentlyDisabled ? "enable" : "disable";
  const res = await fetch("/api/projects/" + encodeURIComponent(name) + "/" + action, { method: "POST" });
  if (res.ok) { location.reload(); return; }
  let msg = "Failed to " + action;
  try { const d = await res.json(); msg = d.error || msg; } catch (e) { msg = res.status + " " + res.statusText; }
  alert(msg);
}

async function enableFeatureFromDrawer(name, feat, btn) {
  btn.disabled = true;
  btn.textContent = "Enabling…";
  try {
    const res = await fetch("/api/projects/" + encodeURIComponent(name) + "/features/" + feat, { method: "POST" });
    if (res.ok) {
      await loadFeatures();
      if (drawerName === name) renderDrawer();
    } else {
      const d = await res.json().catch(() => null);
      alert((d && d.error) || "Failed to enable " + feat);
      btn.disabled = false;
      btn.textContent = "Enable";
    }
  } catch (e) {
    alert("Network error enabling " + feat);
    btn.disabled = false;
    btn.textContent = "Enable";
  }
}

async function disableFeatureFromDrawer(name, feat, btn) {
  btn.disabled = true;
  btn.textContent = "Disabling…";
  try {
    const res = await fetch("/api/projects/" + encodeURIComponent(name) + "/features/" + feat, { method: "DELETE" });
    if (res.ok) {
      await loadFeatures();
      if (drawerName === name) renderDrawer();
    } else {
      const d = await res.json().catch(() => null);
      alert((d && d.error) || "Failed to disable " + feat);
      btn.disabled = false;
      btn.textContent = "Disable";
    }
  } catch (e) {
    alert("Network error disabling " + feat);
    btn.disabled = false;
    btn.textContent = "Disable";
  }
}

async function reindexCodegraph(name, btn) {
  btn.disabled = true;
  btn.textContent = "Reindexing…";
  try {
    const res = await fetch("/api/projects/" + encodeURIComponent(name) + "/codegraph/reindex", { method: "POST" });
    if (res.ok) {
      await loadFeatures();
      if (drawerName === name) renderDrawer();
    } else {
      const d = await res.json().catch(() => null);
      alert((d && d.error) || "Failed to reindex CodeGraph");
      btn.disabled = false;
      btn.textContent = "Reindex";
    }
  } catch (e) {
    alert("Network error reindexing CodeGraph");
    btn.disabled = false;
    btn.textContent = "Reindex";
  }
}

async function refreshToolStatus() {
  if (refreshBusy) return;
  refreshBusy = true;
  const btn = document.getElementById("btn-tool-refresh");
  if (btn) { btn.disabled = true; btn.textContent = "Scanning..."; }
  try {
    await fetch("/api/projects/tool-status/refresh", { method: "POST" });
    await loadFeatures();
  } catch (e) {
    if (btn) { btn.textContent = "Error"; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⟳ Re-scan"; }
    refreshBusy = false;
  }
}

function toggleGitRemote() {
  const show = document.getElementById("init-git").checked;
  document.getElementById("git-remote-group").style.display = show ? "block" : "none";
}
function showCreateForm() { document.getElementById("create-modal").style.display = "flex"; }
function closeCreate() { document.getElementById("create-modal").style.display = "none"; }
async function createProject() {
  const name = document.getElementById("project-name").value.trim();
  if (!name) return;
  const gitInit = document.getElementById("init-git").checked;
  const gitRemote = document.getElementById("git-remote").value.trim();
  const res = await fetch("/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, git_init: gitInit, git_remote: gitRemote || undefined }),
  });
  if (res.ok) { location.reload(); }
  else { const d = await res.json(); document.getElementById("create-error").style.display = "block";
    document.getElementById("create-error").textContent = d.error || "Failed to create"; }
}

async function syncProjects() {
  document.getElementById("sync-modal").style.display = "flex";
  document.getElementById("sync-status").textContent = "Checking...";
  document.getElementById("sync-results").style.display = "none";
  document.getElementById("sync-actions").style.display = "none";
  const res = await fetch("/api/projects/sync").then(r => r.json());
  syncData = res;
  const results = document.getElementById("sync-results");
  results.style.display = "block";
  let html = "";
  if (res.missingInOC && res.missingInOC.length > 0) {
    html += "<p><strong>Missing in OpenChamber</strong> (will be added):</p><ul>";
    res.missingInOC.forEach(n => { html += "<li><code>" + n + "</code></li>"; });
    html += "</ul>";
  }
  if (res.staleInOC && res.staleInOC.length > 0) {
    html += "<p><strong>Stale in OpenChamber</strong> (will be removed):</p><ul>";
    res.staleInOC.forEach(n => { html += "<li><code>" + n + "</code></li>"; });
    html += "</ul>";
  }
  if (!html) {
    document.getElementById("sync-status").textContent = "All projects are in sync.";
    document.getElementById("sync-actions").style.display = "flex";
    document.getElementById("btn-sync-fix").style.display = "none";
    return;
  }
  results.innerHTML = html;
  document.getElementById("sync-status").textContent = res.missingInOC.length + " missing, " + res.staleInOC.length + " stale.";
  document.getElementById("sync-actions").style.display = "flex";
}
async function applySync() {
  const btn = document.getElementById("btn-sync-fix");
  btn.disabled = true;
  btn.textContent = "Syncing...";
  const res = await fetch("/api/projects/sync", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ add: syncData.missingInOC, remove: syncData.staleInOC }),
  }).then(r => r.json());
  if (res.ok) { location.reload(); }
  else { alert("Sync failed"); btn.disabled = false; btn.textContent = "Fix All"; }
}
function closeSync() { document.getElementById("sync-modal").style.display = "none"; }

function showDeleteForm(name) {
  deleteTargetName = name;
  document.getElementById("delete-confirm-name").value = "";
  document.getElementById("delete-confirm-name").placeholder = name;
  document.getElementById("delete-error").style.display = "none";
  document.getElementById("btn-delete-confirm").disabled = true;
  document.getElementById("delete-modal").style.display = "flex";
  document.getElementById("delete-confirm-name").focus();
}
function closeDelete() {
  document.getElementById("delete-modal").style.display = "none";
  deleteTargetName = null;
}
function validateDeleteConfirm() {
  const input = document.getElementById("delete-confirm-name").value;
  document.getElementById("btn-delete-confirm").disabled = input !== deleteTargetName;
}
async function confirmDelete() {
  const btn = document.getElementById("btn-delete-confirm");
  btn.disabled = true;
  btn.textContent = "Deleting...";
  const errEl = document.getElementById("delete-error");
  errEl.style.display = "none";
  try {
    const res = await fetch("/api/projects/" + encodeURIComponent(deleteTargetName) + "/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation_name: deleteTargetName }),
    });
    if (res.ok) { location.reload(); return; }
    const d = await res.json().catch(() => null);
    errEl.textContent = d?.error || "Failed to delete project";
    errEl.style.display = "block";
    btn.disabled = false;
    btn.textContent = "Delete Project";
  } catch (e) {
    errEl.textContent = "Network error";
    errEl.style.display = "block";
    btn.disabled = false;
    btn.textContent = "Delete Project";
  }
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (drawerName) { closeDrawer(); return; }
  if (document.getElementById("remote-modal").style.display === "flex") { closeRemote(); return; }
  if (document.querySelector(".action-menu")) { closeMenu(); return; }
});

loadFeatures();
