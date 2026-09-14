import { describe, expect, test } from "bun:test";
import type { NormalizedModelMetadata } from "./model-metadata";
import {
  suggestForMode,
  type PolicyCapabilityCatalog,
  type PolicyInput,
} from "./agent-model-suggestion-policy";

function meta(
  ref: string,
  overrides: Partial<NormalizedModelMetadata> = {},
): NormalizedModelMetadata {
  const [providerId, modelId] = ref.split("/") as [string, string];
  return {
    providerId,
    modelId,
    reference: ref,
    inputPrice: 1,
    outputPrice: 1,
    contextLimit: 100_000,
    outputLimit: 8_192,
    reasoning: true,
    toolCall: true,
    structuredOutput: null,
    deprecated: false,
    benchmarkScore: null,
    fetchedAt: 1_000,
    ...overrides,
  };
}

function caps(refs: readonly string[]): PolicyCapabilityCatalog {
  const m = new Map<string, { reasoning?: boolean; toolcall?: boolean; attachment?: boolean; input?: Record<string, unknown> }>();
  for (const r of refs) m.set(r, { reasoning: true, toolcall: true, attachment: false, input: {} });
  return m;
}

function baseInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    mode: "economy",
    providers: [],
    catalog: [],
    metadata: new Map(),
    sourceStatus: "fresh",
    sourceAgeMs: 0,
    warnings: [],
    capabilities: new Map(),
    agents: ["general"],
    ...overrides,
  };
}

describe("bounded diversity - non-tied winner remains unchanged", () => {
  test("economy: strictly cheaper wins despite prior reuse", () => {
    const catalog = ["p/cheap", "p/expensive"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/cheap", meta("p/cheap", { inputPrice: 1, outputPrice: 1 })],
      ["p/expensive", meta("p/expensive", { inputPrice: 10, outputPrice: 10 })],
    ]);
    const input = baseInput({
      mode: "economy",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["fixer", "general"],
    });
    const out = suggestForMode(input);
    expect(out.suggestions.get("fixer")?.model).toBe("p/cheap");
    expect(out.suggestions.get("general")?.model).toBe("p/cheap");
    expect(out.suggestions.get("general")?.reason.includes("diversity")).toBe(false);
    expect(out.suggestions.get("general")?.reason.includes("cross-review")).toBe(false);
  });

  test("performance: strictly higher roleScore wins despite reuse", () => {
    const catalog = ["p/high", "p/low"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/high", meta("p/high", { contextLimit: 256_000, outputLimit: 64_000, benchmarkScore: 90 })],
      ["p/low", meta("p/low", { contextLimit: 64_000, outputLimit: 8_192, benchmarkScore: 10 })],
    ]);
    const input = baseInput({
      mode: "performance",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["fixer", "general"],
    });
    const out = suggestForMode(input);
    expect(out.suggestions.get("fixer")?.model).toBe("p/high");
    expect(out.suggestions.get("general")?.model).toBe("p/high");
    expect(out.suggestions.get("general")?.reason.includes("diversity")).toBe(false);
  });
});

describe("bounded diversity - tied candidates diversify deterministically", () => {
  test("economy tie: second agent diversifies to unused model", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1 })],
      ["p/b", meta("p/b", { inputPrice: 1, outputPrice: 1 })],
    ]);
    const input = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "general"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("fixer")?.model).toBe("p/a");
    expect(out.suggestions.get("general")?.model).toBe("p/b");
    expect(out.suggestions.get("general")?.reason.includes("diversity")).toBe(true);
    expect((out.suggestions.get("general")?.reason.length ?? 0) <= 200).toBe(true);
  });

  test("performance tie: second agent diversifies deterministically", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { contextLimit: 100_000, outputLimit: 8_192 })],
      ["p/b", meta("p/b", { contextLimit: 100_000, outputLimit: 8_192 })],
    ]);
    const input = baseInput({ mode: "performance", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "general"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("fixer")?.model).toBe("p/a");
    expect(out.suggestions.get("general")?.model).toBe("p/b");
    expect(out.suggestions.get("general")?.reason.includes("diversity")).toBe(true);
  });

  test("free tie: diversifies within exact roleScore tie", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 0, outputPrice: 0 })],
      ["p/b", meta("p/b", { inputPrice: 0, outputPrice: 0 })],
    ]);
    const input = baseInput({ mode: "free", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "general"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("fixer")?.model).toBe("p/a");
    expect(out.suggestions.get("general")?.model).toBe("p/b");
    expect(out.suggestions.get("general")?.reason.includes("diversity")).toBe(true);
  });
});

describe("bounded diversity - reuse count and provider count ordering", () => {
  test("provider diversity prefers never-used provider within tie", () => {
    const catalog = ["p1/a", "p1/b", "p2/c"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p1/a", meta("p1/a", { inputPrice: 1, outputPrice: 1 })],
      ["p1/b", meta("p1/b", { inputPrice: 1, outputPrice: 1 })],
      ["p2/c", meta("p2/c", { inputPrice: 1, outputPrice: 1 })],
    ]);
    const input = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "general", "explorer"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("fixer")?.model).toBe("p1/a");
    expect(out.suggestions.get("general")?.model).toBe("p2/c");
    expect(out.suggestions.get("explorer")?.model).toBe("p1/b");
  });

  test("model reuse ordering: least reused model wins before provider fallback", () => {
    const catalog = ["p/a", "p/b", "p/c"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })],
      ["p/b", meta("p/b", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })],
      ["p/c", meta("p/c", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })],
    ]);
    const input = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "general", "explorer", "plan"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("fixer")?.model).toBe("p/a");
    expect(out.suggestions.get("general")?.model).toBe("p/b");
    expect(out.suggestions.get("explorer")?.model).toBe("p/c");
    expect(out.suggestions.get("plan")?.model).toBe("p/a");
  });
});

describe("bounded diversity - high-risk cross-review separation", () => {
  test("review after coding diversifies away from coding model and marks cross-review", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })],
      ["p/b", meta("p/b", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })],
    ]);
    const input = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "councillor"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("fixer")?.model).toBe("p/a");
    expect(out.suggestions.get("councillor")?.model).toBe("p/b");
    expect(out.suggestions.get("councillor")?.reason.includes("cross-review")).toBe(true);
    expect((out.suggestions.get("councillor")?.reason.length ?? 0) <= 200).toBe(true);
  });

  test("deep-reasoning after coding cross-review", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })],
      ["p/b", meta("p/b", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })],
    ]);
    const input = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "oracle"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("oracle")?.model).toBe("p/b");
    expect(out.suggestions.get("oracle")?.reason.includes("cross-review")).toBe(true);
  });

  test("unknown counterpart is no-op: high-risk before coding does not cross-review diversify", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })],
      ["p/b", meta("p/b", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })],
    ]);
    const input = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["councillor", "fixer"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("councillor")?.model).toBe("p/a");
    expect(out.suggestions.get("councillor")?.reason.includes("cross-review")).toBe(false);
    expect(out.suggestions.get("councillor")?.reason.includes("diversity")).toBe(false);
    expect(out.suggestions.get("fixer")?.model).toBe("p/b");
    expect(out.suggestions.get("fixer")?.reason.includes("diversity")).toBe(true);
    expect(out.suggestions.get("fixer")?.reason.includes("cross-review")).toBe(false);
  });

  test("high-risk with only one tied candidate equal to coding model falls back to same model", () => {
    const catalog = ["p/a"];
    const metadata = new Map<string, NormalizedModelMetadata>([["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })]]);
    const input = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "councillor"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("councillor")?.model).toBe("p/a");
    expect(out.suggestions.get("councillor")?.reason.includes("diversity")).toBe(false);
  });
});

describe("bounded diversity - single candidate fallback", () => {
  test("single candidate selected without diversity marker", () => {
    const catalog = ["p/shared"];
    const metadata = new Map<string, NormalizedModelMetadata>([["p/shared", meta("p/shared", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })]]);
    const input = baseInput({ mode: "performance", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "general", "oracle"] });
    const out = suggestForMode(input);
    for (const agent of ["fixer", "general", "oracle"]) {
      expect(out.suggestions.get(agent)?.model).toBe("p/shared");
      expect(out.suggestions.get(agent)?.reason.includes("diversity")).toBe(false);
      expect(out.suggestions.get(agent)?.reason.includes("cross-review")).toBe(false);
    }
  });
});

describe("bounded diversity - input permutation remains deterministic", () => {
  test("catalog order permutation yields same diverse winners given same agent order", () => {
    const catalog = ["p/a", "p/b", "p/c"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1 })],
      ["p/b", meta("p/b", { inputPrice: 1, outputPrice: 1 })],
      ["p/c", meta("p/c", { inputPrice: 1, outputPrice: 1 })],
    ]);
    const agents = ["fixer", "general", "explorer"] as const;
    const input1 = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: [...agents] });
    const input2 = baseInput({ mode: "economy", catalog: [...catalog].reverse(), metadata, capabilities: caps([...catalog].reverse()), agents: [...agents] });
    const out1 = suggestForMode(input1);
    const out2 = suggestForMode(input2);
    for (const a of agents) expect(out1.suggestions.get(a)?.model).toBe(out2.suggestions.get(a)?.model);
  });

  test("ledger is run-local: second call does not inherit reuse", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1 })],
      ["p/b", meta("p/b", { inputPrice: 1, outputPrice: 1 })],
    ]);
    const input = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "general"] });
    const out1 = suggestForMode(input);
    const out2 = suggestForMode(input);
    expect(out1.suggestions.get("fixer")?.model).toBe(out2.suggestions.get("fixer")?.model);
    expect(out1.suggestions.get("general")?.model).toBe(out2.suggestions.get("general")?.model);
  });
});

describe("bounded diversity - reason marker is bounded", () => {
  test("diversity marker appears only when diversity decides and stays bounded", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })],
      ["p/b", meta("p/b", { inputPrice: 1, outputPrice: 1, contextLimit: 256_000 })],
    ]);
    const solo = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["general"] });
    const soloOut = suggestForMode(solo);
    expect(soloOut.suggestions.get("general")?.reason.includes("diversity")).toBe(false);
    const duo = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "general"] });
    const duoOut = suggestForMode(duo);
    expect(duoOut.suggestions.get("general")?.reason.includes("diversity")).toBe(true);
    expect((duoOut.suggestions.get("general")?.reason.length ?? 0) <= 200).toBe(true);
    const cross = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "councillor"] });
    const crossOut = suggestForMode(cross);
    expect(crossOut.suggestions.get("councillor")?.reason.includes("cross-review")).toBe(true);
    expect((crossOut.suggestions.get("councillor")?.reason.length ?? 0) <= 200).toBe(true);
  });

  test("no marker when tie group size is one", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1 })],
      ["p/b", meta("p/b", { inputPrice: 10, outputPrice: 10 })],
    ]);
    const input = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["fixer", "general"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("general")?.reason.includes("diversity")).toBe(false);
  });
});

describe("bounded diversity - legacy contracts remain intact", () => {
  test("suggestForMode response shape unchanged (no new fields, deterministic)", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1 })],
      ["p/b", meta("p/b", { inputPrice: 1, outputPrice: 1 })],
    ]);
    const input = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["general"] });
    const out = suggestForMode(input);
    expect(out.mode).toBe("economy");
    expect(Array.isArray(out.providers)).toBe(true);
    expect(out.sourceStatus).toBe("fresh");
    expect(Array.isArray(out.warnings)).toBe(true);
    expect(out.suggestions instanceof Map).toBe(true);
    const suggestion = out.suggestions.get("general");
    expect(suggestion !== undefined).toBe(true);
    if (suggestion !== undefined) {
      expect(typeof suggestion.model).toBe("string");
      expect(typeof suggestion.reason).toBe("string");
      expect(typeof suggestion.heuristic).toBe("boolean");
      expect(typeof suggestion.metadata).toBe("object");
      expect((suggestion as Record<string, unknown>).diversity).toBeUndefined();
      expect((suggestion as Record<string, unknown>).provider).toBeUndefined();
    }
    const json = JSON.stringify([...out.suggestions.entries()]);
    expect(JSON.parse(json)[0][1].model).toBe(out.suggestions.get("general")?.model);
  });
});
