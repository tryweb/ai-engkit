import { describe, expect, test } from "bun:test";
import type { ExecResult } from "./docker";
import { getGhStatus, startDeviceFlow, parseScopes } from "./gh-auth";

function fakeCommand(handler: (command: string) => Partial<ExecResult>): (command: string, timeoutMs: number) => Promise<ExecResult> {
  return async (command) => ({ stdout: "", stderr: "", exitCode: 0, ...handler(command) });
}

describe("gh auth status", () => {
  test("detects logged-in state across stdout and stderr", async () => {
    expect(await getGhStatus(fakeCommand(() => ({ stdout: "Logged in to github.com" })))).toBe("authenticated");
    expect(await getGhStatus(fakeCommand(() => ({ stderr: "Logged in to github.com" })))).toBe("authenticated");
    expect(await getGhStatus(fakeCommand(() => ({ stdout: "not logged in" })))).toBe("not authenticated");
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
