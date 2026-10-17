import { describe, expect, test } from "bun:test";
import type { ExecResult } from "./docker";
import { resolveEnvPath } from "./env";
import {
  restartAiDev,
  restartManagedOpenCode,
  type AiDevRestartDeps,
  type ManagedRestartDeps,
} from "./restart-ai-dev";

const OK: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

function createDeps(composeFileExists: boolean): {
  readonly deps: AiDevRestartDeps;
  readonly commands: Array<{ readonly command: string; readonly timeoutMs: number }>;
} {
  const commands: Array<{ readonly command: string; readonly timeoutMs: number }> = [];
  return {
    deps: {
      composeFileExists: () => composeFileExists,
      getAiDevContainerRef: async () => "ai-dev-ref",
      getComposeProject: async () => "project-name",
      dockerCommand: async (command, timeoutMs) => {
        commands.push({ command, timeoutMs });
        return OK;
      },
    },
    commands,
  };
}

describe("restartAiDev", () => {
  test("recreates the ai-dev compose service when the compose file exists", async () => {
    // Given
    const fixture = createDeps(true);

    // When
    const result = await restartAiDev(fixture.deps);

    // Then
    expect(result).toEqual({ ok: true });
    expect(fixture.commands).toEqual([{
      command: `compose -p project-name --env-file ${resolveEnvPath()} -f /opt/ai-engkit/compose.yml up -d --force-recreate ai-dev 2>&1`,
      timeoutMs: 120_000,
    }]);
  });

  test("restarts the container directly when the compose file is absent", async () => {
    // Given
    const fixture = createDeps(false);

    // When
    const result = await restartAiDev(fixture.deps);

    // Then
    expect(result).toEqual({ ok: true });
    expect(fixture.commands).toEqual([{
      command: "restart ai-dev-ref",
      timeoutMs: 30_000,
    }]);
  });
});

describe("restartManagedOpenCode", () => {
  function createManagedDeps(result: ExecResult): {
    readonly deps: ManagedRestartDeps;
    readonly commands: Array<{ readonly command: string; readonly timeoutMs: number }>;
  } {
    const commands: Array<{ readonly command: string; readonly timeoutMs: number }> = [];
    return {
      deps: {
        exec: async (command, timeoutMs) => {
          commands.push({ command, timeoutMs });
          return result;
        },
        readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "test-password" }),
      },
      commands,
    };
  }

  test("issues a managed pid kill and health wait without docker commands", async () => {
    // Given
    const fixture = createManagedDeps(OK);

    // When
    const result = await restartManagedOpenCode(fixture.deps);

    // Then
    expect(result).toEqual({ ok: true });
    expect(fixture.commands).toHaveLength(1);
    const command = fixture.commands[0]?.command ?? "";
    expect(command).toContain("kill");
    expect(command).toContain("kill -0");
    expect(command).toContain("kill -9");
    expect(command).toContain("0 3 6 9 12 15 18 21 24 27 30 33 36 39 42 45 48 51 54 57 60 63 66 69 72 75 78 81 84 87 90 93 96 99 102 105 108 111 114 117 120 123 126 129 132 135 138 141 144 147 150 153 156 159 162 165 168 171 174 177 180");
    expect(command).toContain("/global/health");
    expect(command).toContain("$HOME/.config/openchamber/managed-opencode");
    expect(command).not.toContain("docker");
    expect(command).not.toContain("compose");
  });

  test("returns success when the managed restart script exits successfully", async () => {
    // Given
    const fixture = createManagedDeps(OK);

    // When
    const result = await restartManagedOpenCode(fixture.deps);

    // Then
    expect(result).toEqual({ ok: true });
  });

  test("returns the script failure when managed restart exits unsuccessfully", async () => {
    // Given
    const fixture = createManagedDeps({ stdout: "", stderr: "managed-opencode health timeout", exitCode: 12 });

    // When
    const result = await restartManagedOpenCode(fixture.deps);

    // Then
    expect(result).toEqual({ ok: false, error: "managed OpenCode health timeout" });
  });
});
