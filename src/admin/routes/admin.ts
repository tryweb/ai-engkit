import { Hono } from "hono";
import { dockerCommand, runCommand, getComposeProject, getSelfBindSource, getSelfContainerRef, getAiDevUptime } from "../lib/docker";
import type { ExecResult } from "../lib/docker";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { readEnvFile, resolveEnvPath } from "../lib/env";
import { resolveImageRef } from "../lib/image-ref";
import {
  resolveEffectiveCompose,
  resolveOverlay,
  UPGRADE_BASE_FILE,
  type EffectiveCompose,
} from "../lib/compose-overlay";

export interface AdminRoutesDeps {
  readonly getComposeProject: () => Promise<string>;
  readonly getSelfBindSource: (destination: string) => Promise<string | null>;
  readonly runCommand: (args: string[], timeoutMs: number) => Promise<ExecResult>;
  readonly schedule: (fn: () => void, delayMs: number) => void;
  readonly resolveEffectiveAiAdmin: () => EffectiveCompose;
  readonly resolveHelperImage?: () => string;
  readonly getAiDevUptime?: () => Promise<number | null>;
}

const REAL_DEPS: AdminRoutesDeps = {
  getComposeProject,
  getSelfBindSource,
  runCommand,
  schedule: (fn, delayMs) => {
    setTimeout(fn, delayMs);
  },
  resolveEffectiveAiAdmin: () => resolveEffectiveCompose(resolveOverlay({ readEnv: readEnvFile })),
  resolveHelperImage: resolveImageRef,
  getAiDevUptime,
};

/** Keep the most recently created exited helper for this project for diagnosis. */
export async function cleanupAdminRestartHelpers(
  run: AdminRoutesDeps["runCommand"],
  project: string,
): Promise<void> {
  const result = await run([
    "docker", "ps", "-a", "--no-trunc",
    "--filter", "label=ai-engkit.operation=admin-restart",
    "--filter", `label=ai-engkit.project=${project}`,
    "--filter", "status=exited",
    "--format", "{{.ID}}",
  ], 10_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || "Could not list restart helpers");
  const obsolete = result.stdout.trim().split(/\s+/).filter((id) => /^[a-f0-9]{64}$/.test(id)).slice(1);
  for (const id of obsolete) {
    const removed = await run(["docker", "rm", id], 10_000);
    if (removed.exitCode !== 0) throw new Error(removed.stderr || "Could not remove restart helper");
  }
}

/**
 * Host installation root for a Compose base bind source. A staged upgrade base
 * lives under `admin-data/`, so its host root is two levels up; the active
 * compose file sits directly in the installation root.
 */
function hostProjectDirectory(baseFile: string, baseSource: string): string {
  return baseFile === UPGRADE_BASE_FILE ? dirname(dirname(baseSource)) : dirname(baseSource);
}

async function getAdminVersion(): Promise<string> {
  try {
    return readFileSync("/opt/ai-engkit/VERSION", "utf-8").trim();
  } catch {
    return "unknown";
  }
}

async function getAdminImageDigest(): Promise<string | null> {
  const ref = await getSelfContainerRef();
  const result = await dockerCommand(
    `inspect --format='{{.Image}}' ${ref}`,
    10_000,
  );
  if (result.exitCode !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

async function getAdminUptime(): Promise<number | null> {
  const ref = await getSelfContainerRef();
  const result = await dockerCommand(
    `inspect --format='{{.State.StartedAt}}' ${ref}`,
    10_000,
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  const startedAt = new Date(result.stdout.trim());
  return Math.floor((Date.now() - startedAt.getTime()) / 1000);
}

export function createAdminRoutes(overrides: Partial<AdminRoutesDeps> = {}): Hono {
  const deps: AdminRoutesDeps = { ...REAL_DEPS, ...overrides };
  const admin = new Hono();

  admin.get("/api/admin/status", async (c) => {
    const [version, imageDigest, uptime] = await Promise.all([
      getAdminVersion(),
      getAdminImageDigest(),
      getAdminUptime(),
    ]);

    return c.json({
      version,
      image_digest: imageDigest,
      uptime_seconds: uptime,
    });
  });

  admin.get("/api/admin/ai-dev-uptime", async (c) => {
    try {
      const uptime = deps.getAiDevUptime ? await deps.getAiDevUptime() : null;
      return c.json({ uptime_seconds: typeof uptime === "number" && Number.isFinite(uptime) ? uptime : null });
    } catch {
      return c.json({ uptime_seconds: null });
    }
  });

  /**
   * Response sent BEFORE restart to avoid connection drop.
   * Client polls admin status after receiving response.
   * Uses a detached helper from the configured image to recreate ai-admin.
   * Bind sources are resolved synchronously before returning success,
   * so misconfiguration is surfaced as HTTP 500 instead of silent failure.
   */
  admin.post("/api/admin/restart", async (c) => {
    let project: string;
    let envSource: string | null;
    let baseSource: string | null;
    let baseFile: string | undefined;
    let overlayActive: boolean;
    try {
      project = await deps.getComposeProject();
      // Line-aware env path: V1 reads /opt/ai-engkit/.env, the V2 line reads
      // /opt/ai-engkit/.env.v2. A hardcoded V1 path makes the restart
      // preflight fail on V2 (HTTP 500, no side effects).
      envSource = await deps.getSelfBindSource(resolveEnvPath());
      const effective = deps.resolveEffectiveAiAdmin();
      overlayActive = effective.overlayActive;
      baseFile = effective.files[0];
      baseSource = baseFile === undefined ? null : await deps.getSelfBindSource(baseFile);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: message }, 500);
    }

    if (envSource === null || baseSource === null || baseFile === undefined) {
      return c.json({ ok: false, error: "Failed to resolve host bind sources for ai-admin restart" }, 500);
    }

    const resolvedEnv = envSource;
    const resolvedBase = baseSource;
    const resolvedProject = project;
    const helperImage = (deps.resolveHelperImage ?? resolveImageRef)();
    const helperName = `ai-engkit-admin-restart-${crypto.randomUUID()}`;
    const projectDirectory = overlayActive ? hostProjectDirectory(baseFile, resolvedBase) : null;

    deps.schedule(() => {
      // Detach the helper so it survives the admin container being recreated.
      const dockerArgs = [
        "docker",
        "run",
        "--detach",
        "--name",
        helperName,
        "--label",
        "ai-engkit.operation=admin-restart",
        "--label",
        `ai-engkit.project=${resolvedProject}`,
        "--log-opt",
        "max-size=1m",
        "--log-opt",
        "max-file=1",
        "--pull=never",
        "--user",
        "0",
        "--entrypoint",
        "/usr/local/bin/docker",
        "-v",
        `${resolvedEnv}:${resolvedEnv}:ro`,
        "-v",
        `${resolvedBase}:${resolvedBase}:ro`,
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        helperImage,
        "compose",
        "-p",
        resolvedProject,
      ];
      if (projectDirectory !== null) {
        dockerArgs.push("--project-directory", projectDirectory);
      }
      dockerArgs.push(
        "--env-file",
        resolvedEnv,
        "-f",
        resolvedBase,
        "up",
        "-d",
        "--force-recreate",
        "ai-admin",
      );
      const resultPromise = (async () => {
        try {
          await cleanupAdminRestartHelpers(deps.runCommand, resolvedProject);
        } catch (error: unknown) {
          console.warn("[admin] restart helper cleanup failed:", error instanceof Error ? error.message : String(error));
        }
        return deps.runCommand(dockerArgs, 120_000);
      })();
      resultPromise
        .then((result) => {
          if (result.exitCode !== 0) {
            console.error(
              "[admin] ai-admin compose recreate failed:",
              helperName,
              result.stderr || result.stdout || `exit ${result.exitCode}`,
            );
          }
        })
        .catch((err: unknown) => {
          console.error(
            "[admin] ai-admin compose recreate failed:",
            helperName,
            err instanceof Error ? err.message : String(err),
          );
        });
    }, 2000);

    return c.json({ ok: true, message: "Admin recreation scheduled", helper: helperName });
  });

  return admin;
}

const admin = createAdminRoutes();

export default admin;
