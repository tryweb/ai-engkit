import { describe, expect, test } from "bun:test";
import type { ExecResult } from "./docker";
import {
  getGlabAuthStatus,
  listGlabInstances,
  listTokenBearingGlabHosts,
  loginGlabWithToken,
  normalizeHostname,
  pruneEmptyGlabHosts,
  readGlabToken,
  setupGlabCredentialHelper,
} from "./glab-auth";

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
  test("lists token-bearing hosts with usernames from per-host auth status", async () => {
    const seen: string[] = [];
    const instances = await listGlabInstances(fakeCommand((command) => {
      seen.push(command);
      if (command.includes("config.yml")) return { stdout: "gitlab.com\ngitlab.example.com\n" };
      if (command.includes('--hostname "gitlab.com"')) return { stdout: "Logged in to gitlab.com as alice\n" };
      if (command.includes('--hostname "gitlab.example.com"')) return { stdout: "Logged in to gitlab.example.com as bob\n" };
      return { stdout: "" };
    }));
    expect(instances).toEqual([
      { hostname: "gitlab.com", username: "alice", authenticated: true },
      { hostname: "gitlab.example.com", username: "bob", authenticated: true },
    ]);
    // No bare `glab auth status` (which would also hit glab's default empty
    // gitlab.com entry and can hang ~30s).
    expect(seen.filter((command) => command.startsWith("glab auth status")).every((command) => command.includes("--hostname"))).toBe(true);
  });

  test("returns no instances without probing when no tokens are configured", async () => {
    const seen: string[] = [];
    const instances = await listGlabInstances(fakeCommand((command) => {
      seen.push(command);
      return { stdout: "" };
    }));
    expect(instances).toEqual([]);
    expect(seen.some((command) => command.startsWith("glab auth status"))).toBe(false);
  });

  test("never exposes token values in the instance list", async () => {
    const instances = await listGlabInstances(fakeCommand((command) => {
      if (command.includes("config.yml")) return { stdout: "gitlab.com\n" };
      return { stdout: "" };
    }));
    expect(JSON.stringify(instances)).not.toContain("glpat-super-secret");
  });
});

describe("glab auth status probing", () => {
  test("reports authenticated from per-host probes", async () => {
    const summary = await getGlabAuthStatus(fakeCommand((command) => {
      if (command.includes("config.yml")) return { stdout: "gitlab.example.com\n" };
      return { stdout: "Logged in to gitlab.example.com as bob\n" };
    }));
    expect(summary.authenticated).toBe(true);
    expect(summary.output).toContain("Logged in");
  });

  test("skips probing entirely when no host carries a token", async () => {
    const seen: string[] = [];
    const summary = await getGlabAuthStatus(fakeCommand((command) => {
      seen.push(command);
      return { stdout: "" };
    }));
    expect(summary).toEqual({ authenticated: false, output: "" });
    expect(seen.some((command) => command.startsWith("glab auth status"))).toBe(false);
  });

  test("never probes the default empty gitlab.com entry", async () => {
    const seen: string[] = [];
    // Phase 1 already filtered the token-less gitlab.com entry.
    const summary = await getGlabAuthStatus(fakeCommand((command) => {
      seen.push(command);
      if (command.includes("config.yml")) return { stdout: "gitlab.example.com\n" };
      return { stdout: "Logged in to gitlab.example.com as bob\n" };
    }));
    expect(summary.authenticated).toBe(true);
    expect(seen.join("\n")).not.toContain('"gitlab.com"');
  });

  test("lists only token-bearing hosts", async () => {
    const hosts = await listTokenBearingGlabHosts(fakeCommand((command) => {
      expect(command).toContain("config.yml");
      return { stdout: "gitlab.example.com\n" };
    }));
    expect(hosts).toEqual(["gitlab.example.com"]);
  });

  test("prunes empty hosts without failing the caller", async () => {
    const seen: string[] = [];
    await pruneEmptyGlabHosts(fakeCommand((command) => {
      seen.push(command);
      return {};
    }));
    expect(seen.some((command) => command.includes("config.yml"))).toBe(true);
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

  test("prunes empty hosts after a successful token login", async () => {
    const commands: string[] = [];
    const result = await loginGlabWithToken("gitlab.example.com", "glpat-fresh-token", async (command, _timeoutMs, options) => {
      commands.push(command);
      if (command.startsWith("test \"$(git config")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    expect(result).toEqual({ ok: true });
    expect(commands.some((command) => command.startsWith("glab auth login"))).toBe(true);
    expect(commands.some((command) => command.includes("config.yml") && command.includes("hosts"))).toBe(true);
    expect(commands.join("\n")).not.toContain("glpat-fresh-token");
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
