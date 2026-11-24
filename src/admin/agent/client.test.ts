import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { StatusResponse } from "../lib/status";
import type { UpgradeEvent } from "../lib/upgrade";
import { createRealCommandDeps } from "./commands";
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeDeps } from "./client";
import {
  buildHelloAck,
  createEnvelope,
  MESSAGE_TYPES,
  parseEnvelope,
  type Envelope,
} from "./protocol";

interface SocketOptions {
  tls?: { ca?: string; cert?: string; key?: string };
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly url: string;
  readonly options: SocketOptions | undefined;
  closeCalls = 0;
  onopen: ((event: object) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: object) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string, _protocols?: string | string[], options?: SocketOptions) {
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  open(): void {
    this.onopen?.({});
  }

  message(env: Envelope | string): void {
    this.onmessage?.({ data: typeof env === "string" ? env : JSON.stringify(env) });
  }

  closeFromCenter(): void {
    this.onclose?.({});
  }
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
  git_user: "Agent User",
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
const runtimes: AgentRuntime[] = [];
let originalRandom: () => number;

interface UpgradeEventSource {
  readonly subscribe: (subscriber: (event: UpgradeEvent) => void) => () => void;
  readonly emit: (event: UpgradeEvent) => void;
  readonly activeCount: () => number;
}

function createUpgradeEventSource(): UpgradeEventSource {
  const subscribers = new Set<(event: UpgradeEvent) => void>();
  return {
    subscribe: (subscriber) => {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    emit: (event) => {
      for (const subscriber of subscribers) subscriber(event);
    },
    activeCount: () => subscribers.size,
  };
}

function socketAt(index: number): FakeWebSocket {
  const socket = FakeWebSocket.instances[index];
  if (socket === undefined) throw new RangeError(`Missing fake socket ${index}`);
  return socket;
}

function envelopeAt(socket: FakeWebSocket, index: number): Envelope {
  const raw = socket.sent[index];
  if (raw === undefined) throw new RangeError(`Missing sent message ${index}`);
  const env = parseEnvelope(raw);
  if (env === null) throw new TypeError(`Sent message ${index} is not an envelope`);
  return env;
}

function makeRuntime(
  logs: string[],
  handled: Envelope[] = [],
  overrides: Partial<AgentRuntimeDeps> = {},
): AgentRuntime {
  const runtime = createAgentRuntime({
    WebSocketCtor: FakeWebSocket,
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
    createRealDeps: createRealCommandDeps,
    createDispatcher: () => ({
      handle: (env) => handled.push(env),
      defer: () => undefined,
      drain: () => undefined,
      pendingCount: () => 0,
    }),
    heartbeatMs: () => 50,
    logger: (_level, message) => logs.push(message),
    ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeWebSocket.instances = [];
  originalRandom = Math.random;
  Math.random = () => 0.5;
});

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop();
  Math.random = originalRandom;
  jest.useRealTimers();
});

describe("agent WebSocket runtime", () => {
  test("stays disabled when CENTER_URL is unset", () => {
    const logs: string[] = [];
    const runtime = makeRuntime(logs);
    const previousCenterUrl = process.env["CENTER_URL"];
    delete process.env["CENTER_URL"];
    try {
      runtime.start({ env: {} });

      expect(runtime.getState()).toBe("disabled");
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(logs).toContain("Agent: CENTER_URL not set, agent mode disabled");
    } finally {
      if (previousCenterUrl === undefined) {
        delete process.env["CENTER_URL"];
      } else {
        process.env["CENTER_URL"] = previousCenterUrl;
      }
    }
  });

  test("reuses a URL registration token without logging the raw URL", () => {
    const logs: string[] = [];
    const runtime = makeRuntime(logs);

    runtime.start({ centerUrl: "ws://center.test/agent?token=xyz", env: {} });
    const socket = socketAt(0);
    socket.open();

    expect(socket.url).toBe("ws://center.test/agent?token=xyz");
    expect(logs).not.toContain("Agent: connected to ws://center.test/agent?token=xyz");
    expect(logs.some((message) => decodeURIComponent(message).includes("xyz…"))).toBe(true);
  });

  test("appends CENTER_TOKEN when the URL has no token", () => {
    const runtime = makeRuntime([]);

    runtime.start({ centerUrl: "ws://center.test/agent", env: { CENTER_TOKEN: "from-env" } });

    expect(socketAt(0).url).toBe("ws://center.test/agent?token=from-env");
  });

  test("passes a URL-bootstrapped CA to the socket and redacts it from logs", () => {
    const logs: string[] = [];
    const runtime = makeRuntime(logs);
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    const encoded = Buffer.from(pem, "utf-8").toString("base64url");

    runtime.start({
      centerUrl: `ws://center.test/agent?token=abc&ca=${encoded}`,
      env: {},
    });
    const socket = socketAt(0);
    socket.open();

    expect(socket.options).toEqual({ tls: { ca: pem } });
    expect(logs.some((message) => message.includes(pem))).toBe(false);
  });

  test("logs a warning when only some certificate env vars are set", () => {
    const logs: string[] = [];
    const runtime = makeRuntime(logs);

    runtime.start({
      centerUrl: "ws://center.test/agent",
      env: { CENTER_CA_CERT: "/path/to/ca.pem" },
    });

    expect(logs.some((m) => m.includes("partial mTLS"))).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.options).toBeUndefined();
  });

  test("does not log a partial mTLS warning when no certificate env vars are set", () => {
    const logs: string[] = [];
    const runtime = makeRuntime(logs);

    runtime.start({ centerUrl: "ws://center.test/agent", env: {} });

    expect(logs.some((m) => m.includes("partial mTLS"))).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test("does not log a partial mTLS warning when URL ca= is used instead of env vars", () => {
    const logs: string[] = [];
    const runtime = makeRuntime(logs);
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    const encoded = Buffer.from(pem, "utf-8").toString("base64url");

    runtime.start({
      centerUrl: `ws://center.test/agent?token=abc&ca=${encoded}`,
      env: {},
    });

    expect(logs.some((m) => m.includes("partial mTLS"))).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.options).toEqual({ tls: { ca: pem } });
  });

  test("sends hello with the configured agent identity on open", () => {
    const runtime = makeRuntime([]);
    runtime.start({ centerUrl: "ws://center.test/agent", env: { AGENT_ID: "agent-7" } });

    const socket = socketAt(0);
    socket.open();

    expect(envelopeAt(socket, 0)).toMatchObject({
      type: MESSAGE_TYPES.hello,
      payload: { agent_id: "agent-7", protocol_version: 1 },
    });
    expect(runtime.getState()).toBe("connected");
  });

  test("gates heartbeats until hello_ack and sends collected status afterward", async () => {
    const runtime = makeRuntime([]);
    runtime.start({ centerUrl: "ws://center.test/agent", env: {} });
    const socket = socketAt(0);
    socket.open();

    jest.advanceTimersByTime(100);
    expect(socket.sent).toHaveLength(1);

    socket.message(buildHelloAck(envelopeAt(socket, 0).id));
    jest.advanceTimersByTime(50);
    await Promise.resolve();

    expect(envelopeAt(socket, 1)).toMatchObject({
      type: MESSAGE_TYPES.heartbeat,
      payload: { container_status: "running", uptime_seconds: 42, versions: VERSIONS, upgrade_state: "idle" },
    });
  });

  test("removes a heartbeat correlation after the first acknowledgement", async () => {
    const logs: string[] = [];
    const runtime = makeRuntime(logs);
    runtime.start({ centerUrl: "ws://center.test/agent", env: {} });
    const socket = socketAt(0);
    socket.open();
    socket.message(buildHelloAck(envelopeAt(socket, 0).id));
    jest.advanceTimersByTime(50);
    await Promise.resolve();
    const heartbeat = envelopeAt(socket, 1);
    const acknowledgement = createEnvelope(MESSAGE_TYPES.ack, {});
    const correlated = { ...acknowledgement, id: heartbeat.id };

    socket.message(correlated);
    socket.message(correlated);

    expect(logs.filter((message) => message.includes(`heartbeat ${heartbeat.id} acked`))).toHaveLength(1);
  });

  test("routes command envelopes to the injected dispatcher", () => {
    const handled: Envelope[] = [];
    const runtime = makeRuntime([], handled);
    runtime.start({ centerUrl: "ws://center.test/agent", env: {} });
    const socket = socketAt(0);
    socket.open();
    socket.message(buildHelloAck(envelopeAt(socket, 0).id));
    const command = createEnvelope(MESSAGE_TYPES.command, { type: "restart" });

    socket.message(command);

    expect(handled).toEqual([command]);
  });

  test("forwards upgrade events after hello_ack and detaches after a terminal event", () => {
    const source = createUpgradeEventSource();
    const runtime = makeRuntime([], [], { subscribeUpgrade: source.subscribe });
    runtime.start({ centerUrl: "ws://center.test/agent", env: {} });
    const socket = socketAt(0);
    socket.open();
    const running: UpgradeEvent = {
      id: 1,
      step: "backup",
      status: "running",
      message: "Backing up",
      timestamp: "2026-08-10T00:00:00.000Z",
    };

    source.emit(running);
    expect(socket.sent).toHaveLength(1);

    socket.message(buildHelloAck(envelopeAt(socket, 0).id));
    source.emit(running);
    expect(envelopeAt(socket, 1)).toMatchObject({
      type: MESSAGE_TYPES.event,
      payload: { name: "upgrade", data: running },
    });

    const terminal: UpgradeEvent = {
      id: 2,
      step: "cleanup",
      status: "success",
      message: "Upgrade complete",
      timestamp: "2026-08-10T00:00:01.000Z",
    };
    source.emit(terminal);

    expect(envelopeAt(socket, 2)).toMatchObject({
      type: MESSAGE_TYPES.event,
      payload: { name: "upgrade", data: terminal },
    });
    expect(source.activeCount()).toBe(0);
  });

  test("reuses one upgrade bridge across reconnect and sends through the current socket", () => {
    const source = createUpgradeEventSource();
    const runtime = makeRuntime([], [], { subscribeUpgrade: source.subscribe });
    runtime.start({ centerUrl: "ws://center.test/agent", env: {} });
    const first = socketAt(0);
    first.open();
    first.message(buildHelloAck(envelopeAt(first, 0).id));
    expect(source.activeCount()).toBe(1);

    first.closeFromCenter();
    expect(source.activeCount()).toBe(0);
    jest.advanceTimersByTime(1_000);

    const second = socketAt(1);
    second.open();
    const helloAck = buildHelloAck(envelopeAt(second, 0).id);
    second.message(helloAck);
    second.message(helloAck);
    expect(source.activeCount()).toBe(1);

    const event: UpgradeEvent = {
      id: 3,
      step: "recreate",
      status: "running",
      message: "Recreating",
      timestamp: "2026-08-10T00:00:02.000Z",
    };
    source.emit(event);

    expect(first.sent).toHaveLength(1);
    expect(envelopeAt(second, 1)).toMatchObject({
      type: MESSAGE_TYPES.event,
      payload: { name: "upgrade", data: event },
    });

    runtime.stop();
    expect(source.activeCount()).toBe(0);
  });

  test("reconnects after close and resets backoff only after a successful handshake", () => {
    const logs: string[] = [];
    const runtime = makeRuntime(logs);
    runtime.start({ centerUrl: "ws://center.test/agent", env: {} });
    const first = socketAt(0);
    first.open();
    first.closeFromCenter();

    expect(runtime.getState()).toBe("disconnected");
    expect(logs).toContain("Agent: reconnecting in 1000ms");
    jest.advanceTimersByTime(1_000);

    const second = socketAt(1);
    second.open();
    second.message(buildHelloAck(envelopeAt(second, 0).id));
    second.closeFromCenter();

    expect(logs.filter((message) => message === "Agent: reconnecting in 1000ms")).toHaveLength(2);
  });

  test("stop clears heartbeat and reconnect timers", async () => {
    const runtime = makeRuntime([]);
    runtime.start({ centerUrl: "ws://center.test/agent", env: {} });
    const socket = socketAt(0);
    socket.open();
    socket.message(buildHelloAck(envelopeAt(socket, 0).id));
    jest.advanceTimersByTime(50);
    await Promise.resolve();
    const sentBeforeStop = socket.sent.length;
    socket.closeFromCenter();

    runtime.stop();
    runtime.stop();
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.sent).toHaveLength(sentBeforeStop);
  });

  test("stop closes an active socket and remains idempotent", () => {
    const runtime = makeRuntime([]);
    runtime.start({ centerUrl: "ws://center.test/agent", env: {} });
    const socket = socketAt(0);
    socket.open();

    runtime.stop();
    runtime.stop();

    expect(socket.closeCalls).toBe(1);
  });

  test("records the last WebSocket error", () => {
    const runtime = makeRuntime([]);
    runtime.start({ centerUrl: "ws://center.test/agent", env: {} });
    const socket = socketAt(0);
    socket.open();

    socket.onerror?.(new ErrorEvent("error", { message: "center unavailable" }));

    expect(runtime.getLastError()).toBe("center unavailable");
    expect(runtime.getState()).toBe("disconnected");
  });
});
