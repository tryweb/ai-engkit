import { readFileSync } from "fs";
import { Hono } from "hono";
import { execInAiDev, dockerCommand, getAiDevContainerRef, getSelfContainerRef } from "../lib/docker";
import { readEnvFile } from "../lib/env";
import type { VersionsViewData } from "../views/versions";

/**
 * Load component versions + image metadata for server-rendered pages.
 * Returns empty data (instead of throwing) when the backends are unreachable,
 * so pages render with an empty table rather than failing.
 */
export async function loadVersionsPageData(baseUrl: string, headers: Record<string, string>): Promise<VersionsViewData> {
  async function fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`fetch ${url} returned ${res.status}`);
    return res.json();
  }

  // Try the external-facing URL first; fall back to internal localhost
  // (needed when port mapping differs, e.g. host 8081 → container 8080)
  try {
    const [versionsData, imageMeta] = (await Promise.all([
      fetchJson(`${baseUrl}/api/versions`),
      fetchJson(`${baseUrl}/api/versions/image`),
    ])) as [VersionsViewData["versionsByCategory"], VersionsViewData["imageMeta"]];
    return { versionsByCategory: versionsData, imageMeta };
  } catch {
    try {
      const internalBase = `http://localhost:${process.env.ADMIN_PORT || "8080"}`;
      const [versionsData, imageMeta] = (await Promise.all([
        fetchJson(`${internalBase}/api/versions`),
        fetchJson(`${internalBase}/api/versions/image`),
    ])) as [VersionsViewData["versionsByCategory"], VersionsViewData["imageMeta"]];
      return { versionsByCategory: versionsData, imageMeta };
    } catch {
      return { versionsByCategory: {}, imageMeta: {} };
    }
  }
}

export interface UpdateCheckResult {
  current: string;
  latest: string;
  update_available: boolean;
  status: "checking" | "up-to-date" | "update-available" | "check-failed" | "pinned";
  /** The version explicitly configured via AI_ENGKIT_VERSION, when pinned. */
  configured: string | null;
  message: string;
}

// In-memory cache with 5-min TTL
let cachedCheck: { result: UpdateCheckResult; expiresAt: number } | null = null;
let inFlightCheck: Promise<UpdateCheckResult> | null = null;

export const LITERAL_LATEST_REF = "ghcr.io/tryweb/ai-engkit:latest";

export function buildLatestManifestCommand(): string {
  return `manifest inspect ${LITERAL_LATEST_REF} | jq -r '.config.digest'`;
}

async function getRemoteDigest(): Promise<string | null> {
  const result = await dockerCommand(
    buildLatestManifestCommand(),
    15_000,
  );
  if (result.exitCode !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

async function getLocalDigest(): Promise<string | null> {
  const ref = await getAiDevContainerRef();
  const result = await dockerCommand(
    `inspect --format='{{.Image}}' ${ref}`,
    10_000,
  );
  if (result.exitCode !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

export async function getUpdateCheck(): Promise<UpdateCheckResult> {
  const now = Date.now();
  if (cachedCheck && now < cachedCheck.expiresAt) {
    return cachedCheck.result;
  }
  if (inFlightCheck) return inFlightCheck;

  inFlightCheck = (async () => {
    try {
      // A pinned AI_ENGKIT_VERSION locks the environment to that release; do not compare against :latest.
      const configured = readEnvFile().AI_ENGKIT_VERSION?.trim();
      if (configured) {
        const result: UpdateCheckResult = {
          current: await getAiEngkitVersion(),
          latest: "",
          update_available: false,
          status: "pinned",
          configured,
          message: `Pinned to ${configured}`,
        };
        cachedCheck = { result, expiresAt: now + 300_000 };
        return result;
      }

      const current = await getAiEngkitVersion();
      // Dev builds (AI_ENGKIT_VERSION=dev) should not compare against GHCR releases
      if (current === "dev") {
        const result: UpdateCheckResult = { current, latest: "", update_available: false, status: "up-to-date", configured: null, message: "Dev build" };
        cachedCheck = { result, expiresAt: now + 300_000 };
        return result;
      }
      const [remoteDigest, localDigest] = await Promise.all([
        getRemoteDigest(),
        getLocalDigest(),
      ]);
      if (!remoteDigest || !localDigest) {
        return { current, latest: "", update_available: false, status: "up-to-date", configured: null, message: "Up to date" };
      }
      const available = localDigest !== remoteDigest;
      const result: UpdateCheckResult = {
        current,
        latest: available ? "latest" : "",
        update_available: available,
        status: available ? "update-available" : "up-to-date",
        configured: null,
        message: available ? `New image available` : "Up to date",
      };
      cachedCheck = { result, expiresAt: now + 300_000 };
      return result;
    } finally {
      inFlightCheck = null;
    }
  })();

  return inFlightCheck;
}

async function getAiEngkitVersion(): Promise<string> {
  try {
    const result = await execInAiDev("cat /opt/ai-engkit/VERSION", 5_000);
    if (result.exitCode === 0 && result.stdout) {
      return result.stdout.trim();
    }
    return "dev";
  } catch {
    return "dev";
  }
}

const versions = new Hono();

async function getVersion(name: string, command: string): Promise<string> {
  try {
    const result = await execInAiDev(command, 15_000);
    if (result.exitCode === 0 && result.stdout) {
      // Take first line, trim
      return result.stdout.split("\n")[0].trim();
    }
    return "";
  } catch {
    return "";
  }
}

versions.get("/api/versions/check-update", async (c) => {
  const result = await getUpdateCheck();
  return c.json(result);
});

versions.get("/api/versions/image", async (c) => {
  const meta: Record<string, string> = {};
  const ref = await getAiDevContainerRef();

  try {
    const result = await dockerCommand(
      `inspect --format='{{.Config.Image}}' ${ref} 2>/dev/null || echo "unknown"`,
      10_000,
    );
    meta["image"] = result.stdout.trim();
  } catch {
    meta["image"] = "unknown";
  }

  try {
    const digest = await dockerCommand(
      `inspect --format='{{.Image}}' ${ref} 2>/dev/null | cut -d: -f2 | cut -c1-12`,
      10_000,
    );
    meta["digest"] = digest.stdout.trim() || "unknown";
  } catch {
    meta["digest"] = "unknown";
  }

  try {
    const created = await dockerCommand(
      `inspect --format='{{.Created}}' ${ref} 2>/dev/null | cut -d. -f1`,
      10_000,
    );
    meta["created"] = created.stdout.trim() || "unknown";
  } catch {
    meta["created"] = "unknown";
  }

  meta["version"] = await getAiEngkitVersion();

  return c.json(meta);
});

versions.get("/api/versions", async (c) => {
  const categoryCommands: Record<string, Record<string, string>> = {
    core: {
      "OpenCode": "opencode --version 2>/dev/null || echo 'unavailable'",
      "OpenChamber": "/home/devuser/.bun/bin/openchamber --version 2>/dev/null || echo 'unavailable'",
      "lean-ctx": "lean-ctx --version 2>/dev/null || echo 'unavailable'",
      "Bun": "bun --version 2>/dev/null || echo 'unavailable'",
      "Docker": "docker --version 2>/dev/null | cut -d' ' -f3 | tr -d ',' || echo 'unavailable'",
      "Docker Compose": "docker compose version --short 2>/dev/null || echo 'unavailable'",
      "Docker Buildx": "docker buildx version 2>/dev/null | sed 's/.*v//' || echo 'unavailable'",
    },
    cli: {
      "gh": "gh --version 2>/dev/null | head -1 | cut -d' ' -f3 || echo 'unavailable'",
      "glab": "glab --version 2>/dev/null | cut -d' ' -f2 || echo 'unavailable'",
      "Git": "git --version 2>/dev/null | cut -d' ' -f3 || echo 'unavailable'",
      "Playwright": "bunx playwright --version 2>/dev/null | sed 's/^Version //' || echo 'unavailable'",
      "marksman": "marksman --version 2>/dev/null || echo 'unavailable'",
      "codegraph": "codegraph --version 2>/dev/null || echo 'unavailable'",
      "openspec": "openspec --version 2>/dev/null || echo 'unavailable'",
    },
    mcp: {
      "Playwright MCP": "pw-mcp --version 2>/dev/null | sed 's/^Version //' || echo 'unavailable'",
    },
    plugin: {
      "superpowers": "jq -r .version /opt/opencode/baked-plugins/superpowers/package.json 2>/dev/null || echo 'unavailable'",
      "oh-my-opencode-slim": "bunx oh-my-opencode-slim --version 2>/dev/null || echo 'unavailable'",
    },
  };

  const result: Record<string, Record<string, string>> = {};
  for (const [category, commands] of Object.entries(categoryCommands)) {
    const entries = Object.entries(commands);
    const settled = await Promise.allSettled(
      entries.map(([name, cmd]) => getVersion(name, cmd).then((v) => ({ name, version: v }))),
    );
    const categoryResult: Record<string, string> = {};
    for (const r of settled) {
      if (r.status === "fulfilled") {
        categoryResult[r.value.name] = r.value.version;
      }
    }
    result[category] = categoryResult;
  }
  return c.json(result);
});

export default versions;
