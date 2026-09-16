import { describe, expect, test } from "bun:test";
import { restartAiDev } from "./restart-ai-dev";
import { defaultStartAiDev } from "./db-maintenance";
import { createRealCommandDeps } from "../agent/commands";
import { resolveValidatedEffectiveCompose, type EffectiveCompose } from "./compose-overlay";
import type { ExecResult } from "./docker";

const OK: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

const overlayEffective: EffectiveCompose = {
  overlayActive: true,
  files: ["/opt/ai-engkit/compose-upgrade-base.yml", "/opt/ai-engkit/extensions/ep-design.yml"],
  overlayReference: "ep-design.yml",
};

// A configured overlay that escapes the extensions directory fails path
// confinement before any Compose invocation, so the real helper rejects it.
function invalidOverlayResolve(project: string): Promise<EffectiveCompose> {
  return resolveValidatedEffectiveCompose({
    project,
    readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "../../etc/passwd" }),
  });
}

describe("restartAiDev with a domain overlay", () => {
  test("recreates ai-dev with the ordered base+overlay configuration", async () => {
    const commands: string[] = [];
    const result = await restartAiDev({
      composeFileExists: () => true,
      getAiDevContainerRef: async () => "ai-dev-ref",
      getComposeProject: async () => "ai-engkit",
      dockerCommand: async (command) => {
        commands.push(command);
        return OK;
      },
      resolveEffective: async () => overlayEffective,
    });

    expect(result).toEqual({ ok: true });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("--project-directory /opt/ai-engkit");
    expect(commands[0]).toContain("-f /opt/ai-engkit/compose-upgrade-base.yml");
    expect(commands[0]).toContain("-f '/opt/ai-engkit/extensions/ep-design.yml'");
    expect(commands[0]).toContain("up -d --force-recreate ai-dev");
  });
});

describe("db maintenance startAiDev with a domain overlay", () => {
  test("starts ai-dev with the ordered base+overlay configuration", async () => {
    const calls: string[] = [];
    const result = await defaultStartAiDev({
      getProjectFn: async () => "ai-engkit",
      dockerCommandFn: async (command) => {
        calls.push(command);
        return OK;
      },
      resolveEffectiveFn: async () => overlayEffective,
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--project-directory /opt/ai-engkit");
    expect(calls[0]).toContain("-f '/opt/ai-engkit/extensions/ep-design.yml'");
    expect(calls[0]).toContain("up -d ai-dev");
  });
});

describe("agent restartContainer with a domain overlay", () => {
  test("recreates ai-dev with the ordered base+overlay configuration", async () => {
    const dockerCalls: string[] = [];
    const deps = createRealCommandDeps(() => true, {
      getComposeProject: async () => "ai-engkit",
      getSelfBindSource: async () => null,
      dockerCommand: async (command) => {
        dockerCalls.push(command);
        return OK;
      },
      runCommand: async () => OK,
      resolveEffectiveAiDev: async () => overlayEffective,
    });

    const result = await deps.restartContainer("ai-dev");

    expect(result.success).toBe(true);
    expect(dockerCalls).toHaveLength(1);
    expect(dockerCalls[0]).toContain("--project-directory /opt/ai-engkit");
    expect(dockerCalls[0]).toContain("-f '/opt/ai-engkit/extensions/ep-design.yml'");
    expect(dockerCalls[0]).toContain("up -d --force-recreate ai-dev");
  });
});

describe("invalid domain overlay fails closed before any Compose invocation", () => {
  test("restartAiDev reports failure without running a compose or docker restart command", async () => {
    const commands: string[] = [];
    const result = await restartAiDev({
      composeFileExists: () => true,
      getAiDevContainerRef: async () => "ai-dev-ref",
      getComposeProject: async () => "ai-engkit",
      dockerCommand: async (command) => {
        commands.push(command);
        return OK;
      },
      resolveEffective: invalidOverlayResolve,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error).toContain("must resolve beneath");
    expect(commands).toHaveLength(0);
  });

  test("defaultStartAiDev reports failure without running a compose or docker start command", async () => {
    const calls: string[] = [];
    const result = await defaultStartAiDev({
      getProjectFn: async () => "ai-engkit",
      dockerCommandFn: async (command) => {
        calls.push(command);
        return OK;
      },
      resolveEffectiveFn: invalidOverlayResolve,
    });

    expect(result.exitCode).not.toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("agent restartContainer('ai-dev') reports failure without running a compose or docker restart command", async () => {
    const dockerCalls: string[] = [];
    const deps = createRealCommandDeps(() => true, {
      getComposeProject: async () => "ai-engkit",
      getSelfBindSource: async () => null,
      dockerCommand: async (command) => {
        dockerCalls.push(command);
        return OK;
      },
      runCommand: async () => OK,
      resolveEffectiveAiDev: invalidOverlayResolve,
    });

    const result = await deps.restartContainer("ai-dev");

    expect(result.success).toBe(false);
    expect(dockerCalls).toHaveLength(0);
  });
});
