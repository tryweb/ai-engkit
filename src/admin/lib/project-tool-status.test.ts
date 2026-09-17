import { describe, expect, test } from "bun:test";
import { createToolStatusProbe, type ProjectToolStatusProvider } from "./project-tool-status";
import type { ProjectCommand } from "./projects-overview";

type CmdResult = { exitCode: number; stdout: string; stderr: string };

interface FakeHandlers {
  codegraph?: (source: string) => CmdResult;
  leanctxProject?: (source: string) => CmdResult;
  site?: (source: string) => CmdResult;
  gain?: (source: string) => CmdResult;
  verify?: (source: string) => CmdResult;
  valueReport?: (source: string) => CmdResult;
  proveReport?: (source: string) => CmdResult;
  savingsReport?: (source: string) => CmdResult;
}

/**
 * Routes each probe source to a fake handler. Defaults model a healthy but
 * empty environment: codegraph CLI missing (exit 127 → null), no leanCTX
 * install (exit 0, empty output → null site stats, exit 127 → null gain).
 */
function fakeCommand(handlers: FakeHandlers = {}): ProjectCommand {
  return async (source) => {
    if (source.includes("gain --json")) {
      return handlers.gain ? handlers.gain(source) : { exitCode: 127, stdout: "", stderr: "" };
    }
    if (source.includes("savings verify")) {
      return handlers.verify ? handlers.verify(source) : { exitCode: 127, stdout: "", stderr: "" };
    }
    if (source.includes("codegraph status")) {
      return handlers.codegraph ? handlers.codegraph(source) : { exitCode: 127, stdout: "", stderr: "" };
    }
    if (source.includes("LEANCTX_PROJECT_ROOTS_EOF")) {
      return handlers.leanctxProject ? handlers.leanctxProject(source) : { exitCode: 0, stdout: "", stderr: "" };
    }
    if (source.includes("knowledge/*/knowledge.json")) {
      return handlers.site ? handlers.site(source) : { exitCode: 0, stdout: "", stderr: "" };
    }
    if (source.includes("value-report --live")) {
      return handlers.valueReport ? handlers.valueReport(source) : { exitCode: 127, stdout: "", stderr: "" };
    }
    if (source.includes("prove --format json")) {
      return handlers.proveReport ? handlers.proveReport(source) : { exitCode: 127, stdout: "", stderr: "" };
    }
    if (source.includes("savings --format json")) {
      return handlers.savingsReport ? handlers.savingsReport(source) : { exitCode: 127, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("codegraph probe", () => {
  test("parses a valid --json status", async () => {
    const command = fakeCommand({
      codegraph: () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          initialized: true,
          version: "1.2.3",
          fileCount: 10,
          nodeCount: 100,
          edgeCount: 200,
          index: { reindexRecommended: false, state: "ok" },
        }),
        stderr: "",
      }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    const result = await provider.probe("alpha");
    expect(result.codegraph).not.toBeNull();
    expect(result.codegraph?.initialized).toBe(true);
    expect(result.codegraph?.fileCount).toBe(10);
    expect(result.codegraph?.index?.state).toBe("ok");
  });

  test("reports an uninitialized index as a status, not a failure", async () => {
    const command = fakeCommand({
      codegraph: () => ({ exitCode: 0, stdout: JSON.stringify({ initialized: false }), stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect((await provider.probe("alpha")).codegraph).toEqual({ initialized: false });
  });

  test("returns null when the CLI is missing or fails", async () => {
    const command = fakeCommand({
      codegraph: () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect((await provider.probe("alpha")).codegraph).toBeNull();
  });

  test("returns null on empty stdout", async () => {
    const command = fakeCommand({
      codegraph: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect((await provider.probe("alpha")).codegraph).toBeNull();
  });

  test("returns null on malformed JSON", async () => {
    const command = fakeCommand({
      codegraph: () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect((await provider.probe("alpha")).codegraph).toBeNull();
  });

  test("returns null when initialized is not a boolean", async () => {
    const command = fakeCommand({
      codegraph: () => ({ exitCode: 0, stdout: JSON.stringify({ initialized: "yes" }), stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect((await provider.probe("alpha")).codegraph).toBeNull();
  });

  test("returns null when the command throws (timeout)", async () => {
    const command = fakeCommand({
      codegraph: () => { throw new Error("timed out"); },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect((await provider.probe("alpha")).codegraph).toBeNull();
  });
});

describe("leanCTX site probe", () => {
  test("parses aggregated site statistics", async () => {
    const command = fakeCommand({
      site: () => ({
        exitCode: 0,
        stdout: "projects_with_facts=3\ntotal_memory_facts=42\nactive_24h=2\nhealth_coverage=1\n",
        stderr: "",
      }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeSite()).toEqual({
      projectsWithFacts: 3,
      totalMemoryFacts: 42,
      activeProjects24h: 2,
      healthCoverage: 1,
    });
  });

  test("parses a zeroed scan as valid stats", async () => {
    const command = fakeCommand({
      site: () => ({
        exitCode: 0,
        stdout: "projects_with_facts=0\ntotal_memory_facts=0\nactive_24h=0\nhealth_coverage=0\n",
        stderr: "",
      }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeSite()).toEqual({
      projectsWithFacts: 0,
      totalMemoryFacts: 0,
      activeProjects24h: 0,
      healthCoverage: 0,
    });
  });

  test("returns null on malformed output", async () => {
    const command = fakeCommand({ site: () => ({ exitCode: 0, stdout: "garbage", stderr: "" }) });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeSite()).toBeNull();
  });

  test("returns null when the scan fails", async () => {
    const command = fakeCommand({ site: () => ({ exitCode: 1, stdout: "", stderr: "jq missing" }) });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeSite()).toBeNull();
  });

  test("returns null when the command throws (timeout)", async () => {
    const command = fakeCommand({ site: () => { throw new Error("timed out"); } });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeSite()).toBeNull();
  });

  test("caches the site scan and re-probes after invalidate", async () => {
    let calls = 0;
    const command = fakeCommand({
      site: () => {
        calls += 1;
        return { exitCode: 0, stdout: "projects_with_facts=1\ntotal_memory_facts=5\nactive_24h=1\nhealth_coverage=0\n", stderr: "" };
      },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    await provider.probeSite();
    await provider.probeSite();
    expect(calls).toBe(1);

    provider.invalidate();
    await provider.probeSite();
    expect(calls).toBe(2);
  });

  test("keeps concurrent site and project scan failures independent", async () => {
    let siteCalls = 0;
    let projectCalls = 0;
    const command = fakeCommand({
      site: () => {
        siteCalls += 1;
        return { exitCode: 1, stdout: "", stderr: "site scan failed" };
      },
      leanctxProject: () => {
        projectCalls += 1;
        return { exitCode: 1, stdout: "", stderr: "project scan failed" };
      },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });
    const probeProject = provider.probeLeanCtx;
    if (probeProject === undefined) throw new Error("probeLeanCtx is not implemented");

    const [site, project] = await Promise.all([
      provider.probeSite(),
      probeProject(["/workspace/alpha"]),
    ]);

    expect(site).toBeNull();
    expect(project.get("/workspace/alpha")).toBeNull();
    expect(siteCalls).toBe(1);
    expect(projectCalls).toBe(1);
  });
});

describe("leanCTX project scan probe", () => {
  function probeFn(provider: ProjectToolStatusProvider) {
    const fn = provider.probeLeanCtx;
    if (fn === undefined) throw new Error("probeLeanCtx is not implemented");
    return fn;
  }

  test("returns parsed statuses keyed by canonical root", async () => {
    const command = fakeCommand({
      leanctxProject: () => ({
        exitCode: 0,
        stdout: '{"state":"available","activeFacts":2,"archivedFacts":1,"patterns":0,"history":3,"lastUpdated":"2026-09-17T00:00:00Z"}\n{"state":"empty"}\n',
        stderr: "",
      }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    const result = await probeFn(provider)(["/workspace/alpha", "/workspace/beta"]);
    expect(result.get("/workspace/alpha")).toEqual({
      state: "available",
      activeFacts: 2,
      archivedFacts: 1,
      patterns: 0,
      history: 3,
      lastUpdated: "2026-09-17T00:00:00Z",
    });
    expect(result.get("/workspace/beta")).toEqual({
      state: "empty",
      activeFacts: 0,
      archivedFacts: 0,
      patterns: 0,
      history: 0,
      lastUpdated: null,
    });
  });

  test("maps an unknown line to null", async () => {
    const command = fakeCommand({
      leanctxProject: () => ({ exitCode: 0, stdout: '{"state":"unknown"}\n', stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect((await probeFn(provider)(["/workspace/alpha"])).get("/workspace/alpha")).toBeNull();
  });

  test("returns null for every root when the scan fails", async () => {
    const command = fakeCommand({
      leanctxProject: () => ({ exitCode: 1, stdout: "", stderr: "read failed" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    const result = await probeFn(provider)(["/workspace/alpha", "/workspace/beta"]);
    expect(result.get("/workspace/alpha")).toBeNull();
    expect(result.get("/workspace/beta")).toBeNull();
  });

  test("returns null for every root when the command throws (timeout)", async () => {
    const command = fakeCommand({
      leanctxProject: () => { throw new Error("timed out"); },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect((await probeFn(provider)(["/workspace/alpha"])).get("/workspace/alpha")).toBeNull();
  });

  test("returns null for every root when the output line count mismatches", async () => {
    const command = fakeCommand({
      leanctxProject: () => ({ exitCode: 0, stdout: '{"state":"empty"}\n', stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    const result = await probeFn(provider)(["/workspace/alpha", "/workspace/beta"]);
    expect(result.get("/workspace/alpha")).toBeNull();
    expect(result.get("/workspace/beta")).toBeNull();
  });

  test("excludes unscannable roots without interpolating them into the command", async () => {
    let captured = "";
    const command = fakeCommand({
      leanctxProject: (source) => {
        captured = source;
        return { exitCode: 0, stdout: '{"state":"empty"}\n', stderr: "" };
      },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    const result = await probeFn(provider)(["/workspace/alpha", "/workspace/evil\nrm -rf /"]);
    expect(result.get("/workspace/evil\nrm -rf /")).toBeNull();
    expect(result.get("/workspace/alpha")).toEqual({
      state: "empty",
      activeFacts: 0,
      archivedFacts: 0,
      patterns: 0,
      history: 0,
      lastUpdated: null,
    });
    expect(captured).not.toContain("rm -rf");
    expect(captured.split("\n").filter((line) => line === "/workspace/alpha")).toHaveLength(1);
  });

  test("runs one scan per TTL window and re-scans after invalidate", async () => {
    let calls = 0;
    const command = fakeCommand({
      leanctxProject: () => {
        calls += 1;
        return { exitCode: 0, stdout: '{"state":"empty"}\n', stderr: "" };
      },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    await probeFn(provider)(["/workspace/alpha"]);
    await probeFn(provider)(["/workspace/alpha"]);
    expect(calls).toBe(1);

    provider.invalidate();
    await probeFn(provider)(["/workspace/alpha"]);
    expect(calls).toBe(2);
  });

  test("deduplicates concurrent scans for the same roots", async () => {
    let calls = 0;
    const command: ProjectCommand = async (source) => {
      if (source.includes("LEANCTX_PROJECT_ROOTS_EOF")) {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { exitCode: 0, stdout: '{"state":"empty"}\n', stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    await Promise.all([
      probeFn(provider)(["/workspace/alpha"]),
      probeFn(provider)(["/workspace/alpha"]),
      probeFn(provider)(["/workspace/alpha"]),
    ]);
    expect(calls).toBe(1);
  });
});

describe("leanCTX gain probe", () => {  const gainJson = JSON.stringify({
    summary: {
      tokens_saved: 19469611,
      net_tokens_saved: 19351773,
      effective_compression_pct: 40.31,
      stream_savings: {
        gross_usd_saved: 55.86,
        overhead_usd: 4.65,
        net_usd_saved: 51.21,
        bounce_tokens: 1858165,
      },
    },
  });

  test("parses gain stats with a verified ledger", async () => {
    const command = fakeCommand({
      gain: () => ({ exitCode: 0, stdout: gainJson, stderr: "" }),
      verify: () => ({ exitCode: 0, stdout: "Savings ledger: OK — 5812 event(s), SHA-256 chain intact.", stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeGain()).toEqual({
      tokensSaved: 19469611,
      netTokensSaved: 19351773,
      compressionPct: 40.31,
      grossUsdSaved: 55.86,
      netUsdSaved: 51.21,
      overheadUsd: 4.65,
      bounceTokens: 1858165,
      ledgerVerified: true,
      ledgerEvents: 5812,
    });
  });

  test("keeps gain data but reports an unverified ledger when verify fails", async () => {
    const command = fakeCommand({
      gain: () => ({ exitCode: 0, stdout: gainJson, stderr: "" }),
      verify: () => ({ exitCode: 1, stdout: "", stderr: "ledger missing" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    const stats = await provider.probeGain();
    expect(stats).not.toBeNull();
    expect(stats?.netTokensSaved).toBe(19351773);
    expect(stats?.ledgerVerified).toBe(false);
    expect(stats?.ledgerEvents).toBe(0);
  });

  test("returns null when the gain JSON is malformed", async () => {
    const command = fakeCommand({
      gain: () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
      verify: () => ({ exitCode: 0, stdout: "Savings ledger: OK — 1 event(s), SHA-256 chain intact.", stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeGain()).toBeNull();
  });

  test("returns null when the gain command fails or is missing", async () => {
    const command = fakeCommand({ verify: () => ({ exitCode: 0, stdout: "", stderr: "" }) });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeGain()).toBeNull();
  });

  test("returns null when the command throws (timeout)", async () => {
    const command = fakeCommand({ gain: () => { throw new Error("timed out"); } });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeGain()).toBeNull();
  });

  test("caches the gain probe and re-probes after invalidate", async () => {
    let calls = 0;
    const command = fakeCommand({
      gain: () => {
        calls += 1;
        return { exitCode: 0, stdout: gainJson, stderr: "" };
      },
      verify: () => ({ exitCode: 0, stdout: "Savings ledger: OK — 1 event(s), SHA-256 chain intact.", stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    await provider.probeGain();
    await provider.probeGain();
    expect(calls).toBe(1);

    provider.invalidate();
    await provider.probeGain();
    expect(calls).toBe(2);
  });
});

describe("cache and invalidation", () => {
  test("reuses results within the TTL and re-probes after invalidate", async () => {
    let calls = 0;
    const command = fakeCommand({
      codegraph: () => {
        calls += 1;
        return { exitCode: 0, stdout: JSON.stringify({ initialized: false }), stderr: "" };
      },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    await provider.probe("alpha");
    await provider.probe("alpha");
    expect(calls).toBe(1);

    provider.invalidate("alpha");
    await provider.probe("alpha");
    expect(calls).toBe(2);

    await provider.probe("beta");
    expect(calls).toBe(3);

    provider.invalidate();
    await provider.probe("alpha");
    expect(calls).toBe(4);
  });

  test("caches null results too", async () => {
    let calls = 0;
    const command = fakeCommand({
      codegraph: () => {
        calls += 1;
        return { exitCode: 127, stdout: "", stderr: "" };
      },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    await provider.probe("alpha");
    await provider.probe("alpha");
    expect(calls).toBe(1);
    expect((await provider.probe("alpha")).codegraph).toBeNull();
  });

  test("re-probes after the TTL expires", async () => {
    let calls = 0;
    const command = fakeCommand({
      codegraph: () => {
        calls += 1;
        return { exitCode: 0, stdout: JSON.stringify({ initialized: false }), stderr: "" };
      },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 1 });

    await provider.probe("alpha");
    await new Promise((r) => setTimeout(r, 5));
    await provider.probe("alpha");
    expect(calls).toBe(2);
  });

  test("bounds concurrent probes by the configured concurrency", async () => {
    let codegraphInFlight = 0;
    let maxCodegraphInFlight = 0;
    const command: ProjectCommand = async (source) => {
      if (source.includes("codegraph status")) {
        codegraphInFlight += 1;
        maxCodegraphInFlight = Math.max(maxCodegraphInFlight, codegraphInFlight);
        await new Promise((r) => setTimeout(r, 10));
        codegraphInFlight -= 1;
        return { exitCode: 0, stdout: JSON.stringify({ initialized: false }), stderr: "" };
      }
      await new Promise((r) => setTimeout(r, 5));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", concurrency: 4, ttlMs: 60_000 });

    await Promise.all(
      ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"].map((n) => provider.probe(n)),
    );
    expect(maxCodegraphInFlight).toBeLessThanOrEqual(4);
    expect(maxCodegraphInFlight).toBeGreaterThan(1);
  });
});

describe("leanCTX value-report probe", () => {
  const valueReportJson = JSON.stringify({
    total_tasks: 12,
    accepted_rate: 0.75,
    cpao_micros: 1500,
    etpao_tokens: 8000,
    total_cost_micros: 250000,
    savings_usd: 12.5,
    tasks: [
      {
        task_id: "t1",
        model: "gpt-4o",
        total_tokens: 5000,
        cost_micros: 1000,
        outcome_accepted: true,
        cpao_micros: 200,
        evidence: ["e1", "e2"],
        timestamp: "2026-08-19T10:00:00Z",
      },
    ],
  });

  test("parses value-report stats from valid JSON", async () => {
    const command = fakeCommand({
      valueReport: () => ({ exitCode: 0, stdout: valueReportJson, stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeValueReport()).toEqual({
      totalTasks: 12,
      acceptedRate: 0.75,
      cpaoMicros: 1500,
      etpaoTokens: 8000,
      totalCostMicros: 250000,
      savingsUsd: 12.5,
      tasks: [
        {
          taskId: "t1",
          model: "gpt-4o",
          totalTokens: 5000,
          costMicros: 1000,
          outcomeAccepted: true,
          cpaoMicros: 200,
          evidence: ["e1", "e2"],
          timestamp: "2026-08-19T10:00:00Z",
        },
      ],
    });
  });

  test("applies defaults for missing fields and filters non-string evidence", async () => {
    const command = fakeCommand({
      valueReport: () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          tasks: [
            { task_id: "t1", cpao_micros: null, evidence: ["ok", 42, null] },
            "not-an-object",
          ],
        }),
        stderr: "",
      }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeValueReport()).toEqual({
      totalTasks: 0,
      acceptedRate: 0,
      cpaoMicros: 0,
      etpaoTokens: 0,
      totalCostMicros: 0,
      savingsUsd: 0,
      tasks: [
        {
          taskId: "t1",
          model: "",
          totalTokens: 0,
          costMicros: 0,
          outcomeAccepted: false,
          cpaoMicros: null,
          evidence: ["ok"],
          timestamp: "",
        },
        {
          taskId: "",
          model: "",
          totalTokens: 0,
          costMicros: 0,
          outcomeAccepted: false,
          cpaoMicros: null,
          evidence: [],
          timestamp: "",
        },
      ],
    });
  });

  test("parses an empty tasks array with zeroed aggregates", async () => {
    const command = fakeCommand({
      valueReport: () => ({
        exitCode: 0,
        stdout: JSON.stringify({ total_tasks: 0, accepted_rate: 0, tasks: [] }),
        stderr: "",
      }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeValueReport()).toEqual({
      totalTasks: 0,
      acceptedRate: 0,
      cpaoMicros: 0,
      etpaoTokens: 0,
      totalCostMicros: 0,
      savingsUsd: 0,
      tasks: [],
    });
  });

  test("returns null on non-JSON output", async () => {
    const command = fakeCommand({
      valueReport: () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeValueReport()).toBeNull();
  });

  test("returns null on empty stdout", async () => {
    const command = fakeCommand({
      valueReport: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeValueReport()).toBeNull();
  });

  test("returns null when the command throws (timeout)", async () => {
    const command = fakeCommand({
      valueReport: () => { throw new Error("timed out"); },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeValueReport()).toBeNull();
  });

  test("returns null when the command is missing", async () => {
    const provider = createToolStatusProbe({ command: fakeCommand(), workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeValueReport()).toBeNull();
  });

  test("caches the value-report probe and re-probes after invalidate", async () => {
    let calls = 0;
    const command = fakeCommand({
      valueReport: () => {
        calls += 1;
        return { exitCode: 0, stdout: valueReportJson, stderr: "" };
      },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    const first = await provider.probeValueReport();
    const second = await provider.probeValueReport();
    expect(calls).toBe(1);
    expect(second).toBe(first);

    provider.invalidate();
    await provider.probeValueReport();
    expect(calls).toBe(2);
  });
});

describe("leanCTX prove-report probe", () => {
  const proveReportJson = JSON.stringify({
    accepted_rate: 0.8,
    aggregate_cpao_micros: 3200,
    evidence_chain_complete: true,
    evidence_ledger: {
      created_at: "2026-08-19T09:00:00Z",
      updated_at: "2026-08-19T10:00:00Z",
      schema_version: 2,
      items: 5,
    },
    tasks: [
      {
        task_id: "p1",
        query: "how does X work",
        profile_intent: "understand",
        profile_complexity: "medium",
        envelope_created: true,
        references_found: ["r1", "r2"],
        bundle_candidates: 3,
        receipt_sources: ["s1"],
        cost_micros: 900,
        outcome_accepted: true,
        cpao_micros: 300,
        evidence_stages: ["stage1", "stage2"],
      },
    ],
  });

  test("parses prove-report stats from valid JSON", async () => {
    const command = fakeCommand({
      proveReport: () => ({ exitCode: 0, stdout: proveReportJson, stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeProveReport()).toEqual({
      acceptedRate: 0.8,
      aggregateCpaoMicros: 3200,
      evidenceChainComplete: true,
      ledger: {
        createdAt: "2026-08-19T09:00:00Z",
        updatedAt: "2026-08-19T10:00:00Z",
        schemaVersion: 2,
        itemCount: 5,
      },
      totalTasks: 1,
      tasks: [
        {
          taskId: "p1",
          query: "how does X work",
          profileIntent: "understand",
          profileComplexity: "medium",
          envelopeCreated: true,
          referencesFound: ["r1", "r2"],
          bundleCandidates: 3,
          receiptSources: ["s1"],
          costMicros: 900,
          outcomeAccepted: true,
          cpaoMicros: 300,
          evidenceStages: ["stage1", "stage2"],
        },
      ],
    });
  });

  test("applies defaults for missing fields and filters non-string arrays", async () => {
    const command = fakeCommand({
      proveReport: () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          tasks: [{ task_id: "p1", references_found: ["r1", 42], receipt_sources: "not-an-array" }],
        }),
        stderr: "",
      }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeProveReport()).toEqual({
      acceptedRate: 0,
      aggregateCpaoMicros: 0,
      evidenceChainComplete: false,
      ledger: { createdAt: "", updatedAt: "", schemaVersion: 0, itemCount: 0 },
      totalTasks: 1,
      tasks: [
        {
          taskId: "p1",
          query: "",
          profileIntent: "",
          profileComplexity: "",
          envelopeCreated: false,
          referencesFound: ["r1"],
          bundleCandidates: 0,
          receiptSources: [],
          costMicros: 0,
          outcomeAccepted: false,
          cpaoMicros: 0,
          evidenceStages: [],
        },
      ],
    });
  });

  test("parses an empty tasks array with a zeroed ledger", async () => {
    const command = fakeCommand({
      proveReport: () => ({
        exitCode: 0,
        stdout: JSON.stringify({ accepted_rate: 0, evidence_chain_complete: false, tasks: [] }),
        stderr: "",
      }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeProveReport()).toEqual({
      acceptedRate: 0,
      aggregateCpaoMicros: 0,
      evidenceChainComplete: false,
      ledger: { createdAt: "", updatedAt: "", schemaVersion: 0, itemCount: 0 },
      totalTasks: 0,
      tasks: [],
    });
  });

  test("returns null on non-JSON output", async () => {
    const command = fakeCommand({
      proveReport: () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeProveReport()).toBeNull();
  });

  test("returns null on empty stdout", async () => {
    const command = fakeCommand({
      proveReport: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeProveReport()).toBeNull();
  });

  test("returns null when the command throws (timeout)", async () => {
    const command = fakeCommand({
      proveReport: () => { throw new Error("timed out"); },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeProveReport()).toBeNull();
  });

  test("returns null when the command is missing", async () => {
    const provider = createToolStatusProbe({ command: fakeCommand(), workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeProveReport()).toBeNull();
  });

  test("caches the prove-report probe and re-probes after invalidate", async () => {
    let calls = 0;
    const command = fakeCommand({
      proveReport: () => {
        calls += 1;
        return { exitCode: 0, stdout: proveReportJson, stderr: "" };
      },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    const first = await provider.probeProveReport();
    const second = await provider.probeProveReport();
    expect(calls).toBe(1);
    expect(second).toBe(first);

    provider.invalidate();
    await provider.probeProveReport();
    expect(calls).toBe(2);
  });
});

describe("leanCTX savings-report probe", () => {
  const savingsReportJson = JSON.stringify({
    period: "2026-08",
    total_tasks: 100,
    accepted_tasks: 80,
    tokens_processed: 1000000,
    tokens_saved: 400000,
    compression_percent: 40,
    estimated_cost_usd: 50,
    actual_cost_usd: 30,
    total_savings_usd: 20,
    savings_percent: 40,
    cpao_usd: 0.25,
    etpao: 4000,
    top_sources: [["claude", 120], ["codex", 80]],
  });

  test("parses savings-report stats from valid JSON", async () => {
    const command = fakeCommand({
      savingsReport: () => ({ exitCode: 0, stdout: savingsReportJson, stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeSavingsReport()).toEqual({
      period: "2026-08",
      totalTasks: 100,
      acceptedTasks: 80,
      tokensProcessed: 1000000,
      tokensSaved: 400000,
      compressionPercent: 40,
      estimatedCostUsd: 50,
      actualCostUsd: 30,
      totalSavingsUsd: 20,
      savingsPercent: 40,
      cpaoUsd: 0.25,
      etpao: 4000,
      topSources: [["claude", 120], ["codex", 80]],
    });
  });

  test("applies defaults for missing fields and drops malformed top_sources entries", async () => {
    const command = fakeCommand({
      savingsReport: () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          top_sources: [["claude", 120], ["only-name"], [123, 5], ["bad-count", "nope"], "not-an-array"],
        }),
        stderr: "",
      }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeSavingsReport()).toEqual({
      period: "",
      totalTasks: 0,
      acceptedTasks: 0,
      tokensProcessed: 0,
      tokensSaved: 0,
      compressionPercent: 0,
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      totalSavingsUsd: 0,
      savingsPercent: 0,
      cpaoUsd: 0,
      etpao: 0,
      topSources: [["claude", 120]],
    });
  });

  test("parses an empty top_sources array", async () => {
    const command = fakeCommand({
      savingsReport: () => ({
        exitCode: 0,
        stdout: JSON.stringify({ period: "2026-08", total_tasks: 0, top_sources: [] }),
        stderr: "",
      }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeSavingsReport()).toEqual({
      period: "2026-08",
      totalTasks: 0,
      acceptedTasks: 0,
      tokensProcessed: 0,
      tokensSaved: 0,
      compressionPercent: 0,
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      totalSavingsUsd: 0,
      savingsPercent: 0,
      cpaoUsd: 0,
      etpao: 0,
      topSources: [],
    });
  });

  test("returns null on non-JSON output", async () => {
    const command = fakeCommand({
      savingsReport: () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeSavingsReport()).toBeNull();
  });

  test("returns null on empty stdout", async () => {
    const command = fakeCommand({
      savingsReport: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeSavingsReport()).toBeNull();
  });

  test("returns null when the command throws (timeout)", async () => {
    const command = fakeCommand({
      savingsReport: () => { throw new Error("timed out"); },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeSavingsReport()).toBeNull();
  });

  test("returns null when the command is missing", async () => {
    const provider = createToolStatusProbe({ command: fakeCommand(), workspaceRoot: "/workspace", ttlMs: 60_000 });

    expect(await provider.probeSavingsReport()).toBeNull();
  });

  test("caches the savings-report probe and re-probes after invalidate", async () => {
    let calls = 0;
    const command = fakeCommand({
      savingsReport: () => {
        calls += 1;
        return { exitCode: 0, stdout: savingsReportJson, stderr: "" };
      },
    });
    const provider = createToolStatusProbe({ command, workspaceRoot: "/workspace", ttlMs: 60_000 });

    const first = await provider.probeSavingsReport();
    const second = await provider.probeSavingsReport();
    expect(calls).toBe(1);
    expect(second).toBe(first);

    provider.invalidate();
    await provider.probeSavingsReport();
    expect(calls).toBe(2);
  });
});
