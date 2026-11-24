import { html } from "hono/html";
import { Layout } from "./layout";

export function HostMaintenancePage() {
  return (
    <Layout title="Host Maintenance" currentPath="/host-maintenance">
      <div>
        <div class="mb-4">
          <h2>Host Maintenance</h2>
          <p class="text-sm text-muted">Host disk janitor: daily evaluation, watermark-triggered, P0 tiers are automation-safe. No <code>prune -a</code>, no volume pruning.</p>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-title">Automatic maintenance (P0: dangling + builder)</h3>
          <label class="flex items-center gap-2 retention-field" style="cursor:pointer;">
            <input id="host-enabled" type="checkbox" />
            <span>Enable daily host maintenance</span>
          </label>
          <label class="flex items-center gap-2 retention-field">
            <span class="retention-label">Daily run time (server time)</span>
            <input id="host-dailyRunAt" type="time" step="60" style="max-width:140px;" />
          </label>
          <label class="flex items-center gap-2 retention-field">
            <span class="retention-label">Builder keep-storage (GB)</span>
            <input id="host-builderGb" type="number" min="1" max="100" step="1" style="max-width:120px;" />
          </label>
          <label class="flex items-center gap-2 retention-field">
            <span class="retention-label">Warn below (GB free)</span>
            <input id="host-warnGb" type="number" min="1" step="1" style="max-width:120px;" />
          </label>
          <label class="flex items-center gap-2 retention-field">
            <span class="retention-label">Critical below (GB free)</span>
            <input id="host-critGb" type="number" min="1" step="1" style="max-width:120px;" />
          </label>
          <div class="flex items-center gap-2 retention-actions">
            <button id="save-host" type="button" onclick="saveHostPolicy()" disabled>Save policy</button>
            <span id="host-status" class="text-sm text-muted" role="status" />
          </div>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-info-title">Host storage status</h3>
          <div id="host-detail" class="text-sm text-muted">Loading host storage…</div>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-info-title">Dry-run plan</h3>
          <p class="text-sm text-muted">Always review the plan before running. Versioned images are manual-only.</p>
          <div id="host-plan" class="text-sm text-muted">Loading plan…</div>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-info-title">Run P0 maintenance now</h3>
          <label class="flex items-center gap-2 retention-field" style="cursor:pointer;">
            <input id="host-confirm" type="checkbox" />
            <span class="text-sm">I understand this prunes dangling images and builder cache</span>
          </label>
          <div class="flex items-center gap-2 retention-actions">
            <button id="run-host" type="button" onclick="runHostNow()" disabled>Run host maintenance</button>
            <span id="host-run-status" class="text-sm text-muted" role="status" />
          </div>
          <div id="host-progress" class="text-sm" style="display:none; margin-top:16px;"></div>
        </div>
        <script>{html`
          const GB = 1024 * 1024 * 1024;
          const hostToggle = document.getElementById("host-enabled");
          const hostDaily = document.getElementById("host-dailyRunAt");
          const hostBuilder = document.getElementById("host-builderGb");
          const hostWarn = document.getElementById("host-warnGb");
          const hostCrit = document.getElementById("host-critGb");
          const hostSave = document.getElementById("save-host");
          const hostStatus = document.getElementById("host-status");
          const hostDetail = document.getElementById("host-detail");
          const hostPlan = document.getElementById("host-plan");
          const hostConfirm = document.getElementById("host-confirm");
          const hostRun = document.getElementById("run-host");
          const hostRunStatus = document.getElementById("host-run-status");
          const hostProgress = document.getElementById("host-progress");
          let hostPolicy = null;

          function fmtBytes(n) {
            if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
            if (n < 1024) return n + " B";
            if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
            if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
            return (n / GB).toFixed(2) + " GB";
          }
          function esc(s) {
            return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          }

          async function loadHostPolicy() {
            try {
              const res = await fetch("/api/admin/host-maintenance/policy");
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "Failed to load policy");
              hostPolicy = data;
              hostToggle.checked = !!data.enabled;
              hostDaily.value = data.dailyRunAt || "03:00";
              hostBuilder.value = String(data.builderKeepStorageGb ?? 5);
              hostWarn.value = String(Math.round((data.watermarkWarnBytes ?? 10 * GB) / GB));
              hostCrit.value = String(Math.round((data.watermarkCritBytes ?? 8 * GB) / GB));
              hostSave.disabled = false;
            } catch (e) {
              hostStatus.textContent = e instanceof Error ? e.message : "Failed to load policy";
            }
          }

          async function saveHostPolicy() {
            hostSave.disabled = true;
            hostStatus.textContent = "Saving...";
            try {
              const body = {
                enabled: hostToggle.checked,
                dailyRunAt: String(hostDaily.value || "03:00"),
                builderKeepStorageGb: Number(hostBuilder.value),
                keepAiEngkitVersions: hostPolicy && typeof hostPolicy.keepAiEngkitVersions === "number" ? hostPolicy.keepAiEngkitVersions : 2,
                watermarkWarnBytes: Math.round(Number(hostWarn.value) * GB),
                watermarkCritBytes: Math.round(Number(hostCrit.value) * GB),
                protectedTags: hostPolicy && Array.isArray(hostPolicy.protectedTags) ? hostPolicy.protectedTags : ["postgres:16-alpine"],
              };
              const res = await fetch("/api/admin/host-maintenance/policy", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "Failed to save policy");
              hostPolicy = data;
              hostStatus.textContent = "Saved";
            } catch (e) {
              hostStatus.textContent = e instanceof Error ? e.message : "Failed to save policy";
            } finally {
              hostSave.disabled = false;
            }
          }

          async function loadHostStatus() {
            try {
              const res = await fetch("/api/admin/host-maintenance/status");
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "Failed to load status");
              const s = data.storage || {};
              hostDetail.classList.remove("text-muted");
              hostDetail.innerHTML =
                "<dl>" +
                "<div><dt>Watermark</dt><dd><strong>" + esc(data.watermark || "unknown") + "</strong></dd></div>" +
                "<div><dt>Free space</dt><dd>" + esc(fmtBytes(s.freeSpaceBytes)) + " <span class=text-muted>" + esc(s.freeSpacePath || "") + "</span></dd></div>" +
                "<div><dt>Tmp free</dt><dd>" + esc(fmtBytes(s.tmpFreeBytes)) + " <span class=text-muted>" + esc(s.tmpPath || "") + "</span></dd></div>" +
                "<div><dt>DB file</dt><dd>" + esc(fmtBytes(s.dbFileSizeBytes)) + "</dd></div>" +
                "<div><dt>State</dt><dd>" + esc(data.state || "idle") + "</dd></div>" +
                "</dl>" +
                (s.dockerDfRaw ? "<pre style=white-space:pre-wrap>" + esc(s.dockerDfRaw) + "</pre>" : "<p class=text-muted>No docker snapshot.</p>");
            } catch (e) {
              hostDetail.textContent = e instanceof Error ? e.message : "Failed to load status";
            }
          }

          async function loadHostPlan() {
            try {
              const res = await fetch("/api/admin/host-maintenance/plan");
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "Failed to load plan");
              const rows = (data.versionedCandidates || []).map(function (c) {
                return "<tr><td>" + esc(c.repository) + ":" + esc(c.tag) + "</td><td><code>" + esc(c.imageId) + "</code></td><td>" + esc(c.size || "") + "</td><td>" + (c.excludedReason ? esc(c.excludedReason) : "<strong>removable (manual)</strong>") + "</td></tr>";
              }).join("");
              hostPlan.classList.remove("text-muted");
              hostPlan.innerHTML =
                "<p>Safe tiers: <code>" + esc((data.tiers || []).join(", ")) + "</code></p>" +
                "<p class=text-muted>" + esc(data.note || "") + "</p>" +
                "<table><thead><tr><th>Image</th><th>ID</th><th>Size</th><th>Decision</th></tr></thead><tbody>" + rows + "</tbody></table>";
            } catch (e) {
              hostPlan.textContent = e instanceof Error ? e.message : "Failed to load plan";
            }
          }

          if (hostConfirm) {
            hostConfirm.addEventListener("change", function () {
              hostRun.disabled = !hostConfirm.checked;
            });
          }

          async function runHostNow() {
            if (!hostConfirm.checked) return;
            hostRun.disabled = true;
            hostRunStatus.textContent = "Starting…";
            hostProgress.style.display = "block";
            hostProgress.innerHTML = "";
            try {
              const res = await fetch("/api/admin/host-maintenance/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tiers: ["dangling", "builder"] }),
              });
              const data = await res.json().catch(function () { return null; });
              if (res.status !== 202) {
                hostRunStatus.textContent = (data && data.error) || "Failed to start (" + res.status + ")";
                hostRun.disabled = false;
                return;
              }
              hostRunStatus.textContent = "Running…";
              const es = new EventSource("/api/admin/host-maintenance/log");
              es.onmessage = function (e) {
                let ev = null;
                try { ev = JSON.parse(e.data); } catch { return; }
                const row = document.createElement("div");
                row.textContent = (ev.step || "") + " [" + (ev.status || "") + "] " + (ev.message || "");
                hostProgress.appendChild(row);
                if (ev.step === "verify" && (ev.status === "success" || ev.status === "failure")) {
                  es.close();
                  hostRunStatus.textContent = ev.status === "success" ? "Completed" : "Failed";
                  hostRun.disabled = false;
                  loadHostStatus();
                }
              };
              es.onerror = function () {
                es.close();
                hostRunStatus.textContent = "Connection lost";
                hostRun.disabled = false;
              };
            } catch (e) {
              hostRunStatus.textContent = e instanceof Error ? e.message : "Failed to start";
              hostRun.disabled = false;
            }
          }

          loadHostPolicy();
          loadHostStatus();
          loadHostPlan();
        `}</script>
      </div>
    </Layout>
  );
}
