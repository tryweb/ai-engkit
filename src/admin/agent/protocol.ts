export interface Envelope {
  type: string;
  payload: unknown;
  id: string;
  timestamp: string;
}

export const MESSAGE_TYPES = Object.freeze({
  hello: "hello",
  hello_ack: "hello_ack",
  heartbeat: "heartbeat",
  ack: "ack",
  command: "command",
  error: "error",
  result: "result",
  event: "event",
});

export const ERROR_CODES = Object.freeze({
  malformed_message: "malformed_message",
  unknown_command: "unknown_command",
  malformed_command: "malformed_command",
  unsupported_version: "unsupported_version",
  auth_failed: "auth_failed",
});

// Result and event are additive message types within protocol version 1.
export const PROTOCOL_VERSION = 1;

export type CommandName =
  | "upgrade"
  | "reconfigure"
  | "restart"
  | "providers.key.add"
  | "providers.key.set-active"
  | "providers.key.delete"
  | "providers.key.update-note"
  | "secrets.set"
  | "ssh.key.add"
  | "ssh.key.delete"
  | "git.config.set"
  | "gh.auth.start"
  | "gh.auth.logout"
  | "glab.instance.add"
  | "glab.instance.remove"
  | "glab.token.rotate"
  | "projects.create"
  | "projects.set-remote"
  | "projects.enable"
  | "projects.disable"
  | "projects.enable-feature"
  | "projects.sync"
  | "agent-models.set";

/** Supported read-only query command names. */
export type QueryName =
  | "status"
  | "env.get"
  | "projects.list"
  | "providers.list"
  | "git.config.get"
  | "glab.instances"
  | "ssh.key.list"
  | "agent-models.list";

/** Supported action and query command types. */
export type CommandType = CommandName | QueryName;

export interface GlabTokenRotatePayload {
  readonly hostname: string;
}

export interface GlabTokenRotateResponse {
  readonly ok: boolean;
  readonly rotated: boolean;
  readonly errorCode?: string;
}

export function parseGlabTokenRotatePayload(payload: unknown): GlabTokenRotatePayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const hostname = Reflect.get(payload, "hostname");
  if (Object.keys(payload).length !== 1 || typeof hostname !== "string" || hostname.trim() === "") {
    return null;
  }
  return { hostname };
}

let messageSequence = 0;

function createAcknowledgement(type: string, payload: unknown, acknowledgesId: string): Envelope {
  return {
    type,
    payload,
    id: acknowledgesId,
    timestamp: new Date().toISOString(),
  };
}

/** Create a protocol envelope with a fresh identifier and timestamp. */
export function createEnvelope(type: string, payload: unknown): Envelope {
  messageSequence += 1;
  return {
    type,
    payload,
    id: `agent-msg-${messageSequence}`,
    timestamp: new Date().toISOString(),
  };
}

/** Parse an untrusted JSON string into a protocol envelope. */
export function parseEnvelope(raw: string): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const type = Reflect.get(parsed, "type");
  const id = Reflect.get(parsed, "id");
  const timestamp = Reflect.get(parsed, "timestamp");
  if (typeof type !== "string" || typeof id !== "string" || typeof timestamp !== "string") return null;

  return {
    type,
    payload: Reflect.get(parsed, "payload"),
    id,
    timestamp,
  };
}

/** Build an error that acknowledges the referenced message. */
export function buildError(code: string, message: string, acknowledgesId: string): Envelope {
  return createAcknowledgement(MESSAGE_TYPES.error, { code, message }, acknowledgesId);
}

/** Build a command acknowledgement with its execution outcome. */
export function buildAck(
  acknowledgesId: string,
  outcome: {
    status: "success" | "failure";
    message: string;
    started_at: string;
    finished_at: string;
    /** Optional machine-readable outcome material (e.g. gh.auth.start device flow). */
    data?: unknown;
  },
): Envelope {
  const payload: Record<string, unknown> = {
    status: outcome.status,
    message: outcome.message,
    started_at: outcome.started_at,
    finished_at: outcome.finished_at,
  };
  if (outcome.data !== undefined) payload["data"] = outcome.data;
  return createAcknowledgement(MESSAGE_TYPES.ack, payload, acknowledgesId);
}

/** Build a query result correlated to the query command. */
export function buildResult(acknowledgesId: string, payload: unknown): Envelope {
  return createAcknowledgement(MESSAGE_TYPES.result, payload, acknowledgesId);
}

/** Build a fire-and-forget event carrying its name and data in a fresh envelope. */
export function buildEvent(name: string, payload: unknown): Envelope {
  return createEnvelope(MESSAGE_TYPES.event, { name, data: payload });
}

/** Build a hello acknowledgement correlated to the hello message. */
export function buildHelloAck(acknowledgesId: string): Envelope {
  return createAcknowledgement(MESSAGE_TYPES.hello_ack, {}, acknowledgesId);
}

/** Build the initial agent hello message. */
export function buildHello(agentId: string): Envelope {
  return createEnvelope(MESSAGE_TYPES.hello, {
    agent_id: agentId,
    protocol_version: PROTOCOL_VERSION,
  });
}

/** Build an agent heartbeat message. */
export function buildHeartbeat(payload: unknown): Envelope {
  return createEnvelope(MESSAGE_TYPES.heartbeat, payload);
}

/** Extract a registration token from a center WebSocket URL. */
export function extractTokenFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("token");
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

/**
 * Extract a CA certificate bootstrapped from a center WebSocket URL.
 * The center embeds the PEM certificate base64url-encoded in the `ca` query
 * parameter, so a single registration URL carries both token and trust anchor.
 * Returns null when the parameter is absent or cannot be decoded to PEM.
 */
export function extractCaFromUrl(url: string): string | null {
  let encoded: string | null;
  try {
    encoded = new URL(url).searchParams.get("ca");
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (encoded === null || encoded === "") return null;

  try {
    const pem = Buffer.from(encoded, "base64url").toString("utf-8");
    if (!pem.includes("BEGIN CERTIFICATE") || !pem.includes("END CERTIFICATE")) return null;
    return pem;
  } catch {
    return null;
  }
}

/** Return whether an envelope acknowledges an agent hello. */
export function isHelloAck(env: Envelope): boolean {
  return env.type === MESSAGE_TYPES.hello_ack;
}

/** Parse a supported command name from an unknown payload. */
export function parseCommandName(payload: unknown): CommandName | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;

  const commandName = Reflect.get(payload, "type");
  switch (commandName) {
    case "upgrade":
    case "reconfigure":
    case "restart":
    case "providers.key.add":
    case "providers.key.set-active":
    case "providers.key.delete":
    case "providers.key.update-note":
    case "secrets.set":
    case "ssh.key.add":
    case "ssh.key.delete":
    case "git.config.set":
    case "gh.auth.start":
    case "gh.auth.logout":
    case "glab.instance.add":
    case "glab.instance.remove":
    case "glab.token.rotate":
    case "projects.create":
    case "projects.set-remote":
    case "projects.enable":
    case "projects.disable":
    case "projects.enable-feature":
    case "projects.sync":
    case "agent-models.set":
      return commandName;
    default:
      return null;
  }
}

/** Parse a supported action or query command type from an unknown payload. */
export function parseCommandType(payload: unknown): CommandType | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;

  const commandType = Reflect.get(payload, "type");
  switch (commandType) {
    case "upgrade":
    case "reconfigure":
    case "restart":
    case "providers.key.add":
    case "providers.key.set-active":
    case "providers.key.delete":
    case "providers.key.update-note":
    case "secrets.set":
    case "ssh.key.add":
    case "ssh.key.delete":
    case "git.config.set":
    case "gh.auth.start":
    case "gh.auth.logout":
    case "glab.instance.add":
    case "glab.instance.remove":
    case "glab.token.rotate":
    case "projects.create":
    case "projects.set-remote":
    case "projects.enable":
    case "projects.disable":
    case "projects.enable-feature":
    case "projects.sync":
    case "agent-models.set":
    case "status":
    case "env.get":
    case "projects.list":
    case "providers.list":
    case "git.config.get":
    case "glab.instances":
    case "ssh.key.list":
    case "agent-models.list":
      return commandType;
    default:
      return null;
  }
}
