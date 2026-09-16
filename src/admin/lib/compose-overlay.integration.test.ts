import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerCommand } from "./docker";
import { validateEffectiveCompose, type ActiveOverlay } from "./compose-overlay";

const FIXTURES = join(import.meta.dir, "../../../test/fixtures/compose-overlay");
const BASE_FILE = join(FIXTURES, "ep-design-base.yml");
const OVERLAY_FILE = join(FIXTURES, "ep-design-overlay.yml");
const EMPTY_ENV = join(FIXTURES, "empty.env");

function dockerComposeAvailable(): boolean {
  try {
    const result = Bun.spawnSync(["docker", "compose", "version"], { stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

const DOCKER_AVAILABLE = dockerComposeAvailable();
const RUN_E2E = process.env["AI_ENGKIT_RUN_DOCKER_E2E"] === "1";

function activeOverlay(path: string): ActiveOverlay {
  return { active: true, reference: "ep-design-overlay.yml", canonicalPath: path };
}

describe.skipIf(!DOCKER_AVAILABLE)("compose overlay validation against real Docker Compose", () => {
  test("accepts the external-network overlay fixture", async () => {
    const result = await validateEffectiveCompose({
      overlay: activeOverlay(OVERLAY_FILE),
      baseFile: BASE_FILE,
      project: "ai-engkit",
      envFile: EMPTY_ENV,
    });
    expect(result).toEqual({ ok: true });
  });

  test("rejects a protected overlay field and never echoes overlay values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "overlay-bad-"));
    const badOverlay = join(dir, "bad.yml");
    writeFileSync(
      badOverlay,
      [
        "services:",
        "  ai-dev:",
        "    container_name: hacked",
        "    environment:",
        "      OPENCODE_SERVER_PASSWORD: super-secret-value",
        "",
      ].join("\n"),
    );
    try {
      const result = await validateEffectiveCompose({
        overlay: activeOverlay(badOverlay),
        baseFile: BASE_FILE,
        project: "ai-engkit",
        envFile: EMPTY_ENV,
      });
      expect(result.ok).toBe(false);
      if ("error" in result) {
        expect(result.error).toContain("protected ai-dev field");
        expect(result.error).not.toContain("super-secret-value");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("merged base+overlay config attaches ai-dev to the external network with the runtime env", async () => {
    const result = await dockerCommand(
      `compose -p ai-engkit --project-directory ${FIXTURES} ` +
        `-f ${BASE_FILE} -f ${OVERLAY_FILE} config --format json`,
      60_000,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      services: Record<string, { networks?: Record<string, unknown>; environment?: Record<string, string> }>;
      networks: Record<string, { external?: boolean }>;
    };
    expect(Object.keys(parsed.services)).toContain("ai-dev");
    expect(parsed.services["ai-dev"]?.networks).toHaveProperty("ep-design_interop");
    expect(parsed.services["ai-dev"]?.environment?.["OPENCHAMBER_OPENCODE_HOSTNAME"]).toBe("0.0.0.0");
    expect(parsed.services["ai-dev"]?.environment?.["OPENCHAMBER_OPENCODE_PORT"]).toBe("4095");
    expect(parsed.networks["ep-design_interop"]?.external).toBe(true);
  });
});

describe.skipIf(!DOCKER_AVAILABLE)("production compose DooD mount contract", () => {
  test("mounts extensions read-only and the staged base rw while preserving /opt/ai-engkit", () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const result = Bun.spawnSync(
      ["docker", "compose", "-f", join(repoRoot, "docker-compose.yml"), "config", "--format", "json"],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.toString()) as {
      services: Record<string, { volumes?: Array<{ type: string; source?: string; target: string; read_only?: boolean }> }>;
    };
    const volumes = parsed.services["ai-admin"]?.volumes ?? [];
    const byTarget = new Map(volumes.map((v) => [v.target, v]));

    const extensions = byTarget.get("/opt/ai-engkit/extensions");
    expect(extensions?.type).toBe("bind");
    expect(extensions?.read_only).toBe(true);
    expect(extensions?.source?.endsWith("/extensions")).toBe(true);

    const stagedBase = byTarget.get("/opt/ai-engkit/compose-upgrade-base.yml");
    expect(stagedBase?.type).toBe("bind");
    expect(stagedBase?.read_only ?? false).toBe(false);
    expect(stagedBase?.source?.endsWith("/admin-data/upgrade-base.yml")).toBe(true);
  });
});

describe.skipIf(!DOCKER_AVAILABLE || !RUN_E2E)("external-network runtime reachability (AI_ENGKIT_RUN_DOCKER_E2E=1)", () => {
  const project = `ep-overlay-e2e-${Date.now()}`;
  const network = "ep-design_interop";
  let createdNetwork = false;

  const composeArgs = `--project-directory ${FIXTURES} -f ${BASE_FILE} -f ${OVERLAY_FILE}`;

  async function workerCheck(): Promise<string> {
    const result = await dockerCommand(
      `run --rm --network ${network} alpine:latest sh -c "for i in 1 2 3 4 5; do ` +
        `wget -qO- -T2 http://ai-dev:4095/ >/dev/null 2>&1 && echo REACHABLE && exit 0; sleep 1; done; echo UNREACHABLE"`,
      60_000,
    );
    return result.stdout.trim();
  }

  afterAll(async () => {
    await dockerCommand(`compose -p ${project} -f ${BASE_FILE} -f ${OVERLAY_FILE} down -v`, 120_000);
    if (createdNetwork) await dockerCommand(`network rm ${network}`, 30_000);
  }, 120_000);

  test(
    "ai-dev and a domain worker resolve each other through ep-design_interop across recreate",
    async () => {
    const inspect = await dockerCommand(`network inspect ${network}`, 15_000);
    if (inspect.exitCode !== 0) {
      const created = await dockerCommand(`network create ${network}`, 30_000);
      expect(created.exitCode).toBe(0);
      createdNetwork = true;
    }

    const up = await dockerCommand(`compose -p ${project} ${composeArgs} up -d ai-dev`, 180_000);
    expect(up.exitCode).toBe(0);
    expect(await workerCheck()).toContain("REACHABLE");

    const recreate = await dockerCommand(
      `compose -p ${project} ${composeArgs} up -d --force-recreate ai-dev`,
      180_000,
    );
    expect(recreate.exitCode).toBe(0);
    expect(await workerCheck()).toContain("REACHABLE");
    },
    120_000,
  );
});
