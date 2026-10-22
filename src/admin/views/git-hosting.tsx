import type { FC } from "hono/jsx";
import { html } from "hono/html";
import type { GitHostingAuthState, GitLabAuthHostState } from "../lib/git-hosting-auth-state";
import { Layout } from "./layout";

interface GlabInstance {
  hostname: string;
  username: string;
  authenticated: boolean;
}

const rotationGuidance: Record<string, string> = {
  invalid_expired: "The credential is expired or invalid. Reauthorize this host, then retry rotation.",
  insufficient_scope: "The credential lacks the required scope. Reauthorize with a token that can manage credentials.",
  unsupported_version: "This GitLab version does not support rotation. Reauthorize this host manually.",
  impersonation_unconfirmed: "Rotation needs impersonation confirmation. Reauthorize this host after confirming the policy.",
  ambiguous_rotation: "Rotation could not be confirmed. Reauthorize this host and retry.",
  persistence_failed: "Rotation completed but status could not be saved. Reauthorize or retry after checking storage.",
  unreachable: "The GitLab host could not be reached. Reauthorize when it is available and retry.",
};

function hostTone(host: GitLabAuthHostState | undefined): string {
  if (!host || host.validity === "unhealthy") return "badge-danger";
  return host.days_remaining !== null && host.days_remaining <= 7 ? "badge-warning" : "badge-success";
}

function hostLabel(host: GitLabAuthHostState | undefined): string {
  if (!host || host.validity === "unhealthy") return "failed";
  return host.days_remaining !== null && host.days_remaining <= 7 ? "expiring soon" : "healthy";
}

const GitLabHealthRow: FC<{ hostname: string; state?: GitLabAuthHostState }> = ({ hostname, state }) => {
  const resultId = `rotate-result-${hostname.replace(/[^a-zA-Z0-9]/g, "-")}`;
  return (
    <div class="form-group" style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
        <strong><code>{hostname}</code></strong>
        <span class={`badge ${hostTone(state)}`}>{hostLabel(state)}</span>
      </div>
      <div class="text-sm text-muted" style="margin-top:4px;">
        {state?.checked_at ? `Checked ${state.checked_at}` : "No health check recorded"}
        {state?.days_remaining !== null && state?.days_remaining !== undefined ? ` · ${state.days_remaining} days remaining` : ""}
      </div>
      {state?.error_code ? <p class="text-sm text-muted">{rotationGuidance[state.error_code] || "Reauthorize this host and retry."}</p> : null}
      <button type="button" class="btn-outline" style="margin-top:8px;" onclick={`rotateGlab(${JSON.stringify(hostname)}, '${resultId}')`}>Rotate credential</button>
      <span id={resultId} class="text-sm text-muted" style="margin-left:8px;" aria-live="polite" />
    </div>
  );
};

const GlabInstanceRow: FC<{ inst: GlabInstance }> = ({ inst }) => (
  <tr>
    <td><code>{inst.hostname}</code></td>
    <td>{inst.username || <span class="text-muted">—</span>}</td>
    <td><span class={`badge ${inst.authenticated ? "badge-success" : "badge-warning"}`}>{inst.authenticated ? "authenticated" : "not authenticated"}</span></td>
    <td><button type="button" class="btn-outline" style="padding:3px 6px;font-size:0.7rem;" onclick={`removeGlabInstance('${inst.hostname}')`}>Remove</button></td>
  </tr>
);

const GitHostingContent: FC<{ ghStatus: string; glabInstances: GlabInstance[]; glabStatus: string; config: Record<string, string>; authState: GitHostingAuthState }> = ({ ghStatus, glabInstances, glabStatus, config, authState }) => {
  const ghAuthenticated = ghStatus === "authenticated";
  const ghState = authState.github;
  return (
    <div>
      <h2 style="margin-bottom:24px;">Git Hosting</h2>
      <h3 style="margin-bottom:12px;">Git Configuration</h3>
      <div class="grid-2">
      <div class="card">
        <h3>Identity</h3>
        <div class="form-group">
          <label for="user-name">User Name</label>
          <input type="text" id="user-name" value={config["user.name"] || ""} />
        </div>
        <div class="form-group">
          <label for="user-email">User Email</label>
          <input type="email" id="user-email" value={config["user.email"] || ""} />
        </div>
        <button type="button" onclick="saveGitConfig()">Save</button>
      </div>
      <div class="card">
        <h3>Current Config</h3>
        <pre>{Object.entries(config).map(([k, v]) => `${k}=${v}`).join("\n") || "No config set"}</pre>
      </div>
      </div>

      <h3 style="margin-bottom:12px;margin-top:24px;">GitHub CLI Authentication</h3>
      <div class="card">
        <div id="gh-user-info" />
        <h3>Status: <span class={`badge ${ghAuthenticated ? "badge-success" : "badge-warning"}`}>{ghStatus}</span></h3>
        <p class="text-sm text-muted">Validity: {ghState.validity}; {ghState.expiry_unknown ? "expiry unknown" : `expiry ${ghState.expiry}`}. {ghState.checked_at ? `Checked ${ghState.checked_at}.` : "No health check recorded."}</p>
        {ghState.expiry_unknown ? <p class="text-sm text-muted">Use the GitHub device flow below to reauthorize when access is invalid or revoked.</p> : null}
        {ghAuthenticated
          ? <button type="button" onclick="ghLogout()" class="btn-danger">Disconnect GitHub</button>
          : <button type="button" onclick="startGhAuth()" class="btn">Connect GitHub</button>
        }
      </div>
      <div id="auth-flow" style="display:none;" class="card">
        <h3>Device Code</h3>
        <p class="text-sm text-muted">Open the verification URL and enter the code below.</p>
        <div id="device-code-display" class="device-code" />
        <p class="text-sm text-muted mb-4">Visit: <a id="verification-url" href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">https://github.com/login/device</a></p>
        <div class="countdown" id="countdown" />
        <div id="poll-status" class="text-sm text-muted mt-4" />
      </div>

      <h3 style="margin-bottom:12px;margin-top:24px;">GitLab CLI Authentication</h3>
      <div class="card">
        <h3>Credential health</h3>
        {glabInstances.length > 0
          ? glabInstances.map((inst) => <GitLabHealthRow key={inst.hostname} hostname={inst.hostname} state={authState.gitlab.find((host) => host.hostname === inst.hostname)} />)
          : <p class="text-muted">No GitLab health checks recorded.</p>}
      </div>
      <div class="card">
        <h3>Configured Instances</h3>
        {glabInstances.length > 0
          ? <table>
              <tr><th>Hostname</th><th>User</th><th>Status</th><th></th></tr>
              {glabInstances.map(inst => <GlabInstanceRow key={inst.hostname} inst={inst} />)}
            </table>
          : <p class="text-muted">No GitLab instances configured.</p>
        }
      </div>

      <div class="card">
        <h3>Add Instance</h3>
        <div class="form-group">
          <label for="hostname">GitLab Hostname</label>
          <input type="text" id="hostname" placeholder="gitlab-238.ichiayi.com" />
        </div>
        <div class="form-group">
          <label for="token">Personal Access Token</label>
          <div style="display:flex;gap:4px;">
            <input type="password" id="token" placeholder="glpat-..." style="flex:1;" />
            <button type="button" class="btn-outline" style="padding:4px 10px;font-size:0.75rem;" onclick="toggleGlabTokenVis()">Show</button>
          </div>
        </div>
        <button type="button" onclick="startGlabAuth()" class="btn">Connect</button>
      </div>

      <script>{html`
        async function saveGitConfig() {
          const name = document.getElementById("user-name").value.trim();
          const email = document.getElementById("user-email").value.trim();
          let ok = true;
          if (name) {
            const r1 = await fetch("/api/git/config", {
              method: "PUT", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ key: "user.name", value: name }),
            }); if (!r1.ok) ok = false;
          }
          if (email) {
            const r2 = await fetch("/api/git/config", {
              method: "PUT", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ key: "user.email", value: email }),
            }); if (!r2.ok) ok = false;
          }
          if (ok) { location.reload(); } else { alert("Failed to save config"); }
        }
      `}</script>
      <script>{html`
        fetch("/api/auth/gh/user").then(r => r.json()).then(function(u) {
          if (u.login) {
            var el = document.getElementById("gh-user-info");
            el.innerHTML = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border);">' +
              '<img src="' + u.avatar_url + '" alt="" style="width:48px;height:48px;border-radius:50%;" />' +
              '<div><strong style="font-size:1.05rem;">' + u.login + '</strong>' +
              (u.name ? '<br/><span class="text-muted" style="font-size:0.85rem;">' + u.name + '</span>' : '') +
              (u.scopes && u.scopes.length ? '<br/><span class="text-muted" style="font-size:0.75rem;">Scopes: ' + u.scopes.join(", ") + '</span>' : '') +
              '</div></div>';
          }
        });
        let ghPollInterval = null;
        async function startGhAuth() {
          document.getElementById("auth-flow").style.display = "block";
          const res = await fetch("/api/auth/gh/start", { method: "POST" });
          const data = await res.json();
          document.getElementById("device-code-display").textContent = data.device_code || "---";
          document.getElementById("verification-url").textContent = data.verification_uri || "https://github.com/login/device";
          document.getElementById("verification-url").href = data.verification_uri || "https://github.com/login/device";
          let countdown = 900;
          document.getElementById("countdown").textContent = "Code expires in " + Math.floor(countdown / 60) + ":" + String(countdown % 60).padStart(2, "0");
          const ghCountInterval = setInterval(() => { countdown--; if (countdown <= 0) clearInterval(ghCountInterval);
            document.getElementById("countdown").textContent = "Code expires in " + Math.floor(countdown / 60) + ":" + String(countdown % 60).padStart(2, "0"); }, 1000);
          ghPollInterval = setInterval(async () => {
            const statusRes = await fetch("/api/auth/gh/status");
            const statusData = await statusRes.json();
            if (statusData.status === "authenticated") {
              clearInterval(ghPollInterval); clearInterval(ghCountInterval);
              document.getElementById("poll-status").innerHTML = '<strong class="text-success">✓ Authenticated!</strong>';
              setTimeout(() => location.reload(), 1500);
            } else {
              document.getElementById("poll-status").textContent = "Waiting for authentication...";
            }
          }, 3000);
        }
        async function ghLogout() {
          await fetch("/api/auth/gh/logout", { method: "POST" });
          location.reload();
        }
        function toggleGlabTokenVis() {
          const el = document.getElementById("token");
          const btn = el.nextElementSibling;
          if (el.type === "password") { el.type = "text"; btn.textContent = "Hide"; }
          else { el.type = "password"; btn.textContent = "Show"; }
        }
        async function startGlabAuth() {
          const hostname = document.getElementById("hostname").value.trim();
          if (!hostname) { alert("Please enter a GitLab host URL"); return; }
          const token = document.getElementById("token").value.trim();
          if (!token) { alert("Please enter a Personal Access Token"); return; }
          const btn = event.target;
          btn.disabled = true; btn.textContent = "Connecting...";
          const res = await fetch("/api/auth/glab/start", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hostname, token }),
          });
          if (res.ok) { location.reload(); }
          else { const d = await res.json(); alert(d.error || "Auth failed"); btn.disabled = false; btn.textContent = "Connect"; }
        }
        async function removeGlabInstance(hostname) {
          if (!confirm("Remove \\"" + hostname + "\\"? Logout from this GitLab instance.")) return;
          await fetch("/api/auth/glab/logout", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hostname }),
          });
          location.reload();
        }
        async function rotateGlab(hostname, resultId) {
          const button = event.target;
          const result = document.getElementById(resultId);
          button.disabled = true;
          button.textContent = "Rotating...";
          result.textContent = "";
          try {
            const response = await fetch("/api/auth/glab/rotate", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ hostname }),
            });
            const data = await response.json();
            if (data.ok) {
              result.textContent = data.rotated ? "Credential rotated." : "Credential is already current.";
              result.className = "text-sm text-success";
            } else {
              result.textContent = "Rotation failed: " + (data.errorCode || "unknown error") + ". Reauthorize this host and retry.";
              result.className = "text-sm text-danger";
            }
          } catch {
            result.textContent = "Rotation failed. Reauthorize this host and retry.";
            result.className = "text-sm text-danger";
          } finally {
            button.disabled = false;
            button.textContent = "Rotate credential";
          }
        }
      `}</script>
    </div>
  );
};

export function GitHostingPage(ghStatus: string, glabInstances: GlabInstance[], glabStatus: string, config: Record<string, string>, authState: GitHostingAuthState = { gitlab: [], github: { validity: "unreachable", expiry: "unknown", expiry_known: false, expiry_unknown: true, checked_at: "" } }) {
  return (
    <Layout title="Git Hosting" currentPath="/auth/git-hosting">
      <GitHostingContent ghStatus={ghStatus} glabInstances={glabInstances} glabStatus={glabStatus} config={config} authState={authState} />
    </Layout>
  );
}
