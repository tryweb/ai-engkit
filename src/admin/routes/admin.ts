import { Hono } from "hono";
import { dockerCommand, runCommand, getComposeProject, getSelfBindSource, getSelfContainerRef } from "../lib/docker";
import type { ExecResult } from "../lib/docker";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { readEnvFile } from "../lib/env";
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
}

const REAL_DEPS: AdminRoutesDeps = {
  getComposeProject,
  getSelfBindSource,
  runCommand,
  schedule: (fn, delayMs) => {
    setTimeout(fn, delayMs);
  },
  resolveEffectiveAiAdmin: () => resolveEffectiveCompose(resolveOverlay({ readEnv: readEnvFile })),
};

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

  /**
   * Response sent BEFORE restart to avoid connection drop.
   * Client polls admin status after receiving response.
   * Uses compose recreate so admin picks up the latest ghcr.io image.
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
      envSource = await deps.getSelfBindSource("/opt/ai-engkit/.env");
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
    const projectDirectory = overlayActive ? hostProjectDirectory(baseFile, resolvedBase) : null;

    deps.schedule(() => {
      // Run compose in a separate container so it survives admin being killed.
      // Use --entrypoint /usr/local/bin/docker with direct args to avoid triple-nested
      // sh -c quoting issues (Bug 4). No shell quoting needed — runCommand passes argv directly.
      const dockerArgs = [
        "docker",
        "run",
        "--rm",
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
        "ghcr.io/tryweb/ai-engkit:latest",
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
      const resultPromise = deps.runCommand(dockerArgs, 120_000);
      resultPromise
        .then((result) => {
          if (result.exitCode !== 0) {
            console.error(
              "[admin] ai-admin compose recreate failed:",
              result.stderr || result.stdout || `exit ${result.exitCode}`,
            );
          }
        })
        .catch((err: unknown) => {
          console.error(
            "[admin] ai-admin compose recreate failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
    }, 2000);

    return c.json({ ok: true, message: "Admin pulling latest image and recreating..." });
  });

  return admin;
}

const admin = createAdminRoutes();

export default admin;
