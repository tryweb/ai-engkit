import { execInAiDev, type ExecResult } from "./docker";

export type GhCommand = (command: string, timeoutMs: number) => Promise<ExecResult>;

export interface DeviceFlowInfo {
  device_code: string;
  verification_uri: string;
}

/**
 * Parse the scope list out of `gh auth status` output.
 *
 * The scopes line looks like `  - Token scopes: 'gist', 'read:org', 'repo'`.
 * Callers should capture only the part after `Token scopes: ` (e.g. with
 * `sed -n 's/.*Token scopes: //p'`); this strips the surrounding quotes and
 * splits on commas so every granted scope is returned, not just the first.
 */
export function parseScopes(output: string): string[] {
  if (!output || !output.trim()) return [];
  return output
    .trim()
    .replace(/'/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function getGhStatus(command: GhCommand = execInAiDev): Promise<string> {
  const result = await command("gh auth status 2>&1 || true", 15_000);
  if (result.stdout.includes("Logged in") || result.stderr.includes("Logged in")) {
    return "authenticated";
  }
  return "not authenticated";
}

function parseDeviceFlowOutput(output: string): { device_code: string; verification_uri: string } {
  let deviceCode = "";
  let verificationUri = "https://github.com/login/device";

  const codeMatch = output.match(/(?:code|Code):\s*([A-Z0-9-]+)/);
  if (codeMatch) deviceCode = codeMatch[1];

  const uriMatch = output.match(/https?:\/\/[^\s]+/);
  if (uriMatch) verificationUri = uriMatch[0];

  return { device_code: deviceCode, verification_uri: verificationUri };
}

/**
 * Start the GitHub device-code flow in the background and read the code the
 * CLI prints. The log is polled briefly because the CLI may take a moment to
 * emit it; the flow itself keeps running once the command returns.
 */
export async function startDeviceFlow(command: GhCommand = execInAiDev): Promise<DeviceFlowInfo> {
  // Request the `workflow` scope in addition to gh's default minimum
  // (repo, read:org, gist). Without it GitHub refuses to let the token create
  // or update `.github/workflows/*`, so pushing CI changes fails with
  // "refusing to allow an OAuth App to create or update workflow ... without
  // `workflow` scope". `--scopes` is additive to the default set.
  await command(
    "nohup sh -c 'gh auth login --web --hostname github.com --scopes workflow >/tmp/gh-device.log 2>&1 &' && sleep 1 && cat /tmp/gh-device.log 2>/dev/null || true",
    10_000,
  );

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const read = await command("cat /tmp/gh-device.log 2>/dev/null || true", 5_000);
    const info = parseDeviceFlowOutput(read.stdout || read.stderr);
    if (info.device_code !== "") return info;
    await Bun.sleep(500);
  }

  const last = await command("cat /tmp/gh-device.log 2>/dev/null || true", 5_000);
  return parseDeviceFlowOutput(last.stdout || last.stderr);
}

export async function logoutGh(command: GhCommand = execInAiDev): Promise<void> {
  await command("gh auth logout 2>/dev/null || true", 15_000);
}

/**
 * Point git at gh's credential helper for github.com (idempotent).
 *
 * `gh auth login` run non-interactively (no TTY stdin, as the Admin device
 * flow does) skips the "Authenticate Git with your GitHub credentials?"
 * prompt, so git never learns the token and HTTPS pushes fail with
 * "could not read Username for 'https://github.com'". `gh auth setup-git`
 * writes the per-host `credential.https://github.com.helper` config. The guard
 * makes this a one-time no-op once the helper is configured.
 */
export async function ensureGitCredentialHelper(command: GhCommand = execInAiDev): Promise<void> {
  await command(
    "if ! git config --global --get-all credential.https://github.com.helper >/dev/null 2>&1; then gh auth setup-git 2>/dev/null || true; fi",
    15_000,
  );
}

