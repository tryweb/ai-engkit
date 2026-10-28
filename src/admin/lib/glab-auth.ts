import { execInAiDev, type ExecOptions, type ExecResult } from "./docker";

export type GlabCommand = (command: string, timeoutMs: number, options?: ExecOptions) => Promise<ExecResult>;

export interface GlabInstance {
  hostname: string;
  username: string;
  authenticated: boolean;
}

/**
 * Reduce a GitLab host input to its bare hostname.
 * Strips scheme and path so "https://gitlab.example.com/" → "gitlab.example.com".
 * A scheme-prefixed value here would create a malformed
 * `credential.https://https://...` git config section that never matches
 * any real remote, leaving git with no credential source.
 */
export function normalizeHostname(input: string): string {
  return input.trim().replace(/^https?:\/\//i, "").split("/")[0];
}

function redactAuthError(message: string, token?: string): string {
  const redacted = token ? message.replaceAll(token, "[REDACTED]") : message;
  return redacted.replace(/glpat-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

/** Per-host `glab auth status` timeout. Healthy hosts answer in <1s;
 * never let one hanging host stall the status/heartbeat path. */
export const GLAB_AUTH_STATUS_TIMEOUT_MS = 5_000;

const GLAB_CONFIG_PATH = "/home/devuser/.config/glab-cli/config.yml";

/** Python snippet: print hosts in config.yml that actually carry a token. */
const TOKEN_HOSTS_PYTHON = `python3 -c '
import yaml
with open("${GLAB_CONFIG_PATH}") as f:
    data = yaml.safe_load(f) or {}
hosts = data.get("hosts", {}) or {}
for h, cfg in hosts.items():
    token = (cfg or {}).get("token", "") or ""
    if token:
        print(h)
' 2>/dev/null || true`;

/**
 * Hosts in config.yml that actually carry a token — the only ones worth
 * probing. This filters out glab's default empty `gitlab.com` entry, which
 * otherwise makes a bare `glab auth status` hang for ~30s
 * (context deadline exceeded) and stalls collectStatus/heartbeat.
 */
export async function listTokenBearingGlabHosts(command: GlabCommand = execInAiDev): Promise<string[]> {
  const configResult = await command(TOKEN_HOSTS_PYTHON, 15_000);
  return configResult.stdout.trim().split("\n").filter(Boolean);
}

export interface GlabAuthStatusSummary {
  readonly authenticated: boolean;
  readonly output: string;
}

/**
 * Probe `glab auth status` per token-bearing host only, never bare.
 * Returns unauthenticated without probing when no host carries a token,
 * so the default empty `gitlab.com` entry can never stall the caller.
 */
export async function getGlabAuthStatus(
  command: GlabCommand = execInAiDev,
  timeoutMs: number = GLAB_AUTH_STATUS_TIMEOUT_MS,
): Promise<GlabAuthStatusSummary> {
  try {
    const hosts = await listTokenBearingGlabHosts(command);
    if (hosts.length === 0) return { authenticated: false, output: "" };
    const results = await Promise.all(
      hosts.map((hostname) => command(`glab auth status --hostname ${JSON.stringify(hostname)} 2>&1 || true`, timeoutMs)),
    );
    const output = results.map((result) => result.stdout || result.stderr).join("\n");
    return { authenticated: output.includes("Logged in"), output };
  } catch {
    return { authenticated: false, output: "" };
  }
}

/**
 * Delete host entries without tokens from config.yml (best-effort hygiene).
 * `glab` always recreates its default empty `gitlab.com` entry and
 * `glab auth logout --hostname` only clears credentials without removing
 * the key, so sweep explicitly to keep future status probes fast.
 */
export async function pruneEmptyGlabHosts(command: GlabCommand = execInAiDev): Promise<void> {
  try {
    await command(
      `python3 -c '
import yaml
p = "${GLAB_CONFIG_PATH}"
with open(p) as f:
    data = yaml.safe_load(f) or {}
hosts = data.get("hosts", {}) or {}
data["hosts"] = {h: cfg for h, cfg in hosts.items() if ((cfg or {}).get("token", "") or "")}
with open(p, "w") as f:
    yaml.dump(data, f, default_flow_style=False, allow_unicode=True)
' 2>/dev/null || true`,
      15_000,
    );
  } catch {
    // Hygiene only — never fail the caller.
  }
}

/** Read one host token from glab config.yml without persisting or logging it. */
export async function readGlabToken(hostname: string, command: GlabCommand = execInAiDev): Promise<string | null> {
  const result = await command(
    `python3 -c '
import yaml
with open("/home/devuser/.config/glab-cli/config.yml") as f:
    data = yaml.safe_load(f) or {}
host = data.get("hosts", {}).get(${JSON.stringify(normalizeHostname(hostname))}, {}) or {}
print(host.get("token", "") or "")
' 2>/dev/null`,
    15_000,
  );
  if (result.exitCode !== 0) return null;
  const token = result.stdout.trim();
  return token || null;
}

/**
 * Configure git to use the git-credential-glab helper for the given hostname.
 *
 * The helper script is baked into the image at build time
 * (~/.local/bin/git-credential-glab — see scripts/git-credential-glab and the
 * Dockerfile), so it survives container recreation. Only the git config
 * needs to be (re)applied after a successful glab auth login.
 *
 * This replaces the insecure ~/.git-credentials plaintext approach with
 * on-demand token reads from glab's own config.yml — the single source
 * of truth for authentication.
 */
export async function setupGlabCredentialHelper(hostname: string, command: GlabCommand = execInAiDev): Promise<void> {
  // Remove the global store helper (older entrypoints re-added it on every
  // start) so git never caches the token back to plaintext on disk.
  await command("git config --global --unset credential.helper 2>/dev/null", 5_000);

  // Defensive re-normalization: only a bare hostname may enter the git config key.
  const escHost = JSON.stringify(normalizeHostname(hostname));
  const httpsResult = await command(`git config --global credential.https://${escHost}.helper glab 2>/dev/null`, 5_000);
  if (httpsResult.exitCode !== 0) throw new Error(redactAuthError("Failed to configure the HTTPS Git credential helper"));
  const httpResult = await command(`git config --global credential.http://${escHost}.helper glab 2>/dev/null`, 5_000);
  if (httpResult.exitCode !== 0) throw new Error(redactAuthError("Failed to configure the HTTP Git credential helper"));

  const clearCredentialsResult = await command(": > ~/.config/git/.git-credentials 2>/dev/null", 5_000);
  if (clearCredentialsResult.exitCode !== 0) throw new Error(redactAuthError("Failed to clear the Git credentials file"));

  const verifyResult = await command(
    `test "$(git config --global --get credential.https://${escHost}.helper)" = glab && ` +
      `test "$(git config --global --get credential.http://${escHost}.helper)" = glab && ` +
      `test -z "$(git config --global --get credential.helper)" && ` +
      `test ! -s ~/.config/git/.git-credentials`,
    5_000,
  );
  if (verifyResult.exitCode !== 0) throw new Error(redactAuthError("Git credential helper verification failed"));
}

export async function listGlabInstances(command: GlabCommand = execInAiDev): Promise<GlabInstance[]> {
  // Phase 1: token-bearing hosts from config.yml (skips glab's default
  // empty gitlab.com entry).
  const tokenHosts = await listTokenBearingGlabHosts(command);
  if (tokenHosts.length === 0) return [];

  // Phase 2: probe each host individually. A bare `glab auth status` would
  // also hit the empty default host and can hang ~30s (context deadline
  // exceeded), stalling every caller.
  const results = await Promise.all(
    tokenHosts.map((hostname) =>
      command(`glab auth status --hostname ${JSON.stringify(hostname)} 2>&1 || true`, GLAB_AUTH_STATUS_TIMEOUT_MS)
    ),
  );

  return tokenHosts.map((hostname, index) => {
    const output = results[index].stdout || results[index].stderr;
    const m = output.match(/Logged in to (\S+) as (\S+)/);
    return {
      hostname,
      username: m ? m[2] : "",
      authenticated: true,
    };
  });
}

export async function loginGlabWithToken(
  hostname: string,
  token: string,
  command: GlabCommand = execInAiDev,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let result: ExecResult;
  try {
    result = await command(
      `glab auth login --hostname ${JSON.stringify(normalizeHostname(hostname))} --stdin 2>&1`,
      30_000,
      { stdin: `${token}\n` },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Authentication failed";
    return { ok: false, error: redactAuthError(message, token) };
  }
  if (result.exitCode !== 0) {
    return { ok: false, error: redactAuthError(result.stderr || result.stdout || "Authentication failed", token) };
  }
  try {
    await setupGlabCredentialHelper(hostname, command);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Credential helper setup failed";
    return { ok: false, error: redactAuthError(message, token) };
  }
  // Sweep glab's default empty gitlab.com entry (and any other token-less
  // leftovers) so future status probes never stall on them.
  await pruneEmptyGlabHosts(command);
  return { ok: true };
}

export async function logoutGlab(hostname: string, command: GlabCommand = execInAiDev): Promise<void> {
  if (hostname) {
    await command(`glab auth logout --hostname ${JSON.stringify(normalizeHostname(hostname))} 2>/dev/null || true`, 15_000);
    await command(
      `python3 -c '
import yaml
with open("/home/devuser/.config/glab-cli/config.yml") as f:
    data = yaml.safe_load(f)
hosts = data.get("hosts", {})
h = "${normalizeHostname(hostname)}"
if h in hosts:
    del hosts[h]
    data["hosts"] = hosts
    with open("/home/devuser/.config/glab-cli/config.yml", "w") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True)
' 2>/dev/null || true`,
      15_000,
    );
  } else {
    await command("glab auth logout 2>/dev/null || true", 15_000);
  }
}
