import { html } from "hono/html";
import { Layout } from "./layout";

export function HostMaintenancePage() {
  return (
    <Layout title="Host Maintenance" currentPath="/host-maintenance">
      <div>
        <div class="mb-4">
          <h2>Host Maintenance</h2>
          <p class="text-sm text-muted">
            Scheduled hygiene for host disk space: safe automatic cleanup (dangling images, build cache)
            plus human-confirmed pruning of superseded ai-engkit versions. Destructive scopes are never automatic.
          </p>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-info-title">Host storage</h3>
          <div id="storage-detail" class="text-sm text-muted">Loading host storage…</div>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-title">
            Automatic maintenance
            <details class="retention-disclosure">
              <summary class="retention-disclosure__trigger" aria-label="About automatic maintenance">i</summary>
              <div class="retention-disclosure__content">When enabled, the daily check prunes only dangling (untagged, unused) images and build cache above the keep limit. Old-version pruning and volumes are never automatic.</div>
            </details>
          </h3>
          <label class="flex items-center gap-2 retention-field" style="cursor:pointer;">
            <input id="hm-enabled" type="checkbox" />
            <span>Enable automatic safe cleanup</span>
          </label>
          <label class="flex items-center gap-2 retention-field">
            <span class="retention-label">Daily run time (server time)</span>
            <input id="hm-dailyRunAt" type="time" step="60" style="max-width:140px;" />
          </label>
          <label class="flex items-center gap-2 retention-field">
            <span class="retention-label">Build cache keep (GB)</span>
            <input id="hm-builderKeep" type="number" min="1" max="100" step="1" style="max-width:120px;" />
          </label>
          <label class="flex items-center gap-2 retention-field">
            <span class="retention-label">Keep newest ai-engkit versions</span>
            <input id="hm-keepVersions" type="number" min="1" max="10" step="1" style="max-width:120px;" />
          </label>
          <label class="flex items-center gap-2 retention-field">
            <span class="retention-label">Warn below free (GB)</span>
            <input id="hm-warnGb" type="number" min="1" max="1024" step="1" style="max-width:120px;" />
          </label>
          <label class="flex items-center gap-2 retention-field">
            <span class="retention-label">Critical below free (GB)</span>
            <input id="hm-critGb" type="number" min="1" max="1024" step="1" style="max-width:120px;" />
          </label>
          <label class="flex items-center gap-2 retention-field">
            <span class="retention-label">Protected tags (comma separated)</span>
            <input id="hm-protected" type="text" style="max-width:320px;" placeholder="postgres:16-alpine" />
          </label>
          <div class="flex items-center gap-2 retention-actions">
            <button id="save-hm" type="button" onclick="saveHostPolicy()">Save policy</button>
            <span id="hm-status" class="text-sm text-muted" role="status" />
          </div>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-info-title">Scheduler status</h3>
          <div id="sched-detail" class="text-sm text-muted">Loading scheduler status…</div>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-info-title">Run safe cleanup now</h3>
          <p id="plan-detail" class="text-sm text-muted" style="overflow-wrap:anywhere;">Loading cleanup plan…</p>
          <label class="flex items-center gap-2 retention-field" style="cursor:pointer;flex-wrap:wrap;min-width:0;">
            <input id="run-confirm" type="checkbox" />
            <span class="text-sm" style="overflow-wrap:anywhere;">I understand this prunes dangling images and build cache above the keep limit</span>
          </label>
          <div class="flex items-center gap-2 retention-actions" style="flex-wrap:wrap;min-width:0;">
            <button id="run-safe" type="button" onclick="runSafeCleanup()">Run safe cleanup now</button>
            <span id="run-status" class="text-sm text-muted" role="status" style="overflow-wrap:anywhere;min-width:0;" />
          </div>
          <div id="run-progress" class="text-sm" style="display:none; margin-top:16px; min-width:0; overflow-wrap:anywhere;"></div>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-info-title">Advanced: prune superseded versions</h3>
          <p id="versioned-detail" class="text-sm text-muted" style="overflow-wrap:anywhere;">Loading version list…</p>
          <label class="flex items-center gap-2 retention-field" style="cursor:pointer;flex-wrap:wrap;min-width:0;">
            <input id="versioned-confirm" type="checkbox" />
            <span class="text-sm" style="overflow-wrap:anywhere;">I understand the listed image versions will be deleted and cannot be used for rollback</span>
          </label>
          <div class="flex items-center gap-2 retention-actions" style="flex-wrap:wrap;min-width:0;">
            <button id="run-versioned" type="button" onclick="runVersionedPrune()">Delete listed versions</button>
            <span id="versioned-status" class="text-sm text-muted" role="status" style="overflow-wrap:anywhere;min-width:0;" />
          </div>
        </div>
        <script>{html`
          var planCache = null;
          function fmtBytes(n) {
            if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
            if (n < 1024) return n.toLocaleString("en-US") + " B";
            if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
            if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
            return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
          }
          function esc(s) {
            return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          }
          async function loadStatus() {
            var el = document.getElementById("storage-detail");
            try {
              var res = await fetch("/api/admin/host-maintenance/status");
              var data = await res.json();
              if (!res.ok) throw new Error(data.error || "failed");
              var root = (data.storage && data.storage.root) || {};
              var docker = (data.storage && data.storage.docker) || {};
              var pills = { ok: "✓", warn: "⚠", crit: "⛔", unknown: "?" };
              var wm = data.watermark || "unknown";
              var html = "<div>Root free: <strong>" + esc(fmtBytes(root.availBytes)) + "</strong> " +
                (pills[wm] || "?") + " (warn &lt; " + esc(String(data.watermarkGb.warn)) +
                "GB, crit &lt; " + esc(String(data.watermarkGb.crit)) + "GB)</div>";
              if (docker.images) {
                html += "<div>Images: " + esc(String(docker.images.total)) + " total, " +
                  esc(fmtBytes(docker.images.reclaimableBytesApprox)) + " reclaimable (approx)</div>";
              }
              if (docker.buildCache) {
                html += "<div>Build cache: " + esc(fmtBytes(docker.buildCache.sizeBytesApprox)) +
                  ", " + esc(fmtBytes(docker.buildCache.reclaimableBytesApprox)) + " reclaimable (approx)</div>";
              }
              if (docker.volumes) {
                html += "<div>Volumes: " + esc(String(docker.volumes.total)) + " total, " +
                  esc(fmtBytes(docker.volumes.reclaimableBytesApprox)) + " reclaimable (manual review only)</div>";
              }
              var m = data.maintenance || {};
              html += "<div>Last run: " + esc(m.lastRunAt || "never") +
                (m.lastFreedBytes !== null && m.lastFreedBytes !== undefined ? " (freed ~" + esc(fmtBytes(m.lastFreedBytes)) + ")" : "") + "</div>";
              el.innerHTML = html;
            } catch (e) {
              el.textContent = "Failed to load host storage: " + (e && e.message ? e.message : e);
            }
          }
          async function loadPolicy() {
            try {
              var res = await fetch("/api/admin/host-maintenance/policy");
              var data = await res.json();
              if (!res.ok) throw new Error(data.error || "failed");
              document.getElementById("hm-enabled").checked = !!data.enabled;
              document.getElementById("hm-dailyRunAt").value = data.dailyRunAt || "";
              document.getElementById("hm-builderKeep").value = data.builderKeepStorageGb;
              document.getElementById("hm-keepVersions").value = data.keepAiEngkitVersions;
              document.getElementById("hm-warnGb").value = data.watermarkWarnGb;
              document.getElementById("hm-critGb").value = data.watermarkCritGb;
              document.getElementById("hm-protected").value = (data.protectedTags || []).join(", ");
            } catch (e) {
              document.getElementById("hm-status").textContent = "Failed to load policy";
            }
          }
          async function saveHostPolicy() {
            var st = document.getElementById("hm-status");
            st.textContent = "Saving…";
            var protectedTags = document.getElementById("hm-protected").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
            var body = {
              enabled: document.getElementById("hm-enabled").checked,
              dailyRunAt: document.getElementById("hm-dailyRunAt").value,
              builderKeepStorageGb: Number(document.getElementById("hm-builderKeep").value),
              keepAiEngkitVersions: Number(document.getElementById("hm-keepVersions").value),
              watermarkWarnGb: Number(document.getElementById("hm-warnGb").value),
              watermarkCritGb: Number(document.getElementById("hm-critGb").value),
              protectedTags: protectedTags,
            };
            try {
              var res = await fetch("/api/admin/host-maintenance/policy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
              var data = await res.json();
              st.textContent = res.ok ? "Saved." : ("Error: " + (data.error || res.status));
            } catch (e) {
              st.textContent = "Error: " + (e && e.message ? e.message : e);
            }
          }
          async function loadPlan() {
            var planEl = document.getElementById("plan-detail");
            var verEl = document.getElementById("versioned-detail");
            try {
              var res = await fetch("/api/admin/host-maintenance/plan");
              var plan = await res.json();
              if (!res.ok) throw new Error(plan.error || "failed");
              planCache = plan;
              var parts = [];
              parts.push("Dangling images: " + plan.dangling.length);
              parts.push("Build cache reclaimable: " + fmtBytes(plan.builder.estimatedReclaimBytesApprox) + " (approx)");
              parts.push("Estimated total reclaim: " + fmtBytes(plan.estimatedReclaimBytesApprox) + " (approx)");
              planEl.textContent = parts.join(" · ");
              if (plan.versioned.length === 0) {
                verEl.textContent = "No superseded versions (newest " + plan.builder.keepStorageGb + " rule aside, family images are within keep count or in use).";
              } else {
                verEl.innerHTML = "Proposed for deletion:<br>" + plan.versioned.map(function (d) {
                  return "• " + esc(d.ref) + " (" + esc(fmtBytes(d.sizeBytesApprox)) + " approx, " + esc(d.reason) + ")";
                }).join("<br>");
              }
            } catch (e) {
              planEl.textContent = "Failed to load plan: " + (e && e.message ? e.message : e);
              verEl.textContent = "";
            }
          }
          async function loadSchedule() {
            var el = document.getElementById("sched-detail");
            try {
              var res = await fetch("/api/admin/host-maintenance/schedule");
              var data = await res.json();
              if (!res.ok) throw new Error(data.error || "failed");
              el.textContent = "Started: " + data.isStarted + " · Last run: " + (data.lastRunAt || "never") +
                " · Last skip: " + (data.lastSkipReason || "—") + " · Next: " + (data.nextEvaluationAt || "—");
            } catch (e) {
              el.textContent = "Failed to load scheduler status";
            }
          }
          function watchLog(progressEl) {
            try {
              var es = new EventSource("/api/admin/host-maintenance/log");
              es.onmessage = function (ev) {
                try {
                  var data = JSON.parse(ev.data);
                  var div = document.createElement("div");
                  div.textContent = (data.at || "") + " [" + (data.tier || "") + "] " + (data.message || "");
                  progressEl.appendChild(div);
                  if (data.tier === "all" && /^cleanup (done|finished)/.test(data.message || "")) {
                    setTimeout(function () { es.close(); loadStatus(); loadPlan(); loadSchedule(); }, 1200);
                  }
                } catch (_) {}
              };
              es.onerror = function () { es.close(); };
            } catch (_) {}
          }
          async function runSafeCleanup() {
            var st = document.getElementById("run-status");
            var progress = document.getElementById("run-progress");
            if (!document.getElementById("run-confirm").checked) { st.textContent = "Please confirm first."; return; }
            st.textContent = "Starting…";
            progress.style.display = "block";
            progress.innerHTML = "";
            try {
              var res = await fetch("/api/admin/host-maintenance/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tiers: ["dangling", "builder"] }) });
              var data = await res.json();
              if (!res.ok) { st.textContent = "Error: " + (data.error || res.status); return; }
              st.textContent = "Started — streaming progress…";
              watchLog(progress);
            } catch (e) {
              st.textContent = "Error: " + (e && e.message ? e.message : e);
            }
          }
          async function runVersionedPrune() {
            var st = document.getElementById("versioned-status");
            if (!document.getElementById("versioned-confirm").checked) { st.textContent = "Please confirm first."; return; }
            if (!planCache || planCache.versioned.length === 0) { st.textContent = "Nothing to delete."; return; }
            st.textContent = "Starting…";
            try {
              var res = await fetch("/api/admin/host-maintenance/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tiers: ["versioned"], confirmed: true }) });
              var data = await res.json();
              st.textContent = res.ok ? "Started — see Run safe cleanup progress above; page refreshes on completion." : ("Error: " + (data.error || res.status));
              if (res.ok) { var progress = document.getElementById("run-progress"); progress.style.display = "block"; watchLog(progress); }
            } catch (e) {
              st.textContent = "Error: " + (e && e.message ? e.message : e);
            }
          }
          loadStatus(); loadPolicy(); loadPlan(); loadSchedule();
        `}</script>
      </div>
    </Layout>
  );
}
