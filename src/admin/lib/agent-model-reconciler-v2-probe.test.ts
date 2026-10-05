import { describe, expect, test, beforeEach } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { clearModelMetadataCache } from "./model-metadata";
import { probeModel, hasAuthMarker } from "./model-probe";

beforeEach(() => {
  rmSync(join(process.env.HOME ?? "", ".cache/openchamber/agent-model-reconcile.lock"), { recursive: true, force: true });
  rmSync(join(process.env.HOME ?? "", ".cache/openchamber/agent-model-health.json"), { force: true });
  clearModelMetadataCache();
});

describe("V2 probe via title", () => {
  test("healthy", async () => {
    const prev = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    const healthy = JSON.stringify({ info: { role: "assistant", modelID: "free-a", providerID: "openai" } });
    const deps: any = {
      exec: async (cmd: string) => {
        if (cmd.includes("dGl0bGU=")) return { stdout: healthy, stderr: "", exitCode: 0 };
        if (cmd.includes("agent-model-health.json")) return { stdout: "{}", stderr: "", exitCode: 0 };
        if (cmd.includes("auth.json")) return { stdout: "", stderr: "", exitCode: 1 };
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
      readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "pw", OMO_ENABLED: "0" }),
    };
    const res = await probeModel(deps, "openai", "free-a");
    expect(res.status).toBe("healthy");
    process.env.OMO_ENABLED = prev;
  });
  test("401/403 -> unavailable", async () => {
    const prev = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    const bad401 = JSON.stringify({ error: { message: "401 Unauthorized" } });
    const bad403 = JSON.stringify({ error: { message: "403 Forbidden invalid api key" } });
    for (const bad of [bad401, bad403]) {
      expect(hasAuthMarker(bad)).toBe(true);
      const deps: any = {
        exec: async (cmd: string) => {
          if (cmd.includes("dGl0bGU=")) return { stdout: bad, stderr: "", exitCode: 0 };
          if (cmd.includes("agent-model-health.json")) return { stdout: "{}", stderr: "", exitCode: 0 };
          if (cmd.includes("auth.json")) return { stdout: "", stderr: "", exitCode: 1 };
          return { stdout: "{}", stderr: "", exitCode: 0 };
        },
        readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "pw", OMO_ENABLED: "0" }),
      };
      const res = await probeModel(deps, "openai", "free-a");
      expect(res.status).toBe("unavailable");
      rmSync(join(process.env.HOME ?? "", ".cache/openchamber/agent-model-health.json"), { force: true });
    }
    process.env.OMO_ENABLED = prev;
  });
  test("quota -> quota_exceeded", async () => {
    const prev = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    const quota = JSON.stringify({ error: { message: "429 quota_exceeded free usage exceeded" } });
    const deps: any = {
      exec: async (cmd: string) => {
        if (cmd.includes("dGl0bGU=")) return { stdout: quota, stderr: "", exitCode: 0 };
        if (cmd.includes("agent-model-health.json")) return { stdout: "{}", stderr: "", exitCode: 0 };
        if (cmd.includes("auth.json")) return { stdout: "", stderr: "", exitCode: 1 };
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
      readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "pw", OMO_ENABLED: "0" }),
    };
    const res = await probeModel(deps, "openai", "free-a");
    expect(res.status).toBe("quota_exceeded");
    process.env.OMO_ENABLED = prev;
  });
  test("startup does not probe paid", async () => {
    const { suggestForMode } = await import("./agent-model-suggestion-policy");
    const catalog = ["openai/free-a", "anthropic/paid-p"];
    const metadata = new Map([
      ["openai/free-a", { providerId: "openai", modelId: "free-a", reference: "openai/free-a", inputPrice: 0, outputPrice: 0, contextLimit: 32000, outputLimit: 4000, reasoning: false, toolCall: true, structuredOutput: null, deprecated: false, benchmarkScore: 0.5, fetchedAt: Date.now() }],
      ["anthropic/paid-p", { providerId: "anthropic", modelId: "paid-p", reference: "anthropic/paid-p", inputPrice: 5, outputPrice: 10, contextLimit: 256000, outputLimit: 64000, reasoning: true, toolCall: true, structuredOutput: null, deprecated: false, benchmarkScore: 0.9, fetchedAt: Date.now() }],
    ] as any);
    const caps = new Map([["openai/free-a", {}], ["anthropic/paid-p", {}]] as any);
    const outFree = suggestForMode({ mode: "free", providers: ["openai","anthropic"], catalog, metadata: metadata as any, sourceStatus: "fresh", sourceAgeMs: 0, warnings: [], capabilities: caps as any, agents: ["explore"] });
    expect(outFree.suggestions.get("explore")?.model).toBe("openai/free-a");
    expect(outFree.suggestions.get("explore")?.model).not.toBe("anthropic/paid-p");
    const outPerf = suggestForMode({ mode: "performance", providers: ["openai","anthropic"], catalog, metadata: metadata as any, sourceStatus: "fresh", sourceAgeMs: 0, warnings: [], capabilities: caps as any, agents: ["explore"] });
    expect(outPerf.suggestions.has("explore")).toBe(true);
  });
});
