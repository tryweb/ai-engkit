import { html } from "hono/html";
import { Layout } from "./layout";

export function OpenChamberSettingsPage() {
  return (
    <Layout title="OpenChamber" currentPath="/openchamber">
      <div>
        <div class="mb-4">
          <h2>OpenChamber Settings</h2>
          <p class="text-muted">Manage server-wide OpenChamber preferences for this AI-EngKit environment.</p>
        </div>
        <div class="card" style="max-width:720px;">
          <h3 style="margin-bottom:8px;">OpenCode update notifications</h3>
          <p class="text-sm text-muted" style="margin-bottom:16px;">Show an update notice in OpenChamber when a newer OpenCode version is available.</p>
          <label class="flex items-center gap-2" style="cursor:pointer;">
            <input id="update-notifications" type="checkbox" />
            <span>Show update notifications</span>
          </label>
          <div class="flex items-center gap-2" style="margin-top:20px;">
            <button id="save-settings" type="button" onclick="saveOpenChamberSettings()" disabled>Save settings</button>
            <span id="settings-status" class="text-sm text-muted" role="status" />
          </div>
        </div>
        <div class="card" style="max-width:720px;margin-top:16px;">
          <h3 style="margin-bottom:8px;">Interface language</h3>
          <p class="text-sm text-muted">Language is stored by OpenChamber in each browser's local storage. Set it from OpenChamber Settings on every browser or device where you use it.</p>
        </div>
        <div class="card" style="max-width:720px;margin-top:16px;">
          <h3 style="margin-bottom:8px;">Agent line <span class="badge">Experimental</span></h3>
          <p class="text-sm text-muted" style="margin-bottom:12px;">One-way migration from oh-my-openagent (OMO) to native agents. Migration restarts ai-dev and interrupts active OpenCode sessions. It cannot be undone from this page.</p>
          <p id="agent-line-current" class="text-sm" role="status">Loading current line...</p>
          <div id="agent-line-migrate-controls" style="display:none;">
          <label class="flex items-center gap-2 text-sm" style="margin-top:12px;">
            <input id="agent-line-confirm" type="checkbox" />
            <span>I understand this is a one-way migration and cannot be switched back.</span>
          </label>
          <div class="flex items-center gap-2" style="margin-top:8px;">
            <input id="agent-line-typed" type="text" placeholder="Type MIGRATE to confirm" style="max-width:220px;" />
            <button id="agent-line-migrate" type="button" onclick="migrateToNative()" disabled>Migrate to native</button>
          </div>
          </div>
          <p id="agent-line-status" class="text-sm text-muted" role="status" />
        </div>
        <script>{html`
          const settingsToggle = document.getElementById("update-notifications");
          const settingsButton = document.getElementById("save-settings");
          const settingsStatus = document.getElementById("settings-status");
          const agentLineCurrent = document.getElementById("agent-line-current");
          const agentLineMigrate = document.getElementById("agent-line-migrate");
          const agentLineConfirm = document.getElementById("agent-line-confirm");
          const agentLineTyped = document.getElementById("agent-line-typed");
          const agentLineStatus = document.getElementById("agent-line-status");
          const agentLineControls = document.getElementById("agent-line-migrate-controls");
          let currentAgentLine = null;
          let canMigrate = false;

          async function loadOpenChamberSettings() {
            try {
              const response = await fetch("/api/openchamber/settings");
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "Failed to load settings");
              settingsToggle.checked = data.showOpenCodeUpdateNotifications;
              settingsButton.disabled = false;
            } catch (error) {
              settingsStatus.textContent = error instanceof Error ? error.message : "Failed to load settings";
            }
          }

          async function saveOpenChamberSettings() {
            settingsButton.disabled = true;
            settingsStatus.textContent = "Saving...";
            try {
              const response = await fetch("/api/openchamber/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ showOpenCodeUpdateNotifications: settingsToggle.checked }),
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "Failed to save settings");
              settingsStatus.textContent = "Saved";
            } catch (error) {
              settingsStatus.textContent = error instanceof Error ? error.message : "Failed to save settings";
            } finally {
              settingsButton.disabled = false;
            }
          }

          function refreshMigrateButton() {
            const typedOk = agentLineTyped.value.trim() === "MIGRATE";
            const checkedOk = agentLineConfirm.checked === true;
            agentLineMigrate.disabled = !(canMigrate && typedOk && checkedOk);
          }
          agentLineConfirm.addEventListener("change", refreshMigrateButton);
          agentLineTyped.addEventListener("input", refreshMigrateButton);

          async function loadAgentLine() {
            try {
              const response = await fetch("/api/openchamber/agent-line");
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "Failed to load agent line");
              currentAgentLine = data.line;
              canMigrate = data.canMigrate === true;
              if (data.migrated === true) {
                agentLineCurrent.textContent = "Current line: native (migrated, locked)";
                agentLineStatus.textContent = "Migration complete. OMO line is retired and cannot be switched back from this page.";
              } else {
                agentLineCurrent.textContent = "Current line: " + data.line + " (" + data.source + ")";
                if (data.source === "env") agentLineStatus.textContent = "NATIVE_AGENTS is explicitly set; migration is locked until the container environment is cleared.";
                else agentLineStatus.textContent = "One-way migration: OMO to native. Sessions will be interrupted.";
              }
              agentLineControls.style.display = canMigrate ? "" : "none";
              refreshMigrateButton();
            } catch (error) {
              agentLineCurrent.textContent = error instanceof Error ? error.message : "Failed to load agent line";
            }
          }

          async function migrateToNative() {
            if (!canMigrate) return;
            if (agentLineTyped.value.trim() !== "MIGRATE" || agentLineConfirm.checked !== true) return;
            if (!confirm("Migrate OMO to native agents and restart ai-dev? This is one-way and cannot be switched back. Active OpenCode sessions will be interrupted.")) return;
            agentLineMigrate.disabled = true;
            agentLineStatus.textContent = "Migrating to native and restarting ai-dev...";
            try {
              const response = await fetch("/api/openchamber/migrate-to-native", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirm: true }),
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "Failed to migrate");
              currentAgentLine = data.line;
              canMigrate = false;
              agentLineControls.style.display = "none";
              agentLineCurrent.textContent = "Current line: native (migrated, locked)";
              agentLineStatus.textContent = "Migrated. ai-dev restarted; existing sessions were interrupted.";
            } catch (error) {
              agentLineStatus.textContent = error instanceof Error ? error.message : "Failed to migrate";
              await loadAgentLine();
            } finally {
              refreshMigrateButton();
            }
          }

          loadOpenChamberSettings();
          loadAgentLine();
        `}</script>
      </div>
    </Layout>
  );
}
