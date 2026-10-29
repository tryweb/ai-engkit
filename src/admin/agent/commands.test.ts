import { describe, expect, test } from "bun:test";
import type { FallbackModelEntry } from "../lib/agent-models";
import { PASSWORD_KEYS } from "../lib/env-schema";
import { readEnvFile } from "../lib/env";
import { KEY_MANAGED_PROVIDERS } from "../lib/opencode-auth";
import { collectProjectOverviews } from "../lib/projects-overview";
import { collectProvidersMeta } from "../lib/provider-meta";
import type { ProviderKey, ProviderKeysFile } from "../lib/provider-keys";
import { collectStatus } from "../lib/status";
import type { GitLabRotationResult } from "../lib/gitlab-token-rotation";
import type { CommandDeps, CommandSender, IdleWaitOutcome } from "./commands";
import { createCommandDispatcher, createRealCommandDeps, waitForIdleSessions } from "./commands";
import type { StatusReport } from "./heartbeat";
import { ERROR_CODES, MESSAGE_TYPES, type Envelope, type QueryName } from "./protocol";

// allow: SIZE_OK — task scope keeps the dispatcher's complete behavior matrix in this test file.
const FIXED_TIME = "2026-08-10T12:00:00.000Z";
const RAW_KEY_MATERIAL = "sk-ant-api03-abcdefghijklmnop";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface Fixture {
  deps: CommandDeps;
  sender: CommandSender;
  sent: Envelope[];
  upgradeCalls: string[];
  restartAiDevCalls: string[];
  restartServices: string[];
  upserts: Array<[string, string]>;
  queryReads: string[];
  registry: ProviderKeysFile;
  keyAdds: Array<{ provider: string; value: string; note: string }>;
  setActiveCalls: Array<[string, string | null]>;
  deleteCalls: Array<[string, string]>;
  noteUpdates: Array<[string, string, string]>;
  v2Credentials: Map<string, Array<{ id: string; label: string }>>;
  v2Activations: string[];
  v2Removals: string[];
  v2LabelUpdates: Array<[string, string]>;
  authApplies: Array<[string, string]>;
  authRemovals: string[];
  idleWaits: string[];
  gracefulRestarts: string[];
  setUpgradeRunning: (running: boolean) => void;
  cacheClears: () => number;
  secretSets: Array<[string, string]>;
  sshAdds: Array<{ name: string; type: string; passphrase: string }>;
  sshDeletes: string[];
  gitConfigSets: Array<[string, string]>;
  ghDeviceStarts: () => number;
  ghLogouts: () => number;
  glabAdds: Array<{ hostname: string; token: string }>;
  glabRemoves: string[];
  glabTokenRotations: string[];
  projectCreates: string[];
  projectSetRemotes: Array<[string, string]>;
  projectEnables: string[];
  projectDisables: string[];
  projectFeatures: Array<[string, string]>;
  projectSyncs: Array<[string[], string[]]>;
  agentModelReads: string[];
  agentModelApplies: Array<{ agent: string; entries: FallbackModelEntry[] }>;
}

const STATUS_REPORT: StatusReport = {
  container_status: "running",
  uptime_seconds: 120,
  containers: {
    "ai-dev": { status: "running", uptime_seconds: 120, version: "1.2.3" },
    "ai-admin": { status: "running", uptime_seconds: 8450, version: "1.2.3" },
  },
  versions: { "AI-EngKit": "1.2.3" },
  gh_auth: "authenticated",
  glab_auth: "not authenticated",
  admin_version: "1.2.3",
  admin_version_mismatch: false,
  upgrade_state: "idle",
  upgrade_available: false,
  latest_version: "",
};

function commandEnvelope(id: string, payload: unknown): Envelope {
  return {
    type: MESSAGE_TYPES.command,
    payload,
    id,
    timestamp: FIXED_TIME,
  };
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {
    throw new Error("Deferred promise was not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function flushAsyncWork(): Promise<void> {
  // Key-command chains run 4+ awaits deep (auth-store read, apply, idle wait,
  // restart); flush enough microtask turns to drain the deepest chain.
  for (let turn = 0; turn < 16; turn += 1) {
    await Promise.resolve();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Expected query result payload to be a record");
  return value;
}

function expectSingleQueryResult(sent: Envelope[], id: string): unknown {
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: MESSAGE_TYPES.result, id });
  expect(sent.some((env) => env.type === MESSAGE_TYPES.ack)).toBe(false);
  return sent[0]?.payload;
}

function createFixture(overrides: Partial<CommandDeps> = {}): Fixture {
  let upgradeRunning = false;
  let cacheClearsCount = 0;
  let keySequence = 1;
  const sent: Envelope[] = [];
  const upgradeCalls: string[] = [];
  const restartAiDevCalls: string[] = [];
  const restartServices: string[] = [];
  const upserts: Array<[string, string]> = [];
  const queryReads: string[] = [];
  const registry: ProviderKeysFile = { providers: {} };
  const keyAdds: Array<{ provider: string; value: string; note: string }> = [];
  const setActiveCalls: Array<[string, string | null]> = [];
  const deleteCalls: Array<[string, string]> = [];
  const noteUpdates: Array<[string, string, string]> = [];
  const v2Credentials = new Map<string, Array<{ id: string; label: string }>>();
  const v2Activations: string[] = [];
  const v2Removals: string[] = [];
  const v2LabelUpdates: Array<[string, string]> = [];
  const authApplies: Array<[string, string]> = [];
  const authRemovals: string[] = [];
  const idleWaits: string[] = [];
  const gracefulRestarts: string[] = [];
  const secretSets: Array<[string, string]> = [];
  const sshAdds: Array<{ name: string; type: string; passphrase: string }> = [];
  const sshDeletes: string[] = [];
  const gitConfigSets: Array<[string, string]> = [];
  const glabAdds: Array<{ hostname: string; token: string }> = [];
  const glabRemoves: string[] = [];
  const glabTokenRotations: string[] = [];
  let ghDeviceStarts = 0;
  let ghLogouts = 0;
  const projectCreates: string[] = [];
  const projectSetRemotes: Array<[string, string]> = [];
  const projectEnables: string[] = [];
  const projectDisables: string[] = [];
  const projectFeatures: Array<[string, string]> = [];
  const projectSyncs: Array<[string[], string[]]> = [];
  const agentModelReads: string[] = [];
  const agentModelApplies: Array<{ agent: string; entries: FallbackModelEntry[] }> = [];
  const deps: CommandDeps = Object.assign(
    {
      isUpgradeRunning: () => upgradeRunning,
      runUpgrade: async () => {
        upgradeCalls.push("upgrade");
        return { success: true, message: "upgrade complete" };
      },
      restartAiDev: async () => {
        restartAiDevCalls.push("ai-dev");
        return { success: true, message: "reconfigured" };
      },
      restartContainer: async (service: string) => {
        restartServices.push(service);
        return { success: true, message: `${service} restarted` };
      },
      upsertEnvVar: (key: string, value: string) => {
        upserts.push([key, value]);
      },
      now: () => FIXED_TIME,
      isKeyProviderSupported: (provider: string) =>
        (KEY_MANAGED_PROVIDERS as readonly string[]).includes(provider),
      readProviderKeys: () => registry,
      addProviderKey: (provider: string, value: string, note = "") => {
        keyAdds.push({ provider, value, note });
        const entry = registry.providers[provider] ?? { keys: [], activeKeyId: null };
        const key: ProviderKey = { id: `k-${keySequence++}`, value, note, createdAt: FIXED_TIME };
        entry.keys.push(key);
        if (entry.activeKeyId === null) entry.activeKeyId = key.id;
        registry.providers[provider] = entry;
        return key;
      },
      setActiveProviderKey: (provider: string, keyId: string | null) => {
        setActiveCalls.push([provider, keyId]);
        const entry = registry.providers[provider];
        if (!entry || (keyId !== null && !entry.keys.some((candidate) => candidate.id === keyId))) return false;
        entry.activeKeyId = keyId;
        return true;
      },
      deleteProviderKey: (provider: string, keyId: string) => {
        deleteCalls.push([provider, keyId]);
        const entry = registry.providers[provider];
        if (!entry) return false;
        const idx = entry.keys.findIndex((candidate) => candidate.id === keyId);
        if (idx === -1) return false;
        entry.keys.splice(idx, 1);
        if (entry.activeKeyId === keyId) {
          entry.activeKeyId = entry.keys[Math.min(idx, entry.keys.length - 1)]?.id ?? null;
        }
        if (entry.keys.length === 0) delete registry.providers[provider];
        return true;
      },
      updateProviderKeyNote: (provider: string, keyId: string, note: string) => {
        noteUpdates.push([provider, keyId, note]);
        const key = registry.providers[provider]?.keys.find((candidate) => candidate.id === keyId);
        if (key === undefined) return false;
        key.note = note;
        return true;
      },
      applyActiveKey: async (provider: string, key: string) => {
        authApplies.push([provider, key]);
      },
      removeAuthKey: async (provider: string) => {
        authRemovals.push(provider);
      },
      clearProviderCache: async () => {
        cacheClearsCount += 1;
      },
      readProviderAuthSnapshot: async () => null,
      readV2Credentials: async () => v2Credentials,
      activateV2Credential: async (credentialId: string) => {
        v2Activations.push(credentialId);
      },
      removeV2Credential: async (credentialId: string) => {
        v2Removals.push(credentialId);
      },
      updateV2CredentialLabel: async (credentialId: string, label: string) => {
        v2LabelUpdates.push([credentialId, label]);
      },
      waitForIdleSessions: async (): Promise<IdleWaitOutcome> => {
        idleWaits.push("idle");
        return "idle";
      },
      gracefulRestartAiDev: async () => {
        gracefulRestarts.push("graceful");
        return { success: true, message: "ai-dev gracefully restarted" };
      },
      setSecret: (key: string, value: string) => {
        secretSets.push([key, value]);
        return key === "ADMIN_PASSWORD" ? "immediate" : "restart_required";
      },
      sshAddKey: async (name: string, type: string, passphrase: string) => {
        sshAdds.push({ name, type, passphrase });
        return { ok: true };
      },
      sshDeleteKey: async (name: string) => {
        sshDeletes.push(name);
        return { ok: true };
      },
      sshListKeys: async () => [{ name: "id_ed25519", fingerprint: "SHA256:abc", type: "Ed25519" }],
      gitSetConfig: async (key: string, value: string) => {
        gitConfigSets.push([key, value]);
        return { ok: true };
      },
      gitGetConfig: async () => ({ "user.name": "Test User", "user.email": "test@example.com" }),
      ghStartDeviceFlow: async () => {
        ghDeviceStarts += 1;
        return { device_code: "ABCD-1234", verification_uri: "https://github.com/login/device" };
      },
      ghLogout: async () => {
        ghLogouts += 1;
      },
      glabAddInstance: async (hostname: string, token: string) => {
        glabAdds.push({ hostname, token });
        return { ok: true };
      },
      glabRemoveInstance: async (hostname: string) => {
        glabRemoves.push(hostname);
      },
      glabListInstances: async () => [{ hostname: "gitlab.com", username: "alice", authenticated: true }],
      glabTokenRotate: async (hostname: string): Promise<GitLabRotationResult> => {
        glabTokenRotations.push(hostname);
        return { ok: true, rotated: true, expiresAt: "2026-09-09" };
      },
      projectCreate: async (name: string) => {
        projectCreates.push(name);
        return { ok: true };
      },
      projectSetRemote: async (name: string, remote: string) => {
        projectSetRemotes.push([name, remote]);
        return { ok: true };
      },
      projectEnable: async (name: string) => {
        projectEnables.push(name);
        return { ok: true };
      },
      projectDisable: async (name: string) => {
        projectDisables.push(name);
        return { ok: true };
      },
      projectEnableFeature: async (name: string, feature: string) => {
        projectFeatures.push([name, feature]);
        return { ok: true };
      },
      projectSync: async (add: string[], remove: string[]) => {
        projectSyncs.push([add, remove]);
        return { ok: true, messages: ["Added alpha to OpenChamber"] };
      },
      readAgentModelsState: async () => {
        agentModelReads.push("agent-models.list");
        return {
          agents: [
            {
              name: "general",
              configured: [],
              resolved: null,
              requestVerified: null,
              providerConnected: false,
              source: "plugin",
              invalid: false,
              effectiveness: "plugin",
            },
          ],
          catalog: ["anthropic/claude-sonnet-4-5"],
          hasPassword: true,
        };
      },
      applyAgentModel: async (agent: string, entries: FallbackModelEntry[]) => {
        agentModelApplies.push({ agent, entries });
        return {
          ok: true,
          status: entries.length === 0 ? "cleared" : "verified",
          resolved: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        };
      },
    },
    {
      readStatus: async () => {
        queryReads.push("status");
        return STATUS_REPORT;
      },
      readEnv: () => {
        queryReads.push("env.get");
        return {};
      },
      readProjects: async () => {
        queryReads.push("projects.list");
        return {};
      },
      readProviders: async () => {
        queryReads.push("providers.list");
        return { invalid: false, error: null, providers: [] };
      },
    },
    overrides,
  );
  return {
    deps,
    sender: { send: (env) => sent.push(env) },
    sent,
    upgradeCalls,
    restartAiDevCalls,
    restartServices,
    upserts,
    queryReads,
    registry,
    keyAdds,
    setActiveCalls,
    deleteCalls,
    noteUpdates,
    v2Credentials,
    v2Activations,
    v2Removals,
    v2LabelUpdates,
    authApplies,
    authRemovals,
    idleWaits,
    gracefulRestarts,
    setUpgradeRunning: (running) => {
      upgradeRunning = running;
    },
    cacheClears: () => cacheClearsCount,
    secretSets,
    sshAdds,
    sshDeletes,
    gitConfigSets,
    ghDeviceStarts: () => ghDeviceStarts,
    ghLogouts: () => ghLogouts,
    glabAdds,
    glabRemoves,
    glabTokenRotations,
    projectCreates,
    projectSetRemotes,
    projectEnables,
    projectDisables,
    projectFeatures,
    projectSyncs,
    agentModelReads,
    agentModelApplies,
  };
}

describe("command dispatcher", () => {
  test("rejects an unknown command type with the original id", () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("unknown-1", { type: "delete" }));

    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.error,
      id: "unknown-1",
      payload: { code: ERROR_CODES.unknown_command, message: "Unknown command type" },
    });
    expect(fixture.queryReads).toEqual([]);
  });

  test("returns one result and no acknowledgement for a status query", async () => {
    const fixture = createFixture({ readStatus: async () => STATUS_REPORT });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("status-1", { type: "status" }));
    await flushAsyncWork();

    expect(fixture.sent).toEqual([
      expect.objectContaining({ type: "result", id: "status-1", payload: STATUS_REPORT }),
    ]);
    expect(fixture.sent.some((env) => env.type === MESSAGE_TYPES.ack)).toBe(false);
  });

  test("redacts secret environment values in an env.get result", async () => {
    const fixture = createFixture({
      readEnv: () => ({
        ADMIN_PASSWORD: "supersecret123",
        OPENCODE_SERVER_PASSWORD: "sk-ant-abc...",
        OPENCODE_PROVIDER: "{}",
        SAFE_KEY: "hello",
      }),
    });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("env-1", { type: "env.get" }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toMatchObject({
      type: "result",
      id: "env-1",
      payload: {
        env: {
          ADMIN_PASSWORD: "••••••",
          OPENCODE_SERVER_PASSWORD: "••••••",
          OPENCODE_PROVIDER: "{}",
          SAFE_KEY: "hello",
        },
        redacted: ["ADMIN_PASSWORD", "OPENCODE_SERVER_PASSWORD"],
      },
    });
    expect(JSON.stringify(fixture.sent[0]?.payload)).not.toContain("supersecret123");
    expect(JSON.stringify(fixture.sent[0]?.payload)).not.toContain("sk-ant-abc");
    expect(fixture.sent.some((env) => env.type === MESSAGE_TYPES.ack)).toBe(false);
  });

  test("returns the project overview map for a projects.list query", async () => {
    const projects = {
      alpha: {
        features: { knowledge: true, maintenance: false, openspec: true, superpowers: false, "security-audit": false },
        remote: "https://example.com/alpha.git",
        disabled: false,
      },
    };
    const fixture = createFixture({ readProjects: async () => projects });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("projects-1", { type: "projects.list" }));
    await flushAsyncWork();

    expect(fixture.sent).toEqual([
      expect.objectContaining({ type: "result", id: "projects-1", payload: projects }),
    ]);
    expect(fixture.sent.some((env) => env.type === MESSAGE_TYPES.ack)).toBe(false);
  });

  test("strips raw provider keys from a providers.list result", async () => {
    const fixture = createFixture({
      readProviders: async () => ({
        invalid: false,
        error: null,
        providers: [{
          name: "anthropic",
          registry: {
            keys: [{ id: "key-1", value: "rawkey12345", note: "main", active: true }],
          },
        }],
      }),
    });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("providers-1", { type: "providers.list" }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toMatchObject({
      type: "result",
      id: "providers-1",
      payload: {
        providers: [{
          registry: {
            keys: [{ id: "key-1", masked: "rawk…2345", note: "main", active: true }],
          },
        }],
      },
    });
    expect(JSON.stringify(fixture.sent[0]?.payload)).not.toContain("rawkey12345");
    expect(fixture.sent.some((env) => env.type === MESSAGE_TYPES.ack)).toBe(false);
  });

  test("rejects malformed command payloads", () => {
    const malformedPayloads: unknown[] = [
      {},
      { type: "reconfigure" },
      { type: "restart" },
    ];

    for (const [index, payload] of malformedPayloads.entries()) {
      const fixture = createFixture();
      const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);
      const id = `malformed-${index}`;

      dispatcher.handle(commandEnvelope(id, payload));

      expect(fixture.sent).toHaveLength(1);
      expect(fixture.sent[0]).toMatchObject({
        type: MESSAGE_TYPES.error,
        id,
        payload: { code: ERROR_CODES.malformed_command, message: "Malformed command payload" },
      });
    }
  });

  test("sends an immediate upgrade acknowledgement before the final success", async () => {
    const completion = deferred<{ success: boolean; message?: string }>();
    const fixture = createFixture({ runUpgrade: () => completion.promise });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("upgrade-1", { type: "upgrade" }));

    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "upgrade-1",
      payload: { status: "success", message: "upgrade starting" },
    });

    completion.resolve({ success: true, message: "upgrade complete" });
    await flushAsyncWork();
    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "upgrade-1",
      payload: {
        status: "success",
        message: "upgrade complete",
        started_at: FIXED_TIME,
        finished_at: FIXED_TIME,
      },
    });
  });

  test("turns a thrown upgrade into a final failure acknowledgement", async () => {
    const fixture = createFixture({
      runUpgrade: async () => {
        throw new Error("upgrade exploded");
      },
    });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("upgrade-failure", { type: "upgrade" }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "upgrade-failure",
      payload: { status: "failure", message: "upgrade exploded" },
    });
  });

  test("writes every reconfiguration value and restarts ai-dev", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("reconfigure-1", {
      type: "reconfigure",
      env: { MODEL: "kimi", REGION: "us-east" },
    }));

    expect(fixture.upserts).toEqual([["MODEL", "kimi"], ["REGION", "us-east"]]);
    expect(fixture.restartAiDevCalls).toEqual(["ai-dev"]);
    expect(fixture.sent[0]).toMatchObject({
      id: "reconfigure-1",
      payload: { status: "success", message: "reconfiguring" },
    });
    await flushAsyncWork();
    expect(fixture.sent[1]).toMatchObject({
      id: "reconfigure-1",
      payload: { status: "success", message: "reconfigured" },
    });
  });

  test("sends the restart acknowledgement before invoking each known service", async () => {
    const order: string[] = [];
    const sent: Envelope[] = [];
    const fixture = createFixture({
      restartContainer: async (service) => {
        order.push(`restart:${service}`);
        return { success: true, message: `${service} restarted` };
      },
    });
    const sender: CommandSender = {
      send: (env) => {
        sent.push(env);
        order.push(`send:${env.id}`);
      },
    };
    const dispatcher = createCommandDispatcher(sender, fixture.deps);

    for (const service of ["ai-dev", "ai-admin"]) {
      const id = `restart-${service}`;
      const offset = order.length;
      dispatcher.handle(commandEnvelope(id, { type: "restart", service }));

      expect(order.slice(offset, offset + 2)).toEqual([`send:${id}`, `restart:${service}`]);
      expect(sent.at(-1)).toMatchObject({
        id,
        payload: { status: "success", message: `restarting ${service}` },
      });
      await flushAsyncWork();
    }
  });

  test("defers while upgrading then drains three commands in FIFO order with ids intact", async () => {
    const fixture = createFixture();
    fixture.setUpgradeRunning(true);
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);
    const commands = [
      commandEnvelope("queued-1", { type: "restart", service: "ai-dev" }),
      commandEnvelope("queued-2", { type: "restart", service: "ai-admin" }),
      commandEnvelope("queued-3", { type: "restart", service: "ai-dev" }),
    ];

    for (const command of commands) dispatcher.handle(command);

    expect(fixture.sent).toHaveLength(0);
    expect(fixture.restartServices).toHaveLength(0);
    expect(dispatcher.pendingCount()).toBe(3);

    fixture.setUpgradeRunning(false);
    dispatcher.drain();
    await flushAsyncWork();

    expect(dispatcher.pendingCount()).toBe(0);
    expect(fixture.restartServices).toEqual(["ai-dev", "ai-admin", "ai-dev"]);
    expect(fixture.sent.map((env) => env.id)).toEqual([
      "queued-1", "queued-2", "queued-3",
      "queued-1", "queued-2", "queued-3",
    ]);
  });

  test("defers a status query during upgrade and returns its result after draining", async () => {
    const fixture = createFixture({ readStatus: async () => STATUS_REPORT });
    fixture.setUpgradeRunning(true);
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("queued-status", { type: "status" }));

    expect(fixture.sent).toHaveLength(0);
    expect(dispatcher.pendingCount()).toBe(1);

    fixture.setUpgradeRunning(false);
    dispatcher.drain();
    await flushAsyncWork();

    expect(dispatcher.pendingCount()).toBe(0);
    expect(fixture.sent).toEqual([
      expect.objectContaining({ type: "result", id: "queued-status", payload: STATUS_REPORT }),
    ]);
  });
});

function seedKey(
  registry: ProviderKeysFile,
  provider: string,
  id: string,
  value: string,
  note = "main",
): void {
  const entry = registry.providers[provider] ?? { keys: [], activeKeyId: null };
  entry.keys.push({ id, value, note, createdAt: FIXED_TIME });
  if (entry.activeKeyId === null) entry.activeKeyId = id;
  registry.providers[provider] = entry;
}

describe("provider key commands", () => {
  test("rejects provider key commands for unsupported providers without side effects", () => {
    const unsupportedPayloads: unknown[] = [
      { type: "providers.key.add", provider: "anthropic", value: "sk-other" },
      { type: "providers.key.set-active", provider: "anthropic", keyId: "k-1" },
      { type: "providers.key.delete", provider: "anthropic", keyId: "k-1" },
      { type: "providers.key.update-note", provider: "anthropic", keyId: "k-1", note: "x" },
    ];

    for (const [index, payload] of unsupportedPayloads.entries()) {
      const fixture = createFixture();
      const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);
      const id = `unsupported-${index}`;

      dispatcher.handle(commandEnvelope(id, payload));

      expect(fixture.sent).toHaveLength(1);
      expect(fixture.sent[0]).toMatchObject({
        type: MESSAGE_TYPES.error,
        id,
        payload: { code: ERROR_CODES.malformed_command, message: "Malformed command payload" },
      });
    }

    const fixture = createFixture();
    expect(fixture.keyAdds).toEqual([]);
    expect(fixture.setActiveCalls).toEqual([]);
    expect(fixture.deleteCalls).toEqual([]);
    expect(fixture.noteUpdates).toEqual([]);
    expect(fixture.authApplies).toEqual([]);
    expect(fixture.restartAiDevCalls).toEqual([]);
  });

  test("rejects malformed provider key payloads without side effects", () => {
    const malformedPayloads: unknown[] = [
      { type: "providers.key.add", provider: "opencode-go" },
      { type: "providers.key.add", provider: "opencode-go", value: "" },
      { type: "providers.key.add", provider: "opencode-go", value: "  " },
      { type: "providers.key.add", provider: "opencode-go", value: "sk-1", note: 42 },
      { type: "providers.key.add", provider: "opencode-go", value: "sk-1", mode: "warp" },
      { type: "providers.key.add", provider: "", value: "sk-1" },
      { type: "providers.key.set-active", provider: "opencode-go" },
      { type: "providers.key.set-active", provider: "opencode-go", keyId: "" },
      { type: "providers.key.delete", provider: "opencode-go", keyId: 42 },
      { type: "providers.key.update-note", provider: "opencode-go", keyId: "k-1" },
      { type: "providers.key.update-note", provider: "opencode-go", keyId: "k-1", note: 42 },
    ];

    for (const [index, payload] of malformedPayloads.entries()) {
      const fixture = createFixture();
      const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);
      const id = `malformed-key-${index}`;

      dispatcher.handle(commandEnvelope(id, payload));

      expect(fixture.sent).toHaveLength(1);
      expect(fixture.sent[0]).toMatchObject({
        type: MESSAGE_TYPES.error,
        id,
        payload: { code: ERROR_CODES.malformed_command, message: "Malformed command payload" },
      });
    }

    const fixture = createFixture();
    expect(fixture.keyAdds).toEqual([]);
    expect(fixture.setActiveCalls).toEqual([]);
    expect(fixture.deleteCalls).toEqual([]);
    expect(fixture.noteUpdates).toEqual([]);
    expect(fixture.authApplies).toEqual([]);
    expect(fixture.restartAiDevCalls).toEqual([]);
  });

  test("adds a second key without applying or restarting", async () => {
    const fixture = createFixture();
    seedKey(fixture.registry, "opencode-go", "seed-1", "sk-ant-seed-one");
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("add-second", {
      type: "providers.key.add",
      provider: "opencode-go",
      value: RAW_KEY_MATERIAL,
      note: "backup",
    }));

    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "add-second",
      payload: { status: "success", message: "adding provider key" },
    });
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "add-second",
      payload: { status: "success", message: "provider key k-1 added" },
    });
    expect(fixture.keyAdds).toEqual([
      { provider: "opencode-go", value: RAW_KEY_MATERIAL, note: "backup" },
    ]);
    expect(fixture.registry.providers["opencode-go"]?.keys).toHaveLength(2);
    expect(fixture.registry.providers["opencode-go"]?.activeKeyId).toBe("seed-1");
    expect(fixture.authApplies).toEqual([]);
    expect(fixture.restartAiDevCalls).toEqual([]);
    expect(fixture.gracefulRestarts).toEqual([]);
    expect(JSON.stringify(fixture.sent)).not.toContain(RAW_KEY_MATERIAL);
  });

  test("applies and gracefully restarts when adding the provider's first key", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("add-first", {
      type: "providers.key.add",
      provider: "opencode-go",
      value: RAW_KEY_MATERIAL,
      note: "primary",
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "add-first",
      payload: {
        status: "success",
        message: "provider key k-1 added and applied (graceful restart)",
      },
    });
    expect(fixture.authApplies).toEqual([["opencode-go", RAW_KEY_MATERIAL]]);
    expect(fixture.idleWaits).toEqual(["idle"]);
    expect(fixture.gracefulRestarts).toEqual(["graceful"]);
    expect(fixture.restartAiDevCalls).toEqual([]);
    expect(fixture.registry.providers["opencode-go"]?.activeKeyId).toBe("k-1");
    expect(JSON.stringify(fixture.sent)).not.toContain(RAW_KEY_MATERIAL);
  });

  test("force mode recreates ai-dev immediately for a first key", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("add-force", {
      type: "providers.key.add",
      provider: "opencode-go",
      value: RAW_KEY_MATERIAL,
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "add-force",
      payload: {
        status: "success",
        message: "provider key k-1 added and applied (force restart)",
      },
    });
    expect(fixture.restartAiDevCalls).toEqual(["ai-dev"]);
    expect(fixture.gracefulRestarts).toEqual([]);
    expect(fixture.idleWaits).toEqual([]);
  });

  test("rejects a first key when the auth store already holds one", async () => {
    const fixture = createFixture({
      readProviderAuthSnapshot: async () => "sk-ant-existing",
    });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("add-collision", {
      type: "providers.key.add",
      provider: "opencode-go",
      value: RAW_KEY_MATERIAL,
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "add-collision",
      payload: {
        status: "failure",
        message: "provider opencode-go already holds a key in the ai-dev auth store; remove it before adding a registry key",
      },
    });
    expect(fixture.keyAdds).toEqual([]);
    expect(fixture.authApplies).toEqual([]);
    expect(fixture.restartAiDevCalls).toEqual([]);
    expect(JSON.stringify(fixture.sent)).not.toContain("sk-ant-existing");
  });

  test("rolls back the added key when applying the first key fails", async () => {
    const fixture = createFixture({
      applyActiveKey: async () => {
        throw new Error("auth store write failed");
      },
    });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("add-rollback", {
      type: "providers.key.add",
      provider: "opencode-go",
      value: RAW_KEY_MATERIAL,
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "add-rollback",
      payload: { status: "failure", message: "auth store write failed" },
    });
    expect(fixture.deleteCalls).toEqual([["opencode-go", "k-1"]]);
    expect(fixture.registry.providers["opencode-go"]).toBeUndefined();
    expect(fixture.authRemovals).toEqual(["opencode-go"]);
    expect(fixture.cacheClears()).toBe(1);
    expect(fixture.restartAiDevCalls).toEqual(["ai-dev"]);
    expect(JSON.stringify(fixture.sent)).not.toContain(RAW_KEY_MATERIAL);
  });

  test("rolls back the first key when restart throws", async () => {
    let restartCalls = 0;
    const fixture = createFixture({
      restartAiDev: async () => {
        restartCalls += 1;
        if (restartCalls === 1) throw new Error("restart crashed");
        return { success: true };
      },
    });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("add-restart-throws", {
      type: "providers.key.add",
      provider: "opencode-go",
      value: RAW_KEY_MATERIAL,
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "add-restart-throws",
      payload: { status: "failure", message: "restart crashed" },
    });
    expect(fixture.registry.providers["opencode-go"]).toBeUndefined();
    expect(fixture.authRemovals).toEqual(["opencode-go"]);
    expect(restartCalls).toBe(2);
  });

  test("persists the selection and restarts when setting an active key", async () => {
    const fixture = createFixture();
    seedKey(fixture.registry, "opencode-go", "seed-1", "sk-ant-seed-one");
    seedKey(fixture.registry, "opencode-go", "seed-2", "sk-ant-seed-two");
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("set-active", {
      type: "providers.key.set-active",
      provider: "opencode-go",
      keyId: "seed-2",
      mode: "force",
    }));

    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "set-active",
      payload: { status: "success", message: "setting active provider key" },
    });
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "set-active",
      payload: { status: "success", message: "provider key seed-2 set active (force restart)" },
    });
    expect(fixture.setActiveCalls).toEqual([["opencode-go", "seed-2"]]);
    expect(fixture.registry.providers["opencode-go"]?.activeKeyId).toBe("seed-2");
    expect(fixture.authApplies).toEqual([["opencode-go", "sk-ant-seed-two"]]);
    expect(fixture.restartAiDevCalls).toEqual(["ai-dev"]);
  });

  test("activates a v2 store credential unknown to the file registry", async () => {
    const fixture = createFixture();
    fixture.v2Credentials.set("opencode-go", [
      { id: "cred-aaa", label: "work" },
      { id: "cred-bbb", label: "home" },
    ]);
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("set-active-v2", {
      type: "providers.key.set-active",
      provider: "opencode-go",
      keyId: "cred-bbb",
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "set-active-v2",
      payload: { status: "success", message: "provider key cred-bbb is active (force restart)" },
    });
    expect(fixture.v2Activations).toEqual(["cred-bbb"]);
    expect(fixture.restartAiDevCalls).toEqual(["ai-dev"]);
    expect(fixture.setActiveCalls).toEqual([]);
    expect(fixture.authApplies).toEqual([]);
  });

  test("no-ops when the v2 credential is already active", async () => {
    const fixture = createFixture();
    fixture.v2Credentials.set("opencode-go", [{ id: "cred-aaa", label: "work" }]);
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("set-active-v2-again", {
      type: "providers.key.set-active",
      provider: "opencode-go",
      keyId: "cred-aaa",
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.sent[fixture.sent.length - 1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      payload: { status: "success", message: "provider key cred-aaa is already active" },
    });
    expect(fixture.v2Activations).toEqual([]);
    expect(fixture.restartAiDevCalls).toEqual([]);
  });

  test("reports failure and rolls back when v2 activation fails", async () => {
    const fixture = createFixture({
      activateV2Credential: async (credentialId: string) => {
        if (credentialId === "cred-bad") throw new Error("credential.activate failed");
      },
    });
    fixture.v2Credentials.set("opencode-go", [
      { id: "cred-ok", label: "good" },
      { id: "cred-bad", label: "bad" },
    ]);
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("set-active-v2-fail", {
      type: "providers.key.set-active",
      provider: "opencode-go",
      keyId: "cred-bad",
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.sent[fixture.sent.length - 1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      payload: { status: "failure", message: "credential.activate failed" },
    });
  });

  test("deletes a v2 store credential unknown to the file registry", async () => {
    const fixture = createFixture();
    fixture.v2Credentials.set("opencode-go", [{ id: "cred-aaa", label: "work" }]);
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("delete-v2", {
      type: "providers.key.delete",
      provider: "opencode-go",
      keyId: "cred-aaa",
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.sent[fixture.sent.length - 1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "delete-v2",
      payload: { status: "success", message: "provider key cred-aaa deleted (force restart)" },
    });
    expect(fixture.v2Removals).toEqual(["cred-aaa"]);
    expect(fixture.deleteCalls).toEqual([]);
  });

  test("updates a v2 credential label unknown to the file registry", async () => {
    const fixture = createFixture();
    fixture.v2Credentials.set("opencode-go", [{ id: "cred-aaa", label: "work" }]);
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("note-v2", {
      type: "providers.key.update-note",
      provider: "opencode-go",
      keyId: "cred-aaa",
      note: "new label",
    }));
    await flushAsyncWork();

    expect(fixture.sent[fixture.sent.length - 1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      payload: { status: "success", message: "note updated for provider key cred-aaa" },
    });
    expect(fixture.v2LabelUpdates).toEqual([["cred-aaa", "new label"]]);
    expect(fixture.noteUpdates).toEqual([]);
  });

  test("rejects an unknown key id that is in neither store", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("unknown-v2", {
      type: "providers.key.set-active",
      provider: "opencode-go",
      keyId: "cred-nope",
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.error,
      payload: { code: ERROR_CODES.malformed_command },
    });
    expect(fixture.v2Activations).toEqual([]);
    expect(fixture.restartAiDevCalls).toEqual([]);
  });

  test("no-ops when the named key is already active", async () => {
    const fixture = createFixture();
    seedKey(fixture.registry, "opencode-go", "seed-1", "sk-ant-seed-one");
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("set-active-again", {
      type: "providers.key.set-active",
      provider: "opencode-go",
      keyId: "seed-1",
    }));

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "set-active-again",
      payload: { status: "success", message: "provider key already active" },
    });
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "set-active-again",
      payload: { status: "success", message: "provider key seed-1 is already active" },
    });
    expect(fixture.setActiveCalls).toEqual([]);
    expect(fixture.authApplies).toEqual([]);
    expect(fixture.restartAiDevCalls).toEqual([]);
  });

  test("restores the actual auth key and registry selection when restart fails", async () => {
    let restartCalls = 0;
    const fixture = createFixture({
      readProviderAuthSnapshot: async () => "sk-runtime-before",
      restartAiDev: async () => {
        restartCalls += 1;
        return restartCalls === 1
          ? { success: false, message: "compose recreate failed" }
          : { success: true };
      },
    });
    seedKey(fixture.registry, "opencode-go", "seed-1", "sk-ant-seed-one");
    seedKey(fixture.registry, "opencode-go", "seed-2", "sk-ant-seed-two");
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("set-active-revert", {
      type: "providers.key.set-active",
      provider: "opencode-go",
      keyId: "seed-2",
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "set-active-revert",
      payload: { status: "failure", message: "compose recreate failed" },
    });
    expect(fixture.setActiveCalls).toEqual([
      ["opencode-go", "seed-2"],
      ["opencode-go", "seed-1"],
    ]);
    expect(fixture.registry.providers["opencode-go"]?.activeKeyId).toBe("seed-1");
    expect(fixture.authApplies).toEqual([
      ["opencode-go", "sk-ant-seed-two"],
      ["opencode-go", "sk-runtime-before"],
    ]);
    expect(restartCalls).toBe(2);
  });

  test("reports incomplete rollback when restoring the actual auth key fails", async () => {
    let applyCalls = 0;
    let restartCalls = 0;
    const fixture = createFixture({
      readProviderAuthSnapshot: async () => "sk-runtime-before",
      applyActiveKey: async () => {
        applyCalls += 1;
        if (applyCalls === 2) throw new Error("restore failed");
      },
      restartAiDev: async () => {
        restartCalls += 1;
        if (restartCalls === 2) throw new Error("rollback restart threw");
        return { success: false, message: "compose recreate failed" };
      },
    });
    seedKey(fixture.registry, "opencode-go", "seed-1", "sk-ant-seed-one");
    seedKey(fixture.registry, "opencode-go", "seed-2", "sk-ant-seed-two");
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("set-active-rollback-fails", {
      type: "providers.key.set-active",
      provider: "opencode-go",
      keyId: "seed-2",
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "set-active-rollback-fails",
      payload: {
        status: "failure",
        message: "compose recreate failed; rollback incomplete: runtime auth restore failed, rollback restart failed",
      },
    });
    expect(fixture.registry.providers["opencode-go"]?.activeKeyId).toBe("seed-1");
    expect(restartCalls).toBe(2);
  });

  test("restores an empty registry selection and absent auth key after restart failure", async () => {
    let restartCalls = 0;
    const fixture = createFixture({
      readProviderAuthSnapshot: async () => null,
      restartAiDev: async () => {
        restartCalls += 1;
        return restartCalls === 1
          ? { success: false, message: "compose recreate failed" }
          : { success: true };
      },
    });
    seedKey(fixture.registry, "opencode-go", "seed-1", "sk-ant-seed-one");
    const entry = fixture.registry.providers["opencode-go"];
    if (entry === undefined) throw new Error("Expected seeded provider entry");
    entry.activeKeyId = null;
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("set-active-from-empty", {
      type: "providers.key.set-active",
      provider: "opencode-go",
      keyId: "seed-1",
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.registry.providers["opencode-go"]?.activeKeyId).toBeNull();
    expect(fixture.authRemovals).toEqual(["opencode-go"]);
    expect(fixture.cacheClears()).toBe(1);
    expect(fixture.setActiveCalls).toEqual([
      ["opencode-go", "seed-1"],
      ["opencode-go", null],
    ]);
  });

  test("promotes and applies the next key when deleting the active key", async () => {
    const fixture = createFixture();
    seedKey(fixture.registry, "opencode-go", "seed-1", "sk-ant-seed-one");
    seedKey(fixture.registry, "opencode-go", "seed-2", "sk-ant-seed-two");
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("delete-active", {
      type: "providers.key.delete",
      provider: "opencode-go",
      keyId: "seed-1",
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "delete-active",
      payload: {
        status: "success",
        message: "provider key seed-1 deleted, key seed-2 promoted (force restart)",
      },
    });
    expect(fixture.deleteCalls).toEqual([["opencode-go", "seed-1"]]);
    expect(fixture.registry.providers["opencode-go"]?.activeKeyId).toBe("seed-2");
    expect(fixture.authApplies).toEqual([["opencode-go", "sk-ant-seed-two"]]);
    expect(fixture.restartAiDevCalls).toEqual(["ai-dev"]);
  });

  test("removes the auth entry and cache when deleting the last key", async () => {
    const fixture = createFixture();
    seedKey(fixture.registry, "opencode-go", "seed-1", "sk-ant-seed-one");
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("delete-last", {
      type: "providers.key.delete",
      provider: "opencode-go",
      keyId: "seed-1",
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "delete-last",
      payload: {
        status: "success",
        message: "provider key seed-1 deleted, auth entry removed (force restart)",
      },
    });
    expect(fixture.authRemovals).toEqual(["opencode-go"]);
    expect(fixture.cacheClears()).toBe(1);
    expect(fixture.restartAiDevCalls).toEqual(["ai-dev"]);
    expect(fixture.registry.providers["opencode-go"]).toBeUndefined();
  });

  test("deletes a non-active key without applying or restarting", async () => {
    const fixture = createFixture();
    seedKey(fixture.registry, "opencode-go", "seed-1", "sk-ant-seed-one");
    seedKey(fixture.registry, "opencode-go", "seed-2", "sk-ant-seed-two");
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("delete-inactive", {
      type: "providers.key.delete",
      provider: "opencode-go",
      keyId: "seed-2",
      mode: "force",
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "delete-inactive",
      payload: { status: "success", message: "provider key seed-2 deleted" },
    });
    expect(fixture.deleteCalls).toEqual([["opencode-go", "seed-2"]]);
    expect(fixture.registry.providers["opencode-go"]?.activeKeyId).toBe("seed-1");
    expect(fixture.registry.providers["opencode-go"]?.keys).toHaveLength(1);
    expect(fixture.authApplies).toEqual([]);
    expect(fixture.restartAiDevCalls).toEqual([]);
  });

  test("rejects set-active, delete, and update-note for unknown key ids", async () => {
    const unknownIdPayloads: unknown[] = [
      { type: "providers.key.set-active", provider: "opencode-go", keyId: "seed-1" },
      { type: "providers.key.delete", provider: "opencode-go", keyId: "seed-1" },
      { type: "providers.key.update-note", provider: "opencode-go", keyId: "seed-1", note: "x" },
    ];

    for (const [index, payload] of unknownIdPayloads.entries()) {
      const fixture = createFixture();
      const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);
      const id = `unknown-id-${index}`;

      dispatcher.handle(commandEnvelope(id, payload));
      // Unknown ids fall through to the async v2-store check before rejection.
      await flushAsyncWork();

      expect(fixture.sent).toHaveLength(1);
      expect(fixture.sent[0]).toMatchObject({
        type: MESSAGE_TYPES.error,
        id,
        payload: { code: ERROR_CODES.malformed_command, message: "Malformed command payload" },
      });
    }
  });

  test("updates a key note without applying or restarting", async () => {
    const fixture = createFixture();
    seedKey(fixture.registry, "opencode-go", "seed-1", "sk-ant-seed-one");
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("update-note", {
      type: "providers.key.update-note",
      provider: "opencode-go",
      keyId: "seed-1",
      note: "rotated 2026-08",
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "update-note",
      payload: { status: "success", message: "note updated for provider key seed-1" },
    });
    expect(fixture.noteUpdates).toEqual([["opencode-go", "seed-1", "rotated 2026-08"]]);
    expect(fixture.registry.providers["opencode-go"]?.keys[0]?.note).toBe("rotated 2026-08");
    expect(fixture.authApplies).toEqual([]);
    expect(fixture.restartAiDevCalls).toEqual([]);
    expect(fixture.gracefulRestarts).toEqual([]);
  });

  test("defers provider key commands while upgrading and drains them in FIFO order", async () => {
    const fixture = createFixture();
    seedKey(fixture.registry, "opencode-go", "seed-1", "sk-ant-seed-one");
    fixture.setUpgradeRunning(true);
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);
    const commands = [
      commandEnvelope("queued-set-active", {
        type: "providers.key.set-active",
        provider: "opencode-go",
        keyId: "seed-1",
      }),
      commandEnvelope("queued-note", {
        type: "providers.key.update-note",
        provider: "opencode-go",
        keyId: "seed-1",
        note: "primary",
      }),
      commandEnvelope("queued-add", {
        type: "providers.key.add",
        provider: "opencode-go",
        value: RAW_KEY_MATERIAL,
      }),
    ];

    for (const command of commands) dispatcher.handle(command);

    expect(fixture.sent).toHaveLength(3);
    for (const id of ["queued-set-active", "queued-note", "queued-add"]) {
      expect(fixture.sent.find((env) => env.id === id)).toMatchObject({
        type: MESSAGE_TYPES.ack,
        id,
        payload: { status: "success", message: "provider key command queued until upgrade completes" },
      });
    }
    expect(dispatcher.pendingCount()).toBe(3);

    fixture.setUpgradeRunning(false);
    dispatcher.drain();
    await flushAsyncWork();

    expect(dispatcher.pendingCount()).toBe(0);
    expect(fixture.keyAdds).toEqual([{ provider: "opencode-go", value: RAW_KEY_MATERIAL, note: "" }]);
    expect(fixture.noteUpdates).toEqual([["opencode-go", "seed-1", "primary"]]);
    expect(fixture.setActiveCalls).toEqual([]);
    expect(fixture.authApplies).toEqual([]);
    expect(fixture.gracefulRestarts).toEqual([]);
    for (const id of ["queued-set-active", "queued-note", "queued-add"]) {
      const acks = fixture.sent.filter((env) => env.id === id);
      expect(acks).toHaveLength(3);
      expect(acks[0]).toMatchObject({ type: MESSAGE_TYPES.ack, id });
      expect(acks[1]).toMatchObject({ type: MESSAGE_TYPES.ack, id });
      expect(acks[2]).toMatchObject({ type: MESSAGE_TYPES.ack, id });
    }
    expect(JSON.stringify(fixture.sent)).not.toContain(RAW_KEY_MATERIAL);
  });

  test("rejects a malformed provider key command before acknowledging it during upgrade", () => {
    const fixture = createFixture();
    fixture.setUpgradeRunning(true);
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("invalid-queued-add", {
      type: "providers.key.add",
      provider: "opencode-go",
    }));

    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.error,
      id: "invalid-queued-add",
      payload: { code: ERROR_CODES.malformed_command, message: "Malformed command payload" },
    });
    expect(dispatcher.pendingCount()).toBe(0);
  });
});

describe("graceful restart", () => {
  test("returns idle immediately when the probe reports idle", async () => {
    expect(await waitForIdleSessions(async () => true, 1_000, 1, 3)).toBe("idle");
  });

  test("keeps polling while sessions are busy", async () => {
    const states = [false, true];
    let index = 0;
    const probe = async () => states[index++];

    expect(await waitForIdleSessions(probe, 1_000, 1, 3)).toBe("idle");
    expect(index).toBe(2);
  });

  test("times out when sessions stay busy past the deadline", async () => {
    expect(await waitForIdleSessions(async () => false, 5, 1, 3)).toBe("timeout");
  });

  test("gives up early when the probe is unavailable", async () => {
    expect(await waitForIdleSessions(async () => null, 60_000, 1, 3)).toBe("unavailable");
  });

  test("resets the failure counter when a probe recovers", async () => {
    const states: Array<boolean | null> = [null, null, true];
    let index = 0;
    const probe = async () => states[index++];

    expect(await waitForIdleSessions(probe, 60_000, 1, 3)).toBe("idle");
    expect(index).toBe(3);
  });

  test("falls back to a force restart after a graceful-wait timeout", async () => {
    const fixture = createFixture({
      waitForIdleSessions: async () => "timeout",
    });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("add-timeout", {
      type: "providers.key.add",
      provider: "opencode-go",
      value: RAW_KEY_MATERIAL,
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "add-timeout",
      payload: {
        status: "success",
        message: "provider key k-1 added and applied (force restart after graceful-wait timeout)",
      },
    });
    expect(fixture.restartAiDevCalls).toEqual(["ai-dev"]);
    expect(fixture.gracefulRestarts).toEqual([]);
  });

  test("falls back to a force restart when the control API is unavailable", async () => {
    const fixture = createFixture({
      waitForIdleSessions: async () => "unavailable",
    });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("add-unavailable", {
      type: "providers.key.add",
      provider: "opencode-go",
      value: RAW_KEY_MATERIAL,
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "add-unavailable",
      payload: {
        status: "success",
        message: "provider key k-1 added and applied (force restart after unavailable control API)",
      },
    });
    expect(fixture.restartAiDevCalls).toEqual(["ai-dev"]);
    expect(fixture.gracefulRestarts).toEqual([]);
  });

  test("reports a failed graceful restart and rolls back the added key", async () => {
    const fixture = createFixture({
      gracefulRestartAiDev: async () => ({ success: false, message: "graceful restart failed" }),
    });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("add-graceful-fail", {
      type: "providers.key.add",
      provider: "opencode-go",
      value: RAW_KEY_MATERIAL,
    }));
    await flushAsyncWork();

    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "add-graceful-fail",
      payload: { status: "failure", message: "graceful restart failed" },
    });
    expect(fixture.deleteCalls).toEqual([["opencode-go", "k-1"]]);
    expect(fixture.registry.providers["opencode-go"]).toBeUndefined();
    expect(fixture.authRemovals).toEqual(["opencode-go"]);
    expect(fixture.restartAiDevCalls).toEqual(["ai-dev"]);
  });
});

describe("query result contracts", () => {
  test("production query dependencies reuse shared read-only helpers", async () => {
    const overviews = await collectProjectOverviews(
      async (command: string) => {
        if (command.startsWith("find ")) return { exitCode: 0, stdout: "alpha\n", stderr: "" };
        if (command.includes("docs/knowledge/README.md")) {
          return { exitCode: 0, stdout: "yes\n", stderr: "" };
        }
        if (command.includes("git remote get-url origin")) {
          return { exitCode: 0, stdout: "https://example.com/alpha.git\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      "/workspace",
      "/settings.json",
      "/disabled-projects.json",
    );
    const deps = createRealCommandDeps();

    expect(typeof collectStatus).toBe("function");
    // StatusResponse pins container_status, uptime_seconds, restart_count,
    // gh_auth, glab_auth, git_user, project_count, admin_version, and admin_version_mismatch.
    expect(typeof readEnvFile).toBe("function");
    expect(typeof collectProjectOverviews).toBe("function");
    expect(typeof collectProvidersMeta).toBe("function");
    expect(overviews).toEqual([{
      name: "alpha",
      features: { knowledge: true, maintenance: false, openspec: false, superpowers: false, "security-audit": false },
      remote: "https://example.com/alpha.git",
      disabled: false,
    }]);
    expect(deps.readEnv).toBe(readEnvFile);
    expect(deps.readProviders).toBe(collectProvidersMeta);
    expect(typeof deps.readProjects).toBe("function");
    expect(typeof deps.readStatus).toBe("function");
  });

  test("status result pins its schema and query correlation", async () => {
    const fixture = createFixture({ readStatus: async () => STATUS_REPORT });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("status-schema", { type: "status" }));
    await flushAsyncWork();

    const payload = expectSingleQueryResult(fixture.sent, "status-schema");
    expect(payload).toEqual(STATUS_REPORT);
    expect(Object.keys(requireRecord(payload)).sort()).toEqual([
      "admin_version",
      "admin_version_mismatch",
      "container_status",
      "containers",
      "gh_auth",
      "glab_auth",
      "latest_version",
      "upgrade_available",
      "upgrade_state",
      "uptime_seconds",
      "versions",
    ].sort());
  });

  test("env.get redacts every password schema key and pins its result schema", async () => {
    const passwordValues = Object.fromEntries(
      PASSWORD_KEYS.map((key) => [key, `${key}-super-secret-value-12345`]),
    );
    const source: Record<string, string> = {
      ...passwordValues,
      PROVIDER_KEY_HINT: RAW_KEY_MATERIAL,
      WORKSPACE_PATH: "/home/devuser/workspace",
      FEATURE_DISABLED: "false",
    };
    const fixture = createFixture({ readEnv: () => source });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("env-schema", { type: "env.get" }));
    await flushAsyncWork();

    const payload = requireRecord(expectSingleQueryResult(fixture.sent, "env-schema"));
    const env = requireRecord(payload["env"]);
    const serialized = JSON.stringify(payload);
    expect(Object.keys(payload).sort()).toEqual(["env", "redacted"]);
    expect(env).toMatchObject({
      WORKSPACE_PATH: "/home/devuser/workspace",
      FEATURE_DISABLED: "false",
    });
    expect(payload["redacted"]).toEqual([...PASSWORD_KEYS, "PROVIDER_KEY_HINT"]);
    for (const key of PASSWORD_KEYS) {
      const rawValue = source[key];
      expect(env[key]).not.toBe(rawValue);
      expect(serialized).not.toContain(rawValue);
    }
    expect(env["PROVIDER_KEY_HINT"]).not.toBe(RAW_KEY_MATERIAL);
    expect(serialized).not.toContain(RAW_KEY_MATERIAL);
  });

  test("projects.list pins the project overview schema and query correlation", async () => {
    const projects = {
      alpha: {
        features: { knowledge: true, maintenance: false, openspec: true, superpowers: false, "security-audit": false },
        remote: "https://example.com/alpha.git",
        disabled: false,
      },
    };
    const fixture = createFixture({ readProjects: async () => projects });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("projects-schema", { type: "projects.list" }));
    await flushAsyncWork();

    const payload = expectSingleQueryResult(fixture.sent, "projects-schema");
    expect(payload).toEqual(projects);
    expect(Object.keys(requireRecord(payload))).toEqual(["alpha"]);
  });

  test("providers.list pins sanitized provider fields and query correlation", async () => {
    const providers = {
      invalid: false,
      error: null,
      providers: [{
        name: "anthropic",
        label: "Anthropic",
        npm: "@ai-sdk/anthropic",
        baseURL: "https://api.anthropic.com",
        hasApiKey: true,
        keyManagement: true,
        authStoreKeyPresent: true,
        virtual: false,
        registry: {
          keyCount: 1,
          activeKeyId: "key-1",
          keys: [{
            id: "key-1",
            value: RAW_KEY_MATERIAL,
            masked: "stale-mask",
            note: "main",
            active: true,
          }],
        },
      }],
    };
    const fixture = createFixture({ readProviders: async () => providers });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("providers-schema", { type: "providers.list" }));
    await flushAsyncWork();

    const payload = expectSingleQueryResult(fixture.sent, "providers-schema");
    expect(payload).toEqual({
      invalid: false,
      error: null,
      providers: [{
        name: "anthropic",
        label: "Anthropic",
        npm: "@ai-sdk/anthropic",
        baseURL: "https://api.anthropic.com",
        hasApiKey: true,
        keyManagement: true,
        authStoreKeyPresent: true,
        virtual: false,
        registry: {
          keyCount: 1,
          activeKeyId: "key-1",
          keys: [{ id: "key-1", masked: "sk-a…mnop", note: "main", active: true }],
        },
      }],
    });
    expect(JSON.stringify(payload)).not.toContain(RAW_KEY_MATERIAL);
  });

  const keyMaterialCases: ReadonlyArray<{
    name: string;
    query: QueryName;
    overrides: Partial<CommandDeps>;
  }> = [
    {
      name: "status",
      query: "status",
      overrides: {
        readStatus: async () => ({ ...STATUS_REPORT, versions: { Center: RAW_KEY_MATERIAL } }),
      },
    },
    {
      name: "projects.list",
      query: "projects.list",
      overrides: {
        readProjects: async () => ({
          alpha: {
            features: { knowledge: true, maintenance: false, openspec: false, superpowers: false, "security-audit": false },
            remote: `https://example.com/alpha.git?token=${RAW_KEY_MATERIAL}`,
            disabled: false,
          },
        }),
      },
    },
    {
      name: "providers.list",
      query: "providers.list",
      overrides: {
        readProviders: async () => ({
          providers: [{
            name: "anthropic",
            registry: {
              keys: [{ id: "key-1", value: RAW_KEY_MATERIAL, note: "main", active: true }],
            },
          }],
        }),
      },
    },
  ];

  for (const keyMaterialCase of keyMaterialCases) {
    test(`${keyMaterialCase.name} result contains no raw key material`, async () => {
      const fixture = createFixture(keyMaterialCase.overrides);
      const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);
      const id = `${keyMaterialCase.name}-no-key-material`;

      dispatcher.handle(commandEnvelope(id, { type: keyMaterialCase.query }));
      await flushAsyncWork();

      const payload = expectSingleQueryResult(fixture.sent, id);
      expect(JSON.stringify(payload)).not.toContain(RAW_KEY_MATERIAL);
    });
  }

  test("secrets.set writes a schema password key and reports activation status", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("secrets-1", { type: "secrets.set", key: "OPENCHAMBER_UI_PASSWORD", value: "hunter2secret" }));
    await flushAsyncWork();

    expect(fixture.secretSets).toEqual([["OPENCHAMBER_UI_PASSWORD", "hunter2secret"]]);
    expect(fixture.sent).toEqual([
      expect.objectContaining({
        type: MESSAGE_TYPES.ack,
        id: "secrets-1",
        payload: expect.objectContaining({
          status: "success",
          message: expect.stringContaining("OPENCHAMBER_UI_PASSWORD updated (restart_required activation)"),
        }),
      }),
    ]);
    expect(JSON.stringify(fixture.sent)).not.toContain("hunter2secret");
  });

  test("secrets.set rejects an unknown key or empty value as malformed", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("secrets-bad-key", { type: "secrets.set", key: "UNKNOWN_KEY", value: "x" }));
    dispatcher.handle(commandEnvelope("secrets-bad-value", { type: "secrets.set", key: "ADMIN_PASSWORD", value: "" }));
    await flushAsyncWork();

    expect(fixture.secretSets).toEqual([]);
    expect(fixture.sent.every((env) => env.type === MESSAGE_TYPES.error)).toBe(true);
    expect(fixture.sent.every((env) => (env.payload as { code?: string })?.code === ERROR_CODES.malformed_command)).toBe(true);
  });

  test("ssh.key.add generates a key and registers it", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("ssh-add-1", { type: "ssh.key.add", name: "deploy", keyType: "ed25519" }));
    await flushAsyncWork();

    expect(fixture.sshAdds).toEqual([{ name: "deploy", type: "ed25519", passphrase: "" }]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "ssh-add-1",
      payload: { status: "success", message: "SSH key deploy added" },
    });
  });

  test("ssh.key.add rejects an unsafe key name", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("ssh-bad", { type: "ssh.key.add", name: "../../tmp/evil" }));
    await flushAsyncWork();

    expect(fixture.sshAdds).toEqual([]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.error,
      id: "ssh-bad",
      payload: { code: ERROR_CODES.malformed_command },
    });
  });

  test("ssh.key.delete removes the named key", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("ssh-del-1", { type: "ssh.key.delete", name: "deploy" }));
    await flushAsyncWork();

    expect(fixture.sshDeletes).toEqual(["deploy"]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "ssh-del-1",
      payload: { status: "success", message: "SSH key deploy deleted" },
    });
  });

  test("git.config.set updates the global git config", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("git-set-1", { type: "git.config.set", key: "user.email", value: "dev@example.com" }));
    await flushAsyncWork();

    expect(fixture.gitConfigSets).toEqual([["user.email", "dev@example.com"]]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "git-set-1",
      payload: { status: "success", message: "git config user.email updated" },
    });
  });

  test("git.config.set rejects a missing value", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("git-bad", { type: "git.config.set", key: "user.name" }));
    await flushAsyncWork();

    expect(fixture.gitConfigSets).toEqual([]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.error,
      payload: { code: ERROR_CODES.malformed_command },
    });
  });

  test("gh.auth.start ack carries the device flow data and starts no query result", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("gh-start-1", { type: "gh.auth.start" }));
    await flushAsyncWork();

    expect(fixture.ghDeviceStarts()).toBe(1);
    expect(fixture.sent).toEqual([
      expect.objectContaining({
        type: MESSAGE_TYPES.ack,
        id: "gh-start-1",
        payload: expect.objectContaining({
          status: "success",
          data: { device_code: "ABCD-1234", verification_uri: "https://github.com/login/device" },
        }),
      }),
    ]);
    expect(fixture.sent.some((env) => env.type === MESSAGE_TYPES.result)).toBe(false);
  });

  test("gh.auth.logout disconnects GitHub", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("gh-logout-1", { type: "gh.auth.logout" }));
    await flushAsyncWork();

    expect(fixture.ghLogouts()).toBe(1);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "gh-logout-1",
      payload: { status: "success", message: "GitHub disconnected" },
    });
  });

  test("glab.instance.add connects an instance without echoing the token", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("glab-add-1", { type: "glab.instance.add", hostname: "gitlab.example.com", token: "glpat-secret-token-xyz" }));
    await flushAsyncWork();

    expect(fixture.glabAdds).toEqual([{ hostname: "gitlab.example.com", token: "glpat-secret-token-xyz" }]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "glab-add-1",
      payload: { status: "success", message: "GitLab instance gitlab.example.com connected" },
    });
    expect(JSON.stringify(fixture.sent)).not.toContain("token");
  });

  test("glab.instance.add rejects a missing token", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("glab-bad", { type: "glab.instance.add", hostname: "gitlab.com" }));
    await flushAsyncWork();

    expect(fixture.glabAdds).toEqual([]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.error,
      payload: { code: ERROR_CODES.malformed_command },
    });
  });

  test("glab.instance.remove logs out of the named instance", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("glab-rm-1", { type: "glab.instance.remove", hostname: "gitlab.example.com" }));
    await flushAsyncWork();

    expect(fixture.glabRemoves).toEqual(["gitlab.example.com"]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "glab-rm-1",
      payload: { status: "success", message: "GitLab instance gitlab.example.com removed" },
    });
  });

  test("glab.token.rotate returns a redacted rotation acknowledgement", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("glab-rotate-1", { type: "glab.token.rotate", hostname: "gitlab.example.com" }));
    await flushAsyncWork();

    expect(fixture.glabTokenRotations).toEqual(["gitlab.example.com"]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "glab-rotate-1",
      payload: {
        status: "success",
        data: { ok: true, hostname: "gitlab.example.com", rotated: true },
      },
    });
    expect(JSON.stringify(fixture.sent)).not.toContain("glpat-secret-token-xyz");
  });

  test("glab.token.rotate rejects payloads that are not hostname-only", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("glab-rotate-bad", {
      type: "glab.token.rotate",
      hostname: "gitlab.example.com",
      token: "unexpected-field",
    }));
    await flushAsyncWork();

    expect(fixture.glabTokenRotations).toEqual([]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.error,
      payload: { code: ERROR_CODES.malformed_command },
    });
    expect(JSON.stringify(fixture.sent)).not.toContain("unexpected-field");
  });

  for (const errorCode of [
    "invalid_expired",
    "insufficient_scope",
    "unsupported_version",
    "impersonation_unconfirmed",
    "persistence_failed",
    "ambiguous_rotation",
    "unreachable",
  ] as const) {
    test(`glab.token.rotate returns stable error code ${errorCode}`, async () => {
      const fixture = createFixture({
        glabTokenRotate: async (): Promise<GitLabRotationResult> => ({ ok: false, code: errorCode }),
      });
      const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

      dispatcher.handle(commandEnvelope(`glab-rotate-${errorCode}`, {
        type: "glab.token.rotate",
        hostname: "gitlab.example.com",
      }));
      await flushAsyncWork();

      expect(fixture.sent[0]).toMatchObject({
        type: MESSAGE_TYPES.ack,
        payload: {
          status: "failure",
          data: { ok: false, hostname: "gitlab.example.com", rotated: false, errorCode },
        },
      });
      expect(JSON.stringify(fixture.sent)).not.toContain('"token"');
    });
  }

  test("git.config.get returns the sanitized config as a query result", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("git-get-1", { type: "git.config.get" }));
    await flushAsyncWork();

    const payload = expectSingleQueryResult(fixture.sent, "git-get-1");
    expect(payload).toEqual({ "user.name": "Test User", "user.email": "test@example.com" });
  });

  test("glab.instances returns configured instances as a query result", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("glab-list-1", { type: "glab.instances" }));
    await flushAsyncWork();

    const payload = expectSingleQueryResult(fixture.sent, "glab-list-1");
    expect(payload).toEqual([{ hostname: "gitlab.com", username: "alice", authenticated: true }]);
  });

  test("ssh.key.list returns existing keys as a query result", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("ssh-list-1", { type: "ssh.key.list" }));
    await flushAsyncWork();

    const payload = expectSingleQueryResult(fixture.sent, "ssh-list-1");
    expect(payload).toEqual([{ name: "id_ed25519", fingerprint: "SHA256:abc", type: "Ed25519" }]);
  });

  test("projects.create reports accepted-then-final acks and creates the project", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("proj-create-1", { type: "projects.create", name: "alpha", gitInit: true }));
    await flushAsyncWork();

    expect(fixture.projectCreates).toEqual(["alpha"]);
    expect(fixture.sent.filter((env) => env.type === MESSAGE_TYPES.ack).map((env) => env.payload)).toEqual([
      expect.objectContaining({ status: "success", message: "creating project" }),
      expect.objectContaining({ status: "success", message: "Project alpha created" }),
    ]);
  });

  test("projects.create rejects an invalid project name", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("proj-bad", { type: "projects.create", name: "../escape" }));
    await flushAsyncWork();

    expect(fixture.projectCreates).toEqual([]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.error,
      payload: { code: ERROR_CODES.malformed_command },
    });
  });

  test("projects.set-remote updates the origin remote", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("proj-remote-1", { type: "projects.set-remote", name: "alpha", remote: "https://github.com/acme/alpha.git" }));
    await flushAsyncWork();

    expect(fixture.projectSetRemotes).toEqual([["alpha", "https://github.com/acme/alpha.git"]]);
    expect(fixture.sent.filter((env) => env.type === MESSAGE_TYPES.ack)).toHaveLength(2);
  });

  test("projects.enable and projects.disable flip project state", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("proj-enable-1", { type: "projects.enable", name: "alpha" }));
    dispatcher.handle(commandEnvelope("proj-disable-1", { type: "projects.disable", name: "alpha" }));
    await flushAsyncWork();

    expect(fixture.projectEnables).toEqual(["alpha"]);
    expect(fixture.projectDisables).toEqual(["alpha"]);
    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent.every((env) => env.type === MESSAGE_TYPES.ack && (env.payload as { status?: string })?.status === "success")).toBe(true);
  });

  test("projects.enable-feature enables a whitelisted skill scaffold", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("proj-feat-1", { type: "projects.enable-feature", name: "alpha", feature: "openspec" }));
    await flushAsyncWork();

    expect(fixture.projectFeatures).toEqual([["alpha", "openspec"]]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      payload: { status: "success" },
    });
  });

  test("projects.enable-feature rejects an unknown feature", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("proj-feat-bad", { type: "projects.enable-feature", name: "alpha", feature: "magic" }));
    await flushAsyncWork();

    expect(fixture.projectFeatures).toEqual([]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.error,
      payload: { code: ERROR_CODES.malformed_command },
    });
  });

  test("projects.sync reconciles add/remove arrays", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("proj-sync-1", { type: "projects.sync", add: ["alpha"], remove: ["beta"] }));
    await flushAsyncWork();

    expect(fixture.projectSyncs).toEqual([[["alpha"], ["beta"]]]);
    expect(fixture.sent.filter((env) => env.type === MESSAGE_TYPES.ack)).toHaveLength(2);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      payload: { status: "success" },
    });
  });

  test("projects.sync rejects an invalid name in either array", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("proj-sync-bad", { type: "projects.sync", add: ["ok"], remove: ["../bad"] }));
    await flushAsyncWork();

    expect(fixture.projectSyncs).toEqual([]);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.error,
      payload: { code: ERROR_CODES.malformed_command },
    });
  });
});

describe("agent model remote management", () => {
  test("agent-models.list returns the per-agent model state without acknowledgements", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("agent-models-query-1", { type: "agent-models.list" }));
    await flushAsyncWork();

    expect(fixture.agentModelReads).toEqual(["agent-models.list"]);
    const payload = expectSingleQueryResult(fixture.sent, "agent-models-query-1");
    expect(payload).toMatchObject({
      agents: [{ name: "general" }],
      catalog: ["anthropic/claude-sonnet-4-5"],
      hasPassword: true,
    });
  });

  test("agent-models.set applies entries and acknowledges twice like other long operations", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("agent-models-set-1", {
      type: "agent-models.set",
      agent: "general",
      entries: [{ model: "anthropic/claude-sonnet-4-5" }],
    }));
    await flushAsyncWork();

    expect(fixture.agentModelApplies).toEqual([
      { agent: "general", entries: [{ model: "anthropic/claude-sonnet-4-5" }] },
    ]);
    expect(fixture.sent).toHaveLength(2);
    expect(fixture.sent[0]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "agent-models-set-1",
      payload: { status: "success", message: "applying agent model" },
    });
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      id: "agent-models-set-1",
      payload: { status: "success", message: "Agent model applied for general" },
    });
  });

  test("agent-models.set with empty entries clears the configured model", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("agent-models-clear-1", {
      type: "agent-models.set",
      agent: "general",
      entries: [],
    }));
    await flushAsyncWork();

    expect(fixture.agentModelApplies).toEqual([{ agent: "general", entries: [] }]);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      payload: { status: "success", message: "Agent model cleared for general; automatic selection restored" },
    });
  });

  test("agent-models.set rejects an unknown agent as a failure without applying", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("agent-models-unknown-1", {
      type: "agent-models.set",
      agent: "ghost",
      entries: [{ model: "anthropic/claude-sonnet-4-5" }],
    }));
    await flushAsyncWork();

    expect(fixture.agentModelApplies).toEqual([]);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      payload: { status: "failure", message: "agent ghost is not a configurable live subagent" },
    });
  });

  test("agent-models.set rejects a model outside the environment catalog", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("agent-models-catalog-1", {
      type: "agent-models.set",
      agent: "general",
      entries: [{ model: "openrouter/not-in-catalog" }],
    }));
    await flushAsyncWork();

    expect(fixture.agentModelApplies).toEqual([]);
    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      payload: {
        status: "failure",
        message: "model openrouter/not-in-catalog is not available in the current environment catalog",
      },
    });
  });

  test("agent-models.set surfaces an apply failure in the final acknowledgement", async () => {
    const fixture = createFixture({
      applyAgentModel: async () => ({ ok: false, status: "write_failed", error: "jq write failed" }),
    });
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("agent-models-fail-1", {
      type: "agent-models.set",
      agent: "general",
      entries: [{ model: "anthropic/claude-sonnet-4-5" }],
    }));
    await flushAsyncWork();

    expect(fixture.sent[1]).toMatchObject({
      type: MESSAGE_TYPES.ack,
      payload: { status: "failure", message: "jq write failed" },
    });
  });

  test("agent-models.set rejects malformed payloads without applying", async () => {
    const fixture = createFixture();
    const dispatcher = createCommandDispatcher(fixture.sender, fixture.deps);

    dispatcher.handle(commandEnvelope("agent-models-bad-1", { type: "agent-models.set", agent: "General" }));
    dispatcher.handle(commandEnvelope("agent-models-bad-2", { type: "agent-models.set", agent: "general", entries: [{ model: "not-a-model-ref" }] }));
    dispatcher.handle(commandEnvelope("agent-models-bad-3", { type: "agent-models.set", agent: "general", entries: "nope" }));
    await flushAsyncWork();

    expect(fixture.agentModelApplies).toEqual([]);
    expect(fixture.sent).toHaveLength(3);
    expect(fixture.sent.every((env) => env.type === MESSAGE_TYPES.error && (env.payload as { code?: string })?.code === ERROR_CODES.malformed_command)).toBe(true);
  });
});
