import { describe, expect, test } from "bun:test";
import { parseRoutingConfig } from "./routing-config";
import type { RoutingConfig } from "./routing-config";
import type { SessionRoutingState } from "./routing-state";
import { resolveHeadEnforcement, shouldEnforceHead } from "./head-enforcement";

function makeConfig(chains: Record<string, { model: string; variant?: string }[]>): RoutingConfig {
  const raw: unknown = {
    version: 1,
    defaults: { cooldownSeconds: 60, maxFallbackAttempts: 3, notifyOnFallback: false },
    chains: Object.fromEntries(
      Object.entries(chains).map(([agent, entries]) => [agent, { chain: entries }]),
    ),
  };
  const { config, errors } = parseRoutingConfig(raw);
  if (!config) throw new Error(`parse failed: ${errors.join("; ")}`);
  return config;
}

describe("head-enforcement - shouldEnforceHead", () => {
  test("allows enforcement on fresh session (no state)", () => {
    expect(shouldEnforceHead(undefined)).toBe(true);
  });
  test("allows enforcement when cursor=0 and attemptCount=0", () => {
    const st: SessionRoutingState = { chain: [], cursor: 0, attemptCount: 0, holdUntil: 0 };
    expect(shouldEnforceHead(st)).toBe(true);
  });
  test("does NOT enforce when cursor>0", () => {
    const st: SessionRoutingState = { chain: [{ model: "p/m1" }, { model: "p/m2" }], cursor: 1, attemptCount: 1, holdUntil: Date.now() + 5000 };
    expect(shouldEnforceHead(st)).toBe(false);
  });
  test("does NOT enforce when attemptCount>0 even if cursor is 0 (edge)", () => {
    const st: SessionRoutingState = { chain: [{ model: "p/m1" }], cursor: 0, attemptCount: 1, holdUntil: 0 };
    expect(shouldEnforceHead(st)).toBe(false);
  });
  test("does NOT enforce when cursor=2 attemptCount=2", () => {
    const st: SessionRoutingState = { chain: [{ model: "p/m1" }, { model: "p/m2" }, { model: "p/m3" }], cursor: 2, attemptCount: 2, holdUntil: 0 };
    expect(shouldEnforceHead(st)).toBe(false);
  });
});

describe("head-enforcement - resolveHeadEnforcement", () => {
  test("fresh session resolves to chain[0] with parsed model", () => {
    const cfg = makeConfig({ build: [{ model: "opencode-go/kimi-k3", variant: "max" }, { model: "openai/gpt-5.6-sol" }] });
    const result = resolveHeadEnforcement(cfg, "build", undefined);
    expect(result).toBeDefined();
    expect(result?.entry.model).toBe("opencode-go/kimi-k3");
    expect(result?.parsed).toEqual({ providerID: "opencode-go", modelID: "kimi-k3" });
    expect(result?.payload).toEqual({ id: "kimi-k3", providerID: "opencode-go", variant: "max" });
  });

  test("does not reset in-flight fallback replay (cursor>0) - returns undefined", () => {
    const cfg = makeConfig({ build: [{ model: "opencode-go/kimi-k3" }, { model: "openai/gpt-5.6-sol" }] });
    const state: SessionRoutingState = { chain: cfg.chains["build"].chain, cursor: 1, attemptCount: 1, holdUntil: Date.now() + 5000 };
    const result = resolveHeadEnforcement(cfg, "build", state);
    expect(result).toBeUndefined();
  });

  test("absent/empty chain is no-op (undefined)", () => {
    const cfg = makeConfig({ build: [{ model: "p/m1" }] });
    // unknown agent
    expect(resolveHeadEnforcement(cfg, "unknown-agent-xyz", undefined)).toBeUndefined();
    // undefined config
    expect(resolveHeadEnforcement(undefined, "build", undefined)).toBeUndefined();
    // empty not possible via parse, but test agent with no chain after filtering: use config without that agent
  });

  test("invalid model string at head is no-op", () => {
    // craft config manually with invalid model (bypass parse validation for test)
    const badCfg: RoutingConfig = {
      version: 1,
      defaults: { cooldownSeconds: 60, maxFallbackAttempts: 3, notifyOnFallback: false },
      chains: { build: { chain: [{ model: "bad-no-slash" }] } },
    };
    const result = resolveHeadEnforcement(badCfg, "build", undefined);
    expect(result).toBeUndefined();
  });

  test("chain[0] without variant omits variant in payload", () => {
    const cfg = makeConfig({ build: [{ model: "openai/gpt-5.6-luna" }, { model: "p/m2" }] });
    const result = resolveHeadEnforcement(cfg, "build", undefined);
    expect(result?.payload).toEqual({ id: "gpt-5.6-luna", providerID: "openai" });
    expect(result?.payload.variant).toBeUndefined();
  });

  test("agent key is case-insensitive and trimmed (reuse normalize)", () => {
    const cfg = makeConfig({ build: [{ model: "openai/gpt-5.6-sol" }] });
    const a = resolveHeadEnforcement(cfg, "BUILD", undefined);
    const b = resolveHeadEnforcement(cfg, " build ", undefined);
    expect(a?.entry.model).toBe("openai/gpt-5.6-sol");
    expect(b?.entry.model).toBe("openai/gpt-5.6-sol");
  });

  test("cursor=0 attemptCount=0 but chain exists enforces head (fresh/primary)", () => {
    const cfg = makeConfig({ plan: [{ model: "p/head" }, { model: "p/tail" }] });
    const state: SessionRoutingState = { chain: cfg.chains["plan"].chain, cursor: 0, attemptCount: 0, holdUntil: 0 };
    const result = resolveHeadEnforcement(cfg, "plan", state);
    expect(result).toBeDefined();
    expect(result?.entry.model).toBe("p/head");
  });
});
