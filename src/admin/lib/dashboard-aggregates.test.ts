import { describe, expect, test } from "bun:test";
import {
  aggregateLspSummary,
  aggregateProviderSummary,
  aggregateSubagentSummary,
  deriveSecurity,
  formatArchive,
  formatApplyState,
  formatCompression,
  formatIntEnUs,
  formatPermissionInheritance,
  formatTools,
  projectCenter,
} from "./dashboard-aggregates";
import { makeAgentEntry } from "./dashboard-fixtures";

describe("format helpers", () => {
  test("Given en-US, When formatting 2125, Then 2,125", () => {
    expect(formatIntEnUs(2125)).toBe("2,125");
    expect(formatIntEnUs(14000)).toBe("14,000");
  });
  test("Given compression off/lite/standard/max, When formatted, Then exact copy", () => {
    expect(formatCompression("off").value).toBe("Off");
    expect(formatCompression("lite").value).toBe("Lite");
    expect(formatCompression("standard").value).toBe("Standard");
    expect(formatCompression("max").value).toBe("Max");
    expect(formatCompression(null).value).toBe("Unknown");
    expect(formatCompression("unknown").value).toBe("Unknown");
    expect(formatCompression(null).tone).toBe("neutral");
  });
  test("Given tools minimal/standard/power, When formatted, Then exact copy", () => {
    expect(formatTools("minimal").value).toBe("Minimal");
    expect(formatTools("standard").value).toBe("Standard");
    expect(formatTools("power").value).toBe("Power");
    expect(formatTools(null).value).toBe("Unknown");
  });
  test("Archive displays On · 48h when enabled with 48", () => {
    expect(formatArchive(true, 48).value).toBe("On · 48h");
    expect(formatArchive(false, 48).value).toBe("Off");
    expect(formatArchive(true, null).value).toBe("Unknown");
    expect(formatArchive(true, 0).value).toBe("Unknown");
    expect(formatArchive(true, NaN).value).toBe("Unknown");
  });
  test("Security precedence Unknown > At risk > Review > Protected", () => {
    expect(deriveSecurity({ secretDetectionEnabled: null, secretRedactionEnabled: true, crossProjectSearch: false }).value).toBe("Unknown");
    expect(deriveSecurity({ secretDetectionEnabled: true, secretRedactionEnabled: false, crossProjectSearch: false }).value).toBe("At risk");
    expect(deriveSecurity({ secretDetectionEnabled: true, secretRedactionEnabled: false, crossProjectSearch: false }).tone).toBe("danger");
    expect(deriveSecurity({ secretDetectionEnabled: true, secretRedactionEnabled: true, crossProjectSearch: true }).value).toBe("Review");
    expect(deriveSecurity({ secretDetectionEnabled: true, secretRedactionEnabled: true, crossProjectSearch: true }).tone).toBe("warning");
    expect(deriveSecurity({ secretDetectionEnabled: true, secretRedactionEnabled: true, crossProjectSearch: false }).value).toBe("Protected");
    expect(deriveSecurity({ secretDetectionEnabled: true, secretRedactionEnabled: true, crossProjectSearch: false }).tone).toBe("success");
  });
  test("Permission inheritance On/Off/Unknown", () => {
    expect(formatPermissionInheritance("on")).toBe("On");
    expect(formatPermissionInheritance("off")).toBe("Off");
    expect(formatPermissionInheritance(null)).toBe("Unknown");
  });
  test("Apply state labels and tone", () => {
    expect(formatApplyState("applied").value).toBe("Applied");
    expect(formatApplyState("applied").tone).toBe("success");
    expect(formatApplyState("pending").value).toBe("Pending apply");
    expect(formatApplyState("pending").tone).toBe("warning");
    expect(formatApplyState("saved-only").value).toBe("Saved config only");
    expect(formatApplyState("saved-only").tone).toBe("neutral");
    expect(formatApplyState("runtime-unavailable").value).toBe("Runtime profile unavailable");
    expect(formatApplyState("runtime-unavailable").tone).toBe("danger");
  });
});

describe("Center projection", () => {
  test("Given connected, Then Connected success /agent", () => {
    const r = projectCenter("connected", null);
    expect(r.label).toBe("Connected"); expect(r.tone).toBe("success"); expect(r.href).toBe("/agent"); expect(r.ariaLabel).toBe("Center Connected");
  });
  test("Given disabled, Then Standalone neutral", () => {
    const r = projectCenter("disabled", null);
    expect(r.label).toBe("Standalone"); expect(r.tone).toBe("neutral");
  });
  test("Given disconnected, Then Disconnected warning", () => {
    const r = projectCenter("disconnected", null);
    expect(r.label).toBe("Disconnected"); expect(r.tone).toBe("warning");
  });
  test("Given unavailable source, Then Unavailable danger", () => {
    const r = projectCenter(null, new Error("fail"));
    expect(r.label).toBe("Unavailable"); expect(r.tone).toBe("danger");
  });
});

describe("Provider aggregation", () => {
  test("Configured Ollama and OpenCode Go count as two ready providers", () => {
    const r = aggregateProviderSummary({
      invalid: false,
      providers: [
        { keyManagement: false, hasApiKey: false, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: null }, virtual: false, baseURL: "http://192.168.11.206:11434/v1" },
        { keyManagement: true, hasApiKey: false, authStoreKeyPresent: true, oauthConnected: false, registry: { activeKeyId: "id1" }, virtual: true, baseURL: "" },
        { keyManagement: true, hasApiKey: false, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: null }, virtual: true, baseURL: "" },
        { keyManagement: true, hasApiKey: false, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: null }, virtual: true, baseURL: "" },
      ],
    });
    expect(r.state).toBe("ready");
    expect(r.label).toBe("2 providers ready");
    expect(r.totalCount).toBe(2);
    expect(r.issueCount).toBe(0);
  });

  test("URL-only custom provider counts as ready", () => {
    const r = aggregateProviderSummary({
      invalid: false,
      providers: [{ keyManagement: false, hasApiKey: false, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: null }, virtual: false, baseURL: "http://localhost:11434/v1" }],
    });
    expect(r.state).toBe("ready");
    expect(r.label).toBe("1 provider ready");
  });

  test("Virtual providers do not count as configured", () => {
    const r = aggregateProviderSummary({
      invalid: false,
      providers: [{ keyManagement: true, hasApiKey: false, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: null }, virtual: true, baseURL: "" }],
    });
    expect(r.state).toBe("none");
    expect(r.label).toBe("No providers configured");
    expect(r.totalCount).toBe(0);
  });

  test("Invalid outranks all — Provider configuration invalid danger", () => {
    const r = aggregateProviderSummary({ invalid: true, providers: [] });
    expect(r.label).toBe("Provider configuration invalid"); expect(r.tone).toBe("danger"); expect(r.state).toBe("invalid");
  });
  test("Pending activation precedence over needs credentials", () => {
    const r = aggregateProviderSummary({
      invalid: false,
      providers: [
        { keyManagement: true, hasApiKey: false, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: "id1" } },
        { keyManagement: false, hasApiKey: false, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: null } },
      ],
    });
    expect(r.state).toBe("pending-activation"); expect(r.label).toBe("1 pending activation"); expect(r.tone).toBe("warning");
  });
  test("Needs credentials 2 ready 1 needs", () => {
    const r = aggregateProviderSummary({
      invalid: false,
      providers: [
        { keyManagement: false, hasApiKey: true, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: null } },
        { keyManagement: false, hasApiKey: true, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: null } },
        { keyManagement: false, hasApiKey: false, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: null } },
      ],
    });
    expect(r.label).toBe("2 ready · 1 needs credentials"); expect(r.tone).toBe("warning");
  });
  test("0 ready · 2 need credentials plural", () => {
    const r = aggregateProviderSummary({
      invalid: false,
      providers: [
        { keyManagement: false, hasApiKey: false, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: null } },
        { keyManagement: false, hasApiKey: false, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: null } },
      ],
    });
    expect(r.label).toBe("0 ready · 2 need credentials");
  });
  test("1 provider ready singular", () => {
    const r = aggregateProviderSummary({
      invalid: false,
      providers: [{ keyManagement: false, hasApiKey: true, authStoreKeyPresent: false, oauthConnected: false, registry: { activeKeyId: null } }],
    });
    expect(r.label).toBe("1 provider ready"); expect(r.tone).toBe("success");
  });
  test("No providers configured warning", () => {
    const r = aggregateProviderSummary({ invalid: false, providers: [] });
    expect(r.label).toBe("No providers configured"); expect(r.tone).toBe("warning");
  });
  test("Unavailable neutral", () => {
    const r = aggregateProviderSummary(null);
    expect(r.label).toBe("Status unavailable"); expect(r.tone).toBe("neutral");
  });
  test("OAuth ready", () => {
    const r = aggregateProviderSummary({
      invalid: false,
      providers: [{ keyManagement: true, hasApiKey: false, authStoreKeyPresent: false, oauthConnected: true, registry: { activeKeyId: null } }],
    });
    expect(r.state).toBe("ready");
  });
  test("Key-managed ready via auth-store", () => {
    const r = aggregateProviderSummary({
      invalid: false,
      providers: [{ keyManagement: true, hasApiKey: false, authStoreKeyPresent: true, oauthConnected: false, registry: { activeKeyId: "id1" } }],
    });
    expect(r.state).toBe("ready");
  });
});

describe("SubAgent aggregation", () => {
  test("All effective 9/9", () => {
    const entries = Array.from({ length: 9 }, () => makeAgentEntry({ effectiveness: "effective" }));
    const r = aggregateSubagentSummary(entries, true);
    expect(r.label).toBe("9/9 effective"); expect(r.tone).toBe("success");
  });
  test("Awaiting verification neutral", () => {
    const entries = [...Array.from({ length: 3 }, () => makeAgentEntry({ effectiveness: "effective" })), ...Array.from({ length: 6 }, () => makeAgentEntry({ effectiveness: "awaiting_request" }))];
    const r = aggregateSubagentSummary(entries, true);
    expect(r.label).toBe("9 configured · 6 awaiting verification"); expect(r.tone).toBe("neutral");
  });
  test("Invalid outranks all", () => {
    const entries = [makeAgentEntry({ effectiveness: "invalid" }), makeAgentEntry({ effectiveness: "runtime_mismatch" }), makeAgentEntry({ effectiveness: "unverified" })];
    const r = aggregateSubagentSummary(entries, true);
    expect(r.state).toBe("invalid"); expect(r.label).toBe("1 invalid configuration"); expect(r.tone).toBe("danger");
  });
  test("Runtime mismatch plural", () => {
    const entries = [makeAgentEntry({ effectiveness: "runtime_mismatch" }), makeAgentEntry({ effectiveness: "runtime_mismatch" })];
    const r = aggregateSubagentSummary(entries, true);
    expect(r.label).toBe("2 runtime mismatches"); expect(r.tone).toBe("danger");
  });
  test("Unverified warning", () => {
    const entries = Array.from({ length: 3 }, () => makeAgentEntry({ effectiveness: "unverified" }));
    const r = aggregateSubagentSummary(entries, true);
    expect(r.label).toBe("3 unverified"); expect(r.tone).toBe("warning");
  });
  test("No SubAgents configured excludes plugin-only", () => {
    const entries = [makeAgentEntry({ source: "plugin", effectiveness: "effective" })];
    const r = aggregateSubagentSummary(entries, true);
    expect(r.label).toBe("No SubAgents configured"); expect(r.tone).toBe("neutral");
  });
  test("Unavailable neutral", () => {
    const r = aggregateSubagentSummary(null, true);
    expect(r.label).toBe("Status unavailable"); expect(r.tone).toBe("neutral");
  });
  test("Catalog unavailable → Status unavailable", () => {
    const entries = [makeAgentEntry({ effectiveness: "effective" })];
    const r = aggregateSubagentSummary(entries, false);
    expect(r.label).toBe("Status unavailable");
  });
});

describe("LSP aggregation", () => {
  test("Null input → Status unavailable", () => {
    const r = aggregateLspSummary(null);
    expect(r.state).toBe("unavailable"); expect(r.label).toBe("Status unavailable"); expect(r.tone).toBe("neutral");
  });
  test("Zero total → Status unavailable", () => {
    const r = aggregateLspSummary({ inSync: 0, drifted: 0, enabled: 0, total: 0 });
    expect(r.state).toBe("unavailable"); expect(r.tone).toBe("neutral");
  });
  test("None enabled → None enabled neutral", () => {
    const r = aggregateLspSummary({ inSync: 8, drifted: 0, enabled: 0, total: 8 });
    expect(r.state).toBe("none"); expect(r.label).toBe("None enabled"); expect(r.tone).toBe("neutral");
  });
  test("All enabled in sync shows both counts", () => {
    const r = aggregateLspSummary({ inSync: 8, drifted: 0, enabled: 8, total: 8 });
    expect(r.state).toBe("in-sync"); expect(r.label).toBe("8 enabled · 8 in sync"); expect(r.tone).toBe("success");
  });
  test("Single enabled shows symmetric counts", () => {
    const r = aggregateLspSummary({ inSync: 1, drifted: 0, enabled: 1, total: 8 });
    expect(r.label).toBe("1 enabled · 1 in sync"); expect(r.tone).toBe("success");
  });
  test("Drift shows enabled and drifted counts", () => {
    const r = aggregateLspSummary({ inSync: 7, drifted: 1, enabled: 3, total: 8 });
    expect(r.state).toBe("drifted"); expect(r.label).toBe("3 enabled · 1 drifted"); expect(r.tone).toBe("warning");
  });
});


