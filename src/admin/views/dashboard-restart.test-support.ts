import { DashboardPage } from "./dashboard";

export type FetchResponse = {
  readonly ok: boolean;
  readonly json: () => Promise<unknown>;
};

export type Button = {
  disabled: boolean;
  textContent: string;
};

export type RestartAdminDeps = {
  readonly fetch: (url: string, init?: unknown) => Promise<FetchResponse>;
  readonly confirm: (message: string) => boolean;
  readonly alert: (message: string) => void;
  readonly Date: { now: () => number };
  readonly setTimeout: (fn: () => void, delay: number) => void;
  readonly location: { reload: () => void };
  readonly event: { target: Button };
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function extractRestartAdmin(html: string): string {
  const marker = "async function restartAdmin(event)";
  const start = html.indexOf(marker);
  if (start === -1) throw new Error("restartAdmin marker not found");
  const braceStart = html.indexOf("{", start);
  if (braceStart === -1) throw new Error("restartAdmin opening brace not found");
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i] ?? "";
    const next = html[i + 1] ?? "";
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (!escaped && ch === "'") inSingle = false;
      else if (ch === "\\" && !escaped) escaped = true;
      else escaped = false;
      continue;
    }
    if (inDouble) {
      if (!escaped && ch === '"') inDouble = false;
      else if (ch === "\\" && !escaped) escaped = true;
      else escaped = false;
      continue;
    }
    if (inTemplate) {
      if (!escaped && ch === "`") inTemplate = false;
      else if (ch === "\\" && !escaped) escaped = true;
      else escaped = false;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return html.slice(start, i + 1);
      }
    }
  }
  throw new Error("unmatched braces for restartAdmin");
}

export function getProductionRestartAdminSource(): string {
  const html = String(
    DashboardPage({
      container_status: "running",
      uptime_seconds: 100,
      versions: { "AI-EngKit": "v1.0.0" },
      gh_auth: "authenticated",
      glab_auth: "authenticated",
      git_user: "test",
      project_count: 0,
      ssh_key_count: 0,
      leanctx: null,
      gain: null,
      valueReport: null,
      proveReport: null,
      savingsReport: null,
      update_check: {
        current: "v1.0.0",
        latest: "v1.0.0",
        update_available: false,
        status: "up-to-date",
        configured: null,
        message: "",
      },
      upgrade_state: "idle",
      upgrade_events: [],
      upgrade_current_step: "",
      upgrade_progress_pct: 0,
      admin_version: "v1.0.0",
      admin_version_mismatch: false,
    }),
  );
  return extractRestartAdmin(html);
}

export function createRestartAdminFromSource(
  source: string,
  deps: RestartAdminDeps,
): () => Promise<unknown> {
  const factory: unknown = new Function(
    "fetch",
    "confirm",
    "alert",
    "Date",
    "setTimeout",
    "location",
    "event",
    `"use strict";\n${source}\nreturn restartAdmin;`,
  );
  if (typeof factory !== "function") throw new Error("factory not a function");
  const fn: unknown = factory(
    deps.fetch,
    deps.confirm,
    deps.alert,
    deps.Date,
    deps.setTimeout,
    deps.location,
    deps.event,
  );
  if (typeof fn !== "function") throw new Error("restartAdmin not a function");
  return () => fn(deps.event);
}

export function createHarness(opts: {
  baseline: { uptime: number | null; digest: string | null };
  postOk: boolean;
  postBody?: unknown;
  pollSequence: Array<{ ok: boolean; body?: unknown; throw?: boolean }>;
}) {
  let now = 0;
  const alerts: Array<string> = [];
  let reloaded = false;
  const btn: Button = { disabled: false, textContent: "↻ Restart" };
  const timeouts: Array<{ fn: () => void; due: number }> = [];
  let fetchCalls = 0;
  const fetch = async (url: string, _init?: unknown): Promise<FetchResponse> => {
    fetchCalls++;
    if (url === "/api/admin/status" && fetchCalls === 1) {
      return {
        ok: true,
        json: async () => ({ uptime_seconds: opts.baseline.uptime, image_digest: opts.baseline.digest }),
      };
    }
    if (url === "/api/admin/restart") {
      if (opts.postOk) {
        return { ok: true, json: async () => opts.postBody ?? ({ ok: true }) };
      }
      return {
        ok: false,
        json: async () => {
          if (opts.postBody !== undefined) return opts.postBody;
          throw new Error("json parse failed");
        },
      };
    }
    const idx = fetchCalls - 3;
    const entry = opts.pollSequence[idx];
    if (entry === undefined) {
      return {
        ok: true,
        json: async () => ({ uptime_seconds: opts.baseline.uptime, image_digest: opts.baseline.digest }),
      };
    }
    if (entry.throw) throw new Error("network failure");
    return {
      ok: entry.ok,
      json: async () => entry.body ?? {},
    };
  };
  const deps: RestartAdminDeps = {
    fetch,
    confirm: (_msg: string) => true,
    alert: (m: string) => alerts.push(m),
    Date: { now: () => now },
    setTimeout: (fn: () => void, delay: number) => {
      timeouts.push({ fn, due: now + delay });
    },
    location: { reload: () => { reloaded = true; } },
    event: { target: btn },
  };
  const harness = {
    now: () => now,
    getAlerts: () => alerts,
    isReloaded: () => reloaded,
    getButton: () => btn,
    getFetchCalls: () => fetchCalls,
    getTimeouts: () => timeouts,
    deps,
    runNextTimeout: async () => {
      if (timeouts.length === 0) return false;
      timeouts.sort((a, b) => a.due - b.due);
      const item = timeouts.shift();
      if (item === undefined) return false;
      now = item.due;
      item.fn();
      await new Promise((r) => setTimeout(r, 0));
      return true;
    },
  };
  return harness;
}
