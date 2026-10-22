import { html, raw } from "hono/html";
import type { FC } from "hono/jsx";
import { Layout } from "./layout";

interface SecretMeta {
  key: string;
  description: string;
  hasValue: boolean;
  activationStatus: "immediate" | "restart_required";
  category: string;
  note?: string;
}

const SECRET_KEYS = ["ADMIN_PASSWORD", "OPENCHAMBER_UI_PASSWORD", "OPENCODE_SERVER_PASSWORD"];

const SECRET_DISPLAY: Record<string, { label: string; icon: string }> = {
  ADMIN_PASSWORD: { label: "Admin Password", icon: "🔐" },
  OPENCHAMBER_UI_PASSWORD: { label: "OpenChamber UI Password", icon: "🔑" },
  OPENCODE_SERVER_PASSWORD: { label: "OpenCode Server Password", icon: "🔑" },
};

function activationLabel(status: string): { text: string; className: string } {
  if (status === "immediate") {
    return { text: "✅ Takes effect immediately", className: "text-success" };
  }
  return { text: "⏳ Restart container required", className: "text-warning" };
}

const SecretsContent: FC<{ meta: SecretMeta[] }> = ({ meta }) => (
  <div>
    <div class="flex items-center justify-between mb-4">
      <h2>Secrets</h2>
      <span class="text-sm text-muted">Sensitive credentials managed separately from environment variables</span>
    </div>
    {meta.map((s) => {
      const display = SECRET_DISPLAY[s.key] ?? { label: s.key, icon: "🔑" };
      const act = activationLabel(s.activationStatus);
      return (
        <div class="card secret-card" key={s.key} data-key={s.key}>
          <div class="flex items-center gap-2 mb-4">
            <span style="font-size:1.5rem;">{display.icon}</span>
            <div>
              <h3 style="margin:0;font-size:var(--text-lg);">{display.label}</h3>
              <span class="text-sm text-muted">{s.description}</span>
            </div>
          </div>
          <div class="secret-value-row mb-4">
            <div class="masked-value" data-key={s.key}>
              <span class="masked" style="font-size:var(--text-xl);letter-spacing:0.1em;font-family:var(--font-mono);">••••••••</span>
              <span class="revealed" style="font-size:var(--text-base);font-family:var(--font-mono);word-break:break-all;" />
            </div>
          </div>
          <div class="secret-actions">
            <span class={`badge ${act.className.replace("text-", "badge-")}`} style="align-self:center;">{act.text}</span>
            <div class="secret-buttons">
              <button type="button" class="btn-outline btn-secret-show" onclick={`showSecretValue('${s.key}')`}>Show</button>
              <button type="button" class="btn-outline btn-secret-edit" onclick={`openSecretEdit('${s.key}')`}>Edit</button>
            </div>
          </div>
          {s.note && (
            <div class="secret-note mt-4">
              <button type="button" class="btn-outline btn-note-toggle" onclick="toggleNote(this)" style="font-size:var(--text-sm);padding:4px 8px;">
                ℹ️ Learn more
              </button>
              <div class="note-content" style="display:none;margin-top:8px;padding:12px;background:rgba(0,0,0,0.2);border-radius:var(--radius);font-size:var(--text-sm);color:var(--text-muted);line-height:1.6;">
                {s.note}
              </div>
            </div>
          )}
        </div>
      );
    })}
    <div id="edit-modal" class="modal-overlay" style="display:none;">
      <div class="modal">
        <h3 id="modal-title">Edit Secret</h3>
        <div class="form-group"><label for="edit-key">Name</label><input type="text" id="edit-key" readonly /></div>
        <div class="form-group"><label for="edit-value">New Value</label><input type="password" id="edit-value" autocomplete="new-password" /></div>
        <div id="edit-status" class="text-sm text-muted" style="margin-bottom:8px;" />
        <div class="flex gap-2" style="justify-content:flex-end;flex-wrap:wrap;">
          <button type="button" class="btn-outline" onclick="closeSecretEdit()">Cancel</button>
          <button type="button" onclick="saveSecret()">Save</button>
        </div>
      </div>
    </div>
    <script>{html`
      var secretsMeta = ${raw(JSON.stringify(meta))};

      function showSecretValue(key) {
        var card = document.querySelector('.secret-card[data-key="' + key + '"]');
        var mv = card.querySelector('.masked-value');
        var revealed = mv.querySelector('.revealed');
        var btn = card.querySelector('.btn-secret-show');

        if (mv.classList.contains('show')) {
          mv.classList.remove('show');
          btn.textContent = 'Show';
          return;
        }

        fetch('/api/secrets/' + encodeURIComponent(key) + '/value')
          .then(function(r) { return r.json(); })
          .then(function(d) {
            revealed.textContent = d.value || '(empty)';
            mv.classList.add('show');
            btn.textContent = 'Hide';
          })
          .catch(function() { alert('Failed to fetch secret value'); });
      }

      function openSecretEdit(key) {
        document.getElementById('edit-key').value = key;
        document.getElementById('edit-value').value = '';
        document.getElementById('edit-status').textContent = '';
        document.getElementById('edit-modal').style.display = 'flex';
        setTimeout(function() { document.getElementById('edit-value').focus(); }, 100);
      }

      function closeSecretEdit() {
        document.getElementById('edit-modal').style.display = 'none';
      }

      function saveSecret() {
        var key = document.getElementById('edit-key').value;
        var value = document.getElementById('edit-value').value;
        var statusEl = document.getElementById('edit-status');

        if (!value) {
          statusEl.textContent = 'Value cannot be empty';
          statusEl.style.color = 'var(--danger)';
          return;
        }

        statusEl.textContent = 'Saving...';
        statusEl.style.color = 'var(--text-muted)';

        fetch('/api/secrets/' + encodeURIComponent(key), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: value }),
        })
          .then(function(r) {
            if (!r.ok) { return r.json().then(function(d) { throw new Error(d.error || 'Failed to save'); }); }
            return r.json();
          })
          .then(function(d) {
            closeSecretEdit();
            var meta = secretsMeta.find(function(m) { return m.key === key; });
            if (meta) meta.hasValue = true;
            location.reload();
          })
          .catch(function(err) {
            statusEl.textContent = err.message;
            statusEl.style.color = 'var(--danger)';
          });
      }

      function toggleNote(btn) {
        var content = btn.parentElement.querySelector('.note-content');
        var isHidden = content.style.display === 'none' || !content.style.display;
        content.style.display = isHidden ? 'block' : 'none';
        btn.textContent = isHidden ? 'ℹ️ Hide details' : 'ℹ️ Learn more';
      }

      document.addEventListener('click', function(e) {
        var modal = document.getElementById('edit-modal');
        if (e.target === modal) closeSecretEdit();
      });
    `}</script>
  </div>
);

export function SecretsPage(envVars: Record<string, string>) {
  const meta: SecretMeta[] = SECRET_KEYS.map((key) => {
    const entry = envVars[key];
    return {
      key,
      description: {
        ADMIN_PASSWORD: "Admin dashboard login password",
        OPENCHAMBER_UI_PASSWORD: "OpenChamber Web UI login password",
        OPENCODE_SERVER_PASSWORD: "OpenCode API authentication",
      }[key] ?? "",
      hasValue: !!entry && entry.length > 0,
      activationStatus: key === "ADMIN_PASSWORD" ? ("immediate" as const) : ("restart_required" as const),
      category: key === "ADMIN_PASSWORD" ? "admin" : "service",
      ...(key === "OPENCODE_SERVER_PASSWORD"
        ? {
            note: "OpenCode port is not exposed externally in standard deployment. This password provides defense-in-depth for internal API access and is essential when connecting to a remote OpenCode server via OPENCODE_HOST.",
          }
        : {}),
    };
  });

  return (
    <Layout title="Secrets" currentPath="/secrets">
      <SecretsContent meta={meta} />
    </Layout>
  );
}
