import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { readFileSync } from "fs";
import { validateSession, isConfigured } from "./lib/auth";
import { readEnvFile, upsertEnvVar, deleteEnvVar } from "./lib/env";
import { startAgent } from "./agent";

import authRoutes from "./routes/auth";
import versionRoutes from "./routes/versions";
import envRoutes from "./routes/env";
import upgradeRoutes from "./routes/upgrade";
import projectRoutes from "./routes/projects";
import ghAuthRoutes from "./routes/gh-auth";
import glabAuthRoutes from "./routes/glab-auth";
import gitHostingRoutes from "./routes/git-hosting";
import gitConfigRoutes from "./routes/git-config";
import sshKeyRoutes from "./routes/ssh-keys";
import adminRoutes from "./routes/admin";
import secretsRoutes from "./routes/secrets";
import providersRoutes from "./routes/providers";
import statusRoutes from "./routes/status";
import agentRoutes from "./routes/agent";
import agentModelsRoutes from "./routes/agent-models";
import openChamberRoutes from "./routes/openchamber";
import retentionPolicyRoutes from "./routes/retention-policy";
import { getUpdateCheck } from "./routes/versions";
import { getStatus as getUpgradeStatus } from "./lib/upgrade";
import { DashboardPage } from "./views/dashboard";
import { getSelfContainerRef, dockerCommand, execInAiDev } from "./lib/docker";
import { listKeys } from "./lib/ssh-keys";
import { createToolStatusProbe } from "./lib/project-tool-status";
import leanctxRoutes from "./routes/leanctx";
import lspRoutes from "./routes/lsp";
import dbHealthRoutes from "./routes/db-health";
import { createDbMaintenanceRoutes } from "./routes/db-maintenance";
import { collectHostDbHealth } from "./lib/db-health";
import { getAgentStatus } from "./agent";
import { readLeanCtxConfig } from "./lib/leanctx";
import { deriveDashboardRuntimeState, readAppliedSnapshot } from "./lib/leanctx-applied-snapshot";
import { aggregateProviderSummary, aggregateSubagentSummary, aggregateLspSummary, projectCenter } from "./lib/dashboard-aggregates";
import { collectProvidersMeta } from "./lib/provider-meta";
import { collectAgentModelState, createAgentModelsLib } from "./lib/agent-models";
import { createLspReconciler } from "./lib/lsp-reconciler";
import { createMaintenanceScheduler } from "./lib/maintenance-scheduler";

export const app = new Hono();

// Global middleware
app.use("*", logger());
app.use("*", cors());

// Static files
app.use("/static/*", serveStatic({ root: "/opt/admin" }));

// Rate limiting store
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 500;
const RATE_WINDOW = 60_000;

async function rateLimit(c: any, next: any) {
  const path = c.req.path;
  // Skip rate limiting for static assets and health checks
  if (path === "/healthz" || path.startsWith("/static/")) return next();

  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || c.req.raw.remoteAddress || "local";
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (entry && now < entry.resetAt) {
    if (entry.count >= RATE_LIMIT) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    entry.count++;
  } else {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
  }

  await next();
}

// Auth middleware
async function authGuard(c: any, next: any) {
  const path = c.req.path;

  // Public paths
  if (
    path === "/healthz" ||
    path === "/login" ||
    path === "/setup" ||
    path === "/api/login" ||
    path === "/api/setup" ||
    path.startsWith("/static/")
  ) {
    return next();
  }

  // Check first-run
  if (!isConfigured() && !path.startsWith("/setup") && !path.startsWith("/api/setup")) {
    if (path.startsWith("/api/")) {
      return c.json({ error: "Not configured", setup_url: "/setup" }, 401);
    }
    return c.redirect("/setup");
  }

  // Validate session
  const cookie = c.req.header("cookie") || "";
  const sessionMatch = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  const token = sessionMatch ? sessionMatch[1] : "";

  if (!validateSession(token)) {
    if (path.startsWith("/api/")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.redirect("/login");
  }

  await next();
}

app.use("*", rateLimit);
app.use("*", authGuard);

// Mount routes
app.route("/", statusRoutes);
app.route("/", agentRoutes);
app.route("/", agentModelsRoutes);
app.route("/", authRoutes);
app.route("/", versionRoutes);
app.route("/", envRoutes);
app.route("/", upgradeRoutes);
app.route("/", projectRoutes);
app.route("/", ghAuthRoutes);
app.route("/", glabAuthRoutes);
app.route("/", gitHostingRoutes);
app.route("/", gitConfigRoutes);
app.route("/", sshKeyRoutes);
app.route("/", adminRoutes);
app.route("/", secretsRoutes);
app.route("/", providersRoutes);
app.route("/", openChamberRoutes);
app.route("/", retentionPolicyRoutes);
app.route("/", leanctxRoutes);
app.route("/", lspRoutes);
app.route("/", dbHealthRoutes);
// Live scheduler instance (not the module default): otherwise /schedule always reports Stopped.
app.route("/", createDbMaintenanceRoutes({ getSchedulerStatus: () => maintenanceScheduler.getStatus() }));

// Dashboard main page — gathers data directly instead of HTTP loopback
app.get("/", async (c) => {
  const { isAiDevRunning, getAiDevUptime, execInAiDev: exec } = await import("./lib/docker");

  const getVer = async (cmd: string): Promise<string> => {
    try {
      const r = await exec(cmd, 15_000);
      return r.exitCode === 0 && r.stdout ? r.stdout.split("\n")[0].trim() : "";
    } catch (error) {
      void error;
      return "";
    }
  };

  const [containerRunning, uptime, ghResult, glabResult, gitResult, projectsResult, sshKeys] =
    await Promise.all([
      isAiDevRunning(),
      getAiDevUptime(),
      exec("gh auth status 2>&1 || true", 10_000),
      exec("glab auth status 2>&1 || true", 10_000),
      exec("git config --global user.name 2>/dev/null || echo ''", 10_000),
      exec("ls ~/workspace/ 2>/dev/null | wc -l || echo '0'", 10_000),
      listKeys(exec).catch(() => []),
    ]);

  const ghAuth = ghResult.stdout.includes("Logged in") || ghResult.stderr.includes("Logged in")
    ? "authenticated" : "not authenticated";
  const glabAuth = glabResult.stdout.includes("Logged in") || glabResult.stderr.includes("Logged in")
    ? "authenticated" : "not authenticated";
  const gitUser = gitResult.stdout.trim();
  const projectCount = parseInt(projectsResult.stdout.trim() || "0", 10);
  const sshKeyCount = sshKeys.length;
  const toolStatus = createToolStatusProbe({ command: execInAiDev, workspaceRoot: "/home/devuser/workspace" });
  const [leanctx, gain, valueReport, proveReport, savingsReport] = await Promise.all([
    toolStatus.probeSite(), toolStatus.probeGain(),
    toolStatus.probeValueReport(), toolStatus.probeProveReport(), toolStatus.probeSavingsReport(),
  ]);

  const timeout = async <T>(p: Promise<T>, ms = 10_000): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const centerRaw = getAgentStatus();
  const centerSummary = projectCenter(centerRaw.state, centerRaw.last_error);

  const runtimeProfilePromise = (async () => {
    try {
      const cfg = await timeout(
        readLeanCtxConfig().then((c) => {
          const { _meta: _omitMeta, ...clean } = c;
          void _omitMeta;
          return clean;
        }),
      );
      const snap = await timeout(readAppliedSnapshot());
      const { profile } = deriveDashboardRuntimeState(cfg, snap);
      return profile;
    } catch (error) {
      void error;
      return null;
    }
  })();

  const providerPromise = (async () => {
    try {
      const meta = await timeout(collectProvidersMeta());
      if (!meta) return null;
      return aggregateProviderSummary(meta);
    } catch (error) {
      void error;
      return aggregateProviderSummary(null);
    }
  })();

  const dbHealthPromise = (async () => {
    try {
      const health = await timeout(collectHostDbHealth(), 8_000);
      return health;
    } catch (error) {
      void error;
      return null;
    }
  })();

  const subagentPromise = (async () => {
    try {
      const lib = createAgentModelsLib();
      const env = readEnvFile();
      const pwd = env["OPENCODE_SERVER_PASSWORD"]?.trim() || null;
      const state = await timeout(collectAgentModelState(lib, pwd));
      if (!state) return aggregateSubagentSummary(null, false);
      return aggregateSubagentSummary(state.agents, state.catalogAvailable);
    } catch (error) {
      void error;
      return aggregateSubagentSummary(null, false);
    }
  })();

  const lspPromise = (async () => {
    try {
      const reconciler = createLspReconciler({
        exec: execInAiDev,
        readEnv: readEnvFile,
        upsertEnvVar,
        deleteEnvVar,
        lspBlockFile: "/home/devuser/.config/opencode/opencode.json",
        lspVarsFile: "/home/devuser/.config/opencode/lsp-managed.env",
      });
      const summary = await timeout(reconciler.reconcile(), 5_000);
      if (!summary) return aggregateLspSummary(null);
      const enabled = summary.servers.filter((s) => s.desiredEnabled).length;
      return aggregateLspSummary({ ...summary, enabled });
    } catch (error) {
      void error;
      return aggregateLspSummary(null);
    }
  })();

  const [runtimeProfile, providerSummary, subagentSummary, dbHealth, lspSummary] = await Promise.all([
    timeout(runtimeProfilePromise.then((v) => v ?? null)),
    timeout(providerPromise.then((v) => v ?? aggregateProviderSummary(null))),
    timeout(subagentPromise.then((v) => v ?? aggregateSubagentSummary(null, false))),
    timeout(dbHealthPromise.then((v) => v ?? null)),
    timeout(lspPromise.then((v) => v ?? aggregateLspSummary(null))),
  ]);

  let adminVer = "dev";
  try {
    adminVer = readFileSync("/opt/ai-engkit/VERSION", "utf-8").trim();
  } catch (error) {
    void error;
  }

  const [aiEngkitVerRaw, opencodeVer, openchamberVer, dockerVer, updateCheck, adminDigest, aiDevDigest] = await Promise.all([
    getVer("cat /opt/ai-engkit/VERSION"),
    getVer("opencode --version 2>/dev/null || echo ''"),
    getVer("/home/devuser/.bun/bin/openchamber --version 2>/dev/null || echo ''"),
    getVer("docker --version 2>/dev/null | cut -d' ' -f3 | tr -d ',' || echo ''"),
    getUpdateCheck(),
    (async () => {
      const ref = await getSelfContainerRef();
      const result = await dockerCommand(`inspect --format='{{.Image}}' ${ref}`, 10_000);
      return result.exitCode === 0 && result.stdout ? result.stdout.trim() : null;
    })(),
    (async () => {
      const result = await dockerCommand(`inspect --format='{{.Image}}' ai-engkit`, 10_000);
      return result.exitCode === 0 && result.stdout ? result.stdout.trim() : null;
    })(),
  ]);
  const aiEngkitVer = aiEngkitVerRaw || "dev";
  const upgradeStatus = getUpgradeStatus();

  const finalRuntime = runtimeProfile ?? { applyState: "runtime-unavailable" as const, source: "unavailable" as const, compressionLevel: null, toolProfile: null, permissionInheritance: null, crossProjectSearch: null, secretDetectionEnabled: null, secretRedactionEnabled: null, archiveEnabled: null, archiveMaxAgeHours: null, archiveMaxDiskMb: null };
  const finalProvider = providerSummary ?? aggregateProviderSummary(null);
  const finalSubagent = subagentSummary ?? aggregateSubagentSummary(null, false);
  const finalLsp = lspSummary ?? aggregateLspSummary(null);

  return c.html(
    DashboardPage({
      container_status: containerRunning ? "running" : "stopped",
      uptime_seconds: uptime,
      versions: {
        "AI-EngKit": aiEngkitVer,
        "OpenCode": opencodeVer,
        "OpenChamber": openchamberVer,
        "Docker": dockerVer,
      },
      gh_auth: ghAuth,
      glab_auth: glabAuth,
      git_user: gitUser,
      project_count: projectCount,
      ssh_key_count: sshKeyCount,
      center: centerSummary,
      runtimeProfile: finalRuntime,
      providerSummary: finalProvider,
      subagentSummary: finalSubagent,
      lspSummary: finalLsp,
      leanctx,
      gain,
      valueReport,
      proveReport,
      savingsReport,
      update_check: updateCheck,
      upgrade_state: upgradeStatus.state,
      upgrade_events: upgradeStatus.events,
      upgrade_current_step: upgradeStatus.current_step,
      upgrade_progress_pct: upgradeStatus.progress_pct,
      admin_version: adminVer,
      dbHealth: dbHealth ?? null,
      admin_version_mismatch: adminDigest !== null && aiDevDigest !== null && adminDigest !== aiDevDigest,
    })
  );
});

// OpenAPI spec
app.get("/api/openapi.json", (c) => {
  return c.json({
    openapi: "3.0.3",
    info: {
      title: "AI-EngKit Admin API",
      version: "1.0.0",
      description: "Local REST API for AI-EngKit admin dashboard",
    },
    servers: [{ url: "", description: "Local admin server" }],
    paths: {
      "/healthz": { get: { summary: "Liveness probe", responses: { "200": { description: "OK" } } } },
      "/api/status": { get: { summary: "System status", responses: { "200": { description: "Status JSON" } } } },
      "/api/login": { post: { summary: "Authenticate", requestBody: { content: { "application/json": { schema: { type: "object", properties: { password: { type: "string" } } } } } }, responses: { "200": { description: "OK" } } } },
      "/api/logout": { post: { summary: "Logout", responses: { "200": { description: "OK" } } } },
      "/api/setup": { post: { summary: "Initial setup", responses: { "200": { description: "OK" } } } },
      "/api/versions": { get: { summary: "Component versions", responses: { "200": { description: "Versions JSON" } } } },
      "/api/env": { get: { summary: "Environment variables", responses: { "200": { description: "Env vars JSON" } } } },
      "/api/upgrade": { post: { summary: "Trigger upgrade", responses: { "200": { description: "Started" }, "409": { description: "Already running" } } } },
      "/api/projects": { get: { summary: "List projects", responses: { "200": { description: "Project list" } } }, post: { summary: "Create project", responses: { "200": { description: "OK" } } } },
    },
  });
});

const PORT = parseInt(Bun.env.ADMIN_PORT || "8080", 10);

export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 255,
};

export const maintenanceScheduler = createMaintenanceScheduler();

// Bun binds the declarative server after module evaluation; defer the agent until the next event-loop turn.
setTimeout(() => {
  try {
    startAgent({ env: { ...process.env, ...readEnvFile() } });
  } catch (error: unknown) {
    console.error("Agent startup failed:", error instanceof Error ? error.message : String(error));
  }
  try {
    maintenanceScheduler.start();
  } catch (error: unknown) {
    console.error("Maintenance scheduler startup failed:", error instanceof Error ? error.message : String(error));
  }
}, 0);
