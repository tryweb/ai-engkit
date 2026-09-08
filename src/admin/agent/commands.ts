import { existsSync } from "node:fs";
import {
  dockerCommand,
  execInAiDev,
  getAiDevContainerRef,
  getComposeProject,
  getSelfBindSource,
  getSelfContainerRef,
  runCommand,
} from "../lib/docker";
import { PASSWORD_KEYS } from "../lib/env-schema";
import { resolveImageRef } from "../lib/image-ref";
import { readEnvFile, upsertEnvVar as upsertRealEnvVar } from "../lib/env";
import { KEY_MATERIAL_PATTERN, readSanitizedGlobalConfig, setGlobalConfig as realSetGlobalConfig } from "../lib/git-config";
import { logoutGh as realLogoutGh, startDeviceFlow as realStartDeviceFlow, type DeviceFlowInfo } from "../lib/gh-auth";
import { listGlabInstances as realListGlabInstances, loginGlabWithToken as realLoginGlabWithToken, logoutGlab as realLogoutGlab, type GlabInstance } from "../lib/glab-auth";
import { isSecretKey as realIsSecretKey, setSecretValue as realSetSecretValue, type ActivationStatus } from "../lib/secrets";
import { collectProjectOverviews, type ProjectFeatures } from "../lib/projects-overview";
import { collectProvidersMeta } from "../lib/provider-meta";
import {
  addProviderKey as realAddProviderKey,
  deleteProviderKey as realDeleteProviderKey,
  maskKey,
  readProviderKeys as realReadProviderKeys,
  setActiveProviderKey as realSetActiveProviderKey,
  updateProviderKeyNote as realUpdateProviderKeyNote,
  type ProviderKey,
  type ProviderKeysFile,
} from "../lib/provider-keys";
import {
  createProject as realCreateProject,
  disableProject as realDisableProject,
  enableProject as realEnableProject,
  enableProjectFeature as realEnableProjectFeature,
  isValidProjectName as realIsValidProjectName,
  PROJECT_FEATURES,
  setProjectRemote as realSetProjectRemote,
  syncProjects as realSyncProjects,
  type ProjectActionResult,
  type ProjectFeature,
} from "../lib/projects";
import {
  addKey as realSshAddKey,
  deleteKey as realSshDeleteKey,
  isValidKeyName,
  listKeys as realSshListKeys,
  type SshKey,
} from "../lib/ssh-keys";
import {
  applyActiveKey as realApplyActiveKey,
  clearProviderCache as realClearProviderCache,
  isKeyProviderSupported as realIsKeyProviderSupported,
  readProviderAuthSnapshot as realReadProviderAuthSnapshot,
  removeAuthKey as realRemoveAuthKey,
} from "../lib/opencode-auth";
import {
  collectAgentModelState,
  createAgentModelsLib,
  validateFallbackModels,
  REAL_DEPS as AGENT_MODEL_REAL_DEPS,
  type AgentModelsViewState,
  type ApplyResult,
  type FallbackModelEntry,
} from "../lib/agent-models";
import { collectStatus } from "../lib/status";
import { restartAiDev as restartRealAiDev } from "../lib/restart-ai-dev";
import { getState, runUpgrade as runRealUpgrade } from "../lib/upgrade";
import { buildStatusReport, getComponentVersions, type StatusReport } from "./heartbeat";
import { getUpdateCheck } from "../routes/versions";
import {
  buildAck,
  buildError,
  buildResult,
  ERROR_CODES,
  parseCommandType,
  type Envelope,
  type QueryName,
} from "./protocol";
import { createDeferralQueue } from "./queue";

// allow: SIZE_OK — this module owns one dispatcher state machine and its production dependencies.
type ProjectReadResult = Record<string, {
  features: ProjectFeatures;
  remote: string | null;
  disabled: boolean;
}>;

const DEFAULT_WORKSPACE_ROOT = "/home/devuser/workspace";
const DEFAULT_OPENCHAMBER_SETTINGS = "/home/devuser/.config/openchamber/settings.json";
const DEFAULT_OPENCHAMBER_DISABLED = "/home/devuser/.config/openchamber/disabled-projects.json";
const SECRET_MASK = "••••••";
const COMPOSE_FILE = "/opt/ai-engkit/compose.yml";
const ENV_FILE = "/opt/ai-engkit/.env";
// ai-admin has no upgrade flow (runUpgrade only recreates ai-dev), so its
// restart is its only path to a newly published image. The ref follows the
// AI_ENGKIT_VERSION pin when set, else the stable latest tag.

/** Runtime operations used to execute commands and serve read-only queries. */
export interface CommandDeps {
  isUpgradeRunning: () => boolean;
  runUpgrade: () => Promise<{ success: boolean; error?: string; message?: string }>;
  restartAiDev: () => Promise<{ success: boolean; message?: string }>;
  restartContainer: (service: string) => Promise<{ success: boolean; message?: string }>;
  upsertEnvVar: (key: string, value: string) => void;
  now: () => string;
  readStatus: () => Promise<StatusReport>;
  readEnv: () => Record<string, string>;
  readProjects: () => Promise<ProjectReadResult>;
  readProviders: () => Promise<unknown>;
  isKeyProviderSupported: (provider: string) => boolean;
  readProviderKeys: () => ProviderKeysFile;
  addProviderKey: (provider: string, value: string, note?: string) => ProviderKey;
  setActiveProviderKey: (provider: string, keyId: string | null) => boolean;
  deleteProviderKey: (provider: string, keyId: string) => boolean;
  updateProviderKeyNote: (provider: string, keyId: string, note: string) => boolean;
  applyActiveKey: (provider: string, key: string) => Promise<void>;
  removeAuthKey: (provider: string) => Promise<void>;
  clearProviderCache: () => Promise<void>;
  readProviderAuthSnapshot: (provider: string) => Promise<string | null>;
  waitForIdleSessions: () => Promise<IdleWaitOutcome>;
  gracefulRestartAiDev: () => Promise<{ success: boolean; message?: string }>;
  setSecret: (key: string, value: string) => ActivationStatus;
  sshAddKey: (name: string, type: string, passphrase: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  sshDeleteKey: (name: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  sshListKeys: () => Promise<SshKey[]>;
  gitSetConfig: (key: string, value: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  gitGetConfig: () => Promise<Record<string, string>>;
  ghStartDeviceFlow: () => Promise<DeviceFlowInfo>;
  ghLogout: () => Promise<void>;
  glabAddInstance: (hostname: string, token: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  glabRemoveInstance: (hostname: string) => Promise<void>;
  glabListInstances: () => Promise<GlabInstance[]>;
  projectCreate: (name: string, payload: { gitInit?: boolean; gitRemote?: string }) => Promise<ProjectActionResult>;
  projectSetRemote: (name: string, remote: string) => Promise<ProjectActionResult>;
  projectEnable: (name: string) => Promise<ProjectActionResult>;
  projectDisable: (name: string) => Promise<ProjectActionResult>;
  projectEnableFeature: (name: string, feature: string) => Promise<ProjectActionResult>;
  projectSync: (add: string[], remove: string[]) => Promise<ProjectActionResult>;
  readAgentModelsState: () => Promise<AgentModelsViewState>;
  applyAgentModel: (agent: string, entries: readonly FallbackModelEntry[]) => Promise<ApplyResult>;
}

/** Transport boundary for protocol envelopes emitted by the dispatcher. */
export interface CommandSender {
  send: (env: Envelope) => void;
}

/** Command routing and FIFO deferral operations exposed to the agent client. */
export interface CommandDispatcher {
  handle: (env: Envelope) => void;
  defer: (env: Envelope) => void;
  drain: (limit?: number) => void;
  pendingCount: () => number;
}

type RestartService = "ai-dev" | "ai-admin";

interface RealRestartDeps {
  getComposeProject: typeof getComposeProject;
  getSelfBindSource: typeof getSelfBindSource;
  dockerCommand: typeof dockerCommand;
  runCommand: typeof runCommand;
}

/** Restart modes accepted by provider key commands (default: graceful). */
export type RestartMode = "graceful" | "force";

/** Outcome of a graceful idle-wait before restarting ai-dev. */
export type IdleWaitOutcome = "idle" | "timeout" | "unavailable";

interface ProviderKeyAddPayload {
  provider: string;
  value: string;
  note: string;
  mode: RestartMode;
}

interface ProviderKeyRefPayload {
  provider: string;
  keyId: string;
  mode: RestartMode;
}

interface ProviderKeyNotePayload {
  provider: string;
  keyId: string;
  note: string;
}

interface SecretSetPayload {
  key: string;
  value: string;
}

interface AgentModelSetPayload {
  agent: string;
  entries: FallbackModelEntry[];
}

interface SshKeyAddPayload {
  name: string;
  keyType: "ed25519" | "rsa";
  passphrase: string;
}

interface SshKeyDeletePayload {
  name: string;
}

interface GitConfigSetPayload {
  key: string;
  value: string;
}

interface GlabInstanceAddPayload {
  hostname: string;
  token: string;
}

interface GlabInstanceRemovePayload {
  hostname: string;
}

interface ProjectCreatePayload {
  name: string;
  gitInit: boolean;
  gitRemote: string;
}

interface ProjectNamePayload {
  name: string;
}

interface ProjectFeaturePayload {
  name: string;
  feature: string;
}

interface ProjectSyncPayload {
  add: string[];
  remove: string[];
}

interface RedactedEnvironment {
  env: Record<string, string>;
  redacted: string[];
}

interface SafeProviderKey {
  id: string;
  masked: string;
  note: string;
  active: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function parseReconfigureEnv(payload: unknown): Record<string, string> | null {
  if (!isRecord(payload)) return null;
  const env = payload["env"];
  return isStringRecord(env) ? env : null;
}

function parseRestartService(payload: unknown): RestartService | null {
  if (!isRecord(payload)) return null;
  const service = payload["service"];
  return service === "ai-dev" || service === "ai-admin" ? service : null;
}

function parseRestartMode(value: unknown): RestartMode | null {
  if (value === undefined) return "graceful";
  return value === "graceful" || value === "force" ? value : null;
}

function parseProviderKeyAdd(payload: unknown): ProviderKeyAddPayload | null {
  if (!isRecord(payload)) return null;
  const provider = payload["provider"];
  const value = payload["value"];
  if (typeof provider !== "string" || provider === "") return null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const note = payload["note"];
  if (note !== undefined && typeof note !== "string") return null;
  const mode = parseRestartMode(payload["mode"]);
  if (mode === null) return null;
  return { provider, value, note: typeof note === "string" ? note : "", mode };
}

function parseProviderKeyRef(payload: unknown): ProviderKeyRefPayload | null {
  if (!isRecord(payload)) return null;
  const provider = payload["provider"];
  const keyId = payload["keyId"];
  if (typeof provider !== "string" || provider === "") return null;
  if (typeof keyId !== "string" || keyId === "") return null;
  const mode = parseRestartMode(payload["mode"]);
  if (mode === null) return null;
  return { provider, keyId, mode };
}

function parseProviderKeyNote(payload: unknown): ProviderKeyNotePayload | null {
  if (!isRecord(payload)) return null;
  const provider = payload["provider"];
  const keyId = payload["keyId"];
  const note = payload["note"];
  if (typeof provider !== "string" || provider === "") return null;
  if (typeof keyId !== "string" || keyId === "") return null;
  if (typeof note !== "string") return null;
  return { provider, keyId, note };
}

function parseSecretSet(payload: unknown): SecretSetPayload | null {
  if (!isRecord(payload)) return null;
  const key = payload["key"];
  const value = payload["value"];
  if (typeof key !== "string" || !realIsSecretKey(key)) return null;
  if (typeof value !== "string" || value.trim() === "") return null;
  return { key, value };
}

const AGENT_MODEL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function parseAgentModelSet(payload: unknown): AgentModelSetPayload | null {
  if (!isRecord(payload)) return null;
  const agent = payload["agent"];
  if (typeof agent !== "string" || !AGENT_MODEL_KEY_PATTERN.test(agent.trim())) return null;
  if (validateFallbackModels(payload) !== null) return null;
  const rawEntries = payload["entries"];
  const entries: FallbackModelEntry[] = Array.isArray(rawEntries)
    ? rawEntries.map((entry) => {
        const record = entry as Record<string, unknown>;
        const variant = typeof record["variant"] === "string" ? record["variant"] : undefined;
        return { model: record["model"] as string, ...(variant ? { variant } : {}) };
      })
    : [];
  return { agent: agent.trim(), entries };
}

function parseSshKeyAdd(payload: unknown): SshKeyAddPayload | null {
  if (!isRecord(payload)) return null;
  const name = payload["name"];
  if (name !== undefined && typeof name !== "string") return null;
  const safeName = typeof name === "string" && name !== "" ? name : "id_ed25519";
  if (!isValidKeyName(safeName)) return null;
  const keyType = payload["keyType"];
  if (keyType !== undefined && keyType !== "ed25519" && keyType !== "rsa") return null;
  const passphrase = payload["passphrase"];
  if (passphrase !== undefined && typeof passphrase !== "string") return null;
  return { name: safeName, keyType: keyType === "rsa" ? "rsa" : "ed25519", passphrase: typeof passphrase === "string" ? passphrase : "" };
}

function parseSshKeyDelete(payload: unknown): SshKeyDeletePayload | null {
  if (!isRecord(payload)) return null;
  const name = payload["name"];
  if (typeof name !== "string" || !isValidKeyName(name)) return null;
  return { name };
}

function parseGitConfigSet(payload: unknown): GitConfigSetPayload | null {
  if (!isRecord(payload)) return null;
  const key = payload["key"];
  const value = payload["value"];
  if (typeof key !== "string" || key.trim() === "") return null;
  if (typeof value !== "string" || value.trim() === "") return null;
  return { key, value };
}

function parseGlabInstanceAdd(payload: unknown): GlabInstanceAddPayload | null {
  if (!isRecord(payload)) return null;
  const hostname = payload["hostname"];
  const token = payload["token"];
  if (typeof hostname !== "string" || hostname.trim() === "") return null;
  if (typeof token !== "string" || token.trim() === "") return null;
  return { hostname, token };
}

function parseGlabInstanceRemove(payload: unknown): GlabInstanceRemovePayload | null {
  if (!isRecord(payload)) return null;
  const hostname = payload["hostname"];
  if (typeof hostname !== "string" || hostname.trim() === "") return null;
  return { hostname };
}

function parseProjectCreate(payload: unknown): ProjectCreatePayload | null {
  if (!isRecord(payload)) return null;
  const name = payload["name"];
  if (typeof name !== "string" || !realIsValidProjectName(name.trim())) return null;
  const gitInit = payload["gitInit"];
  if (gitInit !== undefined && typeof gitInit !== "boolean") return null;
  const gitRemote = payload["gitRemote"];
  if (gitRemote !== undefined && typeof gitRemote !== "string") return null;
  return { name: name.trim(), gitInit: gitInit === true, gitRemote: typeof gitRemote === "string" ? gitRemote : "" };
}

function parseProjectName(payload: unknown): ProjectNamePayload | null {
  if (!isRecord(payload)) return null;
  const name = payload["name"];
  if (typeof name !== "string" || !realIsValidProjectName(name.trim())) return null;
  return { name: name.trim() };
}

function parseProjectSetRemote(payload: unknown): ProjectNamePayload & { remote: string } | null {
  if (!isRecord(payload)) return null;
  const name = payload["name"];
  if (typeof name !== "string" || !realIsValidProjectName(name.trim())) return null;
  const remote = payload["remote"];
  if (remote !== undefined && typeof remote !== "string") return null;
  return { name: name.trim(), remote: typeof remote === "string" ? remote : "" };
}

function parseProjectFeature(payload: unknown): ProjectFeaturePayload | null {
  if (!isRecord(payload)) return null;
  const name = payload["name"];
  const feature = payload["feature"];
  if (typeof name !== "string" || !realIsValidProjectName(name.trim())) return null;
  if (typeof feature !== "string" || !PROJECT_FEATURES.includes(feature as ProjectFeature)) return null;
  return { name: name.trim(), feature };
}

function parseProjectSync(payload: unknown): ProjectSyncPayload | null {
  if (!isRecord(payload)) return null;
  const toNames = (value: unknown): string[] | null => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return null;
    const names: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || !realIsValidProjectName(item.trim())) return null;
      names.push(item.trim());
    }
    return names;
  };
  const add = toNames(payload["add"]);
  const remove = toNames(payload["remove"]);
  if (add === null || remove === null) return null;
  return { add, remove };
}

function redactEnvironment(source: Record<string, string>): RedactedEnvironment {
  const env: Record<string, string> = {};
  const redacted: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (PASSWORD_KEYS.includes(key)) {
      env[key] = SECRET_MASK;
      redacted.push(key);
    } else if (KEY_MATERIAL_PATTERN.test(value)) {
      env[key] = maskKey(value);
      redacted.push(key);
    } else {
      env[key] = value;
    }
  }
  return { env, redacted };
}

function maskResultKeyMaterial(value: unknown): unknown {
  if (typeof value === "string") {
    return KEY_MATERIAL_PATTERN.test(value) ? maskKey(value) : value;
  }
  if (Array.isArray(value)) return value.map(maskResultKeyMaterial);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [key, maskResultKeyMaterial(nestedValue)]),
  );
}

function sanitizeProviderKey(value: unknown): SafeProviderKey {
  if (!isRecord(value)) return { id: "", masked: "", note: "", active: false };
  const rawValue = value["value"];
  const maskedValue = value["masked"];
  return {
    id: typeof value["id"] === "string" ? value["id"] : "",
    masked: typeof rawValue === "string"
      ? maskKey(rawValue)
      : typeof maskedValue === "string" ? maskedValue : "",
    note: typeof value["note"] === "string" ? value["note"] : "",
    active: value["active"] === true,
  };
}

function sanitizeProviders(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload["providers"])) return payload;
  return {
    ...payload,
    providers: payload["providers"].map((provider) => {
      if (!isRecord(provider) || !isRecord(provider["registry"])) return provider;
      const registry = provider["registry"];
      if (!Array.isArray(registry["keys"])) return provider;
      return {
        ...provider,
        registry: {
          ...registry,
          keys: registry["keys"].map(sanitizeProviderKey),
        },
      };
    }),
  };
}

async function readProjectOverviews(): Promise<ProjectReadResult> {
  const overviews = await collectProjectOverviews(
    execInAiDev,
    DEFAULT_WORKSPACE_ROOT,
    DEFAULT_OPENCHAMBER_SETTINGS,
    DEFAULT_OPENCHAMBER_DISABLED,
  );
  const projects: ProjectReadResult = {};
  for (const overview of overviews) {
    projects[overview.name] = {
      features: overview.features,
      remote: overview.remote,
      disabled: overview.disabled,
    };
  }
  return projects;
}

/**
 * Probe whether every live OpenChamber session on the ai-dev opencode server
 * is idle. Returns true (all idle, including when no managed server exists
 * yet), false (at least one session is busy), or null (the opencode server
 * API is unreachable).
 *
 * Reads the server's /session/status map (authenticated with
 * OPENCODE_SERVER_PASSWORD when set), the same source the server's own
 * message-queue consumer uses: the map lists only busy/retry sessions, so an
 * empty map means nothing is running. Verified against the running container
 * (per-id /state returns the web UI fallback, and /session returns empty for
 * zero sessions, so neither is a reliable busy signal).
 */
const OPENCODE_SESSION_PROBE_SCRIPT = `
PORT=$(cat "$HOME/.config/openchamber/managed-opencode/"*.json 2>/dev/null | grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' | tail -1 | grep -o '[0-9]*$')
if [ -z "$PORT" ]; then
  PORT=$(pgrep -af 'opencode serve' 2>/dev/null | grep -o '\-\-port[[:space:]][0-9]*' | tail -1 | awk '{print $2}')
fi
[ -n "$PORT" ] || exit 0
# No managed server and no serve process: same pid namespace and HOME were
# searched, so no session can be running. (A server started later is covered
# by waitForIdleSessions re-probing every interval.)
# Authenticated requests when the managed server requires a password
# (OPENCODE_SERVER_PASSWORD is set in ai-dev); plain requests otherwise.
# A wrong or stale password fails closed via curl exit 2 below.
oc_session_get() {
  if [ -n "\${OPENCODE_SERVER_PASSWORD:-}" ]; then
    curl -fsS -m 5 -u "opencode:\${OPENCODE_SERVER_PASSWORD}" "http://127.0.0.1:\${PORT}/session$1" 2>/dev/null
  else
    curl -fsS -m 5 "http://127.0.0.1:\${PORT}/session$1" 2>/dev/null
  fi
}
# The status map lists only busy/retry sessions (this matches the server's own
# consumer); an empty map means nothing is running. A malformed response fails
# closed via the jq fallback below.
STATUS=$(oc_session_get "/status") || exit 2
BUSYCOUNT=$(echo "$STATUS" | jq -r '[to_entries[] | .value | select(.type == "busy" or .type == "retry")] | length' 2>/dev/null) || exit 2
[ "$BUSYCOUNT" = "0" ] || exit 1
exit 0
`;

export async function probeIdleViaOpenCodeServer(): Promise<boolean | null> {
  const result = await execInAiDev(OPENCODE_SESSION_PROBE_SCRIPT, 30_000);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return null;
}

/**
 * Poll the session probe until every session is idle, the deadline passes, or
 * the probe proves unavailable. Busy sessions keep waiting; repeated probe
 * failures give up early so a dead opencode server cannot block a restart
 * for the full deadline.
 */
export async function waitForIdleSessions(
  probe: () => Promise<boolean | null>,
  deadlineMs = 10 * 60_000,
  intervalMs = 15_000,
  consecutiveFailuresToGiveUp = 3,
): Promise<IdleWaitOutcome> {
  const deadline = Date.now() + deadlineMs;
  let consecutiveFailures = 0;
  while (true) {
    const idle = await probe();
    if (idle === true) return "idle";
    if (idle === null) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= consecutiveFailuresToGiveUp) return "unavailable";
    } else {
      consecutiveFailures = 0;
    }
    if (Date.now() >= deadline) return "timeout";
    await Bun.sleep(intervalMs);
  }
}

/** Create a dispatcher that validates, defers, and asynchronously executes commands. */
export function createCommandDispatcher(sender: CommandSender, deps: CommandDeps): CommandDispatcher {
  const queue = createDeferralQueue<Envelope>();

  function sendMalformed(env: Envelope): void {
    sender.send(buildError(ERROR_CODES.malformed_command, "Malformed command payload", env.id));
  }

  function dispatchUpgrade(env: Envelope): void {
    const startedAt = deps.now();
    sender.send(buildAck(env.id, {
      status: "success",
      message: "upgrade starting",
      started_at: startedAt,
      finished_at: deps.now(),
    }));

    void finishUpgrade(env, startedAt);
  }

  async function finishUpgrade(env: Envelope, startedAt: string): Promise<void> {
    try {
      const result = await deps.runUpgrade();
      sender.send(buildAck(env.id, {
        status: result.success ? "success" : "failure",
        message: result.error ?? result.message ?? "upgrade done",
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  function dispatchReconfigure(env: Envelope, values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) deps.upsertEnvVar(key, value);

    const startedAt = deps.now();
    sender.send(buildAck(env.id, {
      status: "success",
      message: "reconfiguring",
      started_at: startedAt,
      finished_at: deps.now(),
    }));

    void finishReconfigure(env, startedAt);
  }

  async function finishReconfigure(env: Envelope, startedAt: string): Promise<void> {
    try {
      const result = await deps.restartAiDev();
      sender.send(buildAck(env.id, {
        status: result.success ? "success" : "failure",
        message: result.message ?? "reconfiguration done",
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  function dispatchRestart(env: Envelope, service: RestartService): void {
    const startedAt = deps.now();
    sender.send(buildAck(env.id, {
      status: "success",
      message: `restarting ${service}`,
      started_at: startedAt,
      finished_at: deps.now(),
    }));

    void finishRestart(env, service, startedAt);
  }

  async function finishRestart(env: Envelope, service: RestartService, startedAt: string): Promise<void> {
    try {
      const result = await deps.restartContainer(service);
      sender.send(buildAck(env.id, {
        status: result.success ? "success" : "failure",
        message: result.message ?? `${service} restart done`,
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  async function restartPerMode(
    mode: RestartMode,
  ): Promise<{ success: boolean; message: string; suffix: string }> {
    if (mode === "force") {
      const result = await deps.restartAiDev();
      return { success: result.success, message: result.message ?? "ai-dev restarted", suffix: "(force restart)" };
    }

    const waitOutcome = await deps.waitForIdleSessions();
    if (waitOutcome === "idle") {
      const result = await deps.gracefulRestartAiDev();
      return {
        success: result.success,
        message: result.message ?? "ai-dev gracefully restarted",
        suffix: "(graceful restart)",
      };
    }

    const result = await deps.restartAiDev();
    const fallbackReason = waitOutcome === "timeout" ? "graceful-wait timeout" : "unavailable control API";
    return {
      success: result.success,
      message: `${result.message ?? "ai-dev restarted"} (force fallback after ${fallbackReason})`,
      suffix: `(force restart after ${fallbackReason})`,
    };
  }

  async function applyKeyAndRestart(
    provider: string,
    key: string,
    mode: RestartMode,
  ): Promise<{ success: boolean; message: string; suffix: string }> {
    try {
      await deps.applyActiveKey(provider, key);
    } catch (error: unknown) {
      return { success: false, message: error instanceof Error ? error.message : String(error), suffix: "" };
    }
    return restartPerMode(mode);
  }

  function dispatchKeyAdd(env: Envelope, payload: ProviderKeyAddPayload): void {
    const startedAt = deps.now();
    sender.send(buildAck(env.id, {
      status: "success",
      message: "adding provider key",
      started_at: startedAt,
      finished_at: deps.now(),
    }));

    void finishKeyAdd(env, payload, startedAt);
  }

  async function finishKeyAdd(env: Envelope, payload: ProviderKeyAddPayload, startedAt: string): Promise<void> {
    let added: ProviderKey | null = null;
    let firstKey = false;

    const rollbackFirstKey = async (): Promise<string[]> => {
      if (added === null || !firstKey) return [];
      const failures: string[] = [];
      if (!deps.deleteProviderKey(payload.provider, added.id)) failures.push("registry key removal failed");
      try {
        await deps.removeAuthKey(payload.provider);
        await deps.clearProviderCache();
      } catch {
        failures.push("runtime auth removal failed");
      }
      try {
        const restart = await deps.restartAiDev();
        if (!restart.success) failures.push("rollback restart failed");
      } catch {
        failures.push("rollback restart failed");
      }
      return failures;
    };

    const failureMessage = async (message: string): Promise<string> => {
      const failures = await rollbackFirstKey();
      return failures.length === 0 ? message : `${message}; rollback incomplete: ${failures.join(", ")}`;
    };

    try {
      const existing = deps.readProviderKeys().providers[payload.provider]?.keys ?? [];
      firstKey = existing.length === 0;
      if (firstKey) {
        const stored = await deps.readProviderAuthSnapshot(payload.provider);
        if (stored !== null) {
          sender.send(buildAck(env.id, {
            status: "failure",
            message: `provider ${payload.provider} already holds a key in the ai-dev auth store; remove it before adding a registry key`,
            started_at: startedAt,
            finished_at: deps.now(),
          }));
          return;
        }
      }

      added = deps.addProviderKey(payload.provider, payload.value, payload.note);
      if (!firstKey) {
        sender.send(buildAck(env.id, {
          status: "success",
          message: `provider key ${added.id} added`,
          started_at: startedAt,
          finished_at: deps.now(),
        }));
        return;
      }

      const applied = await applyKeyAndRestart(payload.provider, payload.value, payload.mode);
      if (!applied.success) {
        sender.send(buildAck(env.id, {
          status: "failure",
          message: await failureMessage(applied.message),
          started_at: startedAt,
          finished_at: deps.now(),
        }));
        return;
      }
      sender.send(buildAck(env.id, {
        status: "success",
        message: `provider key ${added.id} added and applied ${applied.suffix}`,
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sender.send(buildAck(env.id, {
        status: "failure",
        message: await failureMessage(message),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  function dispatchKeySetActive(
    env: Envelope,
    payload: ProviderKeyRefPayload,
    key: ProviderKey,
    previousActiveId: string | null,
  ): void {
    const alreadyActive = previousActiveId === payload.keyId;
    const startedAt = deps.now();
    sender.send(buildAck(env.id, {
      status: "success",
      message: alreadyActive ? "provider key already active" : "setting active provider key",
      started_at: startedAt,
      finished_at: deps.now(),
    }));

    if (alreadyActive) {
      sender.send(buildAck(env.id, {
        status: "success",
        message: `provider key ${key.id} is already active`,
        started_at: startedAt,
        finished_at: deps.now(),
      }));
      return;
    }

    void finishKeySetActive(env, payload, key, previousActiveId, startedAt);
  }

  async function finishKeySetActive(
    env: Envelope,
    payload: ProviderKeyRefPayload,
    key: ProviderKey,
    previousActiveId: string | null,
    startedAt: string,
  ): Promise<void> {
    let previousAuthKey: string | null;
    try {
      previousAuthKey = await deps.readProviderAuthSnapshot(payload.provider);
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
      return;
    }

    const restorePreviousState = async (): Promise<string[]> => {
      const failures: string[] = [];
      try {
        if (previousAuthKey === null) {
          await deps.removeAuthKey(payload.provider);
          await deps.clearProviderCache();
        } else {
          await deps.applyActiveKey(payload.provider, previousAuthKey);
        }
      } catch {
        failures.push("runtime auth restore failed");
      }

      if (!deps.setActiveProviderKey(payload.provider, previousActiveId)) {
        failures.push("registry selection restore failed");
      }

      try {
        const restart = await deps.restartAiDev();
        if (!restart.success) failures.push("rollback restart failed");
      } catch {
        failures.push("rollback restart failed");
      }
      return failures;
    };

    const failureMessage = async (message: string): Promise<string> => {
      const failures = await restorePreviousState();
      return failures.length === 0 ? message : `${message}; rollback incomplete: ${failures.join(", ")}`;
    };

    try {
      if (!deps.setActiveProviderKey(payload.provider, payload.keyId)) {
        sender.send(buildAck(env.id, {
          status: "failure",
          message: `provider key ${payload.keyId} not found`,
          started_at: startedAt,
          finished_at: deps.now(),
        }));
        return;
      }
      const applied = await applyKeyAndRestart(payload.provider, key.value, payload.mode);
      if (!applied.success) {
        sender.send(buildAck(env.id, {
          status: "failure",
          message: await failureMessage(applied.message),
          started_at: startedAt,
          finished_at: deps.now(),
        }));
        return;
      }
      sender.send(buildAck(env.id, {
        status: "success",
        message: `provider key ${key.id} set active ${applied.suffix}`,
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sender.send(buildAck(env.id, {
        status: "failure",
        message: await failureMessage(message),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  function dispatchKeyDelete(env: Envelope, payload: ProviderKeyRefPayload): void {
    const startedAt = deps.now();
    sender.send(buildAck(env.id, {
      status: "success",
      message: "deleting provider key",
      started_at: startedAt,
      finished_at: deps.now(),
    }));

    void finishKeyDelete(env, payload, startedAt);
  }

  async function finishKeyDelete(env: Envelope, payload: ProviderKeyRefPayload, startedAt: string): Promise<void> {
    try {
      const entryBefore = deps.readProviderKeys().providers[payload.provider];
      const key = entryBefore?.keys.find((candidate) => candidate.id === payload.keyId);
      if (key === undefined) {
        sender.send(buildAck(env.id, {
          status: "failure",
          message: `provider key ${payload.keyId} not found`,
          started_at: startedAt,
          finished_at: deps.now(),
        }));
        return;
      }
      const wasActive = entryBefore.activeKeyId === payload.keyId;
      const remaining = (entryBefore.keys.length ?? 0) - 1;

      if (!deps.deleteProviderKey(payload.provider, payload.keyId)) {
        sender.send(buildAck(env.id, {
          status: "failure",
          message: `provider key ${payload.keyId} not found`,
          started_at: startedAt,
          finished_at: deps.now(),
        }));
        return;
      }

      if (!wasActive) {
        sender.send(buildAck(env.id, {
          status: "success",
          message: `provider key ${payload.keyId} deleted`,
          started_at: startedAt,
          finished_at: deps.now(),
        }));
        return;
      }

      if (remaining === 0) {
        await deps.removeAuthKey(payload.provider);
        await deps.clearProviderCache();
        const applied = await restartPerMode(payload.mode);
        if (!applied.success) {
          sender.send(buildAck(env.id, {
            status: "failure",
            message: applied.message,
            started_at: startedAt,
            finished_at: deps.now(),
          }));
          return;
        }
        sender.send(buildAck(env.id, {
          status: "success",
          message: `provider key ${payload.keyId} deleted, auth entry removed ${applied.suffix}`,
          started_at: startedAt,
          finished_at: deps.now(),
        }));
        return;
      }

      const entryAfter = deps.readProviderKeys().providers[payload.provider];
      const next = entryAfter?.keys.find((candidate) => candidate.id === entryAfter?.activeKeyId);
      if (next === undefined) {
        sender.send(buildAck(env.id, {
          status: "failure",
          message: "no replacement key to apply after deletion",
          started_at: startedAt,
          finished_at: deps.now(),
        }));
        return;
      }
      const applied = await applyKeyAndRestart(payload.provider, next.value, payload.mode);
      if (!applied.success) {
        sender.send(buildAck(env.id, {
          status: "failure",
          message: applied.message,
          started_at: startedAt,
          finished_at: deps.now(),
        }));
        return;
      }
      sender.send(buildAck(env.id, {
        status: "success",
        message: `provider key ${payload.keyId} deleted, key ${next.id} promoted ${applied.suffix}`,
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  function dispatchKeyUpdateNote(env: Envelope, payload: ProviderKeyNotePayload): void {
    const startedAt = deps.now();
    sender.send(buildAck(env.id, {
      status: "success",
      message: "updating provider key note",
      started_at: startedAt,
      finished_at: deps.now(),
    }));

    void finishKeyUpdateNote(env, payload, startedAt);
  }

  async function finishKeyUpdateNote(env: Envelope, payload: ProviderKeyNotePayload, startedAt: string): Promise<void> {
    try {
      if (!deps.updateProviderKeyNote(payload.provider, payload.keyId, payload.note)) {
        sender.send(buildAck(env.id, {
          status: "failure",
          message: `provider key ${payload.keyId} not found`,
          started_at: startedAt,
          finished_at: deps.now(),
        }));
        return;
      }
      sender.send(buildAck(env.id, {
        status: "success",
        message: `note updated for provider key ${payload.keyId}`,
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  async function executeAction(
    env: Envelope,
    run: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>,
  ): Promise<void> {
    const startedAt = deps.now();
    try {
      const result = await run();
      sender.send(buildAck(env.id, {
        status: result.ok ? "success" : "failure",
        message: result.ok ? (result.message ?? "done") : ("error" in result ? result.error : "action failed"),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  async function executeSecretSet(env: Envelope, payload: SecretSetPayload): Promise<void> {
    await executeAction(env, async () => {
      const activation = deps.setSecret(payload.key, payload.value);
      return { ok: true, message: `${payload.key} updated (${activation} activation)` };
    });
  }

  async function executeSshKeyAdd(env: Envelope, payload: SshKeyAddPayload): Promise<void> {
    await executeAction(env, async () => {
      const result = await deps.sshAddKey(payload.name, payload.keyType, payload.passphrase);
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true, message: `SSH key ${payload.name} added` };
    });
  }

  async function executeSshKeyDelete(env: Envelope, payload: SshKeyDeletePayload): Promise<void> {
    await executeAction(env, async () => {
      const result = await deps.sshDeleteKey(payload.name);
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true, message: `SSH key ${payload.name} deleted` };
    });
  }

  async function executeGitConfigSet(env: Envelope, payload: GitConfigSetPayload): Promise<void> {
    await executeAction(env, async () => {
      const result = await deps.gitSetConfig(payload.key, payload.value);
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true, message: `git config ${payload.key} updated` };
    });
  }

  async function executeGhAuthStart(env: Envelope): Promise<void> {
    const startedAt = deps.now();
    try {
      const info = await deps.ghStartDeviceFlow();
      sender.send(buildAck(env.id, {
        status: "success",
        message: "device flow started",
        started_at: startedAt,
        finished_at: deps.now(),
        data: { device_code: info.device_code, verification_uri: info.verification_uri },
      }));
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  async function executeGhAuthLogout(env: Envelope): Promise<void> {
    const startedAt = deps.now();
    try {
      await deps.ghLogout();
      sender.send(buildAck(env.id, {
        status: "success",
        message: "GitHub disconnected",
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  async function executeGlabInstanceAdd(env: Envelope, payload: GlabInstanceAddPayload): Promise<void> {
    await executeAction(env, async () => {
      const result = await deps.glabAddInstance(payload.hostname, payload.token);
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true, message: `GitLab instance ${payload.hostname} connected` };
    });
  }

  async function executeGlabInstanceRemove(env: Envelope, payload: GlabInstanceRemovePayload): Promise<void> {
    const startedAt = deps.now();
    try {
      await deps.glabRemoveInstance(payload.hostname);
      sender.send(buildAck(env.id, {
        status: "success",
        message: `GitLab instance ${payload.hostname} removed`,
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  async function executeProjectEnable(env: Envelope, payload: ProjectNamePayload): Promise<void> {
    await executeAction(env, async () => {
      const result = await deps.projectEnable(payload.name);
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true, message: `Project ${payload.name} enabled` };
    });
  }

  async function executeProjectDisable(env: Envelope, payload: ProjectNamePayload): Promise<void> {
    await executeAction(env, async () => {
      const result = await deps.projectDisable(payload.name);
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true, message: `Project ${payload.name} disabled` };
    });
  }

  async function executeProjectEnableFeature(env: Envelope, payload: ProjectFeaturePayload): Promise<void> {
    await executeAction(env, async () => {
      const result = await deps.projectEnableFeature(payload.name, payload.feature);
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true, message: `Project ${payload.name} feature ${payload.feature} enabled` };
    });
  }

  function dispatchProjectCreate(env: Envelope, payload: ProjectCreatePayload): void {
    const startedAt = deps.now();
    sender.send(buildAck(env.id, {
      status: "success",
      message: "creating project",
      started_at: startedAt,
      finished_at: deps.now(),
    }));
    void finishProjectCreate(env, payload, startedAt);
  }

  async function finishProjectCreate(env: Envelope, payload: ProjectCreatePayload, startedAt: string): Promise<void> {
    try {
      const result = await deps.projectCreate(payload.name, { gitInit: payload.gitInit, gitRemote: payload.gitRemote });
      sender.send(buildAck(env.id, {
        status: result.ok ? "success" : "failure",
        message: result.ok ? `Project ${payload.name} created` : ("error" in result ? result.error : "Project creation failed"),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  function dispatchProjectSetRemote(env: Envelope, payload: ProjectNamePayload & { remote: string }): void {
    const startedAt = deps.now();
    sender.send(buildAck(env.id, {
      status: "success",
      message: "setting project remote",
      started_at: startedAt,
      finished_at: deps.now(),
    }));
    void finishProjectSetRemote(env, payload, startedAt);
  }

  async function finishProjectSetRemote(env: Envelope, payload: ProjectNamePayload & { remote: string }, startedAt: string): Promise<void> {
    try {
      const result = await deps.projectSetRemote(payload.name, payload.remote);
      sender.send(buildAck(env.id, {
        status: result.ok ? "success" : "failure",
        message: result.ok ? `Project ${payload.name} remote set` : ("error" in result ? result.error : "Project remote update failed"),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  function dispatchProjectSync(env: Envelope, payload: ProjectSyncPayload): void {
    const startedAt = deps.now();
    sender.send(buildAck(env.id, {
      status: "success",
      message: "syncing projects",
      started_at: startedAt,
      finished_at: deps.now(),
    }));
    void finishProjectSync(env, payload, startedAt);
  }

  async function finishProjectSync(env: Envelope, payload: ProjectSyncPayload, startedAt: string): Promise<void> {
    try {
      const result = await deps.projectSync(payload.add, payload.remove);
      const message = "error" in result
        ? result.error
        : `Project sync complete (${result.messages?.length ?? 0} changes)`;
      sender.send(buildAck(env.id, {
        status: result.ok ? "success" : "failure",
        message,
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    } catch (error: unknown) {
      sender.send(buildAck(env.id, {
        status: "failure",
        message: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    }
  }

  function dispatchAgentModelSet(env: Envelope, payload: AgentModelSetPayload): void {
    const startedAt = deps.now();
    sender.send(buildAck(env.id, {
      status: "success",
      message: "applying agent model",
      started_at: startedAt,
      finished_at: deps.now(),
    }));
    void finishAgentModelSet(env, payload, startedAt);
  }

  async function finishAgentModelSet(env: Envelope, payload: AgentModelSetPayload, startedAt: string): Promise<void> {
    const fail = (message: string): void => {
      sender.send(buildAck(env.id, {
        status: "failure",
        message,
        started_at: startedAt,
        finished_at: deps.now(),
      }));
    };
    try {
      const state = await deps.readAgentModelsState();
      if (!state.agents.some((entry) => entry.name === payload.agent)) {
        fail(`agent ${payload.agent} is not a configurable live subagent`);
        return;
      }
      const catalog = new Set(state.catalog);
      const unsupported = payload.entries.find((entry) => !catalog.has(entry.model));
      if (unsupported !== undefined) {
        fail(`model ${unsupported.model} is not available in the current environment catalog`);
        return;
      }
      const result = await deps.applyAgentModel(payload.agent, payload.entries);
      const message = "error" in result
        ? result.error
        : result.status === "cleared"
          ? `Agent model cleared for ${payload.agent}; automatic selection restored`
          : `Agent model applied for ${payload.agent}`;
      sender.send(buildAck(env.id, {
        status: result.ok ? "success" : "failure",
        message,
        started_at: startedAt,
        finished_at: deps.now(),
        ...(result.ok ? { data: result } : {}),
      }));
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  async function dispatchQuery(env: Envelope, query: QueryName): Promise<void> {
    let payload: unknown;
    switch (query) {
      case "status":
        payload = await deps.readStatus();
        break;
      case "env.get":
        payload = redactEnvironment(deps.readEnv());
        break;
      case "projects.list":
        payload = await deps.readProjects();
        break;
      case "providers.list":
        payload = sanitizeProviders(await deps.readProviders());
        break;
      case "git.config.get":
        payload = await deps.gitGetConfig();
        break;
      case "glab.instances":
        payload = await deps.glabListInstances();
        break;
      case "ssh.key.list":
        payload = await deps.sshListKeys();
        break;
      case "agent-models.list":
        payload = await deps.readAgentModelsState();
        break;
    }
    sender.send(buildResult(env.id, maskResultKeyMaterial(payload)));
  }

  function defer(env: Envelope): void {
    queue.push(env);
  }

  function deferProviderCommand(env: Envelope): void {
    const acknowledgedAt = deps.now();
    sender.send(buildAck(env.id, {
      status: "success",
      message: "provider key command queued until upgrade completes",
      started_at: acknowledgedAt,
      finished_at: acknowledgedAt,
    }));
    defer(env);
  }

  function handle(env: Envelope): void {
    const command = parseCommandType(env.payload);
    if (command === null) {
      const code = isRecord(env.payload) && typeof env.payload["type"] === "string"
        ? ERROR_CODES.unknown_command
        : ERROR_CODES.malformed_command;
      const message = code === ERROR_CODES.unknown_command
        ? "Unknown command type"
        : "Malformed command payload";
      sender.send(buildError(code, message, env.id));
      return;
    }

    if (deps.isUpgradeRunning() && !command.startsWith("providers.key.")) {
      defer(env);
      return;
    }

    switch (command) {
      case "upgrade":
        dispatchUpgrade(env);
        return;
      case "reconfigure": {
        const values = parseReconfigureEnv(env.payload);
        if (values === null) {
          sendMalformed(env);
          return;
        }
        dispatchReconfigure(env, values);
        return;
      }
      case "restart": {
        const service = parseRestartService(env.payload);
        if (service === null) {
          sendMalformed(env);
          return;
        }
        dispatchRestart(env, service);
        return;
      }
      case "providers.key.add": {
        const payload = parseProviderKeyAdd(env.payload);
        if (payload === null || !deps.isKeyProviderSupported(payload.provider)) {
          sendMalformed(env);
          return;
        }
        if (deps.isUpgradeRunning()) {
          deferProviderCommand(env);
          return;
        }
        dispatchKeyAdd(env, payload);
        return;
      }
      case "providers.key.set-active": {
        const payload = parseProviderKeyRef(env.payload);
        if (payload === null || !deps.isKeyProviderSupported(payload.provider)) {
          sendMalformed(env);
          return;
        }
        const entry = deps.readProviderKeys().providers[payload.provider];
        const key = entry?.keys.find((candidate) => candidate.id === payload.keyId);
        if (key === undefined) {
          sendMalformed(env);
          return;
        }
        if (deps.isUpgradeRunning()) {
          deferProviderCommand(env);
          return;
        }
        dispatchKeySetActive(env, payload, key, entry?.activeKeyId ?? null);
        return;
      }
      case "providers.key.delete": {
        const payload = parseProviderKeyRef(env.payload);
        if (payload === null || !deps.isKeyProviderSupported(payload.provider)) {
          sendMalformed(env);
          return;
        }
        const entry = deps.readProviderKeys().providers[payload.provider];
        if (entry === undefined || !entry.keys.some((candidate) => candidate.id === payload.keyId)) {
          sendMalformed(env);
          return;
        }
        if (deps.isUpgradeRunning()) {
          deferProviderCommand(env);
          return;
        }
        dispatchKeyDelete(env, payload);
        return;
      }
      case "providers.key.update-note": {
        const payload = parseProviderKeyNote(env.payload);
        if (payload === null || !deps.isKeyProviderSupported(payload.provider)) {
          sendMalformed(env);
          return;
        }
        const entry = deps.readProviderKeys().providers[payload.provider];
        if (entry === undefined || !entry.keys.some((candidate) => candidate.id === payload.keyId)) {
          sendMalformed(env);
          return;
        }
        if (deps.isUpgradeRunning()) {
          deferProviderCommand(env);
          return;
        }
        dispatchKeyUpdateNote(env, payload);
        return;
      }
      case "secrets.set": {
        const payload = parseSecretSet(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        void executeSecretSet(env, payload);
        return;
      }
      case "ssh.key.add": {
        const payload = parseSshKeyAdd(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        void executeSshKeyAdd(env, payload);
        return;
      }
      case "ssh.key.delete": {
        const payload = parseSshKeyDelete(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        void executeSshKeyDelete(env, payload);
        return;
      }
      case "git.config.set": {
        const payload = parseGitConfigSet(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        void executeGitConfigSet(env, payload);
        return;
      }
      case "gh.auth.start":
        void executeGhAuthStart(env);
        return;
      case "gh.auth.logout":
        void executeGhAuthLogout(env);
        return;
      case "glab.instance.add": {
        const payload = parseGlabInstanceAdd(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        void executeGlabInstanceAdd(env, payload);
        return;
      }
      case "glab.instance.remove": {
        const payload = parseGlabInstanceRemove(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        void executeGlabInstanceRemove(env, payload);
        return;
      }
      case "projects.create": {
        const payload = parseProjectCreate(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        dispatchProjectCreate(env, payload);
        return;
      }
      case "projects.set-remote": {
        const payload = parseProjectSetRemote(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        dispatchProjectSetRemote(env, payload);
        return;
      }
      case "projects.enable": {
        const payload = parseProjectName(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        void executeProjectEnable(env, payload);
        return;
      }
      case "projects.disable": {
        const payload = parseProjectName(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        void executeProjectDisable(env, payload);
        return;
      }
      case "projects.enable-feature": {
        const payload = parseProjectFeature(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        void executeProjectEnableFeature(env, payload);
        return;
      }
      case "projects.sync": {
        const payload = parseProjectSync(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        dispatchProjectSync(env, payload);
        return;
      }
      case "agent-models.set": {
        const payload = parseAgentModelSet(env.payload);
        if (payload === null) {
          sendMalformed(env);
          return;
        }
        dispatchAgentModelSet(env, payload);
        return;
      }
      case "status":
      case "env.get":
      case "projects.list":
      case "providers.list":
      case "git.config.get":
      case "glab.instances":
      case "ssh.key.list":
      case "agent-models.list":
        void dispatchQuery(env, command);
        return;
    }
  }

  function drain(limit = 10): void {
    let processed = 0;
    while (queue.size() > 0 && !deps.isUpgradeRunning() && processed < limit) {
      const env = queue.shift();
      if (env === undefined) return;
      handle(env);
      processed += 1;
    }
  }

  return {
    handle,
    defer,
    drain,
    pendingCount: queue.size,
  };
}

/** Create production command dependencies backed by shared read and action helpers. */
export function createRealCommandDeps(
  composeFileExists: (path: string) => boolean = existsSync,
  restartDeps: Partial<RealRestartDeps> = {},
): CommandDeps {
  const agentModelsLib = createAgentModelsLib(AGENT_MODEL_REAL_DEPS);
  const {
    getComposeProject: resolveComposeProject = getComposeProject,
    getSelfBindSource: resolveSelfBindSource = getSelfBindSource,
    dockerCommand: runDockerCommand = dockerCommand,
    runCommand: runHostCommand = runCommand,
  } = restartDeps;
  return {
    isUpgradeRunning: () => getState() === "running",
    runUpgrade: async () => {
      try {
        const success = await runRealUpgrade();
        return success ? { success } : { success, error: "Upgrade failed" };
      } catch (error: unknown) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    restartAiDev: async () => {
      const result = await restartRealAiDev();
      return "error" in result ? { success: false, message: result.error } : { success: true };
    },
    restartContainer: async (service) => {
      try {
        if (service !== "ai-dev" && service !== "ai-admin") {
          return { success: false, message: `Unknown service: ${service}` };
        }
        // Mirror restartAiDev: when the compose file is present, recreate the
        // service from compose so a newly pulled image is applied. A plain
        // `docker restart` keeps the container on its old image.
        if (composeFileExists(COMPOSE_FILE)) {
          const project = await resolveComposeProject();
          if (service === "ai-admin") {
            // ai-admin has no upgrade flow; fetch the latest tag so the
            // recreate below applies the newest published image. Best-effort:
            // a registry outage must not block the restart itself.
            await runDockerCommand(`pull ${resolveImageRef()} 2>&1`, 120_000);
            // Recreate ai-admin from a helper container (mirroring
            // POST /api/admin/restart): compose run in-place stops the very
            // container executing it, killing the agent mid-recreate.
            const envSource = await resolveSelfBindSource(ENV_FILE);
            const composeSource = await resolveSelfBindSource(COMPOSE_FILE);
            if (!envSource || !composeSource) {
              return { success: false, message: "Failed to resolve host bind sources for ai-admin restart" };
            }
            const helperResult = await runHostCommand(
              [
                "docker", "run", "--rm", "--user", "0",
                "--entrypoint", "/usr/local/bin/docker",
                "-v", `${envSource}:${envSource}:ro`,
                "-v", `${composeSource}:${composeSource}:ro`,
                "-v", "/var/run/docker.sock:/var/run/docker.sock",
                resolveImageRef(),
                "compose", "-p", project,
                "--env-file", envSource,
                "-f", composeSource,
                "up", "-d", "--force-recreate", "ai-admin",
              ],
              120_000,
            );
            return helperResult.exitCode === 0
              ? { success: true }
              : { success: false, message: helperResult.stderr || helperResult.stdout || "ai-admin compose recreate failed" };
          }
          const result = await runDockerCommand(
            `compose -p ${project} --env-file ${ENV_FILE} -f ${COMPOSE_FILE} up -d --force-recreate ai-dev 2>&1`,
            120_000,
          );
          return result.exitCode === 0
            ? { success: true }
            : { success: false, message: result.stderr || result.stdout || "Compose recreate failed" };
        }

        const containerName =
          service === "ai-admin" ? await getSelfContainerRef() : await getAiDevContainerRef();
        const result = await dockerCommand(`restart ${containerName}`, 30_000);
        return result.exitCode === 0
          ? { success: true }
          : { success: false, message: result.stderr || result.stdout || `Failed to restart ${service}` };
      } catch (error: unknown) {
        return { success: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    upsertEnvVar: upsertRealEnvVar,
    now: () => new Date().toISOString(),
    readStatus: () => buildStatusReport(
      { collectStatus, getVersions: getComponentVersions, getUpdateCheck },
      getState(),
    ),
    readEnv: readEnvFile,
    readProjects: readProjectOverviews,
    readProviders: collectProvidersMeta,
    isKeyProviderSupported: realIsKeyProviderSupported,
    readProviderKeys: realReadProviderKeys,
    addProviderKey: realAddProviderKey,
    setActiveProviderKey: realSetActiveProviderKey,
    deleteProviderKey: realDeleteProviderKey,
    updateProviderKeyNote: realUpdateProviderKeyNote,
    applyActiveKey: realApplyActiveKey,
    removeAuthKey: realRemoveAuthKey,
    clearProviderCache: realClearProviderCache,
    readProviderAuthSnapshot: realReadProviderAuthSnapshot,
    waitForIdleSessions: () => waitForIdleSessions(probeIdleViaOpenCodeServer),
    gracefulRestartAiDev: async () => {
      const result = await restartRealAiDev();
      return "error" in result ? { success: false, message: result.error } : { success: true };
    },
    setSecret: realSetSecretValue,
    sshAddKey: realSshAddKey,
    sshDeleteKey: realSshDeleteKey,
    sshListKeys: realSshListKeys,
    gitSetConfig: realSetGlobalConfig,
    gitGetConfig: readSanitizedGlobalConfig,
    ghStartDeviceFlow: realStartDeviceFlow,
    ghLogout: realLogoutGh,
    glabAddInstance: realLoginGlabWithToken,
    glabRemoveInstance: realLogoutGlab,
    glabListInstances: realListGlabInstances,
    projectCreate: (name, payload) => realCreateProject(name, payload, {}),
    projectSetRemote: (name, remote) => realSetProjectRemote(name, remote, {}),
    projectEnable: (name) => realEnableProject(name, {}),
    projectDisable: (name) => realDisableProject(name, {}),
    projectEnableFeature: (name, feature) => realEnableProjectFeature(name, feature, {}),
    projectSync: (add, remove) => realSyncProjects(add, remove, {}),
    readAgentModelsState: () => collectAgentModelState(agentModelsLib, agentModelsLib.getServerPassword()),
    applyAgentModel: (agent, entries) => agentModelsLib.applyAndVerify(agent, entries),
  };
}
