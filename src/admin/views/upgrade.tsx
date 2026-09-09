import type { FC } from "hono/jsx";
import { html } from "hono/html";
import { Layout } from "./layout";
import { VersionsContent, type VersionsViewData } from "./versions";

const UpgradeContent: FC<{ devBuild?: boolean } & Partial<VersionsViewData>> = ({ devBuild, versionsByCategory = {}, imageMeta = {} }) => (
  <div>
    <h2 style="margin-bottom:24px;">Upgrade Engine</h2>
    <VersionsContent versionsByCategory={versionsByCategory} imageMeta={imageMeta} />
    <div id="status-banner" />
    <div class="card">
      <h3>Current Version</h3>
      <p id="current-version-display" class="text-sm" style="margin-top:8px;">Loading…</p>
    </div>
    {devBuild ? (
      <div class="card" style="border-color:var(--accent);">
        <h3>Not Available in Dev Build</h3>
        <p class="text-sm text-muted">This environment is a locally-built dev image. Upgrade is only available for production releases pulled from <code>ghcr.io/tryweb/ai-engkit:latest</code>.</p>
      </div>
    ) : (
      <>
        <div class="card" id="version-selector-card">
          <h3>Select Upgrade Target</h3>
          <div id="versions-loading" class="text-sm text-muted" role="status" aria-live="polite" aria-busy="true" aria-label="Loading available versions">
            <span class="spinner" aria-hidden="true"></span>
            <span>Loading available versions…</span>
            <span id="versions-elapsed" class="probe-elapsed text-muted" aria-live="polite"></span>
          </div>
          <div id="versions-error" class="text-sm" style="display:none;color:var(--danger);" role="alert" />
          <div id="versions-empty" class="text-sm text-muted" style="display:none;">No formal releases available.</div>
          <button id="versions-retry" type="button" class="btn-outline" style="display:none;margin-top:8px;min-height:44px;" aria-label="Retry loading versions">Retry</button>
          <div id="version-controls" style="display:none;">
            <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
              <input type="radio" name="upgrade-target" id="target-official" value="official" />
              <span id="official-label">Official release</span>
            </label>
            <div id="official-warning" class="text-sm" style="display:none;color:var(--warning);margin-bottom:12px;" role="alert" />
            <label style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
              <input type="radio" name="upgrade-target" id="target-specified" value="specified" />
              <span>Specified version</span>
              <select id="specified-select" style="margin-left:8px;min-width:140px;" aria-label="Specified version"></select>
              <button id="more-versions" type="button" class="btn-outline" style="display:none;margin-left:8px;min-width:44px;white-space:nowrap;">More</button>
            </label>
          </div>
          <div id="no-target-warning" class="text-sm" style="display:none;color:var(--warning);" role="alert">No version selected.</div>
          <div id="configured-version-warning" class="text-sm" style="display:none;color:var(--warning);margin-top:8px;" role="alert" />
        </div>
        <div class="card">
          <h3>Upgrade ai-dev Container</h3>
          <p class="text-sm text-muted mb-4">Pulls the selected image, backs up config, recreates the ai-dev container.</p>
          <button id="start-upgrade" type="button" onclick="startUpgrade()" disabled>Start Upgrade</button>
          <button id="cancel-upgrade" type="button" class="btn-danger" style="display:none;margin-left:8px;" onclick="cancelUpgrade()">Cancel</button>
        </div>
      </>
    )}
    <div class="card" id="progress-card" style="display:none;">
      <h3>Progress</h3>
      <div class="progress-bar mb-4"><div class="fill" id="progress-fill" style="width:0%;" /></div>
      <div class="log-viewer" id="log-viewer" />
    </div>
    <script>{html`
      let eventSource = null;
      let lastEventId = 0;
      let fullVersions = [];
      let displayedCount = 0;
      let officialVersion = null;
      let configuredVersion = null;
      let configuredVersionUnavailable = false;
      let versionsWarning = null;
      const BATCH = 10;
      let upgradeAbortController = null;
      let upgradeElapsedTimer = null;
      let upgradeStartMs = 0;
      let upgradeRetryBound = false;
      let upgradeListenersBound = false;
      let componentAbortController = null;
      let componentElapsedTimer = null;
      let componentStartMs = 0;
      let componentRetryBound = false;
      const UPGRADE_TIMEOUT_MS = 15000;
      const COMPONENT_TIMEOUT_MS = 15000;
      function getSelectedVersion() {
        const official = document.getElementById("target-official");
        const specified = document.getElementById("target-specified");
        if (official && official.checked && !official.disabled && officialVersion) return officialVersion;
        if (specified && specified.checked) {
          const sel = document.getElementById("specified-select");
          return sel ? sel.value : null;
        }
        return null;
      }
      function updateStartButton() {
        const btn = document.getElementById("start-upgrade");
        if (!btn) return;
        const sel = getSelectedVersion();
        const hasVersions = fullVersions.length > 0;
        const errEl = document.getElementById("versions-error");
        const hasError = errEl && errEl.style.display !== "none";
        btn.disabled = !sel || !hasVersions || hasError || configuredVersionUnavailable;
        const warn = document.getElementById("no-target-warning");
        if (warn) warn.style.display = (!sel && hasVersions && !hasError) ? "block" : "none";
      }
      function renderSelect() {
        const sel = document.getElementById("specified-select");
        if (!sel) return;
        const toShow = fullVersions.slice(0, displayedCount);
        sel.innerHTML = "";
        for (const v of toShow) {
          const opt = document.createElement("option");
          opt.value = v; opt.textContent = v; sel.appendChild(opt);
        }
        const more = document.getElementById("more-versions");
        if (more) {
          const hasMore = displayedCount < fullVersions.length;
          more.style.display = hasMore ? "inline-flex" : "none";
          more.disabled = !hasMore;
        }
        updateStartButton();
      }
      function onMore() {
        const next = Math.min(fullVersions.length, displayedCount + BATCH);
        if (next === displayedCount) return;
        displayedCount = next;
        renderSelect();
      }
      function bindUpgradeControlListenersOnce() {
        if (upgradeListenersBound) return;
        const moreBtn = document.getElementById("more-versions");
        const officialRadio = document.getElementById("target-official");
        const specifiedRadio = document.getElementById("target-specified");
        const sel = document.getElementById("specified-select");
        if (moreBtn) moreBtn.addEventListener("click", onMore);
        if (officialRadio) officialRadio.addEventListener("change", function(){ configuredVersionUnavailable = false; updateStartButton(); });
        if (specifiedRadio) specifiedRadio.addEventListener("change", function(){ configuredVersionUnavailable = false; updateStartButton(); });
        if (sel) sel.addEventListener("change", function(){ const sr=document.getElementById("target-specified"); if(sr) sr.checked=true; configuredVersionUnavailable = false; updateStartButton(); });
        upgradeListenersBound = true;
      }
      function escapeHtml(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }
      function renderComponentVersions(versionsByCategory, imageMeta) {
        const skeletons = document.getElementById("component-versions-skeletons");
        const dataContainer = document.getElementById("component-versions-data");
        if (skeletons) skeletons.style.display = "none";
        if (!dataContainer) return;
        const imageMetaLabels = { image: "Image", digest: "Digest", created: "Created", version: "Version" };
        const categoryLabels = { core: "Core", cli: "CLI", mcp: "MCP", plugin: "Plugin" };
        const categoryOrder = ["core", "cli", "mcp", "plugin"];
        let html = '<div class="card"><h3>Image Metadata</h3><table>';
        const imageEntries = Object.entries(imageMeta || {});
        if (imageEntries.length === 0) {
          html += '<tr><td colspan="2" class="text-muted">No image metadata available</td></tr>';
        } else {
          for (const [k,v] of imageEntries) {
            const label = imageMetaLabels[k] || k;
            html += '<tr><td>' + escapeHtml(label) + '</td><td><code>' + escapeHtml(v) + '</code></td></tr>';
          }
        }
        html += '</table></div><div class="grid-2">';
        for (const key of categoryOrder) {
          const tools = versionsByCategory ? versionsByCategory[key] : null;
          if (!tools) continue;
          const title = categoryLabels[key] || key;
          html += '<div class="card"><h3>' + escapeHtml(title) + '</h3><table>';
          const entries = Object.entries(tools);
          if (entries.length === 0) {
            html += '<tr><td colspan="2" class="text-muted">No data</td></tr>';
          } else {
            for (const [name, version] of entries) {
              const ver = version ? '<code>' + escapeHtml(version) + '</code>' : '<span class="text-muted">unavailable</span>';
              html += '<tr><td>' + escapeHtml(name) + '</td><td>' + ver + '</td></tr>';
            }
          }
          html += '</table></div>';
        }
        html += '</div>';
        dataContainer.innerHTML = html;
        dataContainer.style.display = "block";
      }
      async function loadComponentVersions() {
        const loading = document.getElementById("component-versions-loading");
        const errorEl = document.getElementById("component-versions-error");
        const retryBtn = document.getElementById("component-versions-retry");
        const elapsedEl = document.getElementById("component-versions-elapsed");
        const skeletons = document.getElementById("component-versions-skeletons");
        const dataContainer = document.getElementById("component-versions-data");
        if (!loading && !errorEl) return;
        if (componentAbortController) componentAbortController.abort();
        const controller = new AbortController();
        componentAbortController = controller;
        const signal = controller.signal;
        const timeoutId = setTimeout(function() { controller.abort(); }, COMPONENT_TIMEOUT_MS);
        if (loading) { loading.style.display = ""; loading.setAttribute("aria-busy", "true"); }
        if (errorEl) { errorEl.style.display = "none"; errorEl.textContent = ""; }
        if (retryBtn) retryBtn.style.display = "none";
        if (elapsedEl) elapsedEl.textContent = "";
        componentStartMs = Date.now();
        if (componentElapsedTimer) clearInterval(componentElapsedTimer);
        componentElapsedTimer = setInterval(function(){ if (elapsedEl) elapsedEl.textContent = ((Date.now() - componentStartMs)/1000).toFixed(1) + "s"; }, 200);
        if (retryBtn && !componentRetryBound) { retryBtn.addEventListener("click", loadComponentVersions); componentRetryBound = true; }
        try {
          const results = await Promise.all([
            fetch("/api/versions", { signal: signal }).then(async function(r){ if(!r.ok) throw new Error("versions " + r.status); return r.json(); }),
            fetch("/api/versions/image", { signal: signal }).then(async function(r){ if(!r.ok) throw new Error("image " + r.status); return r.json(); })
          ]);
          clearTimeout(timeoutId);
          clearInterval(componentElapsedTimer);
          if (elapsedEl) elapsedEl.textContent = "";
          if (loading) { loading.style.display = "none"; loading.setAttribute("aria-busy", "false"); }
          if (errorEl) { errorEl.style.display = "none"; errorEl.textContent = ""; }
          if (retryBtn) retryBtn.style.display = "none";
          const versionsByCategory = results[0];
          const imageMeta = results[1];
          if (componentAbortController !== controller) return;
          renderComponentVersions(versionsByCategory, imageMeta);
        } catch (e) {
          clearTimeout(timeoutId);
          clearInterval(componentElapsedTimer);
          if (componentAbortController !== controller) return;
          if (elapsedEl) elapsedEl.textContent = "";
          if (loading) { loading.style.display = "none"; loading.setAttribute("aria-busy", "false"); }
          if (errorEl) {
            const isAbort = e && e.name === "AbortError";
            errorEl.textContent = isAbort ? "Request timed out — please retry" : ((e && e.message) || "Failed to load component versions");
            errorEl.style.display = "block";
          }
          if (retryBtn) retryBtn.style.display = "inline-flex";
        }
      }
      async function loadVersions() {
        const loading = document.getElementById("versions-loading");
        const errorEl = document.getElementById("versions-error");
        const emptyEl = document.getElementById("versions-empty");
        const controls = document.getElementById("version-controls");
        const elapsedEl = document.getElementById("versions-elapsed");
        const retryBtn = document.getElementById("versions-retry");
        if (!loading) return;
        if (upgradeAbortController) upgradeAbortController.abort();
        const controller = new AbortController();
        upgradeAbortController = controller;
        const signal = controller.signal;
        const timeoutId = setTimeout(function() { controller.abort(); }, UPGRADE_TIMEOUT_MS);
        if (loading) { loading.style.display = ""; loading.setAttribute("aria-busy", "true"); }
        if (errorEl) { errorEl.style.display = "none"; errorEl.textContent = ""; }
        if (emptyEl) emptyEl.style.display = "none";
        if (controls) controls.style.display = "none";
        if (retryBtn) retryBtn.style.display = "none";
        const configuredWarn0 = document.getElementById("configured-version-warning");
        if (configuredWarn0) { configuredWarn0.style.display = "none"; configuredWarn0.textContent = ""; }
        const officialWarn0 = document.getElementById("official-warning");
        if (officialWarn0) { officialWarn0.style.display = "none"; officialWarn0.textContent = ""; }
        upgradeStartMs = Date.now();
        if (elapsedEl) elapsedEl.textContent = "";
        if (upgradeElapsedTimer) clearInterval(upgradeElapsedTimer);
        upgradeElapsedTimer = setInterval(function(){ if (elapsedEl) elapsedEl.textContent = ((Date.now() - upgradeStartMs)/1000).toFixed(1) + "s"; }, 200);
        if (retryBtn && !upgradeRetryBound) { retryBtn.addEventListener("click", loadVersions); upgradeRetryBound = true; }
        try {
          const res = await fetch("/api/upgrade/versions", { signal: signal });
          clearTimeout(timeoutId);
          clearInterval(upgradeElapsedTimer);
          if (elapsedEl) elapsedEl.textContent = "";
          if (loading) { loading.style.display = "none"; loading.setAttribute("aria-busy", "false"); }
          const data = await res.json();
          const versionDisplay = document.getElementById("current-version-display");
          if (versionDisplay) {
            versionDisplay.textContent = data.current_version || "unknown";
          }
          if (!res.ok) {
            if (errorEl) { errorEl.textContent = data.error || "Failed to load versions"; errorEl.style.display = "block"; }
            if (retryBtn) retryBtn.style.display = "inline-flex";
            updateStartButton(); return;
          }
          fullVersions = Array.isArray(data.versions) ? data.versions : [];
          officialVersion = data.official_version || null;
          configuredVersion = data.configured_version || null;
          configuredVersionUnavailable = false;
          versionsWarning = data.warning || null;
          if (data.error) {
            if (errorEl) { errorEl.textContent = data.error; errorEl.style.display = "block"; }
            if (retryBtn) retryBtn.style.display = "inline-flex";
            updateStartButton(); return;
          }
          if (fullVersions.length === 0) {
            if (emptyEl) emptyEl.style.display = "block";
            updateStartButton(); return;
          }
          if (controls) controls.style.display = "block";
          const officialRadio = document.getElementById("target-official");
          const officialLabel = document.getElementById("official-label");
          const officialWarn = document.getElementById("official-warning");
          const specifiedRadio = document.getElementById("target-specified");
          if (officialRadio && officialLabel) {
            if (officialVersion) {
              officialLabel.textContent = "Official release — " + officialVersion + " (latest)";
              officialRadio.disabled = false;
              if (officialWarn) officialWarn.style.display = "none";
              if (!configuredVersion) {
                officialRadio.checked = true;
              }
            } else {
              officialLabel.textContent = "Official release — unavailable";
              officialRadio.disabled = true;
              officialRadio.checked = false;
              if (officialWarn && versionsWarning) { officialWarn.textContent = versionsWarning; officialWarn.style.display = "block"; }
              else if (officialWarn) { officialWarn.textContent = "latest does not match any formal release"; officialWarn.style.display = "block"; }
              if (specifiedRadio) specifiedRadio.checked = false;
            }
          }
          const configuredWarn = document.getElementById("configured-version-warning");
          if (configuredVersion && fullVersions.includes(configuredVersion)) {
            if (specifiedRadio) {
              specifiedRadio.checked = true;
              if (officialRadio) officialRadio.checked = false;
            }
          } else if (configuredVersion && !fullVersions.includes(configuredVersion)) {
            configuredVersionUnavailable = true;
            if (specifiedRadio) specifiedRadio.checked = true;
            if (officialRadio) officialRadio.checked = false;
            if (configuredWarn) {
              configuredWarn.textContent = "Configured version " + configuredVersion + " is not in the discovered release list. Please select a different version.";
              configuredWarn.style.display = "block";
            }
          }
          displayedCount = Math.min(BATCH, fullVersions.length);
          renderSelect();
          if (configuredVersion && fullVersions.includes(configuredVersion)) {
            const sel = document.getElementById("specified-select");
            if (sel) sel.value = configuredVersion;
          }
          bindUpgradeControlListenersOnce();
          updateStartButton();
        } catch (e) {
          clearTimeout(timeoutId);
          clearInterval(upgradeElapsedTimer);
          if (upgradeAbortController !== controller) return;
          if (elapsedEl) elapsedEl.textContent = "";
          if (loading) { loading.style.display = "none"; loading.setAttribute("aria-busy", "false"); }
          if (errorEl) {
            const isAbort = e && e.name === "AbortError";
            errorEl.textContent = isAbort ? "Request timed out — please retry" : ((e && e.message) || "Failed to load versions");
            errorEl.style.display = "block";
          }
          if (retryBtn) retryBtn.style.display = "inline-flex";
          updateStartButton();
        }
      }
      async function startUpgrade() {
        const sel = getSelectedVersion();
        if (!sel) { alert("Please select a version to upgrade to."); return; }
        const official = document.getElementById("target-official");
        const targetType = (official && official.checked) ? "official" : "specified";
        document.getElementById("start-upgrade").disabled = true;
        document.getElementById("start-upgrade").textContent = "Running...";
        document.getElementById("progress-card").style.display = "block";
        const res = await fetch("/api/upgrade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: sel, target_type: targetType }) });
        if (res.status === 409) {
          const data = await res.json();
          if (data.status && data.status.state === "running") { connectLog(); return; }
          alert("Upgrade already in progress");
          document.getElementById("start-upgrade").disabled = false;
          document.getElementById("start-upgrade").textContent = "Start Upgrade";
          updateStartButton(); return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert(data.error || "Failed to start upgrade");
          document.getElementById("start-upgrade").disabled = false;
          document.getElementById("start-upgrade").textContent = "Start Upgrade";
          updateStartButton(); return;
        }
        connectLog();
      }
      function connectLog() {
        document.getElementById("progress-card").style.display = "block";
        if (eventSource) eventSource.close();
        eventSource = new EventSource("/api/upgrade/log");
        const steps = ["digest_compare","backup","merge_env","recreate","poll_health","reconcile","cleanup"];
        const stepIdx = {};
        steps.forEach((s, i) => stepIdx[s] = i);
        eventSource.onmessage = (e) => {
          const ev = JSON.parse(e.data);
          if (ev.id && ev.id <= lastEventId) return;
          lastEventId = ev.id;
          const viewer = document.getElementById("log-viewer");
          const entry = document.createElement("div");
          entry.className = "log-entry";
          entry.innerHTML = '<span class="time">' + new Date(ev.timestamp).toLocaleTimeString() + '</span>' +
            '<span class="step">' + ev.step + '</span>' +
            '<span class="status ' + (ev.status === 'success' ? 'text-success' : ev.status === 'failure' ? 'text-danger' : '') + '">' + ev.status + '</span>' +
            '<span>' + ev.message + '</span>';
          viewer.appendChild(entry);
          viewer.scrollTop = viewer.scrollHeight;
          if (ev.status === "success" || ev.status === "failure") {
            const idx = stepIdx[ev.step];
            if (idx !== undefined) {
              const pct = Math.round(((idx + 1) / steps.length) * 100);
              document.getElementById("progress-fill").style.width = pct + "%";
            }
          }
          if (ev.status === "failure") {
            document.getElementById("start-upgrade").disabled = false;
            document.getElementById("start-upgrade").textContent = "Retry Upgrade";
            updateStartButton(); eventSource.close();
          }
          if (ev.step === "cleanup" && ev.status === "success") {
            document.getElementById("start-upgrade").disabled = false;
            document.getElementById("start-upgrade").textContent = "Start Upgrade";
            document.getElementById("status-banner").innerHTML =
              '<div class="card" style="border-color:var(--success);"><strong class="text-success">Upgrade completed successfully</strong></div>';
            eventSource.close();
          }
        };
        eventSource.onerror = function() {};
      }
      function cancelUpgrade() {
        if (eventSource) eventSource.close();
        document.getElementById("start-upgrade").disabled = false;
        document.getElementById("start-upgrade").textContent = "Start Upgrade";
        updateStartButton();
      }
      fetch("/api/upgrade/status").then(r => r.json()).then(s => { if (s.state === "running") connectLog(); });
      loadVersions();
      loadComponentVersions();
    `}</script>
  </div>
);
export function UpgradePage({ devBuild, versionsByCategory = {}, imageMeta = {} }: { devBuild?: boolean } & Partial<VersionsViewData>) {
  return (
    <Layout title="Upgrade" currentPath="/upgrade">
      <UpgradeContent devBuild={devBuild} versionsByCategory={versionsByCategory} imageMeta={imageMeta} />
    </Layout>
  );
}
