import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentModelPolicy, readAgentModelPolicy, validatePolicyMode, writeAgentModelPolicy } from "./agent-model-policy";
import type { AgentModelsDeps } from "./agent-model-types";
import type { ExecResult } from "./docker";

describe("agent-model-policy parse", () => {
  test("returns free default on missing/invalid", () => {
    expect(parseAgentModelPolicy("{}")).toBe("free");
    expect(parseAgentModelPolicy('{"mode":"invalid"}')).toBe("free");
    expect(parseAgentModelPolicy("not json")).toBe("free");
    expect(parseAgentModelPolicy('{"mode":"economy"}')).toBe("economy");
    expect(parseAgentModelPolicy('{"mode":"performance"}')).toBe("performance");
  });

  test("validatePolicyMode rejects invalid and accepts valid", () => {
    expect(validatePolicyMode("invalid")).toBe("mode must be one of free, economy, performance");
    expect(validatePolicyMode("free")).toBe("free");
    expect(validatePolicyMode("economy")).toBe("economy");
    expect(validatePolicyMode("performance")).toBe("performance");
  });
});

describe("agent-model-policy persistence", () => {
  test("read returns free when file missing", async () => {
    const deps: Pick<AgentModelsDeps, "exec"> = {
      exec: async (): Promise<ExecResult> => ({ stdout: "", stderr: "", exitCode: 1 }),
    };
    expect(await readAgentModelPolicy(deps)).toBe("free");
  });

  test("write validates and persists via exec", async () => {
    const calls: string[] = [];
    const deps: Pick<AgentModelsDeps, "exec"> = {
      exec: async (cmd: string): Promise<ExecResult> => {
        calls.push(cmd);
        if (cmd.includes("cat")) return { stdout: '{"mode":"free"}', stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const result = await writeAgentModelPolicy(deps, "economy");
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.includes("agent-model-policy.json"))).toBe(true);
    const invalid = validatePolicyMode("invalid");
    expect(invalid).toBe("mode must be one of free, economy, performance");
  });

  test("read via exec returns persisted mode", async () => {
    const deps: Pick<AgentModelsDeps, "exec"> = {
      exec: async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes("cat")) return { stdout: '{"mode":"performance","version":1}', stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    expect(await readAgentModelPolicy(deps)).toBe("performance");
  });

  test("disk roundtrip with sandboxed HOME persists and reads back via real shell expansion", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "policy-home-"));
    const originalHome = process.env.HOME;
    const originalBunHome = Bun.env.HOME;
    process.env.HOME = tmpHome;
    Bun.env.HOME = tmpHome;
    const realExec = async (command: string, _timeoutMs?: number): Promise<ExecResult> => {
      const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: tmpHome } });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode };
    };
    const deps: Pick<AgentModelsDeps, "exec"> = { exec: realExec };
    try {
      const written = await writeAgentModelPolicy(deps, "performance");
      expect(written.ok).toBe(true);
      const read = await readAgentModelPolicy(deps);
      expect(read).toBe("performance");
      const policyPath = join(tmpHome, ".config/opencode/agent-model-policy.json");
      expect(existsSync(policyPath)).toBe(true);
      const raw = readFileSync(policyPath, "utf-8");
      const parsed = JSON.parse(raw) as { mode: string };
      expect(parsed.mode).toBe("performance");
      // Ensure path used $HOME expansion not quoted tilde: file must NOT be under literal "~"
      expect(existsSync(join(tmpHome, "~"))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalBunHome === undefined) delete Bun.env.HOME;
      else Bun.env.HOME = originalBunHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
