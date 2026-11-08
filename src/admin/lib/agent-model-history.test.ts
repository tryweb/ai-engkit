import { describe, expect, test } from "bun:test";
import type { ExecResult } from "./docker";
import {
  createAgentModelHistoryClient,
  parseRecentRequestModels,
  parseRecentRequestModelsResult,
} from "./agent-model-history";

describe("agent model history aggregation", () => {
  test("keeps the newest successful request for an agent across directories", () => {
    const result = parseRecentRequestModels(JSON.stringify([
      { agent: "explore", modelID: "old", providerID: "opencode", completedAt: 100 },
      { agent: "explore", modelID: "new", providerID: "opencode-go", completedAt: 200 },
      { agent: "general", modelID: "general-model", providerID: "openai", completedAt: 150 },
    ]));

    expect(result).toEqual([
      { agent: "explore", modelID: "new", providerID: "opencode-go", completedAt: 200 },
      { agent: "general", modelID: "general-model", providerID: "openai", completedAt: 150 },
    ]);
  });

  test("performs one passive collection command instead of one command per agent", async () => {
    const calls: string[] = [];
    const exec = async (command: string): Promise<ExecResult> => {
      calls.push(command);
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ agent: "explore", modelID: "muse", providerID: "opencode-go", completedAt: 200 }]),
        stderr: "",
      };
    };

    const result = await createAgentModelHistoryClient({ exec }).fetchRecentRequestModels("testpass");

    expect(result.models).toEqual([
      { agent: "explore", modelID: "muse", providerID: "opencode-go", completedAt: 200 },
    ]);
    expect(result.truncated).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/session");
    expect(calls[0]).toContain("cursor");
    expect(calls[0]).toContain("time.completed");
    expect(calls[0]).not.toContain("POST");
    expect(calls[0]).toContain("MAX_DIRECTORIES=64");
    expect(calls[0]).toContain("MAX_PAGES_PER_DIRECTORY=50");
    expect(calls[0]).toContain("MAX_SESSIONS=800");
    expect(calls[0]).toContain("MAX_SECONDS=60");
    expect(calls[0]).toContain("disabled-projects.json");
    expect(calls[0]).toContain("umask 077");
    expect(calls[0]).toContain("INT TERM");
    expect(calls[0]).not.toContain("rm -rf");
  });

  test("uses V2 message endpoint and response shape when OMO is disabled", async () => {
    const previous = process.env.OMO_ENABLED;
    process.env.OMO_ENABLED = "0";
    try {
      let command = "";
      await createAgentModelHistoryClient({
        exec: async (value) => {
          command = value;
          return { exitCode: 0, stdout: JSON.stringify({ models: [], truncated: false }), stderr: "" };
        },
      }).fetchRecentRequestModels("testpass");

      expect(command).toContain("$BASE/api/session/${SESSION}/message");
      expect(command).toContain(".data[]?");
      expect(command).toContain(".model.id");
      expect(command).not.toContain("$BASE/session/${SESSION}/message");
    } finally {
      if (previous === undefined) delete process.env.OMO_ENABLED;
      else process.env.OMO_ENABLED = previous;
    }
  });

  test("keeps the V1 message endpoint and response shape", async () => {
    const previous = process.env.OMO_ENABLED;
    delete process.env.OMO_ENABLED;
    try {
      let command = "";
      await createAgentModelHistoryClient({
        exec: async (value) => {
          command = value;
          return { exitCode: 0, stdout: JSON.stringify({ models: [], truncated: false }), stderr: "" };
        },
      }).fetchRecentRequestModels("testpass");

      expect(command).toContain("$BASE/session/${SESSION}/message");
      expect(command).toContain(".[]?.info");
      expect(command).toContain(".modelID");
      expect(command).not.toContain("$BASE/api/session/${SESSION}/message");
    } finally {
      if (previous === undefined) delete process.env.OMO_ENABLED;
      else process.env.OMO_ENABLED = previous;
    }
  });

  test("parses paginated object output and exposes truncation metadata", () => {
    const result = parseRecentRequestModelsResult(JSON.stringify({
      models: [
        { agent: "explore", modelID: "old", providerID: "opencode", completedAt: 100 },
        { agent: "explore", modelID: "new", providerID: "opencode-go", completedAt: "2026-09-01T00:00:00Z" },
      ],
      truncated: true,
      warning: "session limit reached",
    }));

    expect(result).toEqual({
      models: [{
        agent: "explore",
        modelID: "new",
        providerID: "opencode-go",
        completedAt: Date.parse("2026-09-01T00:00:00Z"),
      }],
      truncated: true,
      warning: "session limit reached",
    });
  });

  test("returns a visible warning when the collection command fails", async () => {
    const result = await createAgentModelHistoryClient({
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "timeout" }),
    }).fetchRecentRequestModels("testpass");

    expect(result.models).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.warning).toBe("history collection command failed");
  });
});
