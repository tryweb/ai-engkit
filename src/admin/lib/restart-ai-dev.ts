import { existsSync } from "node:fs";
import {
  dockerCommand,
  execInAiDev,
  getAiDevContainerRef,
  getComposeProject,
  type ExecResult,
} from "./docker";
import { readEnvFile } from "./env";
import {
  buildRecreateSubcommand,
  resolveOverlay,
  resolveValidatedEffectiveCompose,
  type EffectiveCompose,
} from "./compose-overlay";
import { MANAGED_OPENCODE_DIR } from "./agent-model-types";

const COMPOSE_FILE = "/opt/ai-engkit/compose.yml";
const ENV_FILE = "/opt/ai-engkit/.env";

export interface AiDevRestartDeps {
  readonly composeFileExists: (path: string) => boolean;
  readonly getAiDevContainerRef: () => Promise<string>;
  readonly getComposeProject: () => Promise<string>;
  readonly dockerCommand: (command: string, timeoutMs: number) => Promise<ExecResult>;
  /** Effective base(+overlay) Compose inputs; defaults to validated resolution from the .env. */
  readonly resolveEffective?: (project: string) => Promise<EffectiveCompose>;
}

export interface ManagedRestartDeps {
  readonly exec: (command: string, timeoutMs: number) => Promise<ExecResult>;
  readonly readEnv: () => Record<string, string>;
}

const REAL_DEPS: AiDevRestartDeps = {
  composeFileExists: existsSync,
  getAiDevContainerRef,
  getComposeProject,
  dockerCommand,
};

const REAL_MANAGED_DEPS: ManagedRestartDeps = {
  exec: execInAiDev,
  readEnv: readEnvFile,
};

export async function restartAiDev(
  deps: AiDevRestartDeps = REAL_DEPS,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  try {
    // A configured overlay must never silently fall back to a plain container
    // restart, so resolve its state (which fails closed when invalid) before
    // deciding whether the compose path applies. No overlay and no compose file
    // keeps the historical direct-restart path, which needs no project.
    const composeApplicable = deps.composeFileExists(COMPOSE_FILE) || resolveOverlay({ readEnv: readEnvFile }).active;
    if (composeApplicable) {
      const project = await deps.getComposeProject();
      const effective = deps.resolveEffective
        ? await deps.resolveEffective(project)
        : await resolveValidatedEffectiveCompose({ readEnv: readEnvFile, project });
      const result = await deps.dockerCommand(
        buildRecreateSubcommand({
          project,
          envFile: ENV_FILE,
          effective,
          action: "up -d --force-recreate ai-dev",
          trace: " 2>&1",
        }),
        120_000,
      );
      if (result.exitCode === 0) return { ok: true };
      return { ok: false, error: result.stderr || result.stdout || "Compose recreate failed" };
    }

    const ref = await deps.getAiDevContainerRef();
    const result = await deps.dockerCommand(`restart ${ref}`, 30_000);
    if (result.exitCode === 0) return { ok: true };
    return { ok: false, error: result.stderr || result.stdout || "Failed to restart ai-dev container" };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function restartManagedOpenCode(
  deps: ManagedRestartDeps = REAL_MANAGED_DEPS,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const noRestart = deps.readEnv()["RECONCILE_STARTUP_NO_RESTART"] === "1";
  if (noRestart) {
    const passwordNoKill = deps.readEnv()["OPENCODE_SERVER_PASSWORD"] ?? "";
    const authNoKill = Buffer.from(`opencode:${passwordNoKill}`).toString("base64");
    const managedDirNoKill = MANAGED_OPENCODE_DIR.replace(/^~/, "$HOME");
    const waitScript = `set -u
MANAGED_DIR="${managedDirNoKill}"
# Startup no-restart mode: wait for existing instance to be healthy, do not kill.
for waited in 0 3 6 9 12 15 18 21 24 27 30 33 36 39 42 45 48 51 54 57 60 63 66 69 72 75 78 81 84 87 90 93 96 99 102 105 108 111 114 117 120; do
  latest="$(ls -t "$MANAGED_DIR"/*.json 2>/dev/null | head -n1)"
  [ -n "$latest" ] || { sleep 3; continue; }
  port="$(jq -r '.port // empty' "$latest" 2>/dev/null)"
  [ -n "$port" ] || { sleep 3; continue; }
  endpoint="http://127.0.0.1:$port"
  if curl -fsS -m 3 -H 'Authorization: Basic ${authNoKill}' "$endpoint/global/health" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 3
done
printf '%s\n' 'managed OpenCode health timeout (no-restart wait)' >&2
exit 12`;
    try {
      const result = await deps.exec(waitScript, 150_000);
      if (result.exitCode === 0) return { ok: true };
      if (result.exitCode === 12) return { ok: false, error: "managed OpenCode health timeout" };
      return { ok: false, error: result.stderr || result.stdout || "managed OpenCode wait failed" };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const password = deps.readEnv()["OPENCODE_SERVER_PASSWORD"] ?? "";
  const auth = Buffer.from(`opencode:${password}`).toString("base64");
  const managedDir = MANAGED_OPENCODE_DIR.replace(/^~/, "$HOME");
  const script = `set -u
MANAGED_DIR="${managedDir}"
pid_file="$(ls -t "$MANAGED_DIR"/*.json 2>/dev/null | head -n1)" || {
  printf '%s\n' 'managed-opencode pid file missing' >&2
  exit 10
}
[ -n "$pid_file" ] || {
  printf '%s\n' 'managed-opencode pid file missing' >&2
  exit 10
}
pid="$(jq -r '.pid // empty' "$pid_file" 2>/dev/null)"
port="$(jq -r '.port // empty' "$pid_file" 2>/dev/null)"
[ -n "$pid" ] || {
  printf '%s\n' 'managed-opencode pid file missing' >&2
  exit 10
}
[ -n "$port" ] || {
  printf '%s\n' 'managed-opencode pid file missing' >&2
  exit 10
}
for startup_wait in 0 1 2 3 4 5 6 7 8 9; do
  if kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 1
done
kill "$pid" 2>/dev/null || {
  printf '%s\n' 'managed-opencode kill failed' >&2
  exit 11
}
for shutdown_wait in 0 1 2 3 4 5 6 7 8 9; do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "$pid" 2>/dev/null; then
  kill -9 "$pid" 2>/dev/null || {
    printf '%s\n' 'managed-opencode force kill failed' >&2
    exit 11
  }
fi
for waited in 0 3 6 9 12 15 18 21 24 27 30 33 36 39 42 45 48 51 54 57 60 63 66 69 72 75 78 81 84 87 90 93 96 99 102 105 108 111 114 117 120 123 126 129 132 135 138 141 144 147 150 153 156 159 162 165 168 171 174 177 180; do
  sleep 3
  # Re-read the managed dir to discover the new process: lifecycle restarts
  # on a different port, so the original pid file is stale.
  latest="$(ls -t "$MANAGED_DIR"/*.json 2>/dev/null | head -n1)"
  if [ -n "$latest" ]; then
    new_port="$(jq -r '.port // empty' "$latest" 2>/dev/null)"
    new_pid="$(jq -r '.pid // empty' "$latest" 2>/dev/null)"
    if [ -n "$new_port" ] && [ "$new_port" != "$port" ]; then
      port="$new_port"
      pid="$new_pid"
    fi
  fi
  endpoint="http://127.0.0.1:$port"
  if curl -fsS -m 3 -H 'Authorization: Basic ${auth}' "$endpoint/global/health" >/dev/null 2>&1; then
    printf '%s\n' "$endpoint"
    exit 0
  fi
done
printf '%s\n' 'managed-opencode health timeout' >&2
exit 12`;

  try {
    const result = await deps.exec(script, 150_000);
    if (result.exitCode === 0) return { ok: true };
    if (result.exitCode === 10) return { ok: false, error: "managed OpenCode pid file missing" };
    if (result.exitCode === 11) return { ok: false, error: "managed OpenCode kill failed" };
    if (result.exitCode === 12) return { ok: false, error: "managed OpenCode health timeout" };
    return { ok: false, error: result.stderr || result.stdout || "managed OpenCode restart failed" };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
