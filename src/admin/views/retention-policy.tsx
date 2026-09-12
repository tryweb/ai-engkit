import { html } from "hono/html";
import { Layout } from "./layout";

export function RetentionPolicyPage() {
  return (
    <Layout title="Retention Policy" currentPath="/retention-policy">
      <div>
        <div class="mb-4">
          <h2>Retention Policy</h2>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-title">
            Database retention
            <details class="retention-disclosure">
              <summary class="retention-disclosure__trigger" aria-label="Configure automatic cleanup of inactive sessions and their cascaded dependents. Hard deletion only — archiving reclaims zero bytes and is not offered.">i</summary>
              <div class="retention-disclosure__content">Configure automatic cleanup of inactive sessions and their cascaded dependents. Hard deletion only — archiving reclaims zero bytes and is not offered.</div>
            </details>
          </h3>
          <p class="text-sm text-muted retention-desc">When enabled, the daily maintenance check will hard-delete sessions older than the cutoff. The policy is delete-only.</p>
          <label class="flex items-center gap-2 retention-field" style="cursor:pointer;">
            <input id="retention-enabled" type="checkbox" />
            <span>Enable retention policy</span>
          </label>
          <p id="enable-gate-hint" class="text-sm text-muted" role="status" style="display:none;"></p>
          <label class="flex items-center gap-2 retention-field">
            <span class="retention-label">Inactivity cutoff (days)</span>
            <input id="retention-cutoff" type="number" min="1" max="365" step="1" style="max-width:120px;" />
          </label>
          <p class="text-sm text-muted retention-hint">Allowed range: 1–365 days.</p>
          <label class="flex items-center gap-2 retention-field">
            <span class="retention-label">Daily run time (server time)</span>
            <input id="retention-dailyRunAt" type="time" step="60" style="max-width:140px;" />
          </label>
          <p class="text-sm text-muted retention-hint">Server time (Asia/Taipei) — runs daily at this wall-clock time.</p>
          <div class="flex items-center gap-2 retention-actions">
            <button id="save-retention" type="button" onclick="saveRetentionPolicy()" disabled>Save policy</button>
            <span id="retention-status" class="text-sm text-muted" role="status" />
          </div>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-info-title">Maintenance status</h3>
          <div id="maint-detail" class="text-sm text-muted">Loading maintenance status…</div>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-info-title">Run maintenance now</h3>
          <p id="run-counts" class="text-sm text-muted" style="overflow-wrap:anywhere;">Loading delete counts…</p>
          <label class="flex items-center gap-2 retention-field" style="cursor:pointer;flex-wrap:wrap;min-width:0;">
            <input id="run-confirm" type="checkbox" />
            <span class="text-sm" style="overflow-wrap:anywhere;">I understand this permanently deletes the listed sessions</span>
          </label>
          <div class="flex items-center gap-2 retention-actions" style="flex-wrap:wrap;min-width:0;">
            <button id="run-maintenance" type="button" onclick="runMaintenanceNow()" disabled>Run maintenance now</button>
            <span id="run-status" class="text-sm text-muted" role="status" style="overflow-wrap:anywhere;min-width:0;" />
          </div>
          <div id="run-progress" class="text-sm" style="display:none; margin-top:16px; min-width:0; overflow-wrap:anywhere;"></div>
          <div id="run-result" class="text-sm" style="display:none; margin-top:12px; min-width:0; overflow-wrap:anywhere;" role="status" />
          <p class="text-sm text-muted" style="margin-top:12px;overflow-wrap:anywhere;">Check the Maintenance status section for the latest outcome.</p>
        </div>
        <div class="card retention-card" style="max-width:720px;">
          <h3 class="retention-info-title">Database information</h3>
          <div id="db-detail" class="text-sm text-muted">Loading database health…</div>
        </div>
        <script>{html`
          const retentionToggle = document.getElementById("retention-enabled");
          const retentionCutoff = document.getElementById("retention-cutoff");
          const retentionDailyRunAt = document.getElementById("retention-dailyRunAt");
          const retentionButton = document.getElementById("save-retention");
          const retentionStatus = document.getElementById("retention-status");
          const dbDetail = document.getElementById("db-detail");
          const maintDetail = document.getElementById("maint-detail");
          const runCounts = document.getElementById("run-counts");
          const runConfirm = document.getElementById("run-confirm");
          const runButton = document.getElementById("run-maintenance");
          const runStatus = document.getElementById("run-status");
          const runProgress = document.getElementById("run-progress");
          const runResult = document.getElementById("run-result");
          const enableGateHint = document.getElementById("enable-gate-hint");
          let runInProgress = false;
          let hasPriorSuccess = false;
          let runEventSource = null;
          let runLastEventId = 0;
          let runTerminalReached = false;

          function formatBytes(n) {
            if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
            if (n < 1024) return n.toLocaleString("en-US") + " B";
            if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
            if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
            return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
          }
          function formatInt(n) {
            if (typeof n !== "number" || !Number.isFinite(n)) return "—";
            return n.toLocaleString("en-US");
          }

          async function loadRetentionPolicy() {
            try {
              const response = await fetch("/api/admin/retention-policy");
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "Failed to load retention policy");
              retentionToggle.checked = data.enabled;
              retentionCutoff.value = String(data.cutoffDays);
              if (retentionDailyRunAt) {
                retentionDailyRunAt.value = typeof data.dailyRunAt === "string" ? data.dailyRunAt : "03:00";
              }
              retentionButton.disabled = false;
              applyEnableGate();
            } catch (error) {
              retentionStatus.textContent = error instanceof Error ? error.message : "Failed to load retention policy";
            }
          }

          async function saveRetentionPolicy() {
            retentionButton.disabled = true;
            retentionStatus.textContent = "Saving...";
            try {
              const cutoff = Number(retentionCutoff.value);
              const dailyRunAt = retentionDailyRunAt ? String(retentionDailyRunAt.value || "03:00") : "03:00";
              const response = await fetch("/api/admin/retention-policy", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabled: retentionToggle.checked, cutoffDays: cutoff, dailyRunAt: dailyRunAt }),
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "Failed to save retention policy");
              retentionStatus.textContent = "Saved";
              await loadDeleteCounts();
              await loadMaintenanceStatus();
            } catch (error) {
              retentionStatus.textContent = error instanceof Error ? error.message : "Failed to save retention policy";
            } finally {
              retentionButton.disabled = false;
            }
          }

          async function loadDbHealth() {
            try {
              const response = await fetch("/api/db-health");
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "Failed to load database health");
              const freeSpace = data.freeSpaceBytes !== null && data.freeSpaceBytes !== undefined ? formatBytes(data.freeSpaceBytes) : "—";
              const collected = data.collectedAt ? new Date(data.collectedAt).toLocaleString("en-US") : "—";
              dbDetail.classList.remove("text-muted");
              dbDetail.innerHTML =
                '<div class="retention-db">' +
                '<dl class="retention-db__metrics">' +
                '<div class="retention-db__field"><dt class="retention-db__label">DB File Size</dt><dd class="retention-db__value">' + formatBytes(data.fileSizeBytes) + '</dd><dd class="retention-db__meta">' + (data.dbPath || "") + '</dd></div>' +
                '<div class="retention-db__field"><dt class="retention-db__label">Freelist</dt><dd class="retention-db__value">' + formatInt(data.freelistCount) + '</dd><dd class="retention-db__meta">free pages</dd></div>' +
                '<div class="retention-db__field"><dt class="retention-db__label">Free Disk Space</dt><dd class="retention-db__value">' + freeSpace + '</dd><dd class="retention-db__meta">' + (data.freeSpacePath || "") + '</dd></div>' +
                '</dl>' +
                '<dl class="retention-db__metrics retention-db__metrics--counts">' +
                '<div class="retention-db__field"><dt class="retention-db__label">Sessions</dt><dd class="retention-db__value">' + formatInt(data.rowCounts ? data.rowCounts.session : 0) + '</dd></div>' +
                '<div class="retention-db__field"><dt class="retention-db__label">Events</dt><dd class="retention-db__value">' + formatInt(data.rowCounts ? data.rowCounts.event : 0) + '</dd></div>' +
                '<div class="retention-db__field"><dt class="retention-db__label">Messages</dt><dd class="retention-db__value">' + formatInt(data.rowCounts ? data.rowCounts.message : 0) + '</dd></div>' +
                '<div class="retention-db__field"><dt class="retention-db__label">Parts</dt><dd class="retention-db__value">' + formatInt(data.rowCounts ? data.rowCounts.part : 0) + '</dd></div>' +
                '</dl>' +
                '<p class="text-sm text-muted retention-db__collected">Collected ' + collected + ' · Read-only probe (no writes, no restart)</p>' +
                '</div>';
            } catch (error) {
              dbDetail.textContent = error instanceof Error ? error.message : "Failed to load database health";
            }
          }

          function escapeHtml(s) {
            return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
          }
          function formatMaintTs(iso) {
            if (!iso) return '<span class="text-muted">Never</span>';
            try {
              const d = new Date(iso);
              if (Number.isNaN(d.getTime())) return '<span class="text-muted">Never</span>';
              return d.toLocaleString("en-US");
            } catch {
              return '<span class="text-muted">Never</span>';
            }
          }
          async function loadMaintenanceStatus() {
            try {
              const [schedRes, maintRes, countsRes] = await Promise.all([
                fetch("/api/admin/db-maintenance/schedule"),
                fetch("/api/admin/db-maintenance/status"),
                fetch("/api/admin/db-maintenance/counts")
              ]);
              const sched = await schedRes.json();
              const maint = await maintRes.json();
              let policyEnabled = null;
              try {
                const counts = await countsRes.json();
                if (countsRes.ok && typeof counts.enabled === "boolean") policyEnabled = counts.enabled;
              } catch { policyEnabled = null; }
              if (!schedRes.ok) throw new Error(sched.error || "Failed to load maintenance schedule");
              if (!maintRes.ok) throw new Error(maint.error || "Failed to load maintenance status");
              hasPriorSuccess = typeof maint.last_success_at === "string" && maint.last_success_at.length > 0;
              const isRunning = sched.isStarted === true;
              const pillClass = policyEnabled === false || !isRunning ? "status-pill--neutral" : "status-pill--success";
              const pillText = policyEnabled === false ? "Paused" : (isRunning ? "Running" : "Stopped");
              const lastEvalHtml = sched.lastEvaluationAt ? formatMaintTs(sched.lastEvaluationAt) : '<span class="text-muted">Never</span>';
              let nextRunHtml;
              if (policyEnabled === false) {
                nextRunHtml = '<span class="text-muted">Paused — policy disabled</span>';
              } else if (!hasPriorSuccess) {
                nextRunHtml = '<span class="text-muted">Paused — awaiting first successful manual run</span>';
              } else if (sched.nextEvaluationAt) {
                nextRunHtml = formatMaintTs(sched.nextEvaluationAt) + ' <span class="text-muted" style="font-size:var(--text-xs);">(server time)</span>';
              } else {
                const intervalMs = typeof sched.intervalMs === "number" ? sched.intervalMs : 86400000;
                const hours = Math.round(intervalMs / 3600000);
                nextRunHtml = '<span class="text-muted">Due within ' + hours + ' hours of startup</span>';
              }
              let outcomeHtml;
              if (maint.last_success_at) {
                outcomeHtml = formatMaintTs(maint.last_success_at);
              } else if (maint.last_error) {
                outcomeHtml = '<span class="text-muted">' + escapeHtml(maint.last_error) + '</span>';
              } else if (sched.lastSkipReason) {
                outcomeHtml = '<span class="text-muted">' + escapeHtml(sched.lastSkipReason) + '</span>';
              } else if (sched.lastRunAt) {
                outcomeHtml = formatMaintTs(sched.lastRunAt);
              } else {
                outcomeHtml = '<span class="text-muted">No runs yet</span>';
              }
              maintDetail.classList.remove("text-muted");
              maintDetail.innerHTML =
                '<div class="retention-db">' +
                '<dl class="retention-db__metrics">' +
                '<div class="retention-db__field"><dt class="retention-db__label">Scheduler</dt><dd class="retention-db__value"><span id="maint-pill" class="status-pill ' + pillClass + '">' + pillText + '</span></dd></div>' +
                '<div class="retention-db__field"><dt class="retention-db__label">Last evaluation</dt><dd id="maint-last-evaluation" class="retention-db__value">' + lastEvalHtml + '</dd></div>' +
                '<div class="retention-db__field"><dt class="retention-db__label">Next run</dt><dd id="maint-next-run" class="retention-db__value">' + nextRunHtml + '</dd></div>' +
                '</dl>' +
                '<dl class="retention-db__metrics"><div class="retention-db__field"><dt class="retention-db__label">Last maintenance outcome</dt><dd id="maint-last-outcome" class="retention-db__value">' + outcomeHtml + '</dd></div></dl>' +
                '</div>';
              applyEnableGate();
            } catch (error) {
              maintDetail.textContent = error instanceof Error ? error.message : "Failed to load maintenance status";
            }
          }

          function applyEnableGate() {
            const locked = !hasPriorSuccess && !retentionToggle.checked;
            retentionToggle.disabled = locked;
            if (enableGateHint) {
              enableGateHint.style.display = locked ? "block" : "none";
              enableGateHint.textContent = locked
                ? "Requires one successful manual run before enabling — run maintenance now once to unlock."
                : "";
            }
          }

          function updateRunButtonState() {
            const shouldDisable = runInProgress || !runConfirm.checked;
            runButton.disabled = shouldDisable;
          }

          async function loadDeleteCounts() {
            try {
              const response = await fetch("/api/admin/db-maintenance/counts");
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || data.detail || "Failed to load delete counts");
              const sessions = typeof data.sessions === "number" ? data.sessions.toLocaleString("en-US") : "—";
              const seqs = typeof data.eventSequences === "number" ? data.eventSequences.toLocaleString("en-US") : "—";
              const days = typeof data.cutoffDays === "number" ? String(data.cutoffDays) : "—";
              runCounts.textContent = sessions + " sessions, " + seqs + " event sequences older than " + days + " days will be hard-deleted";
              runCounts.classList.remove("text-muted");
            } catch (error) {
              runCounts.textContent = error instanceof Error ? error.message : "Failed to load delete counts";
              runCounts.classList.add("text-muted");
            }
            updateRunButtonState();
          }

          function pillToneForStatus(status) {
            if (status === "success") return "status-pill--success";
            if (status === "failure") return "status-pill--danger";
            if (status === "running") return "status-pill--warning";
            return "status-pill--neutral";
          }

          function renderRunEvent(ev) {
            if (!ev || typeof ev.step !== "string") return;
            if (typeof ev.id === "number" && ev.id <= runLastEventId) return;
            if (typeof ev.id === "number") runLastEventId = ev.id;
            if (runProgress.style.display === "none") {
              runProgress.style.display = "block";
              runProgress.innerHTML = "";
            }
            const tone = pillToneForStatus(ev.status);
            const time = ev.timestamp ? new Date(ev.timestamp).toLocaleString("en-US") : "";
            const row = document.createElement("div");
            row.className = "flex items-center gap-2";
            row.style.cssText = "flex-wrap:wrap;min-width:0;padding:6px 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere;";
            row.innerHTML =
              '<span class="status-pill ' + tone + '">' + escapeHtml(ev.status || "") + '</span>' +
              '<span style="font-weight:600;min-width:0;overflow-wrap:anywhere;">' + escapeHtml(ev.step) + '</span>' +
              '<span class="text-muted" style="min-width:0;overflow-wrap:anywhere;flex:1 1 160px;">' + escapeHtml(ev.message || "") + '</span>' +
              (time ? '<span class="text-muted" style="font-size:var(--text-xs);white-space:nowrap;">' + escapeHtml(time) + '</span>' : "");
            runProgress.appendChild(row);
          }

          function showRunResult(kind, message) {
            runResult.style.display = "block";
            if (kind === "success") {
              const ts = new Date().toLocaleString("en-US");
              runResult.innerHTML = '<span class="status-pill status-pill--success">Success</span> <span style="margin-left:8px;">' + escapeHtml(message || "Maintenance completed") + ' — ' + escapeHtml(ts) + '</span>';
            } else {
              runResult.innerHTML = '<span class="status-pill status-pill--danger">Failed</span> <span style="margin-left:8px;">' + escapeHtml(message || "Maintenance failed") + '</span>';
            }
          }

          function connectRunLog() {
            if (runEventSource) {
              try { runEventSource.close(); } catch {}
              runEventSource = null;
            }
            runProgress.style.display = "block";
            if (!runProgress.innerHTML) runProgress.innerHTML = "";
            runResult.style.display = "none";
            runResult.innerHTML = "";
            runLastEventId = 0;
            runTerminalReached = false;
            runInProgress = true;
            updateRunButtonState();
            runStatus.textContent = "Running…";
            const es = new EventSource("/api/admin/db-maintenance/log");
            runEventSource = es;
            es.onmessage = function(e) {
              let ev = null;
              try { ev = JSON.parse(e.data); } catch { return; }
              renderRunEvent(ev);
              if (ev.step === "verify" && (ev.status === "success" || ev.status === "failure")) {
                runTerminalReached = true;
                if (ev.status === "success") {
                  showRunResult("success", ev.message || "Maintenance completed successfully");
                } else {
                  showRunResult("failure", ev.message || ev.status);
                }
                setTimeout(function() {
                  try { es.close(); } catch {}
                  runEventSource = null;
                  runInProgress = false;
                  updateRunButtonState();
                  runStatus.textContent = ev.status === "success" ? "Completed" : "Failed";
                  loadDeleteCounts();
                  loadMaintenanceStatus();
                }, 1100);
              } else if (ev.status === "failure") {
                runTerminalReached = true;
                showRunResult("failure", ev.message || "Step failed");
                if (runEventSource) { runEventSource.close(); runEventSource = null; }
                runInProgress = false;
                updateRunButtonState();
                runStatus.textContent = "Failed";
                loadDeleteCounts();
                loadMaintenanceStatus();
              }
            };
            es.onerror = function() {
              if (runEventSource) { runEventSource.close(); runEventSource = null; }
              // A server-side stream close after the terminal event is normal
              // shutdown, not a failure — only report when no terminal state arrived.
              if (runTerminalReached) return;
              runInProgress = false;
              updateRunButtonState();
              runStatus.textContent = "Connection lost";
              showRunResult("failure", "Lost connection to the maintenance log stream");
            };
          }

          async function runMaintenanceNow() {
            if (!runConfirm.checked) {
              runStatus.textContent = "Please confirm deletion first";
              return;
            }
            runButton.disabled = true;
            runStatus.textContent = "Starting…";
            runResult.style.display = "none";
            runResult.innerHTML = "";
            try {
              const response = await fetch("/api/admin/db-maintenance/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirm: true }),
              });
              let data = null;
              try { data = await response.json(); } catch { data = null; }
              if (response.status === 202) {
                connectRunLog();
                return;
              }
              if (response.status === 409) {
                runStatus.textContent = "Maintenance already in progress";
                connectRunLog();
                return;
              }
              if (!response.ok) {
                const msg = (data && (data.error || data.detail)) ? (data.error || data.detail) : "Failed to start maintenance (" + response.status + ")";
                runStatus.textContent = msg;
                runButton.disabled = false;
                updateRunButtonState();
                return;
              }
              connectRunLog();
            } catch (error) {
              runStatus.textContent = error instanceof Error ? error.message : "Failed to start maintenance";
              runButton.disabled = false;
              updateRunButtonState();
            }
          }

          if (runConfirm) {
            runConfirm.addEventListener("change", updateRunButtonState);
          }

          async function checkRunningOnLoad() {
            try {
              const res = await fetch("/api/admin/db-maintenance/status");
              const data = await res.json();
              if (res.ok && data.state === "running") {
                connectRunLog();
                try {
                  const histRes = await fetch("/api/admin/db-maintenance/log?history=1");
                  if (histRes.ok) {
                    const events = await histRes.json();
                    if (Array.isArray(events)) {
                      for (const ev of events) renderRunEvent(ev);
                    }
                  }
                } catch {}
              }
            } catch {}
          }

          loadRetentionPolicy();
          loadDbHealth();
          loadMaintenanceStatus();
          loadDeleteCounts();
          checkRunningOnLoad();
        `}</script>
      </div>
    </Layout>
  );
}
