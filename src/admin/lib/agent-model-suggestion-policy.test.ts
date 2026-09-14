import { describe, expect, test } from "bun:test";
import type { NormalizedModelMetadata } from "./model-metadata";
import {
  suggestForMode,
  effectiveCost,
  isContextInadequate,
  _test,
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
    inputPrice: 0,
    outputPrice: 0,
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
  const m = new Map<
    string,
    {
      reasoning?: boolean;
      toolcall?: boolean;
      attachment?: boolean;
      input?: Record<string, unknown>;
    }
  >();
  for (const r of refs) {
    // default capable for general/exploration: toolcall true
    m.set(r, { reasoning: true, toolcall: true, attachment: false, input: {} });
  }
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

describe("agent-model-suggestion-policy join", () => {
  test("intersection mismatch excludes external-only model", () => {
    const catalog = ["openai/gpt-4o", "anthropic/claude"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["openai/gpt-4o", meta("openai/gpt-4o")],
      ["openai/external-only", meta("openai/external-only")],
    ]);
    const input = baseInput({
      mode: "economy",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    const out = suggestForMode(input);
    // only openai/gpt-4o should be considered, external-only not in catalog => not suggested via other provider
    expect(out.suggestions.get("general")?.model).toBe("openai/gpt-4o");
  });

  test("identity mismatch requires complete provider/model identity", () => {
    // metadata key is provider/model but catalog has different provider prefix
    const catalog = ["openai/gpt-4o"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["anthropic/gpt-4o", meta("anthropic/gpt-4o")],
    ]);
    const input = baseInput({
      mode: "economy",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    const out = suggestForMode(input);
    expect(out.suggestions.has("general")).toBe(false);
  });
});

describe("free mode filtering", () => {
  const freeMeta = (ref: string, o: Partial<NormalizedModelMetadata> = {}) =>
    meta(ref, { inputPrice: 0, outputPrice: 0, ...o });

  test("excludes paid candidate", () => {
    const catalog = ["p/free", "p/paid"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/free", freeMeta("p/free")],
      ["p/paid", freeMeta("p/paid", { inputPrice: 5, outputPrice: 10 })],
    ]);
    const input = baseInput({
      mode: "free",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    const out = suggestForMode(input);
    expect(out.suggestions.get("general")?.model).toBe("p/free");
  });

  test("excludes unknown cost (null)", () => {
    const catalog = ["p/free", "p/unknown"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/free", freeMeta("p/free")],
      [
        "p/unknown",
        freeMeta("p/unknown", { inputPrice: null, outputPrice: null }),
      ],
    ]);
    const input = baseInput({
      mode: "free",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    const out = suggestForMode(input);
    expect(out.suggestions.get("general")?.model).toBe("p/free");
    // Only free qualifies, unknown excluded
  });

  test("excludes stale metadata", () => {
    const catalog = ["p/free"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/free", freeMeta("p/free")],
    ]);
    const input = baseInput({
      mode: "free",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
      sourceStatus: "stale",
      sourceAgeMs: 5_000_000,
      warnings: ["stale_metadata"],
    });
    const out = suggestForMode(input);
    expect(out.suggestions.has("general")).toBe(false);
    expect(out.sourceStatus).toBe("stale");
  });

  test("excludes deprecated", () => {
    const catalog = ["p/free", "p/dep"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/free", freeMeta("p/free")],
      ["p/dep", freeMeta("p/dep", { deprecated: true })],
    ]);
    // Only deprecated candidate if free is also deprecated => empty
    const input = baseInput({
      mode: "free",
      catalog: ["p/dep"],
      metadata: new Map([["p/dep", freeMeta("p/dep", { deprecated: true })]]),
      capabilities: caps(["p/dep"]),
      agents: ["general"],
    });
    expect(suggestForMode(input).suggestions.has("general")).toBe(false);
  });

  test("excludes incapable (reasoning agent without reasoning)", () => {
    const catalog = ["p/free"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/free", freeMeta("p/free", { reasoning: false, toolCall: true })],
    ]);
    const input = baseInput({
      mode: "free",
      catalog,
      metadata,
      // capabilities also influence score but minimum for free uses metadata reasoning/toolCall
      capabilities: new Map([["p/free", { reasoning: false, toolcall: true }]]),
      agents: ["plan"], // reasoning category
    });
    const out = suggestForMode(input);
    expect(out.suggestions.has("plan")).toBe(false);
  });

  test("excludes missing context for free", () => {
    const catalog = ["p/free"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/free", freeMeta("p/free", { contextLimit: null })],
    ]);
    const input = baseInput({
      mode: "free",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    expect(suggestForMode(input).suggestions.has("general")).toBe(false);
  });

  test("no candidate yields no suggestion without fallback", () => {
    const catalog = ["p/paid"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/paid", freeMeta("p/paid", { inputPrice: 10, outputPrice: 10 })],
    ]);
    const input = baseInput({
      mode: "free",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general", "plan"],
    });
    const out = suggestForMode(input);
    expect(out.suggestions.size).toBe(0);
  });

  test("fresh zero-price capable is eligible", () => {
    const catalog = ["p/free"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/free", freeMeta("p/free")],
    ]);
    const input = baseInput({
      mode: "free",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    const out = suggestForMode(input);
    expect(out.suggestions.get("general")?.model).toBe("p/free");
    expect(out.suggestions.get("general")?.reason.length).toBeGreaterThan(0);
    expect((out.suggestions.get("general")?.reason.length ?? 0) <= 200).toBe(
      true,
    );
  });
});

describe("economy ranking", () => {
  test("effective cost ordering input*0.6+output*0.4 ascending", () => {
    const catalog = ["p/cheap", "p/expensive"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/cheap", meta("p/cheap", { inputPrice: 1, outputPrice: 1 })], // 0.6+0.4=1.0
      ["p/expensive", meta("p/expensive", { inputPrice: 10, outputPrice: 10 })], // 10
    ]);
    const input = baseInput({
      mode: "economy",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    const out = suggestForMode(input);
    expect(out.suggestions.get("general")?.model).toBe("p/cheap");
  });

  test("missing price ranks after known price (Infinity)", () => {
    const catalog = ["p/known", "p/unknown"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/known", meta("p/known", { inputPrice: 1, outputPrice: 1 })],
      ["p/unknown", meta("p/unknown", { inputPrice: null, outputPrice: 1 })],
    ]);
    const input = baseInput({
      mode: "economy",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    const out = suggestForMode(input);
    // known should win despite unknown being lexicographically earlier? check ordering
    expect(out.suggestions.get("general")?.model).toBe("p/known");
    expect(
      effectiveCost(meta("p/unknown", { inputPrice: null, outputPrice: 1 })),
    ).toBe(Infinity);
  });

  test("capability score tie-breaker descending then reference ascending", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1 })],
      ["p/b", meta("p/b", { inputPrice: 1, outputPrice: 1 })],
    ]);
    // a has lower capability score
    const capabilities: PolicyCapabilityCatalog = new Map([
      ["p/a", { reasoning: false, toolcall: false }],
      [
        "p/b",
        {
          reasoning: true,
          toolcall: true,
          attachment: true,
          input: { a: {}, b: {} },
        },
      ],
    ]);
    const input = baseInput({
      mode: "economy",
      catalog,
      metadata,
      capabilities,
      agents: ["general"],
    });
    const out = suggestForMode(input);
    // b higher score should win despite a < b lexicographically
    expect(out.suggestions.get("general")?.model).toBe("p/b");
  });

  test("reference tie-breaker when cost and capability equal", () => {
    const catalog = ["p/b", "p/a"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1 })],
      ["p/b", meta("p/b", { inputPrice: 1, outputPrice: 1 })],
    ]);
    const capabilities = caps(catalog);
    // caps gives equal score for both
    const input = baseInput({
      mode: "economy",
      catalog,
      metadata,
      capabilities,
      agents: ["general"],
    });
    const out = suggestForMode(input);
    expect(out.suggestions.get("general")?.model).toBe("p/a");
  });

  test("missing context is inadequate", () => {
    const catalog = ["p/good", "p/bad"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      [
        "p/good",
        meta("p/good", {
          inputPrice: 1,
          outputPrice: 1,
          contextLimit: 100_000,
        }),
      ],
      [
        "p/bad",
        meta("p/bad", {
          inputPrice: 0.1,
          outputPrice: 0.1,
          contextLimit: null,
        }),
      ],
    ]);
    const input = baseInput({
      mode: "economy",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    const out = suggestForMode(input);
    // bad has cheaper cost but inadequate context, so excluded
    expect(out.suggestions.get("general")?.model).toBe("p/good");
    expect(isContextInadequate(meta("p/bad", { contextLimit: null }))).toBe(
      true,
    );
    expect(isContextInadequate(meta("p/good", { contextLimit: 1 }))).toBe(
      false,
    );
  });

  test("known context is adequate (any known value)", () => {
    const catalog = ["p/tiny"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      [
        "p/tiny",
        meta("p/tiny", {
          inputPrice: 1,
          outputPrice: 1,
          contextLimit: 100_000,
        }),
      ],
    ]);
    const input = baseInput({
      mode: "economy",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    expect(suggestForMode(input).suggestions.has("general")).toBe(true);
  });
});

describe("performance ranking", () => {
  test("benchmark descending when comparable exists", () => {
    const catalog = ["p/low", "p/high"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      [
        "p/low",
        meta("p/low", {
          benchmarkScore: 80,
          contextLimit: 100_000,
          outputLimit: 8_192,
        }),
      ],
      [
        "p/high",
        meta("p/high", {
          benchmarkScore: 95,
          contextLimit: 100_000,
          outputLimit: 8_192,
        }),
      ],
    ]);
    const input = baseInput({
      mode: "performance",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    const out = suggestForMode(input);
    expect(out.suggestions.get("general")?.model).toBe("p/high");
    expect(out.suggestions.get("general")?.heuristic).toBe(false);
  });

  test("heuristic true when no comparable benchmark", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      [
        "p/a",
        meta("p/a", {
          benchmarkScore: null,
          contextLimit: 200_000,
          outputLimit: 8_192,
        }),
      ],
      [
        "p/b",
        meta("p/b", {
          benchmarkScore: null,
          contextLimit: 100_000,
          outputLimit: 32_000,
        }),
      ],
    ]);
    const input = baseInput({
      mode: "performance",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    const out = suggestForMode(input);
    expect(out.suggestions.get("general")?.heuristic).toBe(true);
    expect(out.suggestions.get("general")?.reason.toLowerCase()).toContain(
      "heuristic",
    );
  });

  test("performance falls back to roleScore via saturated context/output then reference", () => {
    const catalog = ["p/a", "p/b"];
    // no bench, same capability score, a has larger context
    const metadata = new Map<string, NormalizedModelMetadata>([
      [
        "p/a",
        meta("p/a", {
          benchmarkScore: null,
          contextLimit: 200_000,
          outputLimit: 8_192,
          fetchedAt: 1000,
        }),
      ],
      [
        "p/b",
        meta("p/b", {
          benchmarkScore: null,
          contextLimit: 100_000,
          outputLimit: 8_192,
          fetchedAt: 1000,
        }),
      ],
    ]);
    const capsEqual = caps(catalog);
    const input = baseInput({
      mode: "performance",
      catalog,
      metadata,
      capabilities: capsEqual,
      agents: ["general"],
    });
    expect(suggestForMode(input).suggestions.get("general")?.model).toBe("p/a");

    // tie context, b larger output
    const metadata2 = new Map<string, NormalizedModelMetadata>([
      [
        "p/a",
        meta("p/a", {
          benchmarkScore: null,
          contextLimit: 100_000,
          outputLimit: 8_192,
          fetchedAt: 1000,
        }),
      ],
      [
        "p/b",
        meta("p/b", {
          benchmarkScore: null,
          contextLimit: 100_000,
          outputLimit: 32_000,
          fetchedAt: 1000,
        }),
      ],
    ]);
    const input2 = baseInput({
      mode: "performance",
      catalog,
      metadata: metadata2,
      capabilities: capsEqual,
      agents: ["general"],
    });
    expect(suggestForMode(input2).suggestions.get("general")?.model).toBe(
      "p/b",
    );

    // tie context/output/roleScore → reference ascending (not freshness)
    const metadata3 = new Map<string, NormalizedModelMetadata>([
      [
        "p/a",
        meta("p/a", {
          benchmarkScore: null,
          contextLimit: 100_000,
          outputLimit: 8_192,
          fetchedAt: 1000,
        }),
      ],
      [
        "p/b",
        meta("p/b", {
          benchmarkScore: null,
          contextLimit: 100_000,
          outputLimit: 8_192,
          fetchedAt: 2000,
        }),
      ],
    ]);
    const input3 = baseInput({
      mode: "performance",
      catalog,
      metadata: metadata3,
      capabilities: capsEqual,
      agents: ["general"],
    });
    expect(suggestForMode(input3).suggestions.get("general")?.model).toBe(
      "p/a",
    );
  });

  test("reference tie-breaker for performance", () => {
    const catalog = ["p/b", "p/a"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      [
        "p/a",
        meta("p/a", {
          benchmarkScore: 90,
          contextLimit: 100_000,
          outputLimit: 8_192,
          fetchedAt: 1000,
        }),
      ],
      [
        "p/b",
        meta("p/b", {
          benchmarkScore: 90,
          contextLimit: 100_000,
          outputLimit: 8_192,
          fetchedAt: 1000,
        }),
      ],
    ]);
    const capsEqual = caps(catalog);
    const input = baseInput({
      mode: "performance",
      catalog,
      metadata,
      capabilities: capsEqual,
      agents: ["general"],
    });
    expect(suggestForMode(input).suggestions.get("general")?.model).toBe("p/a");
  });

  test("missing context excluded in performance", () => {
    const catalog = ["p/good", "p/bad"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/good", meta("p/good", { benchmarkScore: 10, contextLimit: 100_000 })],
      ["p/bad", meta("p/bad", { benchmarkScore: 99, contextLimit: null })],
    ]);
    const input = baseInput({
      mode: "performance",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    expect(suggestForMode(input).suggestions.get("general")?.model).toBe(
      "p/good",
    );
  });
});


describe("role-aware agent mappings", () => {
  test("all roles map correctly plus unknown falls back to general", () => {
    expect(_test.roleForAgent("orchestrator")).toBe("planning");
    expect(_test.roleForAgent("oracle")).toBe("deep-reasoning");
    expect(_test.roleForAgent("councillor")).toBe("review");
    expect(_test.roleForAgent("council")).toBe("review");
    expect(_test.roleForAgent("fixer")).toBe("coding");
    expect(_test.roleForAgent("designer")).toBe("coding");
    expect(_test.roleForAgent("explorer")).toBe("exploration");
    expect(_test.roleForAgent("librarian")).toBe("research");
    expect(_test.roleForAgent("observer")).toBe("multimodal");
    expect(_test.roleForAgent("general")).toBe("general");
    expect(_test.roleForAgent("unknown-agent-xyz")).toBe("general");
    expect(_test.roleForAgent("custom-bot")).toBe("general");
  });

  test("general min context/output boundaries exclude below-minimum", () => {
    const generalProfile = _test.profileForAgent("general");
    expect(generalProfile.minContext).toBe(64_000);
    expect(generalProfile.prefContext).toBe(256_000);
    expect(generalProfile.minOutput).toBe(8_000);
    expect(generalProfile.prefOutput).toBe(64_000);
    const catalog = ["p/ok", "p/small"];
    const metadata = new Map([
      ["p/ok", meta("p/ok", { contextLimit: 64_000, outputLimit: 8_192 })],
      ["p/small", meta("p/small", { contextLimit: 63_999, outputLimit: 8_192 })],
    ]);
    const input = baseInput({ mode: "economy", catalog, metadata, capabilities: caps(catalog), agents: ["general"] });
    expect(suggestForMode(input).suggestions.get("general")?.model).toBe("p/ok");
    const metadata2 = new Map([
      ["p/ok", meta("p/ok", { contextLimit: 64_000, outputLimit: 8_192 })],
      ["p/small-out", meta("p/small-out", { contextLimit: 64_000, outputLimit: 7_999 })],
    ]);
    const input2 = baseInput({ mode: "economy", catalog: ["p/ok","p/small-out"], metadata: metadata2, capabilities: caps(["p/ok","p/small-out"]), agents: ["general"] });
    expect(suggestForMode(input2).suggestions.get("general")?.model).toBe("p/ok");
  });

  test("saturated fit is 0 at min, 1 at preferred, and capped above preferred", () => {
    const gp = _test.profileForAgent("general");
    expect(_test.saturatedFit(gp.minContext, gp.minContext, gp.prefContext)).toBe(0);
    expect(_test.saturatedFit(gp.prefContext, gp.minContext, gp.prefContext)).toBe(1);
    expect(_test.saturatedFit(gp.prefContext + 1_000_000, gp.minContext, gp.prefContext)).toBe(1);
    const mid = (gp.minContext + gp.prefContext) / 2;
    expect(_test.saturatedFit(mid, gp.minContext, gp.prefContext)).toBeCloseTo(0.5, 5);
    expect(_test.saturatedFit(100_000, 100_000, 100_000)).toBe(1);
    expect(_test.saturatedFit(gp.minOutput, gp.minOutput, gp.prefOutput)).toBe(0);
    expect(_test.saturatedFit(gp.prefOutput, gp.minOutput, gp.prefOutput)).toBe(1);
    expect(_test.saturatedFit(gp.prefOutput + 1_000, gp.minOutput, gp.prefOutput)).toBe(1);
    const catalog = ["p/a","p/b"];
    const metadata = new Map([
      ["p/a", meta("p/a", { contextLimit: gp.prefContext, outputLimit: gp.prefOutput })],
      ["p/b", meta("p/b", { contextLimit: gp.prefContext + 500_000, outputLimit: gp.prefOutput + 100_000 })],
    ]);
    const input = baseInput({ mode: "performance", catalog, metadata, capabilities: caps(catalog), agents: ["general"] });
    expect(suggestForMode(input).suggestions.get("general")?.model).toBe("p/a");
  });

  test("multimodal attachment required even when model id contains Vision", () => {
    const catalog = ["p/Vision-pro-model","p/real-multimodal"];
    const metadata = new Map([
      ["p/Vision-pro-model", meta("p/Vision-pro-model", { contextLimit: 100_000, outputLimit: 32_000 })],
      ["p/real-multimodal", meta("p/real-multimodal", { contextLimit: 100_000, outputLimit: 32_000 })],
    ]);
    const capabilities = new Map([
      ["p/Vision-pro-model", { reasoning: true, toolcall: true, attachment: false }],
      ["p/real-multimodal", { reasoning: true, toolcall: true, attachment: true }],
    ]);
    const input = baseInput({ mode: "performance", catalog, metadata, capabilities, agents: ["observer"] });
    expect(suggestForMode(input).suggestions.get("observer")?.model).toBe("p/real-multimodal");
    const input2 = baseInput({ mode: "economy", catalog: ["p/Vision-pro-model"], metadata: new Map([["p/Vision-pro-model", meta("p/Vision-pro-model",{contextLimit:100_000, outputLimit:32000})]]), capabilities: new Map([["p/Vision-pro-model", {toolcall:true, attachment:false}]]), agents: ["observer"] });
    expect(suggestForMode(input2).suggestions.has("observer")).toBe(false);
  });
});

describe("benchmark normalization and heuristic", () => {
  test("two comparable benchmark values normalize and higher wins without overriding all role fit", () => {
    const catalog = ["p/low","p/high"];
    const metadata = new Map([
      ["p/low", meta("p/low", { benchmarkScore: 80, contextLimit: 100_000, outputLimit: 8_192, reasoning: true })],
      ["p/high", meta("p/high", { benchmarkScore: 95, contextLimit: 100_000, outputLimit: 8_192, reasoning: false })],
    ]);
    const input = baseInput({ mode: "performance", catalog, metadata, capabilities: caps(catalog), agents: ["general"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("general")?.model).toBe("p/high");
    expect(out.suggestions.get("general")?.heuristic).toBe(false);
  });

  test("missing benchmark in comparable cohort receives 0 for that dimension", () => {
    const catalog = ["p/a","p/b","p/c"];
    const metadata = new Map([
      ["p/a", meta("p/a", { benchmarkScore: 80, contextLimit: 100_000, outputLimit: 8_192 })],
      ["p/b", meta("p/b", { benchmarkScore: 95, contextLimit: 100_000, outputLimit: 8_192 })],
      ["p/c", meta("p/c", { benchmarkScore: null, contextLimit: 100_000, outputLimit: 8_192 })],
    ]);
    const input = baseInput({ mode: "performance", catalog, metadata, capabilities: caps(catalog), agents: ["general"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("general")?.model).toBe("p/b");
    const profile = _test.profileForAgent("general");
    const cands = [
      { reference: "p/a", providerId: "p", modelId: "a", metadata: meta("p/a",{benchmarkScore:80}), capability: {toolcall:true}, capabilityScore:0, effectiveCost: 1 },
      { reference: "p/b", providerId: "p", modelId: "b", metadata: meta("p/b",{benchmarkScore:95}), capability: {toolcall:true}, capabilityScore:0, effectiveCost: 1 },
      { reference: "p/c", providerId: "p", modelId: "c", metadata: meta("p/c",{benchmarkScore:null}), capability: {toolcall:true}, capabilityScore:0, effectiveCost: 1 },
    ];
    const res = _test.computeRoleScores(profile, cands as unknown as readonly import("./agent-model-suggestion-policy").PolicyCandidate[]);
    const low = res.scored.find(s=>s.reference==="p/a")!;
    const missing = res.scored.find(s=>s.reference==="p/c")!;
    expect(missing.roleScore).toBe(low.roleScore);
    expect(res.heuristic).toBe(false);
  });

  test("fewer than two benchmark values -> heuristic and renormalized weights", () => {
    const catalog = ["p/x","p/y"];
    const metadata = new Map([
      ["p/x", meta("p/x", { benchmarkScore: null, contextLimit: 100_000, outputLimit: 8_192 })],
      ["p/y", meta("p/y", { benchmarkScore: null, contextLimit: 100_000, outputLimit: 8_192 })],
    ]);
    const input = baseInput({ mode: "performance", catalog, metadata, capabilities: caps(catalog), agents: ["general"] });
    const out = suggestForMode(input);
    expect(out.suggestions.get("general")?.heuristic).toBe(true);
    const metadata2 = new Map([
      ["p/x", meta("p/x", { benchmarkScore: 85, contextLimit: 100_000, outputLimit: 8_192 })],
      ["p/y", meta("p/y", { benchmarkScore: null, contextLimit: 100_000, outputLimit: 8_192 })],
    ]);
    const input2 = baseInput({ mode: "performance", catalog, metadata: metadata2, capabilities: caps(catalog), agents: ["general"] });
    expect(suggestForMode(input2).suggestions.get("general")?.heuristic).toBe(true);
  });
});

describe("multi-agent and reason structural tokens", () => {
  test("different roles select their own best eligible candidate; duplicates allowed and permutation stable", () => {
    const catalog = ["p/code-specialist","p/research-giant","p/generalist","p/explore-lite"];
    const metadata = new Map([
      ["p/code-specialist", meta("p/code-specialist", { contextLimit: 128_000, outputLimit: 64_000, reasoning: false, toolCall: true, structuredOutput: true, benchmarkScore: 90 })],
      ["p/research-giant", meta("p/research-giant", { contextLimit: 1_000_000, outputLimit: 64_000, reasoning: true, toolCall: true, structuredOutput: false, benchmarkScore: 90 })],
      ["p/generalist", meta("p/generalist", { contextLimit: 256_000, outputLimit: 64_000, reasoning: true, toolCall: true, structuredOutput: true, benchmarkScore: 90 })],
      ["p/explore-lite", meta("p/explore-lite", { contextLimit: 128_000, outputLimit: 32_000, reasoning: false, toolCall: true, structuredOutput: false, benchmarkScore: 90 })],
    ]);
    const capabilities = new Map([
      ["p/code-specialist", { toolcall: true, reasoning: false }],
      ["p/research-giant", { toolcall: true, reasoning: true }],
      ["p/generalist", { toolcall: true, reasoning: true }],
      ["p/explore-lite", { toolcall: true, reasoning: false }],
    ]);
    const agents = ["sisyphus-junior","librarian","explore","general","oracle"];
    const input = baseInput({ mode: "performance", catalog, metadata, capabilities, agents });
    const _out = suggestForMode(input);
    const singleCatalog = ["p/shared"];
    const singleMeta = new Map([["p/shared", meta("p/shared",{contextLimit:256_000, outputLimit:64_000})]]);
    const singleOut = suggestForMode({ mode:"performance", providers:[], catalog:singleCatalog, metadata:singleMeta, sourceStatus:"fresh", sourceAgeMs:0, warnings:[], capabilities: caps(singleCatalog), agents: ["oracle","explore","general"]});
    expect(singleOut.suggestions.size).toBe(3);
    expect([...singleOut.suggestions.values()].every(v=>v.model==="p/shared")).toBe(true);
    const shuffledCatalog = [...catalog].reverse();
    const inputShuffled = baseInput({ mode: "performance", catalog: shuffledCatalog, metadata, capabilities, agents: [...agents].reverse() });
    const outShuffled = suggestForMode(inputShuffled);
    for (const a of agents) {
      expect(_out.suggestions.get(a)?.model).toBe(outShuffled.suggestions.get(a)?.model);
    }
  });

  test("reason contains mode, role, score, and heuristic structural tokens and is bounded", () => {
    const catalog = ["p/a","p/b"];
    const metadata = new Map([
      ["p/a", meta("p/a", { benchmarkScore: 80, contextLimit: 256_000, outputLimit: 32_000 })],
      ["p/b", meta("p/b", { benchmarkScore: 90, contextLimit: 256_000, outputLimit: 32_000 })],
    ]);
    const inputPerf = baseInput({ mode: "performance", catalog, metadata, capabilities: caps(catalog), agents: ["plan","unknown-bot"] });
    const outPerf = suggestForMode(inputPerf);
    const reasonPlan = outPerf.suggestions.get("plan")?.reason ?? "";
    expect(reasonPlan.includes("performance")).toBe(true);
    expect(reasonPlan.includes("planning")).toBe(true);
    expect(/score \d\.\d{2}/.test(reasonPlan)).toBe(true);
    expect(reasonPlan.length).toBeLessThanOrEqual(200);
    const reasonUnknown = outPerf.suggestions.get("unknown-bot")?.reason ?? "";
    expect(reasonUnknown.includes("general")).toBe(true);
    expect(reasonUnknown.includes("performance")).toBe(true);
    const heuristicMeta = new Map([
      ["p/a", meta("p/a", { benchmarkScore: null, contextLimit: 100_000, outputLimit: 8_192 })],
      ["p/b", meta("p/b", { benchmarkScore: null, contextLimit: 100_000, outputLimit: 8_192 })],
    ]);
    const heuristicOut = suggestForMode(baseInput({ mode: "performance", catalog, metadata: heuristicMeta, capabilities: caps(catalog), agents: ["general"] }));
    expect(heuristicOut.suggestions.get("general")?.heuristic).toBe(true);
    expect(heuristicOut.suggestions.get("general")?.reason.toLowerCase().includes("heuristic")).toBe(true);
    const freeReason = suggestForMode(baseInput({ mode:"free", catalog:["p/a"], metadata: new Map([["p/a", meta("p/a",{inputPrice:0, outputPrice:0, contextLimit:100_000, outputLimit:8192})]]), capabilities: caps(["p/a"]), agents:["general"]})).suggestions.get("general")?.reason ?? "";
    expect(freeReason.includes("free")).toBe(true);
    expect(freeReason.includes("role general")).toBe(true);
    const ecoReason = suggestForMode(baseInput({ mode:"economy", catalog:["p/a"], metadata: new Map([["p/a", meta("p/a",{inputPrice:1, outputPrice:1, contextLimit:100_000, outputLimit:8192})]]), capabilities: caps(["p/a"]), agents:["general"]})).suggestions.get("general")?.reason ?? "";
    expect(ecoReason.includes("economy")).toBe(true);
    expect(ecoReason.includes("cost")).toBe(true);
  });

  test("economy reason names only cost and role fit", () => {
    const catalog = ["p/a", "p/b"];
    const metadata = new Map([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1, benchmarkScore: 80 })],
      ["p/b", meta("p/b", { inputPrice: 2, outputPrice: 2, benchmarkScore: 90 })],
    ]);
    const reason =
      suggestForMode(
        baseInput({
          mode: "economy",
          catalog,
          metadata,
          capabilities: caps(catalog),
          agents: ["general"],
        }),
      ).suggestions.get("general")?.reason ?? "";

    expect(reason).toContain("economy");
    expect(reason).toContain("role general");
    expect(reason).toMatch(/score \d\.\d{2}/);
    expect(reason).toContain("cost 1.00");
    expect(reason).toContain("p/a");
    for (const dimension of [
      "benchmark",
      "reasoning,",
      "toolCall",
      "attachment",
      "structured",
      "contextFit",
      "outputFit",
    ]) {
      expect(reason).not.toContain(dimension);
    }
    expect(reason.length).toBeLessThanOrEqual(200);
  });
});

describe("helpers", () => {
  test("isContextInadequate only null", () => {
    expect(_test.isContextInadequate(meta("p/x", { contextLimit: null }))).toBe(
      true,
    );
    expect(_test.isContextInadequate(meta("p/x", { contextLimit: 1 }))).toBe(
      false,
    );
    expect(
      _test.isContextInadequate(meta("p/x", { contextLimit: 128000 })),
    ).toBe(false);
  });

  test("effectiveCost Infinity when missing", () => {
    expect(
      _test.effectiveCost(meta("p/x", { inputPrice: null, outputPrice: 1 })),
    ).toBe(Infinity);
    expect(
      _test.effectiveCost(meta("p/x", { inputPrice: 1, outputPrice: null })),
    ).toBe(Infinity);
    expect(
      _test.effectiveCost(meta("p/x", { inputPrice: null, outputPrice: null })),
    ).toBe(Infinity);
    expect(
      _test.effectiveCost(meta("p/x", { inputPrice: 2, outputPrice: 4 })),
    ).toBeCloseTo(2 * 0.6 + 4 * 0.4);
  });

  test("provider scope filtering", () => {
    const catalog = ["p/a", "q/b"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1 })],
      ["q/b", meta("q/b", { inputPrice: 0.1, outputPrice: 0.1 })],
    ]);
    const input = baseInput({
      mode: "economy",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
      providers: ["p"],
    });
    expect(suggestForMode(input).suggestions.get("general")?.model).toBe("p/a");
  });

  test("bounded reason length", () => {
    const catalog = ["p/a"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a")],
    ]);
    const input = baseInput({
      mode: "performance",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    const reason =
      suggestForMode(input).suggestions.get("general")?.reason ?? "";
    expect(reason.length <= 200).toBe(true);
  });

  test("warning handling passthrough", () => {
    const catalog = ["p/a"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a")],
    ]);
    const input = baseInput({
      mode: "economy",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
      warnings: ["incomplete_metadata", "stale_metadata"],
      sourceStatus: "stale",
      sourceAgeMs: 1000,
    });
    const out = suggestForMode(input);
    expect(out.warnings).toEqual(["incomplete_metadata", "stale_metadata"]);
    expect(out.sourceStatus).toBe("stale");
  });

  test("uses codepoint order for equal-score references", () => {
    const catalog = ["p/a", "p/Z"];
    const metadata = new Map<string, NormalizedModelMetadata>([
      ["p/a", meta("p/a", { inputPrice: 1, outputPrice: 1 })],
      ["p/Z", meta("p/Z", { inputPrice: 1, outputPrice: 1 })],
    ]);
    const input = baseInput({
      mode: "economy",
      catalog,
      metadata,
      capabilities: caps(catalog),
      agents: ["general"],
    });
    expect(suggestForMode(input).suggestions.get("general")?.model).toBe("p/Z");
  });
});
