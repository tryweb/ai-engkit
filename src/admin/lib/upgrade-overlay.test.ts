import { describe, expect, test } from "bun:test";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpgrade, getStatus, getEventLog, type UpgradeDeps } from "./upgrade";
import type { ExecResult } from "./docker";
import {
  resolveOverlay,
  type OverlayFs,
  type ValidateEffectiveOptions,
  type ValidationResult,
} from "./compose-overlay";

const testFs: OverlayFs = {
  exists: existsSync,
  realpath: realpathSync,
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  isReadable: (p) => {
    try {
      accessSync(p, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  size: (p) => {
    try {
      return statSync(p).size;
    } catch {
      return null;
    }
  },
};

const OK: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

function parseEnv(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

interface OverlayWorld {
  readonly dir: string;
  readonly extensionsDir: string;
  readonly overlayFile: string;
  readonly activeFile: string;
  readonly stagedBaseFile: string;
  readonly envFile: string;
  readonly backupDir: string;
  readonly activeBytes: string;
  readonly stagedBytes: string;
  readonly upstreamBase: string;
  readonly composeUpCommands: string[];
  readonly validationCalls: ValidateEffectiveOptions[];
  state: { activeWrites: number; stagedWrites: number };
  readonly deps: UpgradeDeps;
  cleanup: () => void;
}

function makeOverlayWorld(overrides: UpgradeDeps = {}, validation: ValidationResult = { ok: true }): OverlayWorld {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-overlay-"));
  const extensionsDir = join(dir, "extensions");
  mkdirSync(extensionsDir);
  const overlayFile = join(extensionsDir, "ep-design.yml");
  const activeFile = join(dir, "compose.yml");
  const stagedBaseFile = join(dir, "compose-upgrade-base.yml");
  const envFile = join(dir, ".env");
  const backupDir = join(dir, "backups");
  writeFileSync(
    overlayFile,
    "services:\n  ai-dev:\n    environment:\n      OPENCHAMBER_OPENCODE_PORT: \"4095\"\n    networks:\n      - ep-design_interop\nnetworks:\n  ep-design_interop:\n    external: true\n",
  );
  const activeBytes = "services:\n  ai-dev:\n    image: old-active\n";
  const stagedBytes = "services:\n  ai-dev:\n    image: prior-staged\n";
  const upstreamBase = "services:\n  ai-dev:\n    image: new-upstream\n";
  writeFileSync(activeFile, activeBytes);
  writeFileSync(stagedBaseFile, stagedBytes);
  writeFileSync(envFile, "AI_ENGKIT_COMPOSE_OVERLAY=ep-design.yml\nBACKUP_RETENTION=5\nSECRET=dotenv-secret\n");

  const composeUpCommands: string[] = [];
  const validationCalls: ValidateEffectiveOptions[] = [];
  const state = { activeWrites: 0, stagedWrites: 0 };

  const deps: UpgradeDeps = {
    backupDir,
    composeFile: activeFile,
    stagedBaseFile,
    envFile,
    keysFile: join(dir, "provider-keys.json"),
    versionFile: join(dir, "VERSION"),
    resolveImage: () => "ghcr.io/tryweb/ai-engkit:latest",
    readLocalVersion: () => "v1.2.0",
    ensureComposeFile: async () => {},
    pullImage: async () => OK,
    getContainerRef: async () => "fake-container",
    snapshotSettings: async (_ref, dest) => {
      writeFileSync(dest, "{}");
      return OK;
    },
    fetchComposeText: async () => upstreamBase,
    writeComposeText: (content) => {
      writeFileSync(activeFile, content);
      state.activeWrites++;
    },
    writeStagedBase: (content) => {
      writeFileSync(stagedBaseFile, content);
      state.stagedWrites++;
    },
    getProject: async () => "ai-engkit",
    composeUp: async (subcommand) => {
      composeUpCommands.push(subcommand);
      return OK;
    },
    resolveOverlayState: () =>
      resolveOverlay({
        readEnv: () => parseEnv(envFile),
        paths: { extensionsDir, activeFile, stagedBaseFile, envFile },
        fs: testFs,
      }),
    validateOverlay: async (options) => {
      validationCalls.push(options);
      return validation;
    },
    reconcile: async () => OK,
    pruneOld: () => [],
    pruneImages: async () => OK,
    readEnv: () => parseEnv(envFile),
    writeEnv: (vars) => {
      writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    },
    fetchEnvExample: async () => null,
    isRunning: async () => true,
    sleepMs: async () => {},
    ...overrides,
  };

  return {
    dir,
    extensionsDir,
    overlayFile,
    activeFile,
    stagedBaseFile,
    envFile,
    backupDir,
    activeBytes,
    stagedBytes,
    upstreamBase,
    composeUpCommands,
    validationCalls,
    state,
    deps,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function firstBackupDir(backupDir: string): string {
  const entry = readdirSync(backupDir).find((name) => name.startsWith("pre-"));
  if (!entry) throw new Error("no backup directory created");
  return join(backupDir, entry);
}

describe("runUpgrade with a domain overlay", () => {
  test("stages the upstream base and recreates with base+overlay without overwriting the active file", async () => {
    const world = makeOverlayWorld();
    try {
      expect(await runUpgrade(world.deps)).toBe(true);
      expect(world.state.activeWrites).toBe(0);
      expect(world.state.stagedWrites).toBe(1);
      expect(readFileSync(world.activeFile, "utf-8")).toBe(world.activeBytes);
      expect(readFileSync(world.stagedBaseFile, "utf-8")).toBe(world.upstreamBase);

      expect(world.composeUpCommands).toHaveLength(1);
      const command = world.composeUpCommands[0];
      expect(command).toContain("--project-directory /opt/ai-engkit");
      expect(command).toContain(`-f ${world.stagedBaseFile}`);
      expect(command).toContain(`-f '${realpathSync(world.overlayFile)}'`);
      expect(command).toContain("up -d --force-recreate ai-dev");

      expect(world.validationCalls).toHaveLength(1);
      expect(world.validationCalls[0].baseFile).toBe(`${world.stagedBaseFile}.staging`);
      expect(world.validationCalls[0].overlay.canonicalPath).toBe(realpathSync(world.overlayFile));

      const events = getEventLog();
      expect(events.some((e) => e.message.includes("Domain overlay ep-design.yml active"))).toBe(true);
      expect(events.some((e) => e.message.includes("Effective base+overlay configuration validated"))).toBe(true);
    } finally {
      world.cleanup();
    }
  });

  test("backs up base, overlay, and env with owner-only modes and never logs secrets", async () => {
    const world = makeOverlayWorld();
    try {
      expect(await runUpgrade(world.deps)).toBe(true);
      const backup = firstBackupDir(world.backupDir);
      expect(modeOf(backup)).toBe(0o700);
      expect(modeOf(join(backup, ".env"))).toBe(0o600);
      expect(modeOf(join(backup, "compose.yml"))).toBe(0o600);
      expect(modeOf(join(backup, "compose-upgrade-base.yml"))).toBe(0o600);
      expect(modeOf(join(backup, "overlay", "ep-design.yml"))).toBe(0o600);
      expect(modeOf(join(backup, "overlay-reference.txt"))).toBe(0o600);
      expect(existsSync(join(backup, "openchamber-settings.json"))).toBe(true);

      const logged = getEventLog().map((e) => e.message).join("\n");
      expect(logged).not.toContain("dotenv-secret");
      expect(logged).not.toContain("OPENCHAMBER_OPENCODE_PORT");
      expect(logged).toContain("domain overlay ep-design.yml preserved");
    } finally {
      world.cleanup();
    }
  });

  test("fails before recreation when effective validation fails and leaves the stored base untouched", async () => {
    const world = makeOverlayWorld({}, { ok: false, error: 'overlay must not change protected ai-dev field "image"' });
    try {
      expect(await runUpgrade(world.deps)).toBe(false);
      const failure = getEventLog().find((e) => e.status === "failure");
      expect(failure?.message).toContain("Effective Compose validation failed");
      expect(failure?.message).toContain("protected ai-dev field");
      expect(failure?.message).toContain("validation failed before recreate");
      expect(world.composeUpCommands).toHaveLength(0);
      expect(world.state.stagedWrites).toBe(0);
      expect(readFileSync(world.stagedBaseFile, "utf-8")).toBe(world.stagedBytes);
      expect(readFileSync(world.activeFile, "utf-8")).toBe(world.activeBytes);
      expect(existsSync(`${world.stagedBaseFile}.staging`)).toBe(false);
    } finally {
      world.cleanup();
    }
  });

  test("restores the prior base and re-runs base+overlay after a health failure", async () => {
    const world = makeOverlayWorld({ isRunning: async () => false, healthTimeoutMs: 20, intervalMs: 1 });
    try {
      expect(await runUpgrade(world.deps)).toBe(false);
      const failure = getEventLog().find((e) => e.status === "failure");
      expect(failure?.step).toBe("poll_health");
      expect(failure?.message).toContain("did not become healthy");
      expect(failure?.message).toContain("restored .env, compose.yml, compose-upgrade-base.yml");
      expect(world.composeUpCommands).toHaveLength(2);
      for (const command of world.composeUpCommands) {
        expect(command).toContain("--project-directory /opt/ai-engkit");
        expect(command).toContain(`-f '${realpathSync(world.overlayFile)}'`);
      }
      expect(readFileSync(world.stagedBaseFile, "utf-8")).toBe(world.stagedBytes);
    } finally {
      world.cleanup();
    }
  });

  test("falls back to the active base and overlay when the restored staged base is empty", async () => {
    const world = makeOverlayWorld({ isRunning: async () => false, healthTimeoutMs: 20, intervalMs: 1 });
    try {
      // Fresh installs stage a zero-byte base; a health rollback must not
      // recompose the prior configuration against that empty file.
      writeFileSync(world.stagedBaseFile, "");
      expect(await runUpgrade(world.deps)).toBe(false);
      const failure = getEventLog().find((e) => e.status === "failure");
      expect(failure?.step).toBe("poll_health");
      expect(failure?.message).toContain("did not become healthy");
      expect(failure?.message).toContain("restored .env, compose.yml, compose-upgrade-base.yml");
      expect(failure?.message).toContain("and re-ran compose up");
      expect(failure?.message).not.toContain("overlay restore incomplete");

      expect(world.composeUpCommands).toHaveLength(2);
      const rollbackCommand = world.composeUpCommands[1];
      expect(rollbackCommand).not.toContain(`-f ${world.stagedBaseFile}`);
      expect(rollbackCommand).toContain(`-f ${world.activeFile}`);
      expect(rollbackCommand).toContain(`-f '${realpathSync(world.overlayFile)}'`);
      expect(rollbackCommand).toContain("--project-directory /opt/ai-engkit");

      expect(readFileSync(world.stagedBaseFile, "utf-8")).toBe("");
      expect(readFileSync(world.activeFile, "utf-8")).toBe(world.activeBytes);
    } finally {
      world.cleanup();
    }
  });

  test("upgrade status carries sanitized overlay state", () => {
    const status = getStatus();
    expect(status.overlay).toBeDefined();
    expect(typeof status.overlay.configured).toBe("boolean");
    expect(typeof status.overlay.active).toBe("boolean");
  });

  test("reports configured and active status for a valid overlay via the injected seam", () => {
    const world = makeOverlayWorld();
    try {
      const status = getStatus({
        readEnv: () => parseEnv(world.envFile),
        paths: {
          extensionsDir: world.extensionsDir,
          activeFile: world.activeFile,
          stagedBaseFile: world.stagedBaseFile,
          envFile: world.envFile,
        },
        fs: testFs,
      });
      expect(status.overlay.configured).toBe(true);
      expect(status.overlay.active).toBe(true);
      expect(status.overlay.reference).toBe("ep-design.yml");
      expect(status.overlay.error).toBeNull();
      const serialized = JSON.stringify(status.overlay);
      expect(serialized).not.toContain("OPENCHAMBER_OPENCODE_PORT");
      expect(serialized).not.toContain("4095");
    } finally {
      world.cleanup();
    }
  });
});
