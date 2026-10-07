import { describe, expect, test } from "bun:test";
import { readPinnedAgents, setPinnedAgent } from "./agent-model-pinned";
import type { AgentModelsDeps } from "./agent-model-types";
import type { ExecResult } from "../lib/docker";

function stubDeps(files: Map<string, string>): Pick<AgentModelsDeps, "exec"> {
  return {
    exec: async (cmd: string): Promise<ExecResult> => {
      if (cmd.includes("agent-model-pinned.json") && cmd.startsWith("cat")) {
        const hit = [...files.entries()].find(([path]) => cmd.includes(path));
        if (!hit) return { stdout: "", stderr: "", exitCode: 1 };
        return { stdout: hit[1], stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

describe("pinned agents sidecar", () => {
  test("read returns empty set when file is missing", async () => {
    expect(await readPinnedAgents(stubDeps(new Map()))).toEqual(new Set());
  });

  test("read parses agent list and drops invalid entries", async () => {
    const files = new Map([["agent-model-pinned.json", JSON.stringify({ version: 1, agents: ["librarian", 42, "", "metis"] })]]);
    expect(await readPinnedAgents(stubDeps(files))).toEqual(new Set(["librarian", "metis"]));
  });

  test("read falls back to empty set on malformed JSON", async () => {
    const files = new Map([["agent-model-pinned.json", "not json"]]);
    expect(await readPinnedAgents(stubDeps(files))).toEqual(new Set());
  });

  test("setPinned writes through exec without leaking names", async () => {
    const calls: string[] = [];
    const deps: Pick<AgentModelsDeps, "exec"> = {
      exec: async (cmd: string): Promise<ExecResult> => {
        calls.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const ok = await setPinnedAgent(deps, "librarian", true);
    expect(ok).toBe(true);
    expect(calls.some((c) => c.includes("agent-model-pinned.json"))).toBe(true);
  });
});
