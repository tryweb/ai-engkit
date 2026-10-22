import { describe, expect, test } from "bun:test";
import type { ExecResult } from "./docker";
import { getGhStatus, getGhStatusDetails, startDeviceFlow, parseScopes, ensureGitCredentialHelper } from "./gh-auth";

function fakeCommand(handler: (command: string) => Partial<ExecResult>): (command: string, timeoutMs: number) => Promise<ExecResult> {
  return async (command) => ({ stdout: "", stderr: "", exitCode: 0, ...handler(command) });
}

describe("gh auth status", () => {
  test("returns valid with unknown expiry when GitHub provides no expiry metadata", async () => {
    const command = fakeCommand((value) => {
      if (value.includes("--json hosts")) return { stdout: '{"hosts":{"github.com":[{"user":"alice"}]}}' };
      return { stdout: '{"login":"alice"}' };
    });

    expect(await getGhStatusDetails(command)).toEqual({
      validity: "valid",
      expiry: "unknown",
      expiry_unknown: true,
      reauthorization_guidance: null,
    });
    expect(await getGhStatus(command)).toBe("authenticated");
  });

  test("classifies a known expiry within the trusted threshold", async () => {
    const command = fakeCommand((value) => {
      if (value.includes("--json hosts")) {
        return { stdout: `{"hosts":{"github.com":[{"expiresAt":"${new Date(Date.now() + 86_400_000).toISOString()}"}]}}` };
      }
      return { stdout: '{"login":"alice"}' };
    });

    expect(await getGhStatusDetails(command)).toMatchObject({
      validity: "valid",
      expiry: "known-within-threshold",
      expiry_unknown: false,
    });
  });

  test("classifies a known expired credential as invalid", async () => {
    const command = fakeCommand((value) => {
      if (value.includes("--json hosts")) {
        return { stdout: `{"hosts":{"github.com":[{"expiresAt":"${new Date(Date.now() - 86_400_000).toISOString()}"}]}}` };
      }
      return { stdout: '{"login":"alice"}' };
    });

    expect(await getGhStatusDetails(command)).toMatchObject({
      validity: "invalid-revoked-expired",
      expiry: "known-within-threshold",
      expiry_unknown: false,
    });
  });

  test("classifies revoked or expired credentials without exposing command output", async () => {
    const command = fakeCommand((value) => {
      if (value.includes("--json hosts")) return { stdout: "", stderr: "not logged in", exitCode: 1 };
      return { stdout: "", stderr: "token=secret", exitCode: 1 };
    });

    expect(await getGhStatusDetails(command)).toEqual({
      validity: "invalid-revoked-expired",
      expiry: "unknown",
      expiry_unknown: true,
      reauthorization_guidance: "Reauthorize GitHub with the Connect GitHub device flow.",
    });
  });

  test("classifies network failures as unreachable", async () => {
    const command = fakeCommand(() => ({ stderr: "connection refused", exitCode: 1 }));

    expect(await getGhStatusDetails(command)).toEqual({
      validity: "unreachable",
      expiry: "unknown",
      expiry_unknown: true,
      reauthorization_guidance: null,
    });
  });

  test("requires the authenticated-user check after CLI status", async () => {
    const commands: string[] = [];
    const command = fakeCommand((value) => {
      commands.push(value);
      if (value.includes("--json hosts")) return { stdout: '{"hosts":{"github.com":[{}]}}' };
      return { stdout: "", stderr: "Bad credentials", exitCode: 1 };
    });

    await getGhStatusDetails(command);
    expect(commands).toEqual(["gh auth status --json hosts", "gh api user"]);
    expect(commands.join(" ")).not.toContain("--show-token");
  });
});

describe("gh device flow", () => {
  test("requests the workflow scope so CI files can be pushed", async () => {
    let loginCommand = "";
    await startDeviceFlow(fakeCommand((command) => {
      if (loginCommand === "") loginCommand = command;
      return { stdout: "one-time code: ABCD-1234\nhttps://github.com/login/device" };
    }));
    expect(loginCommand).toContain("gh auth login --web --hostname github.com --scopes workflow");
  });

  test("parses the device code and verification URI from the CLI output", async () => {
    const output = "To complete authentication, open the URL and enter the code.\nFirst copy your one-time code: ABCD-1234\nOpen this URL: https://github.com/login/device";
    const info = await startDeviceFlow(fakeCommand(() => ({ stdout: output })));
    expect(info).toEqual({ device_code: "ABCD-1234", verification_uri: "https://github.com/login/device" });
  });

  test("retries reading the log until the code appears", async () => {
    let reads = 0;
    const info = await startDeviceFlow(fakeCommand(() => {
      reads += 1;
      if (reads < 3) return { stdout: "" };
      return { stdout: "one-time code: WXYZ-9876\nOpen this URL: https://github.com/login/device" };
    }));
    expect(info.device_code).toBe("WXYZ-9876");
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  test("falls back to defaults when no code ever appears", async () => {
    const info = await startDeviceFlow(fakeCommand(() => ({ stdout: "" })));
    expect(info).toEqual({ device_code: "", verification_uri: "https://github.com/login/device" });
  });
});

describe("parseScopes", () => {
  test("returns every granted scope, not just the first", () => {
    expect(parseScopes("'gist', 'read:org', 'repo', 'workflow'")).toEqual([
      "gist",
      "read:org",
      "repo",
      "workflow",
    ]);
  });

  test("tolerates a bare comma-separated list and trailing newline", () => {
    expect(parseScopes("repo,read:org\n")).toEqual(["repo", "read:org"]);
  });

  test("returns an empty array for empty output", () => {
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes("   \n")).toEqual([]);
  });
});

describe("ensureGitCredentialHelper", () => {
  test("runs gh auth setup-git behind a guard so it is a one-time no-op", async () => {
    let seen = "";
    await ensureGitCredentialHelper(fakeCommand((command) => {
      seen = command;
      return {};
    }));
    expect(seen).toContain("git config --global --get-all credential.https://github.com.helper");
    expect(seen).toContain("gh auth setup-git");
  });
});
