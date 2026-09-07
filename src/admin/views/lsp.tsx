import { html, raw } from "hono/html";
import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import type { LspDriftReason } from "../lib/lsp-reconciler";

export interface LspRow {
  readonly serverKey: string;
  readonly npmPackage: string;
  readonly command: readonly string[];
  readonly extensions: readonly string[];
  readonly defaultEnabled: boolean;
  readonly builtinBacked: boolean;
  readonly enabled: boolean;
  readonly pinnedVersion: string | null;
  readonly installedVersion: string | null;
  readonly inLspBlock: boolean;
  readonly drift: LspDriftReason | null;
}

const DRIFT_INFO: Record<LspDriftReason, { icon: string; label: string; title: string }> = {
  missing_install: { icon: "⤓", label: "Not installed", title: "Enabled server is not installed" },
  version_mismatch: { icon: "⚠", label: "Version mismatch", title: "Installed version differs from the pinned version" },
  not_enabled_in_lsp: { icon: "⚙", label: "Not in lsp block", title: "Enabled server is missing from opencode.json lsp block" },
};

const IN_SYNC_INFO = { icon: "✓", label: "In sync", title: "Server is in sync" };

function driftBadge(drift: LspDriftReason | null) {
  if (drift === null)
    return (
      <span class="badge badge-success lsp-status" title={IN_SYNC_INFO.title} aria-label={`${IN_SYNC_INFO.label} — ${IN_SYNC_INFO.title}`}>
        <span aria-hidden="true">{IN_SYNC_INFO.icon}</span>
        <span class="visually-hidden">{IN_SYNC_INFO.label}</span>
      </span>
    );
  const info = DRIFT_INFO[drift];
  return (
    <span class="badge badge-warning lsp-status" title={info.title} aria-label={`${info.label} — ${info.title}`}>
      <span aria-hidden="true">{info.icon}</span>
      <span class="visually-hidden">{info.label}</span>
    </span>
  );
}

export type LspGroupKey = "builtin" | "enabled" | "available";

export interface LspGroup {
  readonly key: LspGroupKey;
  readonly label: string;
  readonly caption: string;
  readonly rows: readonly LspRow[];
}

function compareLspRows(a: LspRow, b: LspRow): number {
  const aDrifted = a.drift !== null ? 0 : 1;
  const bDrifted = b.drift !== null ? 0 : 1;
  if (aDrifted !== bDrifted) return aDrifted - bDrifted;
  return a.serverKey.localeCompare(b.serverKey);
}

function sortLspRows(rows: readonly LspRow[]): LspRow[] {
  return [...rows].sort(compareLspRows);
}

export function groupLspRows(rows: readonly LspRow[]): readonly LspGroup[] {
  const builtin = sortLspRows(rows.filter((r) => r.builtinBacked));
  const enabled = sortLspRows(rows.filter((r) => !r.builtinBacked && r.enabled));
  const available = sortLspRows(rows.filter((r) => !r.builtinBacked && !r.enabled));
  return [
    {
      key: "builtin",
      label: "Built-in",
      caption: "Always enabled via OpenCode built-in; pin a version to override.",
      rows: builtin,
    },
    {
      key: "enabled",
      label: "Enabled",
      caption: "Enabled optional servers installed via BUN_PACKAGES.",
      rows: enabled,
    },
    {
      key: "available",
      label: "Available",
      caption: "Disabled optional servers available to enable.",
      rows: available,
    },
  ];
}

function LspRowCells({ row }: { row: LspRow }) {
  return (
    <>
      <td data-label="Server">
        <strong>{row.serverKey}</strong>
        <br />
        <span class="text-xs text-muted"><code>{row.npmPackage}</code> · <code>{row.command.join(" ")}</code></span>
      </td>
      <td data-label="Extensions" class="text-sm">{row.extensions.map((e) => <code key={e} style="margin-right:4px;">{e}</code>)}</td>
      <td data-label="Version">
        <div class="flex items-center gap-2">
          <select class="lsp-version" data-pkg={row.npmPackage} data-row={row.serverKey}>
            <option value="__loaded" hidden></option>
          </select>
          {row.pinnedVersion ? <span class="text-xs text-muted">pinned {row.pinnedVersion}</span> : null}
        </div>
      </td>
      <td data-label="Installed">
        {row.installedVersion !== null
          ? <code>{row.installedVersion}</code>
          : <span class="text-muted">—</span>}
      </td>
      <td data-label="Status">{driftBadge(row.drift)}</td>
      <td data-label="Enabled">
        {row.builtinBacked ? (
          <span
            class="badge lsp-builtin"
            title="Always enabled via OpenCode built-in; pin a version to override."
            role="img"
            aria-label="Built-in server. Always enabled via OpenCode built-in; pin a version to override."
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Zm6 4v3" />
            </svg>
            <span class="visually-hidden">Built-in</span>
          </span>
        ) : (
          <label class="switch">
            <input type="checkbox" class="lsp-toggle" data-row={row.serverKey} checked={row.enabled} />
            <span class="slider" />
          </label>
        )}
      </td>
    </>
  );
}

const LspContent: FC<{ rows: readonly LspRow[] }> = ({ rows }) => {
  const groups = groupLspRows(rows);
  return (
  <div>
    <div class="flex items-center justify-between" style="margin-bottom:16px;">
      <h2>LSP Server Management</h2>
      <button id="apply-btn" class="btn-primary" type="button">Apply Changes</button>
    </div>
    <p class="text-sm text-muted" style="margin-bottom:20px;">
      Manage the language servers OpenCode uses. Enable a server to install it (via BUN_PACKAGES) and
      add it to the generated <code>opencode.json</code> lsp block; pin a version to install that exact
      release. Versions are detected from the npm registry, newest first.
    </p>

      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`lsp-group-${group.key}`} style="margin-bottom:24px;">
          <div class="flex items-center gap-2" style="margin-bottom:8px;">
            <h3 id={`lsp-group-${group.key}`} style="margin:0;font-size:1rem;font-weight:600;">
              {group.label} <span class="text-sm text-muted" style="font-weight:400;">({group.rows.length})</span>
            </h3>
          </div>
          <p class="text-sm text-muted" style="margin-bottom:10px;">{group.caption}</p>
          <div class="card lsp-table-wrap">
            <table id={group.key === "builtin" ? "lsp-table" : `lsp-table-${group.key}`} data-group={group.key}>
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Extensions</th>
                  <th>Version</th>
                  <th>Installed</th>
                  <th>Status</th>
                  <th>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.length === 0 ? (
                  <tr>
                    <td colspan={6} class="text-sm text-muted" style="text-align:center;padding:16px;">No servers in this group</td>
                  </tr>
                ) : (
                  group.rows.map((row) => (
                    <tr key={row.serverKey} data-key={row.serverKey}>
                      <LspRowCells row={row} />
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      ))}

    <script>{html`
      var ROWS = ${raw(JSON.stringify(rows))};
      var loaded = {};   // serverKey -> full version list (descending)
      var shownCount = {}; // serverKey -> number of options currently shown

      var SHOW = 10;

      var state = {};
      ROWS.forEach(function (r) {
        state[r.serverKey] = { enabled: r.enabled, version: r.pinnedVersion || null };
      });

      function row(key) { return document.querySelector('tr[data-key="' + key + '"]'); }
      function select(key) { return row(key).querySelector('.lsp-version'); }

      function setDriftBadge(key, drift) {
        var cell = row(key).querySelector('td:nth-child(5)');
        var syncIcon = "✓";
        var syncLabel = "In sync";
        var syncTitle = "Server is in sync";
        var labels = {
          missing_install: { icon: "⤓", label: "Not installed", title: "Enabled server is not installed" },
          version_mismatch: { icon: "⚠", label: "Version mismatch", title: "Installed version differs from the pinned version" },
          not_enabled_in_lsp: { icon: "⚙", label: "Not in lsp block", title: "Enabled server is missing from opencode.json lsp block" }
        };
        if (!drift) {
          cell.innerHTML = '<span class="badge badge-success lsp-status" title="' + syncTitle + '" aria-label="' + syncLabel + ' — ' + syncTitle + '">'
            + '<span aria-hidden="true">' + syncIcon + '</span>'
            + '<span class="visually-hidden">' + syncLabel + '</span></span>';
          return;
        }
        var l = labels[drift];
        cell.innerHTML = '<span class="badge badge-warning lsp-status" title="' + l.title + '" aria-label="' + l.label + ' — ' + l.title + '">'
          + '<span aria-hidden="true">' + l.icon + '</span>'
          + '<span class="visually-hidden">' + l.label + '</span></span>';
      }

      function buildOptions(key) {
        var versions = loaded[key] || [];
        var count = (shownCount[key] !== undefined) ? shownCount[key] : Math.min(SHOW, versions.length);
        var opts = '<option value="">Latest (unpinned)</option>';
        for (var i = 0; i < count; i++) {
          var v = versions[i];
          opts += '<option value="' + v + '"' + (state[key].version === v ? ' selected' : '') + '>' + v + '</option>';
        }
        if (count < versions.length) {
          opts += '<option value="__more">Show more (' + (versions.length - count) + ' more)…</option>';
        }
        return opts;
      }

      function renderSelect(key) {
        var sel = select(key);
        sel.innerHTML = buildOptions(key);
        var pinned = state[key].version;
        if (pinned) sel.value = pinned;
      }

      function loadVersions(key) {
        if (loaded[key]) { renderSelect(key); return; }
        var sel = select(key);
        sel.innerHTML = '<option value="">Loading…</option>';
        var pkg = sel.getAttribute('data-pkg');
        fetch('/api/lsp/versions?package=' + encodeURIComponent(pkg)).then(function (res) {
          return res.json().then(function (data) {
            if (!res.ok) { sel.innerHTML = '<option value="">' + (data.error || 'Error') + '</option>'; return; }
            loaded[key] = data.versions || [];
            shownCount[key] = Math.min(SHOW, loaded[key].length);
            renderSelect(key);
          });
        }).catch(function () {
          sel.innerHTML = '<option value="">Failed to load versions</option>';
        });
      }

      document.querySelectorAll('.lsp-version').forEach(function (sel) {
        var key = sel.getAttribute('data-row');
        loadVersions(key);
        sel.addEventListener('change', function () {
          var val = sel.value;
          if (val === '__more') {
            shownCount[key] = loaded[key].length;
            renderSelect(key);
            return;
          }
          state[key].version = val === '' ? null : val;
        });
      });

      document.querySelectorAll('.lsp-toggle').forEach(function (toggle) {
        toggle.addEventListener('change', function () {
          var key = toggle.getAttribute('data-row');
          state[key].enabled = toggle.checked;
        });
      });

      function collectOverrides() {
        var overrides = {};
        Object.keys(state).forEach(function (key) {
          overrides[key] = { enabled: state[key].enabled, version: state[key].version };
        });
        return overrides;
      }

      async function save() {
        var res = await fetch('/api/lsp', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ overrides: collectOverrides() })
        });
        if (!res.ok) {
          var err = await res.json().catch(function () { return {}; });
          throw new Error('Save failed: ' + (err.error || 'unknown error'));
        }
      }

      document.getElementById('apply-btn').addEventListener('click', async function () {
        var btn = document.getElementById('apply-btn');
        btn.disabled = true;
        btn.textContent = 'Applying…';
        try {
          await save();
          var res = await fetch('/api/lsp/apply', { method: 'POST' });
          var data = await res.json();
          if (!data.ok) { alert('Apply failed: ' + (data.error || 'unknown error')); return; }
          alert('LSP changes applied successfully.');
          window.location.reload();
        } catch (err) {
          alert('Apply error: ' + err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Apply Changes';
        }
      });
    `}</script>
  </div>
  );
};

export function LspPage(rows: readonly LspRow[]) {
  return (
    <Layout title="LSP Servers" currentPath="/lsp">
      <LspContent rows={rows} />
    </Layout>
  );
}
