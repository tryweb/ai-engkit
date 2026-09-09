import { html, raw } from "hono/html";
import { Layout } from "./layout";

interface RegistryKeyView {
  id: string;
  masked: string;
  note: string;
  active: boolean;
}

interface ProviderMetaView {
  name: string;
  label: string;
  npm: string;
  baseURL: string;
  hasApiKey: boolean;
  keyManagement: boolean;
  authStoreKeyPresent: boolean;
  oauthManaged: boolean;
  oauthConnected: boolean;
  virtual: boolean;
  registry: {
    keyCount: number;
    activeKeyId: string | null;
    keys: RegistryKeyView[];
  };
}

interface ProvidersMeta {
  invalid: boolean;
  error: string | null;
  providers: ProviderMetaView[];
}

const OPENAI_VERIFY_URL = "https://auth.openai.com/codex/device";

function getProviderIcon(name: string) {
  switch (name) {
    case "google":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
        </svg>
      );
    case "openai":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="color: #10a37f;">
          <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 8.487a4.485 4.485 0 0 1 2.365-1.98v5.67a.78.78 0 0 0 .388.676l5.843 3.372-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 8.487zm16.597 3.855l-5.843-3.372 2.02-1.168a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.674 8.105v-5.679a.79.79 0 0 0-.404-.677zm2.72-4.143a4.472 4.472 0 0 1 .535 3.014l-.142-.085-4.783-2.759a.77.77 0 0 0-.78 0l-5.843 3.369V9.406a.08.08 0 0 1 .033-.062L15.52 6.55a4.5 4.5 0 0 1 6.136 1.648l.001.001zm-11.45-3.047A4.476 4.476 0 0 1 13.082 6.2l-.141.081-4.779 2.758a.795.795 0 0 0-.392.681v6.737L5.75 15.289a.071.071 0 0 1-.038-.052V9.654a4.504 4.504 0 0 1 4.492-4.495zm1.18 4.887l2.846-1.642 2.846 1.642v3.284l-2.846 1.642-2.846-1.642v-3.284z" />
        </svg>
      );
    case "nvidia":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="#76B900" aria-hidden="true">
          <path d="M8.939 8.922h-.007C6.88 8.94 4.887 9.878 3.518 11.452c-1.222 1.405-1.85 3.193-1.77 5.034.08 1.84.864 3.559 2.21 4.84 1.345 1.28 3.12 1.956 4.996 1.902 2.658-.077 5.09-1.393 6.452-3.492l-2.09-1.267c-.984 1.517-2.741 2.469-4.662 2.525-1.355.039-2.637-.449-3.608-1.373-.972-.924-1.537-2.164-1.595-3.491-.058-1.328.396-2.617 1.277-3.63 1.015-1.166 2.47-1.848 3.993-1.862h.005c2.257-.02 4.341 1.295 5.289 3.348l2.188-.996c-1.31-2.836-4.188-4.654-7.307-4.626h-.005zm.139-4.469h-.011C5.176 4.482 1.83 6.074.209 8.784c-1.59 2.657-1.745 5.86-.425 8.788 1.32 2.927 3.869 5.05 6.993 5.823 3.124.773 6.438.256 9.094-1.42 2.657-1.675 4.397-4.423 4.773-7.538.376-3.115-.623-6.223-2.741-8.528L16.29 7.43c1.614 1.758 2.375 4.128 2.088 6.505-.287 2.377-1.614 4.473-3.642 5.751-2.027 1.279-4.555 1.674-6.938 1.084-2.383-.59-4.328-2.209-5.334-4.442-1.007-2.233-.889-4.677.324-6.704C3.998 7.597 6.551 6.383 9.4 6.368h.008c2.936-.015 5.707 1.348 7.424 3.651l1.89-1.554C16.507 5.674 13.067 4.437 9.078 4.453zM9.014 0C5.39.02 1.954 1.705.02 4.482l1.91 1.529C3.418 3.832 6.136 2.348 9.014 2.333c4.764-.025 9.097 2.668 11.285 7.01l2.13-1.071C19.866 3.09 14.678-.025 9.014 0z" />
        </svg>
      );
    case "openrouter":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M16 12l-4-4-4 4" />
          <path d="M12 16V8" />
        </svg>
      );
    case "opencode-go":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
          <line x1="14" y1="4" x2="10" y2="20" />
        </svg>
      );
    default:
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
          <line x1="6" y1="6" x2="6.01" y2="6" />
          <line x1="6" y1="18" x2="6.01" y2="18" />
        </svg>
      );
  }
}

function getProviderKeyPlaceholder(name: string): string {
  switch (name) {
    case "google":
      return "AIzaSy... (Google AI Studio API Key)";
    case "openai":
      return "sk-... or sk-proj-... (OpenAI API Key)";
    case "nvidia":
      return "nvapi-... (NVIDIA API Key)";
    case "openrouter":
      return "sk-or-v1-... (OpenRouter API Key)";
    case "opencode-go":
      return "sk-... (OpenCode Go API Key)";
    default:
      return "New API key";
  }
}

export function ProvidersPage({
  meta,
  entries,
}: {
  meta: ProvidersMeta;
  entries: Record<string, unknown>;
}) {
  const boot = html`<script>
    window.providersBoot = {
      entries: ${raw(JSON.stringify(entries).replace(/</g, "\\u003c"))},
      meta: ${raw(JSON.stringify(meta.providers).replace(/</g, "\\u003c"))}
    };
  </script>`;

  const totalCount = meta.providers.length;
  const activeCount = meta.providers.filter((p) => p.authStoreKeyPresent || p.oauthConnected || p.hasApiKey).length;
  const keyManagedCount = meta.providers.filter((p) => p.keyManagement).length;

  return (
    <Layout title="Providers">
      <div class="flex items-center justify-between mb-4">
        <h2>Providers</h2>
        <div class="flex" style="gap: 8px;">
          <button type="button" class="btn" onclick="openAddProvider()">Add Provider</button>
          <button type="button" class="btn-outline" onclick="restartAiDev()">Restart ai-dev</button>
        </div>
      </div>
      <p class="text-sm text-muted" style="margin-bottom: 16px;">
        Providers are defined in <code>OPENCODE_PROVIDER</code> and injected into <code>opencode.json</code> on startup.
        Key-managed providers (Opencode Go, OpenAI API, Google, Nvidia API, OpenRouter) keep their API keys in the provider-keys registry instead;
        the registry-selected key is written to the opencode auth store and applied on restart.
      </p>

      {!meta.invalid && totalCount > 0 && (
        <div class="providers-overview-grid mb-4">
          <div class="provider-stat-card">
            <div class="text-xs text-muted" style="text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Configured Providers</div>
            <div class="stat-number" style="font-size: var(--text-2xl);">{totalCount}</div>
          </div>
          <div class="provider-stat-card">
            <div class="text-xs text-muted" style="text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Active / Connected</div>
            <div class="stat-number text-success" style="font-size: var(--text-2xl);">{activeCount}</div>
          </div>
          <div class="provider-stat-card">
            <div class="text-xs text-muted" style="text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Key-Managed Providers</div>
            <div class="stat-number" style="font-size: var(--text-2xl);">{keyManagedCount}</div>
          </div>
        </div>
      )}

      {meta.invalid && (
        <div class="card danger-card" style="margin-bottom: 16px;">
          <b>OPENCODE_PROVIDER is not valid JSON:</b> {meta.error} — fix it in the{" "}
          <a href="/env">Environment editor</a> or via the raw JSON editor below.
        </div>
      )}
      {meta.providers.length === 0 && !meta.invalid && (
        <div class="card" style="margin-bottom: 16px;">
          <p style="margin-bottom: 12px;">No providers configured yet.</p>
          <button type="button" class="btn" onclick="openAddProvider()">Add Provider</button>
        </div>
      )}
      {meta.providers.map((p) => {
        const isConnected = p.authStoreKeyPresent || p.oauthConnected || p.hasApiKey;
        return (
          <div key={p.name} class={`card secret-card provider-card ${isConnected ? "provider-card--active" : ""}`} data-provider={p.name} style="margin-bottom: 16px;">
            <div class="provider-card__header flex" style="justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                <div class="provider-icon-wrapper">
                  {getProviderIcon(p.name)}
                </div>
                <div>
                  <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                    <h3 style="margin: 0; font-size: 1.15rem; font-weight: 600;">{p.label}</h3>
                    {p.virtual && <span class="badge badge-warning">auth-managed</span>}
                    {p.npm && <span class="text-muted" style="font-size: 12px; font-family: var(--font-mono);">{p.npm}</span>}
                  </div>
                </div>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                {p.keyManagement ? (
                  <span class={`status-pill ${isConnected ? "status-pill--success" : "status-pill--neutral"}`}>
                    <span class="status-dot">●</span>
                    {p.oauthConnected ? "OAuth connected" : p.authStoreKeyPresent ? "auth store: API key present" : "auth store: no API key"}
                  </span>
                ) : (
                  <span class={`status-pill ${p.hasApiKey ? "status-pill--success" : "status-pill--neutral"}`}>
                    <span class="status-dot">●</span>
                    {p.hasApiKey ? "API key set" : "no API key"}
                  </span>
                )}
              </div>
            </div>
            {!p.virtual && (
              <div class="flex" style="gap: 32px; margin-bottom: 12px; flex-wrap: wrap;">
                <div>
                  <div class="text-muted" style="font-size: 13px;">Base URL</div>
                  <div>{p.baseURL || "—"}</div>
                </div>
                <div>
                  <div class="text-muted" style="font-size: 13px;">API Key</div>
                  <div>{p.hasApiKey ? <span class="badge badge-success">set</span> : "—"}</div>
                </div>
              </div>
            )}
            {p.keyManagement && (
              <div style="margin-bottom: 12px;">
                <div class="flex" style="justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; flex-wrap: wrap;">
                  <div>
                    <b style="font-size: 14px;">{p.label} keys in registry ({p.registry.keyCount})</b>
                    <span class="key-activation-status text-muted" style="font-size: 13px; margin-left: 8px;"></span>
                  </div>
                  <span class={`badge ${p.authStoreKeyPresent ? "badge-success" : "badge-warning"}`}>
                    {p.authStoreKeyPresent ? "auth store: API key present" : "auth store: no API key"}
                  </span>
                </div>
                {p.registry.keys.length === 0 && (
                  <div class="text-muted" style="font-size: 13px; margin-bottom: 8px;">
                    No keys stored. Add one below, or import the key already present in the auth store.
                  </div>
                )}
                {p.registry.keys.map((k) => (
                  <div key={k.id} class="key-row" data-key-id={k.id} data-active={k.active ? "true" : "false"}>
                    <input
                      type="radio"
                      class="key-row__select"
                      name={`active-${p.name}`}
                      checked={k.active}
                      onclick={`selectActiveKey('${p.name}', '${k.id}')`}
                      aria-label={`Select ${k.masked} as the active key`}
                    />
                    <span class="masked-value key-row__value" title={k.masked}>
                      <span class="masked">{k.masked}</span>
                      <span class="revealed"></span>
                    </span>
                    {k.active && <span class="badge badge-success">Selected in registry</span>}
                    <input
                      type="text"
                      class="key-note-input key-row__note"
                      value={k.note}
                      placeholder="Note"
                      aria-label={`Note for ${k.masked}`}
                    />
                    <span class="key-row__actions">
                      <button type="button" class="btn-outline" onclick={`saveKeyNote('${p.name}', '${k.id}', this)`}>
                        Save
                      </button>
                      <button type="button" class="btn-outline" onclick={`toggleKeyValue('${p.name}', '${k.id}', this)`}>Show</button>
                      <button type="button" class="btn-outline" onclick={`deleteKey('${p.name}', '${k.id}')`}>Delete</button>
                    </span>
                  </div>
                ))}
                <div class="key-add-row" style="margin-top: 10px;">
                  <input
                    type="password"
                    class="key-add-input"
                    placeholder={getProviderKeyPlaceholder(p.name)}
                    autocomplete="new-password"
                  />
                  <input type="text" class="key-add-note-input" placeholder="Note (optional)" />
                  <button type="button" class="btn-outline" onclick={`addKey('${p.name}')`}>Add key</button>
                  {p.registry.keyCount === 0 && (
                    <button type="button" class="btn-outline" onclick={`importKey('${p.name}')`}>Import from auth store</button>
                  )}
                </div>
              </div>
            )}
            {p.oauthManaged && (
              <div class="oauth-panel" data-provider={p.name} data-connected={p.oauthConnected ? "true" : "false"}>
                <div class="flex" style="justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; flex-wrap: wrap;">
                  <div>
                    <b style="font-size: 14px;">ChatGPT Pro/Plus</b>
                    {p.oauthConnected && <span class="badge badge-success" style="margin-left: 8px;">OAuth connected</span>}
                  </div>
                  {p.oauthConnected ? (
                    <button type="button" class="btn-danger" onclick={`disconnectOAuth('${p.name}')`}>Disconnect ChatGPT</button>
                  ) : (
                    <button type="button" class="btn" onclick={`startOAuth('${p.name}')`}>Connect ChatGPT Pro/Plus</button>
                  )}
                </div>
                <p class="text-sm text-muted">
                  {p.oauthConnected
                    ? "OpenAI models run through your ChatGPT Pro/Plus subscription — no API key needed."
                    : `Prerequisites: an active ChatGPT Pro or Plus subscription. You will be shown a code and asked to enter it at ${OPENAI_VERIFY_URL}. Connecting replaces any stored OpenAI API key credential.`}
                </p>
                <div id="oauth-flow" class="oauth-flow" hidden>
                  <div class="oauth-code-display">
                    <span class="text-muted text-sm">Code</span>
                    <div class="oauth-code" id="oauth-user-code"></div>
                  </div>
                  <p class="text-sm" style="margin: 8px 0;">
                    Open <a id="oauth-verify-link" href={OPENAI_VERIFY_URL} target="_blank" rel="noopener noreferrer">auth.openai.com/codex/device</a> and enter the code above.
                  </p>
                  <div id="oauth-poll-status" class="text-sm text-muted" style="margin-bottom: 8px;"></div>
                  <div class="flex" style="gap: 8px;">
                    <button type="button" class="btn-outline" onclick="cancelOAuth()">Cancel</button>
                    <button type="button" id="oauth-apply" class="btn" onclick="applyOAuth()" hidden>Finish connecting</button>
                  </div>
                </div>
              </div>
            )}
            <div class="flex" style="justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span class="badge badge-warning">Restart required to apply</span>
              <div class="flex" style="gap: 8px;">
                {!p.virtual && <button type="button" class="btn-outline" onclick={`openProviderEdit('${p.name}')`}>Edit</button>}
                {!p.virtual && <button type="button" class="btn-outline" onclick={`deleteProvider('${p.name}')`}>Delete</button>}
              </div>
            </div>
          </div>
        );
      })}

      <div id="edit-modal" class="modal-overlay" style="display: none;">
        <div class="modal" style="max-width: 560px;">
          <h3 style="margin-top: 0;">Edit Provider</h3>
          <div class="form-group">
            <label for="edit-name">Provider name (key)</label>
            <input type="text" id="edit-name" readonly />
          </div>
          <div class="form-group">
            <label for="edit-label">Display name</label>
            <input type="text" id="edit-label" oninput="patchField('label', this.value)" />
          </div>
          <div class="form-group">
            <label for="edit-npm">npm package <span class="text-danger">*</span></label>
            <input type="text" id="edit-npm" oninput="patchField('npm', this.value)" placeholder="@ai-sdk/openai-compatible" />
            <div id="edit-npm-error" class="text-danger" style="font-size: 12px; margin-top: 4px; display: none;"></div>
          </div>
          <div class="form-group">
            <label for="edit-baseurl">Base URL</label>
            <input type="text" id="edit-baseurl" oninput="patchField('baseURL', this.value)" placeholder="https://…" />
            <div id="edit-baseurl-error" class="text-danger" style="font-size: 12px; margin-top: 4px; display: none;"></div>
          </div>
          <div class="form-group">
            <label for="edit-apikey">
              API key <span class="text-muted" style="font-size: 12px;">(leave empty to keep existing)</span>
            </label>
            <input type="password" id="edit-apikey" oninput="patchField('apiKey', this.value)" autocomplete="new-password" />
            <div id="edit-apikey-error" class="text-danger" style="font-size: 12px; margin-top: 4px; display: none;"></div>
          </div>
          <div class="form-group">
            <label for="edit-raw">Raw JSON (authoritative)</label>
            <textarea
              id="edit-raw"
              rows={8}
              spellcheck={false}
              oninput="onRawInput(this.value)"
              style="width: 100%; font-family: var(--font-mono); font-size: 13px;"
            />
          </div>
          <div id="edit-status" class="text-muted" style="font-size: 13px; margin-bottom: 8px;"></div>
          <div class="flex" style="justify-content: flex-end; gap: 8px;">
            <button type="button" class="btn-outline" onclick="closeProviderEdit()">Cancel</button>
            <button type="button" onclick="saveProvider()">Save</button>
          </div>
        </div>
      </div>

      <div id="add-modal" class="modal-overlay" style="display: none;">
        <div class="modal" style="max-width: 560px;">
          <h3 style="margin-top: 0;">Add Provider</h3>
          <div class="form-group">
            <label for="add-name">Provider name (key) <span class="text-danger">*</span></label>
            <input type="text" id="add-name" oninput="validateAddField('name', this.value)" placeholder="my-provider" />
            <div id="add-name-error" class="text-danger" style="font-size: 12px; margin-top: 4px; display: none;"></div>
          </div>
          <div class="form-group">
            <label for="add-label">Display name</label>
            <input type="text" id="add-label" oninput="validateAddField('label', this.value)" placeholder="My Provider" />
          </div>
          <div class="form-group">
            <label for="add-npm">npm package <span class="text-danger">*</span></label>
            <input type="text" id="add-npm" oninput="validateAddField('npm', this.value)" placeholder="@ai-sdk/openai-compatible" />
            <div id="add-npm-error" class="text-danger" style="font-size: 12px; margin-top: 4px; display: none;"></div>
          </div>
          <div class="form-group">
            <label for="add-baseurl">Base URL <span class="text-danger">*</span></label>
            <input type="text" id="add-baseurl" oninput="validateAddField('baseURL', this.value)" placeholder="https://api.example.com/v1" />
            <div id="add-baseurl-error" class="text-danger" style="font-size: 12px; margin-top: 4px; display: none;"></div>
          </div>
          <div class="form-group">
            <label for="add-apikey">API key</label>
            <input type="password" id="add-apikey" oninput="validateAddField('apiKey', this.value)" autocomplete="new-password" />
            <div id="add-apikey-error" class="text-danger" style="font-size: 12px; margin-top: 4px; display: none;"></div>
          </div>
          <div class="form-group">
            <label for="add-raw">Raw JSON (authoritative)</label>
            <textarea
              id="add-raw"
              rows={8}
              spellcheck={false}
              oninput="onAddRawInput(this.value)"
              style="width: 100%; font-family: var(--font-mono); font-size: 13px;"
            />
          </div>
          <div id="add-status" class="text-muted" style="font-size: 13px; margin-bottom: 8px;"></div>
          <div class="flex" style="justify-content: flex-end; gap: 8px;">
            <button type="button" class="btn-outline" onclick="closeAddProvider()">Cancel</button>
            <button type="button" onclick="saveNewProvider()">Add Provider</button>
          </div>
        </div>
      </div>
      {boot}
      <script src="/static/providers-page.js"></script>
    </Layout>
  );
}
