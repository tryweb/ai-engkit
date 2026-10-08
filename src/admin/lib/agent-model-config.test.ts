import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildJqWriteCommand,
  buildRoutingWriteCommand,
  displayNameToKey,
  OMO_CONFIG,
  validateFallbackModels,
} from "./agent-models";

describe("validateFallbackModels", () => {
  test("accepts valid entries with and without variant", () => {
    expect(validateFallbackModels({ entries: [{ model: "opencode/big-pickle" }] })).toBeNull();
    expect(validateFallbackModels({ entries: [{ model: "openai/gpt-5.6-sol", variant: "max" }] })).toBeNull();
    expect(validateFallbackModels({ entries: [] })).toBeNull();
  });

  test("rejects multiple entries because only one primary model is supported", () => {
    expect(
      validateFallbackModels({
        entries: [{ model: "openai/gpt-5.6-sol" }, { model: "opencode/big-pickle" }],
      }),
    ).toContain("at most one");
  });

  test("rejects non-object bodies", () => {
    expect(validateFallbackModels(null)).toContain("JSON object");
    expect(validateFallbackModels("x")).toContain("JSON object");
    expect(validateFallbackModels([])).toContain("JSON object");
  });

  test("rejects non-array entries", () => {
    expect(validateFallbackModels({ entries: "nope" })).toContain("entries must be an array");
  });

  test("rejects missing or non-string model", () => {
    expect(validateFallbackModels({ entries: [{}] })).toContain("non-empty string model");
    expect(validateFallbackModels({ entries: [{ model: 42 }] })).toContain("non-empty string model");
    expect(validateFallbackModels({ entries: [{ model: "" }] })).toContain("non-empty string model");
  });

  test("rejects invalid variant", () => {
    expect(validateFallbackModels({ entries: [{ model: "opencode/big-pickle", variant: "turbo" }] })).toContain(
      "variant must be one of",
    );
  });

  test("rejects model ids without a provider", () => {
    expect(validateFallbackModels({ entries: [{ model: "big-pickle" }] })).toContain("provider/model");
  });

  test("accepts multi-segment catalog ids such as nvidia/<org>/<model>", () => {
    expect(validateFallbackModels({ entries: [{ model: "nvidia/google/gemma-3-12b-it" }] })).toBeNull();
    expect(validateFallbackModels({ entries: [{ model: "nvidia/meta/llama-guard-4-12b", variant: "high" }] })).toBeNull();
  });

  test("still rejects malformed references under the relaxed pattern", () => {
    expect(validateFallbackModels({ entries: [{ model: "/leading-slash/model" }] })).toContain("provider/model");
    expect(validateFallbackModels({ entries: [{ model: "provider/" }] })).toContain("provider/model");
    expect(validateFallbackModels({ entries: [{ model: "pro vider/model" }] })).toContain("provider/model");
    expect(validateFallbackModels({ entries: [{ model: "provider/mod el" }] })).toContain("provider/model");
  });
});

describe("buildJqWriteCommand", () => {
  test("delete case drops only model keys without changing sibling settings", () => {
    const command = buildJqWriteCommand("sisyphus", []);
    expect(command).toContain(
      `del(.agents[$agent].model, .agents[$agent].variant, .agents[$agent].models, .agents[$agent].fallback_models)`,
    );
    expect(command).not.toContain(".agents[$agent].permission");
    expect(command).toContain(`mv /tmp/omo.jsonc.tmp ${OMO_CONFIG}`);
    expect(command).not.toContain("base64");
  });

  test("single-entry case writes the model string plus variant", () => {
    const command = buildJqWriteCommand("sisyphus-junior", [{ model: "gpt-5.6-sol", variant: "medium" }]);
    expect(command).toContain(`--arg agent 'sisyphus-junior'`);
    expect(command).toContain(`--arg model 'gpt-5.6-sol'`);
    expect(command).toContain(`.agents[$agent].model = $model`);
    expect(command).toContain(`.agents[$agent].variant = "medium"`);
    expect(command).toContain(`del(.agents[$agent].models, .agents[$agent].fallback_models)`);
    expect(command).not.toContain(".agents[$agent].permission");
    expect(command).not.toContain("$schema");
    expect(command).not.toContain(".agents[$agent].other");
  });

  test("shell-quotes model values containing apostrophes", () => {
    const command = buildJqWriteCommand("explore", [{ model: "provider/model'; echo pwn" }]);

    expect(command).toContain(`--arg model 'provider/model'"'"'; echo pwn'`);
  });

  test("clear case removes all model keys without changing sibling settings", () => {
    const command = buildJqWriteCommand("explore", []);
    expect(command).toContain(
      `del(.agents[$agent].model, .agents[$agent].variant, .agents[$agent].models, .agents[$agent].fallback_models)`,
    );
    expect(command).not.toContain(".agents[$agent].permission");
    expect(command).not.toContain("$schema");
    expect(command).not.toContain(".agents[$agent].other");
  });
});

describe("displayNameToKey", () => {
  const keys = new Set(["sisyphus", "plan", "explore", "sisyphus-junior", "oracle"]);

  test("maps role display names to config keys", () => {
    expect(displayNameToKey("Sisyphus - ultraworker", keys)).toBe("sisyphus");
    expect(displayNameToKey("Sisyphus-Junior", keys)).toBe("sisyphus-junior");
  });

  test("passes plain display names through unchanged", () => {
    expect(displayNameToKey("plan", keys)).toBe("plan");
    expect(displayNameToKey("oracle", keys)).toBe("oracle");
  });

  test("returns null for unknown built-ins", () => {
    expect(displayNameToKey("build", keys)).toBeNull();
    expect(displayNameToKey("compaction", keys)).toBeNull();
  });
});

describe("buildRoutingWriteCommand", () => {
  test("creates routing.json when absent (fresh V2 volume) instead of failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-home-"));
    const routingPath = join(dir, "routing.json");
    const opencodePath = join(dir, "opencode.json");
    // opencode.json is entrypoint-guaranteed; routing.json is NOT seeded on a
    // fresh V2 volume. Before the fix jq exited 2 reading the missing file and
    // every chain write reported "jq routing write failed".
    writeFileSync(opencodePath, "{}\n");
    try {
      const command = buildRoutingWriteCommand("plan", [{ model: "opencode/space-bunny-free" }], routingPath, opencodePath);
      const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(existsSync(routingPath)).toBe(true);
      const routing = JSON.parse(readFileSync(routingPath, "utf-8")) as {
        version: number;
        chains: Record<string, { chain: unknown[] }>;
      };
      expect(routing.version).toBe(1);
      expect(routing.chains.plan?.chain).toEqual([{ model: "opencode/space-bunny-free" }]);
      const opencode = JSON.parse(readFileSync(opencodePath, "utf-8")) as {
        agent: Record<string, { model: string }>;
      };
      expect(opencode.agent.plan?.model).toBe("opencode/space-bunny-free");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty chain also seeds routing.json before deleting the agent entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-home-"));
    const routingPath = join(dir, "routing.json");
    const opencodePath = join(dir, "opencode.json");
    writeFileSync(opencodePath, '{"agent":{"plan":{"model":"p/m"}}}\n');
    try {
      const command = buildRoutingWriteCommand("plan", [], routingPath, opencodePath);
      const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      expect(existsSync(routingPath)).toBe(true);
      const opencode = JSON.parse(readFileSync(opencodePath, "utf-8")) as {
        agent: Record<string, unknown>;
      };
      expect(opencode.agent.plan).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
