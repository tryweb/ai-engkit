import { describe, expect, test } from "bun:test";
import type { ExecResult } from "./docker";
import { listGlabInstances, loginGlabWithToken, normalizeHostname, readGlabToken, setupGlabCredentialHelper } from "./glab-auth";

function fakeCommand(handler: (command: string) => Partial<ExecResult>): (command: string, timeoutMs: number) => Promise<ExecResult> {
  return async (command) => ({ stdout: "", stderr: "", exitCode: 0, ...handler(command) });
}

describe("glab hostname normalization", () => {
  test("strips scheme and path", () => {
    expect(normalizeHostname("https://gitlab.example.com/")).toBe("gitlab.example.com");
    expect(normalizeHostname("http://gitlab.com")).toBe("gitlab.com");
    expect(normalizeHostname("gitlab.example.com")).toBe("gitlab.example.com");
    expect(normalizeHostname("  gitlab.com  ")).toBe("gitlab.com");
  });
});

describe("glab instances", () => {
  test("lists token-bearing hosts with usernames from auth status", async () => {
    const instances = await listGlabInstances(fakeCommand((command) => {
      if (command.includes("config.yml")) return { stdout: "gitlab.com\ngitlab.example.com\n" };
      return { stdout: "Logged in to gitlab.com as alice\nLogged in to gitlab.example.com as bob\n" };
    }));
    expect(instances).toEqual([
      { hostname: "gitlab.com", username: "alice", authenticated: true },
      { hostname: "gitlab.example.com", username: "bob", authenticated: true },
    ]);
  });

  test("returns no instances when no tokens are configured", async () => {
    const instances = await listGlabInstances(fakeCommand(() => ({ stdout: "" })));
    expect(instances).toEqual([]);
  });

  test("never exposes token values in the instance list", async () => {
    const instances = await listGlabInstances(fakeCommand((command) => {
      if (command.includes("config.yml")) return { stdout: "gitlab.com\n" };
      return { stdout: "" };
    }));
    expect(JSON.stringify(instances)).not.toContain("glpat-super-secret");
  });
});

describe("glab authentication", () => {
  test("reads a configured token into memory only", async () => {
    const token = await readGlabToken("gitlab.example.com", fakeCommand((command) => {
      expect(command).toContain("config.yml");
      return { stdout: "glpat-in-memory-only\n" };
    }));

    expect(token).toBe("glpat-in-memory-only");
  });

  test("returns a redacted error when login fails", async () => {
    const token = "glpat-login-secret";
    const commands: string[] = [];
    const stdin: string[] = [];
    const result = await loginGlabWithToken("gitlab.example.com", token, async (command, _timeoutMs, options) => {
      commands.push(command);
      stdin.push(options?.stdin ?? "");
      if (command.startsWith("glab auth login")) return { stdout: "", stderr: `invalid token ${token}`, exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    expect(result).toEqual({ ok: false, error: "invalid token [REDACTED]" });
    expect(commands[0]).toContain("glab auth login --hostname \"gitlab.example.com\" --stdin");
    expect(commands.join("\n")).not.toContain(token);
    expect(stdin[0]).toBe(`${token}\n`);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test("surfaces credential helper verification failure", async () => {
    const result = await loginGlabWithToken("gitlab.example.com", "glpat-helper-secret", fakeCommand((command) => {
      if (command.startsWith("test \"$(git config")) return { exitCode: 1, stderr: "verification failed" };
      return {};
    }));

    expect(result).toEqual({ ok: false, error: "Git credential helper verification failed" });
  });

  test("fails helper setup when verification does not pass", async () => {
    await expect(setupGlabCredentialHelper("gitlab.example.com", fakeCommand((command) => {
      if (command.startsWith("test \"$(git config")) return { exitCode: 1 };
      return {};
    }))).rejects.toThrow("Git credential helper verification failed");
  });
});
