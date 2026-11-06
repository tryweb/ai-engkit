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
          <p class="text-sm text-muted" style="margin-bottom:12px;">Switch between the native agents and oh-my-openagent (OMO) configuration. This experimental change restarts ai-dev and interrupts active OpenCode sessions.</p>
          <p id="agent-line-current" class="text-sm" role="status">Loading current line...</p>
          <button id="agent-line-toggle" type="button" onclick="toggleAgentLine()" disabled>Switch agent line</button>
          <p class="text-sm text-muted" style="margin-top:12px;">To roll back, use this switch again to return to the previous line. If Admin reports a restart failure, the marker is restored automatically; retry after checking ai-dev.</p>
          <p id="agent-line-status" class="text-sm text-muted" role="status" />
        </div>
        <script>{html`
          const settingsToggle = document.getElementById("update-notifications");
          const settingsButton = document.getElementById("save-settings");
          const settingsStatus = document.getElementById("settings-status");
          const agentLineCurrent = document.getElementById("agent-line-current");
          const agentLineToggle = document.getElementById("agent-line-toggle");
          const agentLineStatus = document.getElementById("agent-line-status");
          let currentAgentLine = null;

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

          async function loadAgentLine() {
            try {
              const response = await fetch("/api/openchamber/agent-line");
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "Failed to load agent line");
              currentAgentLine = data.line;
              agentLineCurrent.textContent = "Current line: " + data.line + " (" + data.source + ")";
              agentLineToggle.disabled = data.source === "env";
              if (data.source === "env") agentLineStatus.textContent = "NATIVE_AGENTS is explicitly set; change the container environment to switch lines.";
            } catch (error) {
              agentLineCurrent.textContent = error instanceof Error ? error.message : "Failed to load agent line";
            }
          }

          async function toggleAgentLine() {
            const target = currentAgentLine === "native" ? "OMO" : "native agents";
            if (!confirm("Switch to " + target + " and restart ai-dev? Active OpenCode sessions will be interrupted.")) return;
            agentLineToggle.disabled = true;
            agentLineStatus.textContent = "Switching and restarting ai-dev...";
            try {
              const response = await fetch("/api/openchamber/agent-line", { method: "POST" });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "Failed to switch agent line");
              currentAgentLine = data.line;
              agentLineCurrent.textContent = "Current line: " + data.line + " (" + data.source + ")";
              agentLineStatus.textContent = "Switched. ai-dev restarted; existing sessions were interrupted.";
            } catch (error) {
              agentLineStatus.textContent = error instanceof Error ? error.message : "Failed to switch agent line";
              await loadAgentLine();
            } finally {
              agentLineToggle.disabled = false;
            }
          }

          loadOpenChamberSettings();
          loadAgentLine();
        `}</script>
      </div>
    </Layout>
  );
}
