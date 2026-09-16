import { describe, expect, test } from "bun:test";
import { createRealCommandDeps } from "./commands";
import type { EffectiveCompose } from "../lib/compose-overlay";

// Focused tests for the REAL restartContainer implementation inside
// createRealCommandDeps (the dispatch-level tests in commands.test.ts mock
// restartContainer away). Capture the real modules first so the mock
// factories do not re-enter the interception loop.


const dockerCalls: Array<{ cmd: string; timeout: number }> = [];
const runCommandCalls: Array<{ args: string[]; timeout: number }> = [];
let bindSources: Record<string, string | null> = {
  "/opt/ai-engkit/.env": "/root/.env",
  "/opt/ai-engkit/compose.yml": "/root/docker-compose.yml",
};

const noOverlayEffective: EffectiveCompose = {
  overlayActive: false,
  files: ["/opt/ai-engkit/compose.yml"],
  overlayReference: null,
};

const stagedOverlayEffective: EffectiveCompose = {
  overlayActive: true,
  files: ["/opt/ai-engkit/compose-upgrade-base.yml", "/opt/ai-engkit/extensions/ep-design.yml"],
  overlayReference: "ep-design.yml",
};

const restartDeps = {
  getComposeProject: async () => "test-proj",
  getSelfBindSource: async (dest: string) => bindSources[dest] ?? null,
  dockerCommand: async (cmd: string, timeout: number) => {
    dockerCalls.push({ cmd, timeout });
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  runCommand: async (args: string[], timeout: number) => {
    runCommandCalls.push({ args, timeout });
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  resolveEffectiveAiAdmin: () => noOverlayEffective,
};

// Force the compose branch even in dev environments where
// /opt/ai-engkit/compose.yml does not exist.
const PULL_CMD = "pull ghcr.io/tryweb/ai-engkit:latest 2>&1";
const AI_DEV_COMPOSE_CMD =
  "compose -p test-proj --env-file /opt/ai-engkit/.env -f /opt/ai-engkit/compose.yml up -d --force-recreate ai-dev 2>&1";
const AI_ADMIN_HELPER_ARGS = [
  "docker", "run", "--rm", "--user", "0",
  "--entrypoint", "/usr/local/bin/docker",
  "-v", "/root/.env:/root/.env:ro",
  "-v", "/root/docker-compose.yml:/root/docker-compose.yml:ro",
  "-v", "/var/run/docker.sock:/var/run/docker.sock",
  "ghcr.io/tryweb/ai-engkit:latest",
  "compose", "-p", "test-proj",
  "--env-file", "/root/.env",
  "-f", "/root/docker-compose.yml",
  "up", "-d", "--force-recreate", "ai-admin",
];

describe("real restartContainer", () => {
  test("ai-admin pulls the latest image, then recreates from compose via a helper container", async () => {
    dockerCalls.length = 0;
    runCommandCalls.length = 0;
    const deps = createRealCommandDeps(() => true, restartDeps);
    const result = await deps.restartContainer("ai-admin");

    expect(result.success).toBe(true);
    expect(dockerCalls.map((c) => c.cmd)).toEqual([PULL_CMD]);
    expect(dockerCalls[0].timeout).toBe(120_000);
    expect(runCommandCalls).toHaveLength(1);
    expect(runCommandCalls[0].args).toEqual(AI_ADMIN_HELPER_ARGS);
    expect(runCommandCalls[0].timeout).toBe(120_000);
  });

  test("ai-admin reports failure when host bind sources cannot be resolved", async () => {
    dockerCalls.length = 0;
    runCommandCalls.length = 0;
    bindSources = {};
    const deps = createRealCommandDeps(() => true, restartDeps);
    const result = await deps.restartContainer("ai-admin");

    expect(result.success).toBe(false);
    expect(dockerCalls.map((c) => c.cmd)).toEqual([PULL_CMD]);
    expect(runCommandCalls).toHaveLength(0);
    bindSources = {
      "/opt/ai-engkit/.env": "/root/.env",
      "/opt/ai-engkit/compose.yml": "/root/docker-compose.yml",
    };
  });

  test("ai-admin with an active overlay recreates from the staged base and adds --project-directory", async () => {
    dockerCalls.length = 0;
    runCommandCalls.length = 0;
    bindSources = {
      "/opt/ai-engkit/.env": "/root/.env",
      "/opt/ai-engkit/compose-upgrade-base.yml": "/root/admin-data/upgrade-base.yml",
    };
    const deps = createRealCommandDeps(() => true, {
      ...restartDeps,
      resolveEffectiveAiAdmin: () => stagedOverlayEffective,
    });
    const result = await deps.restartContainer("ai-admin");

    expect(result.success).toBe(true);
    expect(dockerCalls.map((c) => c.cmd)).toEqual([PULL_CMD]);
    expect(runCommandCalls).toHaveLength(1);
    expect(runCommandCalls[0].args).toEqual([
      "docker", "run", "--rm", "--user", "0",
      "--entrypoint", "/usr/local/bin/docker",
      "-v", "/root/.env:/root/.env:ro",
      "-v", "/root/admin-data/upgrade-base.yml:/root/admin-data/upgrade-base.yml:ro",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "ghcr.io/tryweb/ai-engkit:latest",
      "compose", "-p", "test-proj",
      "--project-directory", "/root",
      "--env-file", "/root/.env",
      "-f", "/root/admin-data/upgrade-base.yml",
      "up", "-d", "--force-recreate", "ai-admin",
    ]);
    bindSources = {
      "/opt/ai-engkit/.env": "/root/.env",
      "/opt/ai-engkit/compose.yml": "/root/docker-compose.yml",
    };
  });

  test("ai-dev recreates from compose without pulling (upgrade flow owns fetching)", async () => {
    dockerCalls.length = 0;
    runCommandCalls.length = 0;
    const deps = createRealCommandDeps(() => true, restartDeps);
    const result = await deps.restartContainer("ai-dev");

    expect(result.success).toBe(true);
    expect(dockerCalls.map((c) => c.cmd)).toEqual([AI_DEV_COMPOSE_CMD]);
    expect(runCommandCalls).toHaveLength(0);
  });

  test("unknown service is rejected", async () => {
    dockerCalls.length = 0;
    runCommandCalls.length = 0;
    const deps = createRealCommandDeps(() => true, restartDeps);
    const result = await deps.restartContainer("bogus");

    expect(result.success).toBe(false);
    expect(dockerCalls).toHaveLength(0);
    expect(runCommandCalls).toHaveLength(0);
  });
});
