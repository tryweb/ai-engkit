import { html, raw } from "hono/html";
import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import type { AgentModelEntry } from "../lib/agent-models";

interface AgentModelsState {
  agents: AgentModelEntry[];
  catalog: string[];
  providers: string[];
  hasPassword: boolean;
  catalogAvailable: boolean;
  unhealthyModels?: readonly string[];
  unhealthyReasons?: Readonly<Record<string, string>>;
}

const VARIANTS = ["low", "medium", "high", "xhigh", "max"];

const AgentModelsContent: FC<{ state: AgentModelsState }> = ({ state }) => {
  const json = raw(
    JSON.stringify({
      agents: state.agents,
      catalog: state.catalog,
      providers: state.providers,
      hasPassword: state.hasPassword,
      catalogAvailable: state.catalogAvailable,
      unhealthyModels: state.unhealthyModels ?? [],
      unhealthyReasons: state.unhealthyReasons ?? {},
    }).replace(/</g, "\\u003c"),
  );
  return (
    <div>
      <div class="flex items-center justify-between mb-4">
        <h2>Agent Models</h2>
        <span id="restart-status" class="text-sm text-muted" style="align-self:center;"></span>
      </div>

      <p class="text-sm text-muted" style="margin-top:12px;">
        Per-subagent model overrides for the AI agents invoked by your primary agent (e.g. general).
        The primary agent's own model and internal mechanism agents (compaction, summary, title,
        build) are not configurable here.
      </p>
      <p class="text-sm text-muted" style="margin-top:8px;">
        <strong>Assigned model</strong> is OpenCode's current agent assignment. <strong>Last successful request</strong>
        is the model metadata returned by the most recent real request. A model is <strong>effective</strong> only when both
        match the configured model and its provider is connected.
      </p>

      {!state.hasPassword && (
        <div class="card" style="border-color:var(--danger);margin-bottom:16px;">
          <strong>Prerequisite missing:</strong> <code>OPENCODE_SERVER_PASSWORD</code> is not set in{" "}
          <code>.env</code>. Assigned models, request verification, and "Save &amp; Restart" are unavailable until it is
          set (see the Environment page).
        </div>
      )}

      {!state.catalogAvailable && (
        <div class="card" style="border-color:var(--danger);margin-bottom:16px;">
          <strong>Model catalog unavailable:</strong> Live provider models and the local OpenCode model catalog
          could not be read. Model selection is disabled until the catalog becomes available.
        </div>
      )}

      <div id="batch-bar" class="card" style="display:none; margin-bottom:16px; background:rgba(245,158,11,0.1); border-color:var(--warning);">
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <span id="batch-count" class="text-sm" style="font-weight:600;"></span>
          <div style="display:flex; gap:8px; align-items:center;">
            <label style="display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted);">
              <input type="checkbox" id="verify-inference" /> Verify usability (may consume quota)
            </label>
            <button id="btn-discard" class="btn-outline" onclick="discardPending()" style="padding:6px 12px;">Discard</button>
            <button id="btn-apply" onclick="applyPending()" style="padding:6px 16px; background:var(--warning); color:#000; font-weight:600;">Apply</button>
          </div>
        </div>
        <div id="batch-status" class="text-sm" style="margin-top:8px;"></div>
        <div id="verify-warning" class="text-sm" style="display:none; margin-top:6px; color:var(--warning);">⚠ Inference verification sends a real model request and may consume provider quota or incur cost. Readiness verification (default) checks configuration without inference.</div>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <fieldset id="provider-filter" style="border:0;padding:0;margin:0;">
          <legend style="font-weight:600;margin-bottom:6px;">Suggestion providers</legend>
          <p class="text-sm text-muted" style="margin:0 0 12px;">
            Generate a reasonable configured model from the selected providers. Manual edits are kept.
          </p>
          <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin-bottom:12px;">
            <label for="suggestion-mode" style="display:inline-flex;align-items:center;gap:8px;font-weight:600;">
              Mode
              <select
                id="suggestion-mode"
                aria-label="Suggestion mode"
                disabled={!state.catalogAvailable || !state.hasPassword}
                style={{
                  padding: "4px 8px",
                  borderRadius: "6px",
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  opacity: state.catalogAvailable && state.hasPassword ? 1 : 0.5,
                  cursor: state.catalogAvailable && state.hasPassword ? "pointer" : "not-allowed",
                }}
              >
                <option value="free" selected>Free</option>
                <option value="economy">Economy</option>
                <option value="performance">Performance</option>
              </select>
            </label>
            <label style="display:inline-flex;align-items:center;gap:8px;">
              <input id="provider-all" type="checkbox" checked disabled={!state.catalogAvailable || !state.hasPassword} />
              All providers
            </label>
            <span id="provider-options" style="display:inline-flex;flex-wrap:wrap;gap:12px 16px;">
              {state.providers.map((provider) => (
                <label style="display:inline-flex;align-items:center;gap:8px;">
                  <input class="provider-option" type="checkbox" value={provider} checked disabled={!state.catalogAvailable || !state.hasPassword} />
                  {provider}
                </label>
              ))}
            </span>
          </div>
          <button
            id="btn-generate"
            class="btn-outline"
            onclick="generateSuggestions()"
            disabled={!state.catalogAvailable || !state.hasPassword || state.providers.length === 0}
            style="margin-top:14px;"
          >
            Generate suggestions
          </button>
          <span id="provider-hint" class="text-sm text-muted" style="margin-left:10px;">
            All connected providers are selected.
          </span>
          <div id="suggestion-meta" class="text-sm text-muted" style="margin-top:12px;display:none;overflow-wrap:anywhere;word-break:break-word;" aria-live="polite"></div>
          <div id="suggestion-list" role="list" style="margin-top:12px;display:none;overflow-wrap:anywhere;word-break:break-word;min-width:0;"></div>
        </fieldset>
      </div>

      <div class="card">
        <style>{`
          .agent-models-table-disabled td {
            opacity: 0.4;
            pointer-events: none;
            cursor: not-allowed;
            background-color: rgba(0, 0, 0, 0.1);
          }
          .agent-models-table-disabled td:last-child .btn-outline {
            opacity: 0.4 !important;
            cursor: not-allowed !important;
          }
          .modal-overlay.disabled {
            opacity: 0.6;
            pointer-events: none;
          }
          .modal-overlay.disabled .modal {
            filter: grayscale(50%);
          }
          .restart-banner {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: linear-gradient(135deg, var(--warning) 0%, #d97706 100%);
            color: #000;
            padding: 12px 20px;
            text-align: center;
            font-weight: 600;
            z-index: 9999;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            animation: pulse 2s infinite;
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.8; }
          }
          .restart-banner .spinner {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid #000;
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-right: 8px;
            vertical-align: middle;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          .dirty-dot {
            display: inline-block;
            width: 8px;
            height: 8px;
            background: var(--warning);
            border-radius: 50%;
            margin-left: 6px;
            vertical-align: middle;
          }
        `}</style>
        <div class="agent-models-table-wrap">
          <table id="agent-models-table">
          <tr>
            <th>Subagent</th>
            <th>Configured model</th>
            <th>Assigned model</th>
            <th>Last successful request</th>
            <th>Source / status</th>
            <th></th>
          </tr>
          {state.agents.map((a) => (
            <tr data-agent={a.name}>
              <td data-label="Subagent"><code>{a.name}</code></td>
              <td data-label="Configured model">
                <span class="configured-value">
                    {a.configured.length === 0 ? (
                    <span class="text-muted">—</span>
                  ) : (
                    (() => {
                      const e = a.configured[0];
                      if (!e) return "—";
                      const suffix = a.configured.length > 1 ? ` (+${a.configured.length - 1} fallback${a.configured.length > 2 ? "s" : ""})` : "";
                      return `${e.model}${e.variant ? ` (${e.variant})` : ""}${suffix}`;
                    })()
                  )}
                </span>
                <span class="dirty-dot" style="display:none;" title="Pending change"></span>
                <div class="pending-value text-sm" style="display:none; color:var(--warning);"></div>
                <div class="batch-result text-sm" style="display:none;"></div>
              </td>
              <td data-label="Assigned model">
                {a.resolved ? (
                  <code>
                    {a.resolved.modelID} @ {a.resolved.providerID}
                  </code>
                ) : (
                  <span class="text-muted">n/a</span>
                )}
              </td>
              <td data-label="Last successful request">
                {a.requestVerified ? (
                  <code>
                    {a.requestVerified.modelID} @ {a.requestVerified.providerID}
                  </code>
                ) : (
                  <span class="text-muted">not verified</span>
                )}
              </td>
              <td data-label="Source / status">
                {a.invalid && (
                  <span
                    title="Config has keys the OMO plugin no longer recognizes (e.g. permission). Fix or remove them for overrides to take effect."
                    style={{ color: "#ef4444", fontSize: "0.75rem", marginRight: "0.5rem" }}
                  >
                    ⚠ invalid
                  </span>
                )}
                {" "}
                <span
                  style={{
                    color:
                      a.source === "configured"
                        ? "var(--success)"
                        : a.source === "inherited"
                          ? "var(--warning)"
                          : "#94a3b8",
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.03em",
                  }}
                >
                  {a.source}
                </span>
                <span class="text-muted" style="font-size:0.75rem;margin-left:0.5rem;">
                  {a.effectiveness}
                </span>
              </td>
              <td data-label="Actions">
                <button
                  class="btn-outline"
                  style={{
                    padding: "4px 8px",
                    fontSize: "0.75rem",
                    opacity: state.catalogAvailable && state.hasPassword ? 1 : 0.5,
                    cursor: state.catalogAvailable && state.hasPassword ? "pointer" : "not-allowed",
                  }}
                  title={!state.catalogAvailable ? "Model catalog unavailable" : !state.hasPassword ? "OpenCode password unavailable" : undefined}
                  disabled={!state.catalogAvailable || !state.hasPassword}
                  onclick="editAgent(this)"
                >
                  Edit
                </button>
              </td>
            </tr>
          ))}
          </table>
        </div>
      </div>

      <div id="edit-modal" class="modal-overlay" style="display:none;">
        <div class="modal" style="max-width:580px;">
          <h3 id="modal-title" style="margin-bottom:4px;">Edit primary model</h3>
          <p class="text-sm text-muted" style="margin-bottom:12px;">
            Sets the model the subagent runs on. Fallback chains are not supported until the OMO
            plugin honors them. Changes are collected locally — press Apply to restart once.
          </p>
          <div id="model-rows"></div>
          <div class="flex gap-2" style="justify-content:flex-end;margin-top:14px;">
            <button id="btn-cancel" class="btn-outline" onclick="closeModal()">Cancel</button>
            <button id="btn-clear" class="btn-outline" style="display:none;" onclick="clearAgent()">Use automatic model</button>
            <button id="btn-save" onclick="saveAgent()">Save to pending</button>
          </div>
          <div id="save-result" class="text-sm" style="margin-top:12px;"></div>
        </div>
      </div>

      <script>{html`
        var agentModelsState = ${json};
        var editAgentName = null;
        var pending = new Map();
        var applyInProgress = false;

        function selectedProviders() {
          var options = Array.from(document.querySelectorAll('.provider-option'));
          var selected = options.filter(function (option) { return option.checked; }).map(function (option) { return option.value; });
          return selected.length === options.length ? null : selected;
        }

        function selectedMode() {
          var el = document.getElementById('suggestion-mode');
          var v = el ? el.value : 'free';
          return (v === 'free' || v === 'economy' || v === 'performance') ? v : 'free';
        }

        function sameEntries(left, right) {
          if (left.length !== right.length) return false;
          return left.every(function (entry, index) {
            var other = right[index];
            return other !== undefined && entry.model === other.model && (entry.variant || '') === (other.variant || '');
          });
        }

        function escapeHtml(s) {
          return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function syncProviderSelection() {
          var all = document.getElementById('provider-all');
          var options = Array.from(document.querySelectorAll('.provider-option'));
          var selectedCount = options.filter(function (option) { return option.checked; }).length;
          if (options.length > 0 && selectedCount === 0) {
            options.forEach(function (option) { option.checked = true; });
            selectedCount = options.length;
          }
          all.checked = selectedCount === options.length;
          all.indeterminate = selectedCount > 0 && selectedCount < options.length;
          document.getElementById('provider-hint').textContent = all.checked
            ? 'All connected providers are selected.'
            : selectedCount + ' provider' + (selectedCount === 1 ? '' : 's') + ' selected.';
        }

        function configureProviderSelection() {
          var all = document.getElementById('provider-all');
          all.addEventListener('change', function () {
            document.querySelectorAll('.provider-option').forEach(function (option) { option.checked = all.checked; });
            syncProviderSelection();
          });
          document.querySelectorAll('.provider-option').forEach(function (option) {
            option.addEventListener('change', syncProviderSelection);
          });
          syncProviderSelection();
        }

        function renderSuggestionMeta(data) {
          var metaEl = document.getElementById('suggestion-meta');
          if (!metaEl) return;
          var isExplicit = data && typeof data.mode === 'string' && typeof data.sourceStatus === 'string';
          if (!isExplicit) {
            metaEl.style.display = 'none';
            metaEl.textContent = '';
            return;
          }
          var parts = [];
          parts.push('Mode: ' + escapeHtml(data.mode));
          parts.push('Source: ' + escapeHtml(data.sourceStatus));
          if (data.sourceAgeMs !== null && data.sourceAgeMs !== undefined) {
            var sec = Math.round(data.sourceAgeMs / 1000);
            parts.push('Age: ' + sec + 's');
          }
          if (Array.isArray(data.warnings) && data.warnings.length > 0) {
            parts.push('Warnings: ' + data.warnings.map(escapeHtml).join(', '));
          }
          if (Array.isArray(data.providers) && data.providers.length > 0) {
            parts.push('Providers: ' + data.providers.map(escapeHtml).join(', '));
          }
          metaEl.innerHTML = parts.join(' · ');
          metaEl.style.display = 'block';
        }

        function renderSuggestionList(data) {
          var listEl = document.getElementById('suggestion-list');
          if (!listEl) return;
          var isExplicit = data && typeof data.mode === 'string' && typeof data.sourceStatus === 'string';
          if (!isExplicit) {
            listEl.style.display = 'none';
            listEl.innerHTML = '';
            return;
          }
          var suggestions = data.suggestions || {};
          var agentNames = agentModelsState.agents.map(function (a) { return a.name; });
          var htmlOut = '';
          for (var i = 0; i < agentNames.length; i++) {
            var agent = agentNames[i];
            var sug = suggestions[agent];
            if (sug && typeof sug.model === 'string' && sug.model.indexOf('/') !== -1) {
              var reason = sug.reason ? escapeHtml(sug.reason) : '';
              var heuristicLabel = sug.heuristic ? ' <span style="color:var(--warning);font-weight:600;">⚠ heuristic</span>' : '';
              var meta = sug.metadata || {};
              var metaParts = [];
              if (meta.inputPrice !== null && meta.inputPrice !== undefined) metaParts.push('in:' + meta.inputPrice);
              if (meta.outputPrice !== null && meta.outputPrice !== undefined) metaParts.push('out:' + meta.outputPrice);
              if (meta.contextLimit !== null && meta.contextLimit !== undefined) metaParts.push('ctx:' + meta.contextLimit);
              if (meta.outputLimit !== null && meta.outputLimit !== undefined) metaParts.push('outLim:' + meta.outputLimit);
              if (meta.reasoning !== null && meta.reasoning !== undefined) metaParts.push('reasoning:' + meta.reasoning);
              if (meta.toolCall !== null && meta.toolCall !== undefined) metaParts.push('toolCall:' + meta.toolCall);
              if (meta.deprecated) metaParts.push('deprecated');
              var metaStr = metaParts.length ? ' [' + metaParts.map(escapeHtml).join(', ') + ']' : '';
              var pendingLabel = pending.has(agent) ? ' (pending kept)' : '';
              htmlOut += '<div role="listitem" class="text-sm" style="padding:6px 0;border-top:1px solid var(--border);min-width:0;"><strong>' + escapeHtml(agent) + '</strong>: <code>' + escapeHtml(sug.model) + '</code>' + heuristicLabel + pendingLabel + '<br><span class="text-muted">' + reason + metaStr + '</span></div>';
            } else {
              htmlOut += '<div role="listitem" class="text-sm" style="padding:6px 0;border-top:1px solid var(--border);color:var(--muted);min-width:0;"><strong>' + escapeHtml(agent) + '</strong>: no candidate for ' + escapeHtml(data.mode) + ' — no eligible model</div>';
            }
          }
          var extraAgents = Object.keys(suggestions).filter(function (k) { return agentNames.indexOf(k) === -1; });
          for (var j = 0; j < extraAgents.length; j++) {
            var ea = extraAgents[j];
            var esug = suggestions[ea];
            if (esug && typeof esug.model === 'string') {
              htmlOut += '<div role="listitem" class="text-sm" style="padding:6px 0;border-top:1px solid var(--border);min-width:0;"><strong>' + escapeHtml(ea) + '</strong>: <code>' + escapeHtml(esug.model) + '</code></div>';
            }
          }
          listEl.innerHTML = htmlOut;
          listEl.style.display = 'block';
        }

        async function generateSuggestions() {
          var button = document.getElementById('btn-generate');
          var status = document.getElementById('batch-status');
          var restartStatus = document.getElementById('restart-status');
          var providerInputs = document.querySelectorAll('#provider-filter input');
          var modeSelect = document.getElementById('suggestion-mode');
          var banner = document.createElement('div');
          var elapsed = 0;
          var timer;
          if (button.disabled) return;
          button.disabled = true;
          button.setAttribute('aria-busy', 'true');
          button.textContent = 'Generating…';
          providerInputs.forEach(function (input) { input.disabled = true; });
          if (modeSelect) modeSelect.disabled = true;
          banner.className = 'restart-banner';
          banner.innerHTML = '<span class="spinner"></span> Generating model suggestions… Checking provider models and preparing pending changes. <span class="probe-elapsed">0s</span>';
          document.body.appendChild(banner);
          restartStatus.innerHTML = '<span class="spinner"></span> Generating suggestions… <span class="probe-elapsed">0s</span>';
          status.style.color = '';
          status.textContent = 'Generating suggestions… The system is checking the selected providers.';
          timer = setInterval(function () {
            elapsed += 1;
            document.querySelectorAll('.probe-elapsed').forEach(function (element) { element.textContent = elapsed + 's'; });
          }, 1000);
          try {
            var providers = selectedProviders();
            var mode = selectedMode();
            var body = { mode: mode };
            if (providers !== null) body.providers = providers;
            var res = await fetch('/api/agent-models/suggestions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            var data = await res.json();
            if (!res.ok) {
              status.style.color = 'var(--danger)';
              status.textContent = data.error || ('HTTP ' + res.status);
              banner.remove();
              restartStatus.textContent = '';
              return;
            }
            var isExplicit = data && typeof data.mode === 'string' && typeof data.sourceStatus === 'string';
            var added = 0;
            var suggestions = data.suggestions || {};
            if (isExplicit) {
              renderSuggestionMeta(data);
              Object.keys(suggestions).forEach(function (agent) {
                var sug = suggestions[agent];
                if (!sug || typeof sug.model !== 'string' || sug.model.indexOf('/') === -1) return;
                var entries = [{ model: sug.model }];
                var current = agentModelsState.agents.filter(function (item) { return item.name === agent; })[0];
                var configured = current ? current.configured : [];
                if (!pending.has(agent) && !sameEntries(configured, entries)) {
                  pending.set(agent, entries);
                  added += 1;
                }
              });
              renderSuggestionList(data);
            } else {
              document.getElementById('suggestion-meta').style.display = 'none';
              document.getElementById('suggestion-list').style.display = 'none';
              Object.keys(suggestions).forEach(function (agent) {
                var suggestion = suggestions[agent] || [];
                if (!Array.isArray(suggestion)) return;
                var current = agentModelsState.agents.filter(function (item) { return item.name === agent; })[0];
                var configured = current ? current.configured : [];
                if (!pending.has(agent) && !sameEntries(configured, suggestion)) {
                  var valid = suggestion.every(function (e) { return typeof e.model === 'string' && e.model.indexOf('/') !== -1; });
                  if (!valid) return;
                  pending.set(agent, suggestion);
                  added += 1;
                }
              });
            }
            updateRowDirtyState();
            updateBatchBar();
            status.style.color = 'var(--success)';
            status.textContent = 'Added ' + added + ' suggestions. Review them, then Apply.';
            banner.innerHTML = '<span class="spinner"></span> Suggestions ready. Review the pending changes before Apply.';
            restartStatus.textContent = 'Suggestions ready ✔';
            setTimeout(function () { banner.remove(); restartStatus.textContent = ''; }, 1800);
          } catch (e) {
            status.style.color = 'var(--danger)';
            status.textContent = e instanceof Error ? e.message : 'Could not generate suggestions';
            banner.remove();
            restartStatus.textContent = '';
          } finally {
            clearInterval(timer);
            button.disabled = false;
            button.removeAttribute('aria-busy');
            button.textContent = 'Generate suggestions';
            providerInputs.forEach(function (input) {
              input.disabled = !agentModelsState.catalogAvailable || !agentModelsState.hasPassword;
            });
            if (modeSelect) modeSelect.disabled = !agentModelsState.catalogAvailable || !agentModelsState.hasPassword;
          }
        }

        configureProviderSelection();

        (function setupPolicyMode(){
          var sel = document.getElementById('suggestion-mode');
          if (!sel) return;
          fetch('/api/agent-models/policy').then(function(r){ return r.json(); }).then(function(d){ if(d && d.mode) sel.value=d.mode; }).catch(function(){});
          sel.addEventListener('change', function(){
            var mode = selectedMode();
            fetch('/api/agent-models/policy', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mode:mode})}).then(function(r){ return r.json(); }).then(function(d){ if(!d.mode) console.warn('policy save failed',d); }).catch(function(e){ console.warn(e); });
          });
        })();

        function unhealthySet() {
          var list = agentModelsState.unhealthyModels;
          return Array.isArray(list) ? list : [];
        }

        function unhealthyReason(model) {
          var reasons = agentModelsState.unhealthyReasons;
          if (reasons && typeof reasons[model] === 'string') return reasons[model];
          return 'A recent probe reported this model as retired, unavailable, or mismatched.';
        }

        function markUnhealthyRows() {
          var bad = unhealthySet();
          if (bad.length === 0) return;
          document.querySelectorAll('#agent-models-table tr[data-agent]').forEach(function (tr) {
            var agent = tr.getAttribute('data-agent');
            var configuredEl = tr.querySelector('.configured-value');
            if (!agent || !configuredEl) return;
            var info = agentModelsState.agents.filter(function (a) { return a.name === agent; })[0];
            var current = info && info.configured.length ? info.configured[0].model : null;
            var warn = tr.querySelector('.unhealthy-warn');
            if (warn) warn.remove();
            configuredEl.style.color = '';
            configuredEl.removeAttribute('title');
            if (current && bad.indexOf(current) !== -1) {
              configuredEl.style.color = 'var(--danger)';
              configuredEl.setAttribute('title', unhealthyReason(current));
              var badge = document.createElement('span');
              badge.className = 'unhealthy-warn';
              badge.style.color = 'var(--danger)';
              badge.style.fontSize = '0.75rem';
              badge.style.marginLeft = '0.5rem';
              badge.setAttribute('title', unhealthyReason(current));
              badge.textContent = '⚠ unhealthy';
              configuredEl.appendChild(badge);
            }
          });
        }

        function rowTemplate(model, variant) {
          var bad = unhealthySet();
          var modelOpts = agentModelsState.catalog.map(function (m) {
            var flagged = bad.indexOf(m) !== -1;
            return '<option value="' + escapeHtml(m) + '"' + (m === model ? ' selected' : '') +
              (flagged ? ' style="color:var(--danger);" title="' + escapeHtml('⚠ ' + unhealthyReason(m)) + '"' : '') + '>' +
              (flagged ? '⚠ ' : '') + escapeHtml(m) + '</option>';
          }).join('');
          var variantOpts = ['', ${raw(VARIANTS.map((v) => `"${v}"`).join(","))}].map(function (v) {
            return '<option value="' + v + '"' + (v === (variant || '') ? ' selected' : '') + '>' + (v || 'default') + '</option>';
          }).join('');
          return '<div class="model-row" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:center;min-width:0;">' +
            '<select class="model-select" style="flex:1;min-width:0;max-width:100%;">' + modelOpts + '</select>' +
            '<select class="variant-select" style="width:110px;max-width:100%;">' + variantOpts + '</select>' +
          '</div>';
        }

        function editAgent(button) {
          var row = button.closest('tr[data-agent]');
          var name = row ? row.getAttribute('data-agent') : null;
          if (!name) return;
          if (!agentModelsState.catalogAvailable || !agentModelsState.hasPassword) return;
          editAgentName = name;
          var agent = agentModelsState.agents.filter(function (a) { return a.name === name; })[0];
          var pendingEntries = pending.get(name);
          var rows = document.getElementById('model-rows');
          rows.innerHTML = '';
          var primary;
          if (pendingEntries !== undefined) {
            primary = pendingEntries[0] || {};
          } else {
            primary = agent && agent.configured.length ? agent.configured[0] : {};
          }
          rows.insertAdjacentHTML('beforeend', rowTemplate(primary.model || '', primary.variant || ''));
          document.getElementById('btn-clear').style.display = (pendingEntries !== undefined ? pendingEntries.length === 0 : agent && agent.configured.length) ? 'inline-block' : 'none';
          // Show pending vs configured hint
          var hint = pendingEntries !== undefined ? ' (pending: ' + (pendingEntries.length ? pendingEntries[0].model : 'automatic') + ')' : '';
          document.getElementById('modal-title').textContent = 'Edit primary model' + hint;
          document.getElementById('save-result').textContent = '';
          document.getElementById('edit-modal').style.display = 'flex';
        }

        function collectEntries() {
          var row = document.querySelector('#model-rows .model-row');
          if (!row) return [];
          var model = row.querySelector('.model-select').value;
          var variant = row.querySelector('.variant-select').value;
          if (!model) return [];
          var entry = { model: model };
          if (variant) entry.variant = variant;
          return [entry];
        }

        function closeModal() {
          document.getElementById('edit-modal').style.display = 'none';
        }

        function updateBatchBar() {
          var bar = document.getElementById('batch-bar');
          var count = document.getElementById('batch-count');
          var applyBtn = document.getElementById('btn-apply');
          if (pending.size === 0) {
            bar.style.display = 'none';
            return;
          }
          bar.style.display = 'block';
          count.textContent = pending.size + ' pending change' + (pending.size > 1 ? 's' : '');
          applyBtn.textContent = 'Apply (' + pending.size + ')';
        }

        function updateRowDirtyState() {
          document.querySelectorAll('#agent-models-table tr[data-agent]').forEach(function (tr) {
            var agent = tr.getAttribute('data-agent');
            var pendingEntries = pending.get(agent);
            var dot = tr.querySelector('.dirty-dot');
            var pendingEl = tr.querySelector('.pending-value');
            var configuredEl = tr.querySelector('.configured-value');
            var batchResultEl = tr.querySelector('.batch-result');
            if (pendingEntries !== undefined) {
              if (dot) dot.style.display = 'inline-block';
              if (pendingEl) {
                pendingEl.style.display = 'block';
                pendingEl.textContent = '→ ' + (pendingEntries.length ? pendingEntries[0].model + (pendingEntries[0].variant ? ' (' + pendingEntries[0].variant + ')' : '') : 'automatic');
              }
              if (configuredEl) configuredEl.style.opacity = '0.5';
              if (batchResultEl) batchResultEl.style.display = 'none';
            } else {
              if (dot) dot.style.display = 'none';
              if (pendingEl) pendingEl.style.display = 'none';
              if (configuredEl) configuredEl.style.opacity = '1';
            }
          });
        }

        function saveAgent() {
          var entries = collectEntries();
          pending.set(editAgentName, entries);
          updateRowDirtyState();
          updateBatchBar();
          closeModal();
          var resultEl = document.getElementById('save-result');
          // Clear any previous batch result for this agent
          var tr = document.querySelector('tr[data-agent="' + CSS.escape(editAgentName) + '"]');
          if (tr) {
            var batchResultEl = tr.querySelector('.batch-result');
            if (batchResultEl) batchResultEl.style.display = 'none';
          }
        }

        function clearAgent() {
          pending.set(editAgentName, []);
          updateRowDirtyState();
          updateBatchBar();
          closeModal();
        }

        function discardPending() {
          pending.clear();
          updateRowDirtyState();
          updateBatchBar();
          document.querySelectorAll('.batch-result').forEach(function (el) { el.style.display = 'none'; el.textContent = ''; });
          document.getElementById('batch-status').textContent = '';
          var meta = document.getElementById('suggestion-meta');
          var list = document.getElementById('suggestion-list');
          if (meta) { meta.style.display = 'none'; meta.textContent = ''; }
          if (list) { list.style.display = 'none'; list.innerHTML = ''; }
        }

        function disableTableRows() {
          var table = document.getElementById('agent-models-table');
          if (table) table.classList.add('agent-models-table-disabled');
        }

        function enableTableRows() {
          var table = document.getElementById('agent-models-table');
          if (table) table.classList.remove('agent-models-table-disabled');
          var modal = document.getElementById('edit-modal');
          if (modal) modal.classList.remove('disabled');
          var banner = document.querySelector('.restart-banner');
          if (banner) banner.remove();
        }

        function renderBatchResults(results) {
          Object.keys(results).forEach(function (agent) {
            var r = results[agent];
            var tr = document.querySelector('tr[data-agent="' + CSS.escape(agent) + '"]');
            if (!tr) return;
            var batchResultEl = tr.querySelector('.batch-result');
            if (!batchResultEl) return;
            batchResultEl.style.display = 'block';
            if (r.ok) {
              if (r.status === 'applied_with_quota_warning') {
                batchResultEl.style.color = 'var(--warning)';
                var warning = r.warning || r.error || 'provider quota exhausted';
                batchResultEl.textContent = 'applied with quota warning → ' + (r.resolved ? r.resolved.modelID + ' @ ' + r.resolved.providerID : 'n/a') + ' (' + warning + ')';
              } else {
                batchResultEl.style.color = 'var(--success)';
                batchResultEl.textContent = r.status === 'cleared' ? 'cleared → ' + (r.resolved ? r.resolved.modelID + ' @ ' + r.resolved.providerID : 'n/a') : 'verified → ' + (r.requestVerified ? r.requestVerified.modelID + ' @ ' + r.requestVerified.providerID : r.resolved ? r.resolved.modelID + ' @ ' + r.resolved.providerID : 'n/a');
              }
            } else {
              var message = batchResultMessage(r);
              batchResultEl.style.color = message.color;
              batchResultEl.textContent = message.text;
            }
          });
          markUnhealthyRows();
        }

        function batchStageLabel(r, error) {
          if (r.status === 'write_failed' || r.status === 'restart_failed' || r.status === 'rollback_failed') return 'write';
          if (r.status === 'probe_failed') return 'probe';
          if (r.status === 'runtime_mismatch') {
            return /did not match request-verified/i.test(error) ? 'request' : 'probe';
          }
          if (r.status === 'unverified') {
            if (/not connected/i.test(error)) return 'provider';
            if (/timed out|timeout/i.test(error)) return 'verify';
            return 'request';
          }
          return 'verify';
        }

        function batchResultMessage(r) {
          var error = r.error || r.warning || 'Unknown error';
          if (r.status === 'applied_with_quota_warning') return { color: 'var(--warning)', text: '[quota] applied with quota warning: ' + error };
          if (r.status === 'unverified') {
            if (error.toLowerCase().indexOf('timed out') !== -1 || error.toLowerCase().indexOf('timeout') !== -1) {
              return { color: 'var(--warning)', text: '[verify] Apply timed out: ' + error + ' The configuration was written but verification did not complete. Check health and retry.' };
            }
            if (/not connected/i.test(error)) {
              return { color: 'var(--danger)', text: '[provider] Provider not connected: ' + error };
            }
            return { color: 'var(--warning)', text: '[request] Applied but request did not confirm the model: ' + error };
          }
          if (r.status === 'write_failed' || r.status === 'restart_failed' || r.status === 'rollback_failed') {
            return { color: 'var(--danger)', text: '[write] not applied — rolled back: ' + error };
          }
          if (r.status === 'probe_failed') return { color: 'var(--danger)', text: '[probe] rolled back — probe failed: ' + error };
          if (r.status === 'runtime_mismatch') return { color: 'var(--danger)', text: '[' + batchStageLabel(r, error) + '] applied but mismatched: ' + error };
          return { color: 'var(--danger)', text: '[verify] ' + r.status + ': ' + error };
        }

        async function applyPending() {
          if (pending.size === 0) return;
          if (applyInProgress) return;
          var verifyEl = document.getElementById('verify-inference');
          var verification = verifyEl && verifyEl.checked ? 'inference' : 'readiness';
          var confirmMsg = 'Apply ' + pending.size + ' change' + (pending.size > 1 ? 's' : '') + ' & restart ai-dev? Active OpenCode sessions will be interrupted.';
          if (verification === 'inference') confirmMsg += '\\n\\nInference verification will send a real model request and may consume provider quota or incur cost. Continue?';
          if (!confirm(confirmMsg)) return;
          applyInProgress = true;
          var applyBtn = document.getElementById('btn-apply');
          var discardBtn = document.getElementById('btn-discard');
          var status = document.getElementById('restart-status');
          var batchStatus = document.getElementById('batch-status');
          var modal = document.getElementById('edit-modal');
          applyBtn.disabled = true;
          discardBtn.disabled = true;
          disableTableRows();
          if (modal) {
            modal.classList.add('disabled');
            modal.style.display = 'none';
          }

          var banner = document.createElement('div');
          banner.className = 'restart-banner';
          banner.innerHTML = '<span class="spinner"></span> Applying ' + pending.size + ' change' + (pending.size > 1 ? 's' : '') + ' &amp; restarting… This restarts ai-dev and typically takes 30–60 seconds.';
          document.body.appendChild(banner);

          var elapsed = 0;
          status.innerHTML = '<span class="spinner"></span> Applying &amp; restarting… <span class="probe-hint">This restarts ai-dev and typically takes 30–60 seconds.</span> <span class="probe-elapsed">0s</span>';
          batchStatus.textContent = 'Restarting…';
          var timer = setInterval(function () {
            elapsed += 1;
            var el = status.querySelector('.probe-elapsed');
            if (el) el.textContent = elapsed + 's';
          }, 1000);
          var deadlineMs = verification === 'inference' ? 310000 : 190000;
          var controller = new AbortController();
          var timeoutId = setTimeout(function () { controller.abort(); }, deadlineMs);
          try {
            var changes = Array.from(pending.entries()).map(function (kv) { return { agent: kv[0], entries: kv[1] }; });
            var res = await fetch('/api/agent-models', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ changes: changes, verification: verification }),
              signal: controller.signal,
            });
            clearTimeout(timeoutId);
            var data = await res.json();
            clearInterval(timer);
            if (!res.ok) {
              batchStatus.style.color = 'var(--danger)';
              batchStatus.textContent = data.error || ('HTTP ' + res.status);
              applyBtn.disabled = false;
              discardBtn.disabled = false;
              enableTableRows();
              status.textContent = '';
              applyInProgress = false;
              return;
            }
            // data.results is Record<agent, ApplyResult>
            var results = data.results || {};
            renderBatchResults(results);
            var failed = Object.keys(results).filter(function (k) { return !results[k].ok; });
            var quotaWarned = Object.keys(results).filter(function (k) { return results[k].ok && results[k].status === 'applied_with_quota_warning'; });
            if (failed.length === 0) {
              if (quotaWarned.length > 0) {
                batchStatus.style.color = 'var(--warning)';
                batchStatus.textContent = 'Applied with quota warning for ' + quotaWarned.join(', ') + '. Configuration kept; check provider quota. Reloading…';
              } else {
                batchStatus.style.color = 'var(--success)';
                batchStatus.textContent = 'Applied and restarted (' + Object.keys(results).length + ' agents). Reloading…';
              }
              status.textContent = quotaWarned.length > 0 ? 'Applied with warning ⚠' : 'Restarted ✔';
              setTimeout(function () { status.textContent = ''; batchStatus.textContent = ''; applyBtn.disabled = false; discardBtn.disabled = false; enableTableRows(); applyInProgress = false; pending.clear(); updateRowDirtyState(); updateBatchBar(); location.reload(); }, 2500);
            } else {
              batchStatus.style.color = 'var(--danger)';
              batchStatus.textContent = failed.length + ' failed: ' + failed.join(', ') + '. See per-row status.';
              applyBtn.disabled = false;
              discardBtn.disabled = false;
              enableTableRows();
              status.textContent = '';
              applyInProgress = false;
              // Keep pending for failed ones, clear succeeded? For now keep all pending for retry
            }
          } catch (e) {
            clearTimeout(timeoutId);
            clearInterval(timer);
            batchStatus.style.color = 'var(--danger)';
            var errMsg = e && typeof e.message === 'string' ? e.message : String(e);
            if (e && e.name === 'AbortError') {
              batchStatus.textContent = 'Apply timed out after ' + (deadlineMs/1000) + 's. The configuration was written but verification did not complete. Check provider quota and try again.';
              status.textContent = 'Timed out ⏱';
            } else {
              batchStatus.textContent = errMsg;
              status.textContent = '';
            }
            applyBtn.disabled = false;
            discardBtn.disabled = false;
            enableTableRows();
            status.textContent = e && e.name === 'AbortError' ? 'Timed out ⏱' : '';
            applyInProgress = false;
          }
        }

        // Legacy single-agent path kept for compatibility (not used by new UI)
        async function submitAgentModel(entries, confirmation) {
          if (applyInProgress) return;
          if (!confirm(confirmation)) return;
          var verifyEl = document.getElementById('verify-inference');
          var verification = verifyEl && verifyEl.checked ? 'inference' : 'readiness';
          if (verification === 'inference' && !confirm('Inference verification will send a real model request and may consume provider quota or incur cost. Continue?')) return;
          applyInProgress = true;
          var btn = document.getElementById('btn-save');
          var clearBtn = document.getElementById('btn-clear');
          var cancelBtn = document.getElementById('btn-cancel');
          var status = document.getElementById('restart-status');
          var modal = document.getElementById('edit-modal');
          btn.disabled = true;
          clearBtn.disabled = true;
          if (cancelBtn) cancelBtn.disabled = true;
          disableTableRows();
          if (modal) {
            modal.classList.add('disabled');
            modal.style.display = 'none';
          }

          var banner = document.createElement('div');
          banner.className = 'restart-banner';
          banner.innerHTML = '<span class="spinner"></span> Applying &amp; restarting… This restarts ai-dev and typically takes 30–60 seconds.';
          document.body.appendChild(banner);

          var elapsed = 0;
          status.innerHTML = '<span class="spinner"></span> Applying &amp; restarting… <span class="probe-hint">This restarts ai-dev and typically takes 30–60 seconds.</span> <span class="probe-elapsed">0s</span>';
          var timer = setInterval(function () {
            elapsed += 1;
            var el = status.querySelector('.probe-elapsed');
            if (el) el.textContent = elapsed + 's';
          }, 1000);
          var deadlineMs = verification === 'inference' ? 310000 : 190000;
          var controller = new AbortController();
          var timeoutId = setTimeout(function () { controller.abort(); }, deadlineMs);
          try {
            var res = await fetch('/api/agent-models/' + encodeURIComponent(editAgentName), {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ entries: entries, verification: verification }),
              signal: controller.signal,
            });
            clearTimeout(timeoutId);
            var data = await res.json();
            clearInterval(timer);
            if (!res.ok) {
              var el = document.getElementById('save-result');
              el.style.color = 'var(--danger)';
              el.textContent = data.error || ('HTTP ' + res.status);
              btn.disabled = false;
              clearBtn.disabled = false;
              if (cancelBtn) cancelBtn.disabled = false;
              enableTableRows();
              status.textContent = '';
              applyInProgress = false;
              return;
            }
            var el = document.getElementById('save-result');
            if (data.ok && data.status === 'cleared') {
              var automatic = data.resolved ? data.resolved.modelID + ' @ ' + data.resolved.providerID : 'n/a';
              el.style.color = 'var(--success)';
              el.textContent = 'Configured model cleared. Automatic model: ' + automatic;
            } else if (data.ok && data.status === 'verified') {
              var resolved = data.resolved ? data.resolved.modelID + ' @ ' + data.resolved.providerID : 'n/a';
              var requestVerified = data.requestVerified ? data.requestVerified.modelID + ' @ ' + data.requestVerified.providerID : 'not verified';
              el.style.color = 'var(--success)';
              el.textContent = 'Applied and restarted. Successful request model: ' + requestVerified + ' (assigned: ' + resolved + ')';
            } else if (data.ok && data.status === 'applied_with_quota_warning') {
              var qWarning = data.warning || data.error || 'provider quota exhausted';
              el.style.color = 'var(--warning)';
              el.textContent = 'Applied with quota warning: ' + qWarning + ' (provider quota exhausted; configuration kept)';
            } else if (!data.ok && data.status === 'unverified') {
              if (data.error && data.error.toLowerCase().indexOf('timed out') !== -1) {
                el.style.color = 'var(--warning)';
                el.textContent = 'Apply timed out: ' + data.error;
              } else {
                el.style.color = 'var(--warning)';
                el.textContent = 'Applied but could not confirm the server came back: ' + data.error;
              }
            } else if (!data.ok && data.status === 'rollback_failed') {
              el.style.color = 'var(--danger)';
              el.textContent = 'Applied but verification failed and rollback also failed: ' + data.error;
            } else if (!data.ok && data.status === 'probe_failed') {
              el.style.color = 'var(--danger)';
              el.textContent = 'Applied but verification probe failed: ' + data.error;
            } else {
              el.style.color = 'var(--danger)';
              el.textContent = data.error || 'Unknown error';
            }
            if (data.ok === true) {
              status.textContent = data.status === 'applied_with_quota_warning' ? 'Applied with warning ⚠' : 'Restarted ✔';
              setTimeout(function () { status.textContent = ''; btn.disabled = false; clearBtn.disabled = false; if (cancelBtn) cancelBtn.disabled = false; enableTableRows(); applyInProgress = false; location.reload(); }, 2500);
            } else {
              btn.disabled = false;
              clearBtn.disabled = false;
              if (cancelBtn) cancelBtn.disabled = false;
              enableTableRows();
              status.textContent = '';
              applyInProgress = false;
            }
          } catch (e) {
            clearTimeout(timeoutId);
            clearInterval(timer);
            var el = document.getElementById('save-result');
            el.style.color = 'var(--danger)';
            var errMsg2 = e && typeof e.message === 'string' ? e.message : String(e);
            if (e && e.name === 'AbortError') {
              el.textContent = 'Apply timed out after ' + (deadlineMs/1000) + 's. The configuration was written but verification did not complete. Check provider quota and try again.';
              status.textContent = 'Timed out ⏱';
            } else {
              el.textContent = errMsg2;
              status.textContent = '';
            }
            btn.disabled = false;
            clearBtn.disabled = false;
            if (cancelBtn) cancelBtn.disabled = false;
            enableTableRows();
            applyInProgress = false;
          }
        }

        (function setupVerifyToggle() {
          var el = document.getElementById('verify-inference');
          var warning = document.getElementById('verify-warning');
          if (!el || !warning) return;
          el.addEventListener('change', function () {
            warning.style.display = el.checked ? 'block' : 'none';
          });
        })();

        markUnhealthyRows();
      `}</script>
    </div>
  );
};

export function AgentModelsPage(state: AgentModelsState) {
  return (
    <Layout title="Agent Models" currentPath="/agent-models">
      <AgentModelsContent state={state} />
    </Layout>
  );
}
