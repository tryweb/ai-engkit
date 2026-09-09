import { readFileSync } from "fs";
import { Hono } from "hono";
import { runUpgrade, getState, getStatus, subscribe, getEventLog } from "../lib/upgrade";
import { readEnvFile, writeEnvFile, deleteEnvVar } from "../lib/env";
import { discoverGhcrVersions, isFormalReleaseTag, type GhcrDiscoveryResult } from "../lib/ghcr-versions";
import { UpgradePage } from "../views/upgrade";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readVersion(): string {
  try {
    return readFileSync("/opt/ai-engkit/VERSION", "utf-8").trim();
  } catch {
    return "unknown";
  }
}

export interface UpgradeRoutesDeps {
  readonly readVersion: () => string;
  readonly getState: () => ReturnType<typeof getState>;
  readonly getStatus: () => ReturnType<typeof getStatus>;
  readonly getEventLog: () => ReturnType<typeof getEventLog>;
  readonly subscribe: typeof subscribe;
  readonly runUpgrade: typeof runUpgrade;
  readonly readEnvFile: typeof readEnvFile;
  readonly writeEnvFile: typeof writeEnvFile;
  readonly deleteEnvVar: typeof deleteEnvVar;
  readonly discoverVersions: () => Promise<GhcrDiscoveryResult>;
}

const REAL_DEPS: UpgradeRoutesDeps = {
  readVersion,
  getState,
  getStatus,
  getEventLog,
  subscribe,
  runUpgrade,
  readEnvFile,
  writeEnvFile,
  deleteEnvVar,
  discoverVersions: () => discoverGhcrVersions(),
};

function isDevBuild(version: string): boolean {
  return version === "dev";
}

function resolveConfiguredVersion(env: Record<string, string>): string | null {
  const raw = env["AI_ENGKIT_VERSION"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createUpgradeRoutes(options: Partial<UpgradeRoutesDeps> = {}): Hono {
  const deps: UpgradeRoutesDeps = { ...REAL_DEPS, ...options };
  const upgrade = new Hono();
  let upgradeStartInFlight = false;

  upgrade.get("/api/upgrade/status", (c) => {
    return c.json(deps.getStatus());
  });

  upgrade.get("/api/upgrade/versions", async (c) => {
    const version = deps.readVersion();
    const configured = resolveConfiguredVersion(deps.readEnvFile());
    if (isDevBuild(version)) {
      return c.json(
        {
          versions: [],
          official_version: null,
          current_version: version,
          configured_version: configured,
          warning: "Dev build — version selector not available",
          error: null,
        },
        200,
      );
    }
    try {
      const discovery = await deps.discoverVersions();
      return c.json({
        versions: [...discovery.versions],
        official_version: discovery.officialVersion,
        current_version: version,
        configured_version: configured,
        warning: discovery.warning,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          versions: [],
          official_version: null,
          current_version: version,
          configured_version: configured,
          warning: null,
          error: message,
        },
        500,
      );
    }
  });

  upgrade.post("/api/upgrade", async (c) => {
    const state = deps.getState();
    if (state === "running") {
      return c.json({ error: "Upgrade already in progress", status: deps.getStatus() }, 409);
    }

    const version = deps.readVersion();
    if (isDevBuild(version)) {
      return c.json({ error: "Dev build detected. Upgrade is only available for production releases (ghcr.io/tryweb/ai-engkit:latest)." }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON with a 'version' field" }, 400);
    }

    if (!isRecord(body)) {
      return c.json({ error: "Request body must be an object with a 'version' field" }, 400);
    }
    const requested = body["version"];
    if (typeof requested !== "string" || !requested.trim()) {
      return c.json({ error: "version must be a non-empty string" }, 400);
    }
    const target = requested.trim();
    if (!isFormalReleaseTag(target)) {
      return c.json({ error: `Invalid version "${target}": must match v1.x.y` }, 400);
    }

    const requestedTargetType = body["target_type"];
    if (requestedTargetType !== undefined && requestedTargetType !== "official" && requestedTargetType !== "specified") {
      return c.json({ error: "target_type must be 'official' or 'specified'" }, 400);
    }
    const targetType = requestedTargetType ?? "specified";

    let discovery: GhcrDiscoveryResult;
    try {
      discovery = await deps.discoverVersions();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Version discovery failed: ${message}` }, 502);
    }

    if (discovery.versions.length === 0) {
      return c.json({ error: "No formal releases available" }, 400);
    }

    if (targetType === "official") {
      if (!discovery.officialVersion) {
        return c.json({ error: "Official version unavailable — no latest alias resolved" }, 400);
      }
      if (target !== discovery.officialVersion) {
        return c.json({ error: `Official target must be the resolved official version (${discovery.officialVersion}), not "${target}"` }, 400);
      }
    } else {
      const allowed = new Set(discovery.versions);
      if (!allowed.has(target)) {
        return c.json({ error: `Unknown version "${target}"` }, 400);
      }
    }

    if (upgradeStartInFlight || deps.getState() === "running") {
      return c.json({ error: "Upgrade already in progress", status: deps.getStatus() }, 409);
    }

    upgradeStartInFlight = true;
    try {
      if (targetType === "official") {
        deps.deleteEnvVar("AI_ENGKIT_VERSION");
      } else {
        const env = deps.readEnvFile();
        env["AI_ENGKIT_VERSION"] = target;
        deps.writeEnvFile(env);
      }
    } catch (err) {
      upgradeStartInFlight = false;
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Failed to persist upgrade version: ${message}` }, 500);
    }

    void deps.runUpgrade().catch(() => {}).finally(() => {
      upgradeStartInFlight = false;
    });

    return c.json({ status: "started", log_url: "/api/upgrade/log", version: target });
  });

  upgrade.get("/api/upgrade/log", (c) => {
    const history = c.req.query("history");
    if (history === "1") {
      return c.json(deps.getEventLog());
    }

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    const stream = new ReadableStream({
      start(controller) {
        for (const event of deps.getEventLog()) {
          controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
        }

        const unsub = deps.subscribe((event) => {
          controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
          if (event.step === "cleanup" && (event.status === "success" || event.status === "failure")) {
            setTimeout(() => controller.close(), 1000);
          }
        });

        const abortController = new AbortController();
        c.req.raw.signal.addEventListener("abort", () => {
          unsub();
          abortController.abort();
        });
      },
    });

    return c.body(stream);
  });

  upgrade.get("/upgrade", (c) => {
    const ver = deps.readVersion();
    return c.html(UpgradePage({ devBuild: ver === "dev", versionsByCategory: {}, imageMeta: {} }));
  });

  return upgrade;
}

const defaultRouter = createUpgradeRoutes();
export default defaultRouter;
