import { describe, expect, test } from "bun:test";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_COMPOSE_FILE,
  DEFAULT_OVERLAY_PATHS,
  OverlayConfigError,
  buildRecreateSubcommand,
  getOverlayStatus,
  requireAiDevService,
  resolveEffectiveCompose,
  resolveOverlay,
  resolveValidatedEffectiveCompose,
  sanitizeComposeError,
  validateOverlayAloneJson,
  type OverlayFs,
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

interface World {
  readonly dir: string;
  readonly extensions: string;
  readonly overlay: string;
  readonly activeFile: string;
  readonly stagedBase: string;
  readonly envFile: string;
  readonly paths: typeof DEFAULT_OVERLAY_PATHS;
  cleanup: () => void;
}

function makeWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), "overlay-unit-"));
  const extensions = join(dir, "extensions");
  mkdirSync(extensions);
  const activeFile = join(dir, "compose.yml");
  const stagedBase = join(dir, "compose-upgrade-base.yml");
  const envFile = join(dir, ".env");
  writeFileSync(activeFile, "services:\n  ai-dev:\n    image: base\n");
  writeFileSync(stagedBase, "services:\n  ai-dev:\n    image: staged\n");
  writeFileSync(envFile, "");
  const overlay = join(extensions, "ep-design.yml");
  writeFileSync(overlay, "services:\n  ai-dev:\n    environment:\n      FOO: bar\n");
  return {
    dir,
    extensions,
    overlay,
    activeFile,
    stagedBase,
    envFile,
    paths: {
      extensionsDir: extensions,
      activeFile,
      stagedBaseFile: stagedBase,
      envFile,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("resolveOverlay", () => {
  test("returns inactive when the key is missing or empty", () => {
    expect(resolveOverlay({ readEnv: () => ({}), fs: testFs })).toEqual({ active: false });
    expect(resolveOverlay({ readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "" }), fs: testFs })).toEqual({ active: false });
    expect(resolveOverlay({ readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "   " }), fs: testFs })).toEqual({ active: false });
  });

  test("resolves a bare filename beneath the extensions directory", () => {
    const w = makeWorld();
    try {
      const resolved = resolveOverlay({
        readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "ep-design.yml" }),
        fs: testFs,
        paths: w.paths,
      });
      expect(resolved.active).toBe(true);
      if (resolved.active) expect(resolved.canonicalPath).toBe(realpathSync(w.overlay));
    } finally {
      w.cleanup();
    }
  });

  test("resolves an absolute path beneath the extensions directory", () => {
    const w = makeWorld();
    try {
      const resolved = resolveOverlay({
        readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: w.overlay }),
        fs: testFs,
        paths: w.paths,
      });
      expect(resolved.active).toBe(true);
    } finally {
      w.cleanup();
    }
  });

  test("rejects parent-directory escapes with a sanitized message", () => {
    const w = makeWorld();
    try {
      expect(() =>
        resolveOverlay({
          readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "../escape.yml" }),
          fs: testFs,
          paths: w.paths,
        }),
      ).toThrow(OverlayConfigError);
      expect(() =>
        resolveOverlay({
          readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "../../etc/passwd" }),
          fs: testFs,
          paths: w.paths,
        }),
      ).toThrow(/must resolve beneath/);
    } finally {
      w.cleanup();
    }
  });

  test("rejects an absolute path outside the extensions directory", () => {
    const w = makeWorld();
    try {
      expect(() =>
        resolveOverlay({
          readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "/etc/passwd" }),
          fs: testFs,
          paths: w.paths,
        }),
      ).toThrow(/must resolve beneath/);
    } finally {
      w.cleanup();
    }
  });

  test("rejects a symlink whose canonical target escapes extensions", () => {
    const w = makeWorld();
    try {
      const outside = join(w.dir, "outside.yml");
      writeFileSync(outside, "services: {}\n");
      const link = join(w.extensions, "link.yml");
      symlinkSync(outside, link);
      expect(() =>
        resolveOverlay({
          readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "link.yml" }),
          fs: testFs,
          paths: w.paths,
        }),
      ).toThrow(/must resolve beneath/);
    } finally {
      w.cleanup();
    }
  });

  test("rejects missing, non-file, and control-character paths", () => {
    const w = makeWorld();
    try {
      expect(() =>
        resolveOverlay({
          readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "missing.yml" }),
          fs: testFs,
          paths: w.paths,
        }),
      ).toThrow(/does not exist/);

      mkdirSync(join(w.extensions, "adirectory.yml"));
      expect(() =>
        resolveOverlay({
          readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "adirectory.yml" }),
          fs: testFs,
          paths: w.paths,
        }),
      ).toThrow(/must reference a regular file/);

      expect(() =>
        resolveOverlay({
          readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "bad\u0000name.yml" }),
          fs: testFs,
          paths: w.paths,
        }),
      ).toThrow(/does not exist/);
    } finally {
      w.cleanup();
    }
  });

  test("reports inaccessible paths without leaking overlay contents", () => {
    const w = makeWorld();
    try {
      const secret = "OPENCODE_SERVER_PASSWORD=super-secret";
      writeFileSync(w.overlay, secret);
      const unreadableFs: OverlayFs = { ...testFs, isReadable: () => false };
      try {
        resolveOverlay({
          readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "ep-design.yml" }),
          fs: unreadableFs,
          paths: w.paths,
        });
        throw new Error("expected resolveOverlay to throw");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("not readable");
        expect(message).not.toContain("super-secret");
      }
    } finally {
      w.cleanup();
    }
  });
});

describe("resolveEffectiveCompose", () => {
  test("returns the single active file with no overlay", () => {
    const effective = resolveEffectiveCompose({ active: false }, { paths: { activeFile: ACTIVE_COMPOSE_FILE } });
    expect(effective).toEqual({ overlayActive: false, files: [ACTIVE_COMPOSE_FILE], overlayReference: null });
  });

  test("orders staged base before the overlay deterministically", () => {
    const w = makeWorld();
    try {
      const overlay = resolveOverlay({
        readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "ep-design.yml" }),
        fs: testFs,
        paths: w.paths,
      });
      const first = resolveEffectiveCompose(overlay, { paths: w.paths, fs: testFs });
      const second = resolveEffectiveCompose(overlay, { paths: w.paths, fs: testFs });
      expect(first.files).toEqual([w.stagedBase, realpathSync(w.overlay)]);
      expect(second.files).toEqual(first.files);
      expect(first.overlayReference).toBe("ep-design.yml");
    } finally {
      w.cleanup();
    }
  });

  test("falls back to the active file when the staged base is empty", () => {
    const w = makeWorld();
    try {
      writeFileSync(w.stagedBase, "");
      const overlay = resolveOverlay({
        readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "ep-design.yml" }),
        fs: testFs,
        paths: w.paths,
      });
      const effective = resolveEffectiveCompose(overlay, { paths: w.paths, fs: testFs });
      expect(effective.files).toEqual([w.activeFile, realpathSync(w.overlay)]);
    } finally {
      w.cleanup();
    }
  });

  test("throws when neither base file is usable", () => {
    const w = makeWorld();
    try {
      rmSync(w.stagedBase);
      rmSync(w.activeFile);
      const overlay = resolveOverlay({
        readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "ep-design.yml" }),
        fs: testFs,
        paths: w.paths,
      });
      expect(() => resolveEffectiveCompose(overlay, { paths: w.paths, fs: testFs })).toThrow(OverlayConfigError);
    } finally {
      w.cleanup();
    }
  });
});

describe("buildRecreateSubcommand", () => {
  test("keeps the historical single-file command for no overlay", () => {
    const command = buildRecreateSubcommand({
      project: "ai-engkit",
      envFile: "/opt/ai-engkit/.env",
      effective: { overlayActive: false, files: ["/opt/ai-engkit/compose.yml"], overlayReference: null },
      action: "up -d --force-recreate ai-dev",
      trace: " 2>&1",
    });
    expect(command).toBe(
      "compose -p ai-engkit --env-file /opt/ai-engkit/.env -f /opt/ai-engkit/compose.yml up -d --force-recreate ai-dev 2>&1",
    );
  });

  test("adds the project directory and both files with an overlay", () => {
    const command = buildRecreateSubcommand({
      project: "ai-engkit",
      envFile: "/opt/ai-engkit/.env",
      effective: {
        overlayActive: true,
        files: ["/opt/ai-engkit/compose-upgrade-base.yml", "/opt/ai-engkit/extensions/ep-design.yml"],
        overlayReference: "ep-design.yml",
      },
      action: "up -d ai-dev",
    });
    expect(command).toBe(
      "compose -p ai-engkit --project-directory /opt/ai-engkit --env-file /opt/ai-engkit/.env " +
        "-f /opt/ai-engkit/compose-upgrade-base.yml -f '/opt/ai-engkit/extensions/ep-design.yml' up -d ai-dev",
    );
  });
});

describe("validateOverlayAloneJson", () => {
  const valid = JSON.stringify({
    name: "ai-engkit",
    services: {
      "ai-dev": {
        command: null,
        entrypoint: null,
        environment: { FOO: "bar" },
        networks: { "ep-design_interop": null },
        volumes: [{ type: "volume", source: "ep-data", target: "/data" }],
        labels: { owner: "domain" },
        healthcheck: { test: ["CMD", "true"] },
      },
    },
    networks: { "ep-design_interop": { external: true } },
    volumes: { "ep-data": { external: true } },
  });

  test("accepts the allowed ai-dev surface", () => {
    expect(validateOverlayAloneJson(valid)).toEqual({ ok: true });
  });

  test("rejects a foreign service", () => {
    const bad = JSON.stringify({ services: { "ai-dev": {}, worker: { image: "x" } } });
    expect(validateOverlayAloneJson(bad).ok).toBe(false);
    if (!validateOverlayAloneJson(bad).ok) {
      expect((validateOverlayAloneJson(bad) as { error: string }).error).toContain("worker");
    }
  });

  test("rejects a missing ai-dev service", () => {
    expect(validateOverlayAloneJson(JSON.stringify({ services: {} })).ok).toBe(false);
  });

  test("rejects protected fields", () => {
    for (const key of ["image", "container_name", "ports", "privileged", "network_mode"]) {
      const payload = JSON.stringify({ services: { "ai-dev": { [key]: "x" } } });
      const result = validateOverlayAloneJson(payload);
      expect(result.ok).toBe(false);
      if ("error" in result) expect(result.error).toContain(key);
    }
  });

  test("rejects a non-null command or entrypoint but allows the null normalization", () => {
    expect(validateOverlayAloneJson(JSON.stringify({ services: { "ai-dev": { command: null, entrypoint: null } } })).ok).toBe(true);
    expect(validateOverlayAloneJson(JSON.stringify({ services: { "ai-dev": { command: ["sh"] } } })).ok).toBe(false);
  });

  test("rejects unknown service and top-level keys", () => {
    expect(validateOverlayAloneJson(JSON.stringify({ services: { "ai-dev": { user: "root" } } })).ok).toBe(false);
    expect(validateOverlayAloneJson(JSON.stringify({ services: { "ai-dev": {} }, configs: {} })).ok).toBe(false);
  });

  test("rejects a Docker socket bind mount", () => {
    const payload = JSON.stringify({
      services: {
        "ai-dev": { volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }] },
      },
    });
    const result = validateOverlayAloneJson(payload);
    expect(result.ok).toBe(false);
    if ("error" in result) expect(result.error).toContain("Docker socket");
  });

  test("rejects arbitrary host bind mounts while allowing named volumes", () => {
    for (const source of ["/", "/etc", "/host", "/opt/ai-engkit"]) {
      const payload = JSON.stringify({
        services: { "ai-dev": { volumes: [{ type: "bind", source, target: "/mnt/data" }] } },
      });
      const result = validateOverlayAloneJson(payload);
      expect(result.ok).toBe(false);
      if ("error" in result) expect(result.error).toContain("bind-mount");
    }

    const named = JSON.stringify({
      services: { "ai-dev": { volumes: [{ type: "volume", source: "ep-data", target: "/data" }] } },
    });
    expect(validateOverlayAloneJson(named)).toEqual({ ok: true });
  });

  test("rejects malformed JSON and non-object roots", () => {
    expect(validateOverlayAloneJson("not json").ok).toBe(false);
    expect(validateOverlayAloneJson("[]").ok).toBe(false);
    expect(validateOverlayAloneJson("{}").ok).toBe(false);
  });
});

describe("requireAiDevService", () => {
  test("accepts a merged config containing ai-dev and rejects its absence", () => {
    expect(requireAiDevService(JSON.stringify({ services: { "ai-dev": { image: "x" } } }))).toEqual({ ok: true });
    expect(requireAiDevService(JSON.stringify({ services: { "ai-admin": {} } })).ok).toBe(false);
    expect(requireAiDevService("nope").ok).toBe(false);
  });
});

describe("sanitizeComposeError", () => {
  test("returns only the first diagnostic line and redacts assignment values", () => {
    const sanitized = sanitizeComposeError("FOO=secret-value bar\nSECRET=abc\u0000def");
    expect(sanitized).toBe("FOO=[redacted] bar");
    expect(sanitized).not.toContain("\u0000");
    expect(sanitizeComposeError("open /x\nFOO=other-secret")).toBe("open /x");
  });

  test("handles empty output", () => {
    expect(sanitizeComposeError("   \n")).toBe("no diagnostic output");
  });
});

describe("resolveValidatedEffectiveCompose", () => {
  const validOverlayJson = JSON.stringify({ services: { "ai-dev": { environment: { FOO: "bar" } } } });

  test("returns the historical single-file config without validating when no overlay is configured", async () => {
    const w = makeWorld();
    let composeCalls = 0;
    try {
      const effective = await resolveValidatedEffectiveCompose({
        project: "ai-engkit",
        readEnv: () => ({}),
        fs: testFs,
        paths: w.paths,
        compose: async () => {
          composeCalls += 1;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      expect(effective).toEqual({ overlayActive: false, files: [w.activeFile], overlayReference: null });
      expect(composeCalls).toBe(0);
    } finally {
      w.cleanup();
    }
  });

  test("validates and returns the ordered effective config when the overlay is active", async () => {
    const w = makeWorld();
    const subcommands: string[] = [];
    try {
      const effective = await resolveValidatedEffectiveCompose({
        project: "ai-engkit",
        readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "ep-design.yml" }),
        fs: testFs,
        paths: w.paths,
        compose: async (subcommand) => {
          subcommands.push(subcommand);
          return { stdout: validOverlayJson, stderr: "", exitCode: 0 };
        },
      });
      expect(effective).toEqual({
        overlayActive: true,
        files: [w.stagedBase, realpathSync(w.overlay)],
        overlayReference: "ep-design.yml",
      });
      expect(subcommands).toHaveLength(2);
      expect(subcommands[0]).toContain("config --no-consistency");
      expect(subcommands[1]).toContain(`-f ${w.stagedBase}`);
    } finally {
      w.cleanup();
    }
  });

  test("fails closed with a sanitized error when the active overlay violates validation", async () => {
    const w = makeWorld();
    try {
      const failure = await resolveValidatedEffectiveCompose({
        project: "ai-engkit",
        readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "ep-design.yml" }),
        fs: testFs,
        paths: w.paths,
        compose: async () => ({
          stdout: JSON.stringify({
            services: { "ai-dev": { volumes: [{ type: "bind", source: "/etc", target: "/mnt/data" }] } },
          }),
          stderr: "",
          exitCode: 0,
        }),
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OverlayConfigError);
      if (failure instanceof OverlayConfigError) expect(failure.message).toContain("bind-mount");
    } finally {
      w.cleanup();
    }
  });

  test("never echoes compose secrets through the helper failure", async () => {
    const w = makeWorld();
    try {
      const failure = await resolveValidatedEffectiveCompose({
        project: "ai-engkit",
        readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "ep-design.yml" }),
        fs: testFs,
        paths: w.paths,
        compose: async () => ({ stdout: "", stderr: "FOO=super-secret-value\nboom", exitCode: 1 }),
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OverlayConfigError);
      if (failure instanceof OverlayConfigError) {
        expect(failure.message).toContain("overlay validation failed");
        expect(failure.message).not.toContain("super-secret-value");
      }
    } finally {
      w.cleanup();
    }
  });
});

describe("getOverlayStatus", () => {
  test("reports inactive for a missing key and sanitized errors for invalid configs", () => {
    expect(getOverlayStatus({ readEnv: () => ({}), fs: testFs })).toEqual({
      configured: false,
      active: false,
      reference: null,
      error: null,
    });
    const w = makeWorld();
    try {
      const status = getOverlayStatus({
        readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "missing.yml" }),
        fs: testFs,
        paths: w.paths,
      });
      expect(status.configured).toBe(true);
      expect(status.active).toBe(false);
      expect(status.reference).toBe("missing.yml");
      expect(status.error).toContain("does not exist");
    } finally {
      w.cleanup();
    }
  });

  test("reports an active valid overlay", () => {
    const w = makeWorld();
    try {
      const status = getOverlayStatus({
        readEnv: () => ({ AI_ENGKIT_COMPOSE_OVERLAY: "ep-design.yml" }),
        fs: testFs,
        paths: w.paths,
      });
      expect(status).toEqual({ configured: true, active: true, reference: "ep-design.yml", error: null });
    } finally {
      w.cleanup();
    }
  });
});
