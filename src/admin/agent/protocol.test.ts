import { describe, expect, it } from "bun:test";
import type { CommandType } from "./protocol";
import {
  ERROR_CODES,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  buildAck,
  buildError,
  buildEvent,
  buildHeartbeat,
  buildHello,
  buildHelloAck,
  buildResult,
  createEnvelope,
  extractCaFromUrl,
  extractTokenFromUrl,
  isHelloAck,
  parseCommandName,
  parseCommandType,
  parseEnvelope,
  parseGlabTokenRotatePayload,
} from "./protocol";

describe("agent protocol", () => {
  it("defines the frozen message types and reserved error codes", () => {
    expect(MESSAGE_TYPES).toEqual({
      hello: "hello",
      hello_ack: "hello_ack",
      heartbeat: "heartbeat",
      ack: "ack",
      command: "command",
      error: "error",
      result: "result",
      event: "event",
    });
    expect(ERROR_CODES).toEqual({
      malformed_message: "malformed_message",
      unknown_command: "unknown_command",
      malformed_command: "malformed_command",
      unsupported_version: "unsupported_version",
      auth_failed: "auth_failed",
    });
    expect(Object.isFrozen(MESSAGE_TYPES)).toBe(true);
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });

  it("round-trips a created envelope through JSON", () => {
    const created = createEnvelope("heartbeat", { healthy: true });

    const parsed = parseEnvelope(JSON.stringify(created));

    expect(parsed).toEqual(created);
    expect(created.id).toStartWith("agent-msg-");
    expect(Number.isNaN(Date.parse(created.timestamp))).toBe(false);
  });

  it("creates unique envelope identifiers", () => {
    const first = createEnvelope("heartbeat", null);
    const second = createEnvelope("heartbeat", null);

    expect(second.id).not.toBe(first.id);
  });

  it("rejects malformed or incomplete envelopes", () => {
    const invalidEnvelopes = [
      "not-json",
      "null",
      "[]",
      JSON.stringify({ id: "id", timestamp: "now", payload: null }),
      JSON.stringify({ type: "hello", timestamp: "now", payload: null }),
      JSON.stringify({ type: "hello", id: "id", payload: null }),
    ];

    for (const raw of invalidEnvelopes) {
      expect(parseEnvelope(raw)).toBeNull();
    }
  });

  it("uses the acknowledged message id for acknowledgement envelopes", () => {
    const outcome = {
      status: "success" as const,
      message: "complete",
      started_at: "2026-08-10T00:00:00.000Z",
      finished_at: "2026-08-10T00:00:01.000Z",
    };

    const ack = buildAck("command-1", outcome);
    const error = buildError("unknown_command", "Unknown command", "command-2");
    const helloAck = buildHelloAck("hello-1");

    expect(ack).toMatchObject({ type: "ack", id: "command-1", payload: outcome });
    expect(error).toMatchObject({
      type: "error",
      id: "command-2",
      payload: { code: "unknown_command", message: "Unknown command" },
    });
    expect(helloAck).toMatchObject({ type: "hello_ack", id: "hello-1", payload: {} });
  });

  it("optionally carries machine-readable data in an ack payload", () => {
    const outcome = {
      status: "success" as const,
      message: "device flow started",
      started_at: "2026-08-10T00:00:00.000Z",
      finished_at: "2026-08-10T00:00:01.000Z",
      data: { device_code: "ABCD-1234", verification_uri: "https://github.com/login/device" },
    };

    const ack = buildAck("gh-start-1", outcome);

    expect(ack).toMatchObject({ type: "ack", id: "gh-start-1", payload: outcome });
  });

  it("omits data from acks built without it", () => {
    const ack = buildAck("cmd-1", {
      status: "success",
      message: "done",
      started_at: "2026-08-10T00:00:00.000Z",
      finished_at: "2026-08-10T00:00:01.000Z",
    });

    expect(ack).toMatchObject({
      type: "ack",
      id: "cmd-1",
      payload: {
        status: "success",
        message: "done",
        started_at: "2026-08-10T00:00:00.000Z",
        finished_at: "2026-08-10T00:00:01.000Z",
      },
    });
    expect("data" in (ack.payload as Record<string, unknown>)).toBe(false);
  });

  it("builds a correlated result envelope", () => {
    const payload = { container_status: "running" };

    const result = buildResult("query-1", payload);

    expect(result).toMatchObject({ type: "result", id: "query-1", payload });
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
  });

  it("builds event envelopes with fresh identifiers", () => {
    const payload = { step: "download", status: "running" };

    const first = buildEvent("upgrade.progress", payload);
    const second = buildEvent("upgrade.progress", payload);

    expect(first.type).toBe("event");
    expect(first.id).toStartWith("agent-msg-");
    expect(second.id).not.toBe(first.id);
    expect(first.payload).toEqual({ name: "upgrade.progress", data: payload });
  });

  it("round-trips a correlated result through JSON", () => {
    const result = buildResult("query-2", { providers: [] });

    const parsed = parseEnvelope(JSON.stringify(result));

    expect(parsed).toEqual(result);
    expect(parsed).toMatchObject({ type: "result", id: "query-2", payload: { providers: [] } });
  });

  it("builds hello and heartbeat envelopes", () => {
    const hello = buildHello("agent-7");
    const heartbeatPayload = { uptime_seconds: 42 };
    const heartbeat = buildHeartbeat(heartbeatPayload);

    expect(PROTOCOL_VERSION).toBe(1);
    expect(hello).toMatchObject({
      type: "hello",
      payload: { agent_id: "agent-7", protocol_version: 1 },
    });
    expect(heartbeat).toMatchObject({ type: "heartbeat", payload: heartbeatPayload });
  });

  it("extracts registration tokens without throwing for invalid URLs", () => {
    expect(extractTokenFromUrl("wss://center.example.com/ws?token=abc")).toBe("abc");
    expect(extractTokenFromUrl("wss://center.example.com/ws")).toBeNull();
    expect(extractTokenFromUrl("not a url")).toBeNull();
  });

  it("extracts a base64url-encoded PEM CA from the registration URL", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    const encoded = Buffer.from(pem, "utf-8").toString("base64url");

    expect(extractCaFromUrl(`wss://center.example.com/ws?token=t&ca=${encoded}`)).toBe(pem);
    expect(extractCaFromUrl("wss://center.example.com/ws?token=t")).toBeNull();
    expect(extractCaFromUrl("wss://center.example.com/ws")).toBeNull();
    expect(extractCaFromUrl("not a url")).toBeNull();
  });

  it("returns null when the ca parameter is not a PEM certificate", () => {
    const notPem = Buffer.from("just some text", "utf-8").toString("base64url");

    expect(extractCaFromUrl(`wss://center.example.com/ws?ca=${notPem}`)).toBeNull();
  });

  it("recognizes hello acknowledgements", () => {
    expect(isHelloAck(buildHelloAck("hello-1"))).toBe(true);
    expect(isHelloAck(createEnvelope("heartbeat", {}))).toBe(false);
  });

  it("parses supported command names and rejects other payloads", () => {
    expect(parseCommandName({ type: "upgrade" })).toBe("upgrade");
    expect(parseCommandName({ type: "reconfigure" })).toBe("reconfigure");
    expect(parseCommandName({ type: "restart" })).toBe("restart");
    expect(parseCommandName({ type: "providers.key.add" })).toBe("providers.key.add");
    expect(parseCommandName({ type: "providers.key.set-active" })).toBe("providers.key.set-active");
    expect(parseCommandName({ type: "providers.key.delete" })).toBe("providers.key.delete");
    expect(parseCommandName({ type: "providers.key.update-note" })).toBe("providers.key.update-note");
    expect(parseCommandName({ type: "secrets.set" })).toBe("secrets.set");
    expect(parseCommandName({ type: "ssh.key.add" })).toBe("ssh.key.add");
    expect(parseCommandName({ type: "ssh.key.delete" })).toBe("ssh.key.delete");
    expect(parseCommandName({ type: "git.config.set" })).toBe("git.config.set");
    expect(parseCommandName({ type: "gh.auth.start" })).toBe("gh.auth.start");
    expect(parseCommandName({ type: "gh.auth.logout" })).toBe("gh.auth.logout");
    expect(parseCommandName({ type: "glab.instance.add" })).toBe("glab.instance.add");
    expect(parseCommandName({ type: "glab.instance.remove" })).toBe("glab.instance.remove");
    expect(parseCommandName({ type: "glab.token.rotate", hostname: "gitlab.example.com" })).toBe("glab.token.rotate");
    expect(parseCommandName({ type: "projects.create" })).toBe("projects.create");
    expect(parseCommandName({ type: "projects.set-remote" })).toBe("projects.set-remote");
    expect(parseCommandName({ type: "projects.enable" })).toBe("projects.enable");
    expect(parseCommandName({ type: "projects.disable" })).toBe("projects.disable");
    expect(parseCommandName({ type: "projects.enable-feature" })).toBe("projects.enable-feature");
    expect(parseCommandName({ type: "projects.sync" })).toBe("projects.sync");
    expect(parseCommandName({ type: "agent-models.set" })).toBe("agent-models.set");
    expect(parseCommandName({ type: "delete" })).toBeNull();
    expect(parseCommandName({})).toBeNull();
    expect(parseCommandName(null)).toBeNull();
    expect(parseCommandName("upgrade")).toBeNull();
    expect(parseCommandName({ type: "git.config.get" })).toBeNull();
    expect(parseCommandName({ type: "agent-models.list" })).toBeNull();
  });

  it("validates the hostname-only GitLab token rotation payload", () => {
    expect(parseGlabTokenRotatePayload({ hostname: "gitlab.example.com" })).toEqual({
      hostname: "gitlab.example.com",
    });
    expect(parseGlabTokenRotatePayload({})).toBeNull();
    expect(parseGlabTokenRotatePayload({ hostname: " " })).toBeNull();
    expect(parseGlabTokenRotatePayload({ hostname: "gitlab.example.com", extra: true })).toBeNull();
    expect(parseGlabTokenRotatePayload(null)).toBeNull();
    expect(parseGlabTokenRotatePayload("gitlab.example.com")).toBeNull();
  });

  it("parses action and query command types", () => {
    const commandTypes: CommandType[] = [
      "upgrade",
      "reconfigure",
      "restart",
      "providers.key.add",
      "providers.key.set-active",
      "providers.key.delete",
      "providers.key.update-note",
      "secrets.set",
      "ssh.key.add",
      "ssh.key.delete",
      "git.config.set",
      "gh.auth.start",
      "gh.auth.logout",
      "glab.instance.add",
      "glab.instance.remove",
      "glab.token.rotate",
      "projects.create",
      "projects.set-remote",
      "projects.enable",
      "projects.disable",
      "projects.enable-feature",
      "projects.sync",
      "agent-models.set",
      "status",
      "env.get",
      "projects.list",
      "providers.list",
      "git.config.get",
      "glab.instances",
      "ssh.key.list",
      "agent-models.list",
    ];

    for (const commandType of commandTypes) {
      expect(parseCommandType({ type: commandType })).toBe(commandType);
    }

    expect(parseCommandType({ type: "delete" })).toBeNull();
    expect(parseCommandType({ type: "unknown" })).toBeNull();
    expect(parseCommandType("status")).toBeNull();
    expect(parseCommandType(["status"])).toBeNull();
    expect(parseCommandName({ type: "status" })).toBeNull();
  });
});
