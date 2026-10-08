import { describe, expect, it } from "bun:test";
import { AgentModelsPage } from "./agent-models";

function render(state: Partial<Parameters<typeof AgentModelsPage>[0]> = {}): string {
  return String(
    AgentModelsPage({
      agents: [
        {
          name: "general",
          configured: [],
          resolved: null,
          requestVerified: null,
          lastSuccessfulRequestAt: null,
          source: "inherited",
          effectiveness: "plugin",
          invalid: false,
        } as never,
        {
          name: "plan",
          configured: [{ model: "openai/gpt-4" }],
          resolved: { providerID: "openai", modelID: "gpt-4" },
          requestVerified: null,
          lastSuccessfulRequestAt: null,
          source: "configured",
          effectiveness: "effective",
          invalid: false,
        } as never,
      ],
      catalog: ["openai/gpt-4", "openai/free-model", "opencode-go/kimi-k3"],
      providers: ["openai", "opencode-go"],
      hasPassword: true,
      catalogAvailable: true,
      ...state,
    }),
  );
}

describe("AgentModelsPage unhealthy model warnings", () => {
  it("embeds unhealthy models and reasons in page state", () => {
    const html = render({
      unhealthyModels: ["p/dead"],
      unhealthyReasons: { "p/dead": "retired" },
    } as never);
    expect(html).toContain('"unhealthyModels":["p/dead"]');
    expect(html).toContain('"unhealthyReasons":{"p/dead":"retired"}');
  });

  it("marks unhealthy options red in the edit modal template", () => {
    const html = render({ unhealthyModels: ["p/dead"] } as never);
    expect(html).toContain("unhealthy-warn");
    expect(html).toContain("markUnhealthyRows");
  });

  it("labels batch failure stages in result messages", () => {
    const html = render();
    expect(html).toContain("[provider] Provider not connected");
    expect(html).toContain("[probe] rolled back");
    expect(html).toContain("[request] Applied but request did not confirm");
    expect(html).toContain("[write] not applied");
  });
});

describe("AgentModelsPage batch failure navigation", () => {
  it("gives each agent row an anchor id", () => {
    const html = render();
    expect(html).toContain('id="row-general"');
    expect(html).toContain('id="row-plan"');
  });

  it("renders clickable failure anchors and row highlight hooks", () => {
    const html = render();
    expect(html).toContain('href="#row-');
    expect(html).toContain('batch-failed');
    expect(html).toContain('batch-ok');
    expect(html).toContain('Click a name to jump to its row');
  });
});

describe("AgentModelsPage unresolved apply attention", () => {
  it("loads the attention module after markup and delegates apply state to it", () => {
    const html = render();

    expect(html).toContain('id="agent-models-attention"');
    expect(html).toContain('class="agent-models-attention__list"');
    expect(html).toContain("Pending recheck");
    expect(html).toContain("Recently changed");
    expect(html).toContain('src="/static/agent-models-attention.js?v=');
    expect(html).toContain("window.AgentModelsAttention.setApplyFailure");
    expect(html).toContain("window.AgentModelsAttention.markChanged");
    expect(html).not.toContain("function restoreApplyFailures");
  });
});

describe("AgentModelsPage empty suggestions state", () => {
  it("tells the user there is nothing to apply instead of pointing at Apply", () => {
    const html = render();
    expect(html).toContain('nothing to apply');
    expect(html).toContain("added === 0");
  });
});

describe("AgentModelsPage pinned badge", () => {
  it("shows pinned badge for manually configured agents", () => {
    const html = render({
      agents: [
        {
          name: "plan",
          configured: [{ model: "openai/gpt-4" }],
          resolved: null,
          requestVerified: null,
          lastSuccessfulRequestAt: null,
          source: "configured",
          effectiveness: "awaiting_request",
          invalid: false,
          pinned: true,
        } as never,
      ],
    });
    expect(html).toContain("Pinned");
    expect(html).toContain("Manual pin");
  });

  it("omits pinned badge when not pinned", () => {
    const html = render();
    expect(html).not.toContain("● pinned");
  });
});

describe("AgentModelsPage concise route status and diagnostics", () => {
  it("shows the configured route and latest successful model while hiding the API default in diagnostics", () => {
    const html = render({
      agents: [{
        name: "plan",
        configured: [{ model: "nvidia/z-ai/glm-5.3" }, { model: "openrouter/free-fallback" }],
        resolved: { providerID: "opencode-go", modelID: "kimi-k3" },
        requestVerified: { providerID: "openrouter", modelID: "free-fallback" },
        lastSuccessfulRequestAt: Date.UTC(2026, 9, 7, 1, 2),
        providerConnected: true,
        source: "configured",
        pinned: true,
        invalid: false,
        effectiveness: "effective",
      }],
    });
    const diagnosticsStart = html.indexOf("Diagnostics");

    expect(html).toContain("Configured route");
    expect(html).toContain("Last successful model");
    expect(html).toContain("Status");
    expect(html).toContain("nvidia/z-ai/glm-5.3 → openrouter/free-fallback");
    expect(html).toContain("free-fallback @ openrouter");
    expect(html).toContain("2026-10-07 01:02 UTC");
    expect(diagnosticsStart).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("OpenCode agent default", diagnosticsStart)).toBeGreaterThan(diagnosticsStart);
    expect(html.indexOf("Configuration source", diagnosticsStart)).toBeGreaterThan(diagnosticsStart);
    expect(html.indexOf("Agent API model")).toBe(-1);
  });

  it("marks agents with no successful request as not yet verified", () => {
    expect(render()).toContain("Not yet verified");
  });

  it("shows a runtime model mismatch in the main Status column", () => {
    const html = render({
      agents: [{
        name: "plan",
        configured: [{ model: "nvidia/z-ai/glm-5.3" }],
        resolved: { providerID: "opencode-go", modelID: "kimi-k3" },
        requestVerified: { providerID: "openrouter", modelID: "other-model" },
        lastSuccessfulRequestAt: Date.UTC(2026, 9, 7, 1, 2),
        providerConnected: true,
        source: "configured",
        pinned: false,
        invalid: false,
        effectiveness: "runtime_mismatch",
      }],
    });
    const statusStart = html.indexOf('data-label="Status"');
    const statusEnd = html.indexOf("</td>", statusStart);
    const statusCell = html.slice(statusStart, statusEnd);

    expect(statusCell).toContain("Model mismatch");
    expect(statusCell).toContain("status-pill--danger");
  });
});

describe("AgentModelsPage mode-aware suggestions", () => {
  it("renders Provider-adjacent mode selector with free/economy/performance and defaults to free", () => {
    const html = render();
    expect(html).toContain('id="suggestion-mode"');
    expect(html).toContain('aria-label="Suggestion mode"');
    expect(html).toContain('for="suggestion-mode"');
    expect(html).toContain('value="free" selected');
    expect(html).toContain('value="economy"');
    expect(html).toContain('value="performance"');
    // mode selector is inside provider-filter fieldset, Provider-adjacent
    const filterIndex = html.indexOf('id="provider-filter"');
    const modeIndex = html.indexOf('id="suggestion-mode"');
    expect(modeIndex).toBeGreaterThan(filterIndex);
    // ensure default free is selected, economy/performance not selected
    expect(html).not.toContain('value="economy" selected');
    expect(html).not.toContain('value="performance" selected');
  });

  it("includes selected mode in Generate Suggestions fetch body", () => {
    const html = render();
    // must read mode via selectedMode() and include in body
    expect(html).toContain("selectedMode()");
    expect(html).toContain("function selectedMode()");
    // body must contain mode
    expect(html).toContain("var body = { mode: mode }");
    expect(html).toContain("body.providers = providers");
    expect(html).toContain("JSON.stringify(body)");
    // must not use legacy providers-only body
    expect(html).not.toContain("JSON.stringify(providers === null ? {} : { providers: providers })");
  });

  it("uses Provider scope when sending mode payload", () => {
    const html = render();
    expect(html).toContain("selectedProviders()");
    expect(html).toContain("if (providers !== null) body.providers = providers");
  });

  it("renders explicit response sourceStatus/sourceAgeMs/warnings", () => {
    const html = render();
    expect(html).toContain("sourceStatus");
    expect(html).toContain("sourceAgeMs");
    expect(html).toContain("warnings");
    expect(html).toContain("renderSuggestionMeta");
    expect(html).toContain("function renderSuggestionMeta");
    expect(html).toContain('id="suggestion-meta"');
    expect(html).toContain('aria-live="polite"');
    // meta rendering must show Mode, Source, Age, Warnings
    expect(html).toContain("Mode: ");
    expect(html).toContain("Source: ");
    expect(html).toContain("Age: ");
    expect(html).toContain("Warnings: ");
  });

  it("renders per-agent recommendation metadata/reason/heuristic states", () => {
    const html = render();
    expect(html).toContain("renderSuggestionList");
    expect(html).toContain("function renderSuggestionList");
    expect(html).toContain('id="suggestion-list"');
    expect(html).toContain("sug.metadata");
    expect(html).toContain("sug.reason");
    expect(html).toContain("sug.heuristic");
    expect(html).toContain("heuristic");
    // metadata fields
    expect(html).toContain("inputPrice");
    expect(html).toContain("outputPrice");
    expect(html).toContain("contextLimit");
    expect(html).toContain("reasoning");
    expect(html).toContain("toolCall");
  });

  it("renders no-candidate states for explicit mode", () => {
    const html = render();
    // no-candidate message pattern
    expect(html).toContain("no candidate for");
    expect(html).toContain("no eligible model");
  });

  it("preserves pending manual edits when suggestions return", () => {
    const html = render();
    // must guard pending.has before setting
    expect(html).toContain("!pending.has(agent)");
    // explicit branch
    expect(html).toContain("pending.set(agent, entries)");
    // ensure sameEntries check remains for manual preservation
    expect(html).toContain("sameEntries(configured, entries)");
  });

  it("keeps accepted suggestions in pending batch Apply as explicit [{model}]", () => {
    const html = render();
    // explicit branch converts {model} to [{model}]
    expect(html).toContain("var entries = [{ model: sug.model }]");
    // pending entries are [{model: string}] without variant unless provided
    expect(html).toContain("pending.set(agent, entries)");
    // Apply flow still uses changes: Array.from(pending.entries()).map(...)
    expect(html).toContain("Array.from(pending.entries()).map");
    expect(html).toContain("verification");
    expect(html).toContain("JSON.stringify({ changes: changes, verification: verification })");
  });

  it("handles legacy suggestion response safely by checking Array.isArray", () => {
    const html = render();
    expect(html).toContain("Array.isArray(suggestion)");
    expect(html).toContain("isExplicit");
    // legacy guard
    expect(html).toContain("typeof data.mode === 'string'");
  });

  it("validates provider/model format before pending (contains slash)", () => {
    const html = render();
    expect(html).toContain("indexOf('/')");
  });

  it("disables mode selector when catalog unavailable or password missing", () => {
    const htmlDisabled = render({ catalogAvailable: false, hasPassword: true });
    // when catalog unavailable, selector should be disabled
    expect(htmlDisabled).toContain('id="suggestion-mode"');
    // check disabled attribute present in that rendered state
    // Hono renders boolean disabled as attribute presence
    const modeTag = htmlDisabled.slice(htmlDisabled.indexOf('id="suggestion-mode"') - 200, htmlDisabled.indexOf('id="suggestion-mode"') + 200);
    expect(modeTag).toContain("disabled");

    const htmlNoPassword = render({ hasPassword: false });
    const modeTag2 = htmlNoPassword.slice(htmlNoPassword.indexOf('id="suggestion-mode"') - 200, htmlNoPassword.indexOf('id="suggestion-mode"') + 200);
    expect(modeTag2).toContain("disabled");
  });

  it("does not interpolate agent or catalog values into executable HTML", () => {
    const html = render({
      agents: [{
        name: "evil');alert(1)//",
        configured: [],
        resolved: null,
        requestVerified: null,
        lastSuccessfulRequestAt: null,
        source: "inherited",
        effectiveness: "plugin",
        invalid: false,
      }] as never,
      catalog: ['provider/model" onfocus="alert(1)'],
    });
    expect(html).toContain('onclick="editAgent(this)"');
    expect(html).not.toContain("onclick=\"editAgent('evil');alert(1)//')\"");
    expect(html).toContain("escapeHtml(m)");
    expect(html).toContain("CSS.escape(agent)");
  });

  it("describes batch rollback statuses as not applied", () => {
    const html = render();
    expect(html).toContain("write_failed");
    expect(html).toContain("restart_failed");
    expect(html).toContain("not applied — rolled back");
    expect(html).toContain("rolled back — probe failed");
  });

  it("guards Apply before confirmation and fetch to prevent rapid duplicates", () => {
    const html = render();
    const applyStart = html.indexOf("async function applyPending()");
    const applyEnd = html.indexOf("// Legacy single-agent path kept for compatibility", applyStart);
    expect(applyStart).toBeGreaterThanOrEqual(0);
    expect(applyEnd).toBeGreaterThan(applyStart);
    const applySource = html.slice(applyStart, applyEnd);
    const guardIndex = applySource.indexOf("if (applyInProgress) return;");
    const confirmIndex = applySource.indexOf("if (!confirm(confirmMsg)) return;");
    const lockIndex = applySource.indexOf("applyInProgress = true;");
    const fetchIndex = applySource.indexOf("fetch('/api/agent-models'");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(confirmIndex);
    expect(lockIndex).toBeLessThan(fetchIndex);
    expect(applySource).toContain("applyBtn.disabled = true;");
    expect(applySource).toContain("discardBtn.disabled = true;");
  });

  it("escapes newlines in the inference confirmation JavaScript string", () => {
    const html = render();
    expect(html).toContain("\\n\\nInference verification will send a real model request");
    expect(html).not.toContain("'\n\nInference verification will send a real model request");
  });
});
