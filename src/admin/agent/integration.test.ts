import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StatusResponse } from "../lib/status";
import type { ProviderKey, ProviderKeysFile } from "../lib/provider-keys";
import type { UpgradeEvent } from "../lib/upgrade";
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeDeps } from "./client";
import type { CommandDeps } from "./commands";
import type { StatusReport } from "./heartbeat";
import { buildHelloAck, MESSAGE_TYPES, parseEnvelope, type Envelope } from "./protocol";

interface StubSocketData {
  readonly messages: Envelope[];
}

interface StubConnection {
  readonly messages: Envelope[];
  readonly send: (envelope: Envelope) => void;
  readonly close: () => void;
}

interface UpgradeEventSource {
  readonly subscribe: (subscriber: (event: UpgradeEvent) => void) => () => void;
  readonly emit: (event: UpgradeEvent) => void;
  readonly activeCount: () => number;
}

const STATUS: StatusResponse = {
  container_status: "running",
  uptime_seconds: 42,
  ai_dev_health: { status: "healthy", http_code: 200, latency_ms: 8 },
  containers: {
    "ai-dev": { status: "running", uptime_seconds: 42, version: "1.2.3" },
    "ai-admin": { status: "running", uptime_seconds: 8450, version: "1.2.3" },
  },
  restart_count: 0,
  gh_auth: "authenticated",
  glab_auth: "not authenticated",
  git_user: "Integration Agent",
  project_count: 2,
  leanctx: null,
  gain: null,
  valueReport: null,
  proveReport: null,
  savingsReport: null,
  admin_version: "1.2.3",
  admin_version_mismatch: false,
};

const VERSIONS = { "AI-EngKit": "1.2.3" };
const STATUS_REPORT: StatusReport = {
  container_status: STATUS.container_status,
  uptime_seconds: STATUS.uptime_seconds,
  containers: STATUS.containers,
  versions: VERSIONS,
  gh_auth: STATUS.gh_auth,
  glab_auth: STATUS.glab_auth,
  admin_version: STATUS.admin_version,
  admin_version_mismatch: STATUS.admin_version_mismatch,
  upgrade_state: "idle",
  upgrade_available: false,
  latest_version: "",
};
const STATUS_FIELDS = [
  "admin_version",
  "admin_version_mismatch",
  "container_status",
  "containers",
  "gh_auth",
  "glab_auth",
  "latest_version",
  "uptime_seconds",
  "upgrade_available",
  "upgrade_state",
  "versions",
] as const;

const connections: StubConnection[] = [];
const acknowledgedIds = new Set<string>();
const runtimes: AgentRuntime[] = [];
let closedConnections = 0;
let centerUrl = "";
let originalCenterUrl: string | undefined;
let stopServer: (() => void) | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} is not an object`);
  return value;
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new RangeError(`Timed out waiting for ${description}`);
    await Bun.sleep(10);
  }
}

async function waitForConnection(index: number, timeoutMs = 5_000): Promise<StubConnection> {
  await waitUntil(() => connections[index] !== undefined, `stub connection ${index}`, timeoutMs);
  const connection = connections[index];
  if (connection === undefined) throw new RangeError(`Missing stub connection ${index}`);
  return connection;
}

async function waitForEnvelope(
  connection: StubConnection,
  predicate: (envelope: Envelope) => boolean,
  timeoutMs = 5_000,
): Promise<Envelope> {
  let found: Envelope | undefined;
  await waitUntil(() => {
    found = connection.messages.find(predicate);
    return found !== undefined;
  }, "matching WebSocket envelope", timeoutMs);
  if (found === undefined) throw new RangeError("Missing matching WebSocket envelope");
  return found;
}

function createUpgradeEventSource(): UpgradeEventSource {
  let subscribers: ((event: UpgradeEvent) => void)[] = [];
  return {
    subscribe: (subscriber) => {
      subscribers.push(subscriber);
      return () => {
        subscribers = subscribers.filter((candidate) => candidate !== subscriber);
      };
    },
    emit: (event) => {
      for (const subscriber of subscribers) subscriber(event);
    },
    activeCount: () => subscribers.length,
  };
}

function createKeyDeps(): CommandDeps {
  let keySequence = 1;
  const registry: ProviderKeysFile = { providers: {} };
  return {
    isUpgradeRunning: () => false,
    runUpgrade: async () => ({ success: true }),
    restartAiDev: async () => ({ success: true }),
    restartContainer: async () => ({ success: true }),
    upsertEnvVar: () => undefined,
    now: () => "2026-08-10T00:00:00.000Z",
    readStatus: async () => STATUS_REPORT,
    readEnv: () => ({}),
    readProjects: async () => ({}),
    readProviders: async () => ({}),
    isKeyProviderSupported: (provider) => provider === "anthropic",
    readProviderKeys: () => registry,
    addProviderKey: (provider, value, note = "") => {
      const entry = registry.providers[provider] ?? { keys: [], activeKeyId: null };
      const key: ProviderKey = { id: `k-${keySequence++}`, value, note, createdAt: "2026-08-10T00:00:00.000Z" };
      entry.keys.push(key);
      if (entry.activeKeyId === null) entry.activeKeyId = key.id;
      registry.providers[provider] = entry;
      return key;
    },
    setActiveProviderKey: (provider, keyId) => {
      const entry = registry.providers[provider];
      if (!entry || !entry.keys.some((candidate) => candidate.id === keyId)) return false;
      entry.activeKeyId = keyId;
      return true;
    },
    deleteProviderKey: (provider, keyId) => {
      const entry = registry.providers[provider];
      if (!entry) return false;
      const index = entry.keys.findIndex((candidate) => candidate.id === keyId);
      if (index === -1) return false;
      entry.keys.splice(index, 1);
      if (entry.activeKeyId === keyId) entry.activeKeyId = null;
      return true;
    },
    updateProviderKeyNote: (provider, keyId, note) => {
      const entry = registry.providers[provider];
      const key = entry?.keys.find((candidate) => candidate.id === keyId);
      if (key === undefined) return false;
      key.note = note;
      return true;
    },
    applyActiveKey: async () => {},
    removeAuthKey: async () => {},
    clearProviderCache: async () => {},
    readProviderAuthSnapshot: async () => null,
    waitForIdleSessions: async () => "idle",
    gracefulRestartAiDev: async () => ({ success: true, message: "restarted" }),
    setSecret: (key) => (key === "ADMIN_PASSWORD" ? "immediate" : "restart_required"),
    sshAddKey: async () => ({ ok: true }),
    sshDeleteKey: async () => ({ ok: true }),
    sshListKeys: async () => [],
    gitSetConfig: async () => ({ ok: true }),
    gitGetConfig: async () => ({}),
    ghStartDeviceFlow: async () => ({ device_code: "ABCD-1234", verification_uri: "https://github.com/login/device" }),
    ghLogout: async () => {},
    glabAddInstance: async () => ({ ok: true }),
    glabRemoveInstance: async () => {},
    glabListInstances: async () => [],
    projectCreate: async () => ({ ok: true }),
    projectSetRemote: async () => ({ ok: true }),
    projectEnable: async () => ({ ok: true }),
    projectDisable: async () => ({ ok: true }),
    projectEnableFeature: async () => ({ ok: true }),
    projectSync: async () => ({ ok: true, messages: [] }),
    readAgentModelsState: async () => ({ agents: [], catalog: [], providers: [], hasPassword: false, catalogAvailable: false }),
    applyAgentModel: async () => ({
      ok: true,
      status: "verified",
      resolved: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      requestVerified: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    }),
  };
}

function createIntegrationRuntime(
  logs: string[],
  overrides: Partial<AgentRuntimeDeps> = {},
): AgentRuntime {
  const runtime = createAgentRuntime({
    collectStatus: async () => STATUS,
    getVersions: async () => VERSIONS,
    getUpdateCheck: async () => ({
      current: "1.2.3",
      latest: "",
      update_available: false,
      status: "up-to-date",
      configured: null,
      message: "Up to date",
    }),
    getUpgradeState: () => "idle",
    createRealDeps: createKeyDeps,
    heartbeatMs: () => 25,
    logger: (level, message) => logs.push(`${level}:${message}`),
    ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
}

beforeAll(() => {
  originalCenterUrl = process.env["CENTER_URL"];
  const server = Bun.serve<StubSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request, { data: { messages: [] } })) return;
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        connections.push({
          messages: socket.data.messages,
          send: (envelope) => {
            socket.send(JSON.stringify(envelope));
          },
          close: () => {
            socket.close();
          },
        });
      },
      message(socket, message) {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        const envelope = parseEnvelope(raw);
        if (envelope === null) return;
        socket.data.messages.push(envelope);
        if (envelope.type === MESSAGE_TYPES.ack) acknowledgedIds.add(envelope.id);
        if (socket.data.messages.length === 1 && envelope.type === MESSAGE_TYPES.hello) {
          socket.send(JSON.stringify(buildHelloAck(envelope.id)));
        }
      },
      close() {
        closedConnections += 1;
      },
    },
  });
  centerUrl = `ws://127.0.0.1:${server.port}/ws?token=test-token`;
  process.env["CENTER_URL"] = centerUrl;
  stopServer = () => {
    void server.stop(true);
  };
});

afterAll(() => {
  for (const runtime of runtimes) runtime.stop();
  if (stopServer !== null) stopServer();
  if (originalCenterUrl === undefined) {
    delete process.env["CENTER_URL"];
  } else {
    process.env["CENTER_URL"] = originalCenterUrl;
  }
});

describe("agent stub-center integration", () => {
  it("round-trips hello v1, heartbeat, and a status query without an ack", async () => {
    const connectionIndex = connections.length;
    const logs: string[] = [];
    const runtime = createIntegrationRuntime(logs);
    runtime.start({ env: { CENTER_URL: centerUrl } });
    const connection = await waitForConnection(connectionIndex);

    const hello = await waitForEnvelope(connection, (envelope) => envelope.type === MESSAGE_TYPES.hello);
    expect(connection.messages[0]).toEqual(hello);
    const helloPayload = requireRecord(hello.payload, "hello payload");
    expect(typeof helloPayload["agent_id"]).toBe("string");
    expect(helloPayload["agent_id"]).not.toBe("");
    expect(helloPayload["protocol_version"]).toBe(1);

    const heartbeat = await waitForEnvelope(connection, (envelope) => envelope.type === MESSAGE_TYPES.heartbeat);
    expect(heartbeat.payload).toMatchObject({
      container_status: "running",
      uptime_seconds: 42,
      versions: VERSIONS,
      upgrade_state: "idle",
    });

    connection.send({
      type: MESSAGE_TYPES.command,
      id: "q1",
      payload: { type: "status" },
      timestamp: new Date().toISOString(),
    });
    const result = await waitForEnvelope(
      connection,
      (envelope) => envelope.type === MESSAGE_TYPES.result && envelope.id === "q1",
    );
    const resultPayload = requireRecord(result.payload, "status result payload");
    expect(Object.keys(resultPayload).sort()).toEqual([...STATUS_FIELDS].sort());
    expect(acknowledgedIds.has("q1")).toBe(false);
    expect(logs.some((line) => line.includes("handshake complete"))).toBe(true);

    runtime.stop();
  }, 10_000);

  it("streams ordered upgrade events and restores one subscription after reconnect", async () => {
    const source = createUpgradeEventSource();
    const connectionIndex = connections.length;
    const runtime = createIntegrationRuntime([], { subscribeUpgrade: source.subscribe });
    runtime.start({ env: { CENTER_URL: centerUrl } });
    const first = await waitForConnection(connectionIndex);
    await waitUntil(() => source.activeCount() === 1, "initial upgrade subscription");

    const events: UpgradeEvent[] = [
      { id: 1, step: "backup", status: "running", message: "A", timestamp: "2026-08-10T00:00:00.000Z" },
      { id: 2, step: "merge_env", status: "running", message: "B", timestamp: "2026-08-10T00:00:01.000Z" },
      { id: 3, step: "recreate", status: "running", message: "C", timestamp: "2026-08-10T00:00:02.000Z" },
    ];
    for (const event of events) source.emit(event);
    await waitUntil(
      () => first.messages.filter((envelope) => envelope.type === MESSAGE_TYPES.event).length === 3,
      "three upgrade event envelopes",
    );

    const received = first.messages.filter((envelope) => envelope.type === MESSAGE_TYPES.event);
    expect(received.map((envelope) => requireRecord(envelope.payload, "event payload")["name"])).toEqual([
      "upgrade",
      "upgrade",
      "upgrade",
    ]);
    expect(received.map((envelope) => {
      const payload = requireRecord(envelope.payload, "event payload");
      return requireRecord(payload["data"], "event data")["step"];
    })).toEqual(["backup", "merge_env", "recreate"]);
    expect(new Set(received.map((envelope) => envelope.id)).size).toBe(3);

    const closedBeforeReconnect = closedConnections;
    first.close();
    await waitUntil(() => closedConnections > closedBeforeReconnect, "server-side WebSocket close");
    await waitUntil(() => source.activeCount() === 0, "upgrade subscription detach");
    const second = await waitForConnection(connectionIndex + 1, 4_000);
    await waitUntil(() => source.activeCount() === 1, "reconnected upgrade subscription", 4_000);
    expect(source.activeCount()).toBe(1);

    source.emit({
      id: 4,
      step: "poll_health",
      status: "running",
      message: "After reconnect",
      timestamp: "2026-08-10T00:00:03.000Z",
    });
    await waitUntil(
      () => second.messages.filter((envelope) => envelope.type === MESSAGE_TYPES.event).length === 1,
      "one post-reconnect event",
    );

    runtime.stop();
  }, 10_000);

  it("round-trips the four provider-key commands with two acks and no raw key material", async () => {
    const connectionIndex = connections.length;
    const logs: string[] = [];
    const runtime = createIntegrationRuntime(logs, { createRealDeps: createKeyDeps });
    runtime.start({ env: { CENTER_URL: centerUrl } });
    const connection = await waitForConnection(connectionIndex);
    await waitForEnvelope(connection, (envelope) => envelope.type === MESSAGE_TYPES.heartbeat);

    const acksFor = (id: string): Envelope[] =>
      connection.messages.filter((envelope) => envelope.type === MESSAGE_TYPES.ack && envelope.id === id);
    const sendCommand = (id: string, payload: Record<string, unknown>): void => {
      connection.send({
        type: MESSAGE_TYPES.command,
        id,
        payload,
        timestamp: "2026-08-10T00:00:00.000Z",
      });
    };
    const payloadOf = (envelope: Envelope): Record<string, unknown> =>
      requireRecord(envelope.payload, "ack payload");

    const rawFirst = "sk-ant-test-123";
    sendCommand("key-add-1", { type: "providers.key.add", provider: "anthropic", value: rawFirst });
    await waitUntil(() => acksFor("key-add-1").length >= 2, "two acks for first add");
    expect(payloadOf(acksFor("key-add-1")[0])["message"]).toBe("adding provider key");
    expect(payloadOf(acksFor("key-add-1")[1])["message"]).toBe("provider key k-1 added and applied (graceful restart)");

    const rawSecond = "sk-ant-test-456";
    sendCommand("key-add-2", { type: "providers.key.add", provider: "anthropic", value: rawSecond });
    await waitUntil(() => acksFor("key-add-2").length >= 2, "two acks for second add");
    expect(payloadOf(acksFor("key-add-2")[1])["message"]).toBe("provider key k-2 added");

    sendCommand("key-set-1", { type: "providers.key.set-active", provider: "anthropic", keyId: "k-1" });
    await waitUntil(() => acksFor("key-set-1").length >= 2, "two acks for already-active set");
    expect(payloadOf(acksFor("key-set-1")[0])["message"]).toBe("provider key already active");
    expect(payloadOf(acksFor("key-set-1")[1])["message"]).toBe("provider key k-1 is already active");

    sendCommand("key-set-2", { type: "providers.key.set-active", provider: "anthropic", keyId: "k-2" });
    await waitUntil(() => acksFor("key-set-2").length >= 2, "two acks for switching active");
    expect(payloadOf(acksFor("key-set-2")[0])["message"]).toBe("setting active provider key");
    expect(payloadOf(acksFor("key-set-2")[1])["message"]).toBe("provider key k-2 set active (graceful restart)");

    sendCommand("key-note-1", { type: "providers.key.update-note", provider: "anthropic", keyId: "k-1", note: "primary" });
    await waitUntil(() => acksFor("key-note-1").length >= 2, "two acks for note update");
    expect(payloadOf(acksFor("key-note-1")[0])["message"]).toBe("updating provider key note");
    expect(payloadOf(acksFor("key-note-1")[1])["message"]).toBe("note updated for provider key k-1");

    sendCommand("key-del-1", { type: "providers.key.delete", provider: "anthropic", keyId: "k-1" });
    await waitUntil(() => acksFor("key-del-1").length >= 2, "two acks for deleting inactive key");
    expect(payloadOf(acksFor("key-del-1")[0])["message"]).toBe("deleting provider key");
    expect(payloadOf(acksFor("key-del-1")[1])["message"]).toBe("provider key k-1 deleted");

    sendCommand("key-del-2", { type: "providers.key.delete", provider: "anthropic", keyId: "k-2" });
    await waitUntil(() => acksFor("key-del-2").length >= 2, "two acks for deleting last active key");
    expect(payloadOf(acksFor("key-del-2")[0])["message"]).toBe("deleting provider key");
    expect(payloadOf(acksFor("key-del-2")[1])["message"]).toBe("provider key k-2 deleted, auth entry removed (graceful restart)");

    const serialized = JSON.stringify(connection.messages);
    expect(serialized).not.toContain(rawFirst);
    expect(serialized).not.toContain(rawSecond);

    runtime.stop();
  }, 10_000);

  it("defers provider-key commands during an upgrade and drains them after the terminal event", async () => {
    const source = createUpgradeEventSource();
    const connectionIndex = connections.length;
    const logs: string[] = [];
    let upgradeRunning = false;
    const runtime = createIntegrationRuntime(logs, {
      subscribeUpgrade: source.subscribe,
      createRealDeps: () => ({ ...createKeyDeps(), isUpgradeRunning: () => upgradeRunning }),
    });
    runtime.start({ env: { CENTER_URL: centerUrl } });
    const connection = await waitForConnection(connectionIndex);
    await waitUntil(() => source.activeCount() === 1, "upgrade subscription attached");

    upgradeRunning = true;
    connection.send({
      type: MESSAGE_TYPES.command,
      id: "key-add-deferred",
      payload: { type: "providers.key.add", provider: "anthropic", value: "sk-ant-test-789" },
      timestamp: "2026-08-10T00:00:00.000Z",
    });
    await Bun.sleep(150);
    const deferred = connection.messages.filter(
      (envelope) => envelope.type === MESSAGE_TYPES.ack && envelope.id === "key-add-deferred",
    );
    expect(deferred).toHaveLength(1);
    expect(requireRecord(deferred[0].payload, "ack payload")["message"]).toBe(
      "provider key command queued until upgrade completes",
    );

    upgradeRunning = false;
    source.emit({ step: "cleanup", status: "success", message: "ok", timestamp: "2026-08-10T00:00:01.000Z" } as UpgradeEvent);
    await waitUntil(
      () =>
        connection.messages.filter(
          (envelope) => envelope.type === MESSAGE_TYPES.ack && envelope.id === "key-add-deferred",
        ).length >= 3,
      "three acks after drain",
    );
    const drained = connection.messages.filter(
      (envelope) => envelope.type === MESSAGE_TYPES.ack && envelope.id === "key-add-deferred",
    );
    expect(requireRecord(drained[1].payload, "ack payload")["message"]).toBe("adding provider key");
    expect(requireRecord(drained[2].payload, "ack payload")["message"]).toBe(
      "provider key k-1 added and applied (graceful restart)",
    );
    expect(JSON.stringify(connection.messages)).not.toContain("sk-ant-test-789");

    runtime.stop();
  }, 10_000);

  it("round-trips the six remote management domains over the wire", async () => {
    const connectionIndex = connections.length;
    const runtime = createIntegrationRuntime([], { createRealDeps: createKeyDeps });
    runtime.start({ env: { CENTER_URL: centerUrl } });
    const connection = await waitForConnection(connectionIndex);
    await waitForEnvelope(connection, (envelope) => envelope.type === MESSAGE_TYPES.heartbeat);

    const sendCommand = (id: string, payload: Record<string, unknown>): void => {
      connection.send({
        type: MESSAGE_TYPES.command,
        id,
        payload,
        timestamp: "2026-08-10T00:00:00.000Z",
      });
    };
    const ackFor = async (id: string, index: number): Promise<Envelope> => {
      await waitUntil(
        () => connection.messages.filter((env) => env.type === MESSAGE_TYPES.ack && env.id === id).length > index,
        `ack ${id}[${index}]`,
      );
      return connection.messages.filter((env) => env.type === MESSAGE_TYPES.ack && env.id === id)[index];
    };
    const payloadOf = (env: Envelope): Record<string, unknown> => requireRecord(env.payload, "ack payload");

    sendCommand("int-secrets", { type: "secrets.set", key: "OPENCHAMBER_UI_PASSWORD", value: "secret-abc" });
    expect(payloadOf(await ackFor("int-secrets", 0))["message"]).toContain("OPENCHAMBER_UI_PASSWORD updated");

    sendCommand("int-ssh", { type: "ssh.key.add", name: "ci", keyType: "ed25519" });
    expect(payloadOf(await ackFor("int-ssh", 0))["message"]).toBe("SSH key ci added");

    sendCommand("int-git", { type: "git.config.set", key: "user.email", value: "a@b.c" });
    expect(payloadOf(await ackFor("int-git", 0))["message"]).toBe("git config user.email updated");

    sendCommand("int-gh", { type: "gh.auth.start" });
    expect(payloadOf(await ackFor("int-gh", 0))["data"]).toEqual({
      device_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
    });

    sendCommand("int-glab", { type: "glab.instance.add", hostname: "gitlab.example.com", token: "glpat-int-token" });
    expect(payloadOf(await ackFor("int-glab", 0))["message"]).toBe("GitLab instance gitlab.example.com connected");

    sendCommand("int-proj", { type: "projects.create", name: "alpha", gitInit: true });
    expect(payloadOf(await ackFor("int-proj", 1))["message"]).toBe("Project alpha created");

    const serialized = JSON.stringify(connection.messages);
    expect(serialized).not.toContain("secret-abc");
    expect(serialized).not.toContain("glpat-int-token");

    runtime.stop();
  }, 10_000);
});
