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
            <button type="button" id="save-settings" onclick="saveOpenChamberSettings()" disabled>Save settings</button>
            <span id="settings-status" class="text-sm text-muted" role="status" />
          </div>
        </div>
        <div class="card" style="max-width:720px;margin-top:16px;">
          <h3 style="margin-bottom:8px;">Interface language</h3>
          <p class="text-sm text-muted">Language is stored by OpenChamber in each browser's local storage. Set it from OpenChamber Settings on every browser or device where you use it.</p>
        </div>
        <script>{html`
          const settingsToggle = document.getElementById("update-notifications");
          const settingsButton = document.getElementById("save-settings");
          const settingsStatus = document.getElementById("settings-status");

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

          loadOpenChamberSettings();
        `}</script>
      </div>
    </Layout>
  );
}
