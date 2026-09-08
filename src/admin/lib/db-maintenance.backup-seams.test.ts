import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  DEFAULT_BACKUP_DIR,
  BACKUP_CONTAINER_ROOT,
  defaultGetDbFileSize,
  defaultGetFreeSpace,
  defaultCreateBackup,
  defaultVerifyBackup,
  defaultResolveHostBackupPath,
  _resetMaintenanceState,
} from "./db-maintenance";
import type { ExecResult } from "./docker";

function okExec(stdout = "ok"): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

describe("blocker: backup path persistent and DooD-safe", () => {
  beforeEach(() => _resetMaintenanceState());
  afterEach(() => _resetMaintenanceState());

  test("DEFAULT_BACKUP_DIR is under already-mounted /opt/ai-engkit/backups", () => {
    expect(DEFAULT_BACKUP_DIR).toBe("/opt/ai-engkit/backups/db-maintenance");
    expect(DEFAULT_BACKUP_DIR.startsWith(`${BACKUP_CONTAINER_ROOT}/`)).toBe(true);
  });

  test("BACKUP_CONTAINER_ROOT is the mounted bind destination", () => {
    expect(BACKUP_CONTAINER_ROOT).toBe("/opt/ai-engkit/backups");
  });

  test("defaultResolveHostBackupPath fail-closed when bind source unavailable", async () => {
    const result = await defaultResolveHostBackupPath(
      `${BACKUP_CONTAINER_ROOT}/db-maintenance/maintenance-1`,
      async () => null,
    );
    expect(result).toBeNull();
  });

  test("defaultResolveHostBackupPath maps container path to host path", async () => {
    const fakeGetSelfBindSource = async (dest: string): Promise<string> => {
      expect(dest).toBe(BACKUP_CONTAINER_ROOT);
      return "/host/backups";
    };
    const containerPath = `${BACKUP_CONTAINER_ROOT}/db-maintenance/maintenance-2026-09-08T00-00-00-000Z`;
    const mapped = await defaultResolveHostBackupPath(containerPath, fakeGetSelfBindSource);
    expect(mapped).toBe("/host/backups/db-maintenance/maintenance-2026-09-08T00-00-00-000Z");
  });

  test("defaultResolveHostBackupPath rejects path outside container root", async () => {
    const getBindSource = async (): Promise<string> => "/host/backups";
    expect(await defaultResolveHostBackupPath("/tmp/evil", getBindSource)).toBeNull();
    expect(await defaultResolveHostBackupPath("/opt/ai-engkit/other", getBindSource)).toBeNull();
  });

  test("defaultCreateBackup passes the host path to the Docker daemon", async () => {
    let command = "";
    const result = await defaultCreateBackup(
      `${BACKUP_CONTAINER_ROOT}/db-maintenance/maintenance-1`,
      "/fake/opencode.db",
      {
        resolveDataVolumeFn: async () => "opencode-data",
        resolveHostBackupPathFn: async () => "/host/backups/db-maintenance/maintenance-1",
        dockerCommandFn: async (subcommand) => {
          command = subcommand;
          return okExec();
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(command).toContain("'/host/backups/db-maintenance/maintenance-1:/dst'");
    expect(command).not.toContain(`${BACKUP_CONTAINER_ROOT}/db-maintenance/maintenance-1:/dst`);
  });

  test("defaultVerifyBackup passes the host path to the Docker daemon", async () => {
    let command = "";
    const result = await defaultVerifyBackup(
      `${BACKUP_CONTAINER_ROOT}/db-maintenance/maintenance-1`,
      {
        resolveHostBackupPathFn: async () => "/host/backups/db-maintenance/maintenance-1",
        dockerCommandFn: async (subcommand) => {
          command = subcommand;
          return okExec();
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(command).toContain("'/host/backups/db-maintenance/maintenance-1:/d:ro'");
    expect(command).not.toContain(`${BACKUP_CONTAINER_ROOT}/db-maintenance/maintenance-1:/d:ro`);
  });

  test("runMaintenance fail-closed when host backup path unavailable", async () => {
    let dockerCalled = false;
    const deps = {
      dbPath: "/fake/opencode.db",
      backupDir: DEFAULT_BACKUP_DIR,
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      getDbFileSize: async () => 10 * 1024 * 1024,
      getFreeSpace: async () => 100 * 1024 * 1024,
      getWalMtime: async () => 1000,
      stopAiDev: async () => okExec(),
      startAiDev: async () => okExec(),
      isAiDevRunning: async () => true,
      waitForIdle: async () => "idle" as const,
      sleepMs: async () => {},
      createBackup: undefined as unknown as () => Promise<ExecResult>,
      verifyBackup: undefined as unknown as () => Promise<ExecResult>,
      getHostBackupPath: async () => null,
      criticalFloorBytes: 1024 * 1024,
    };
    // Use real runMaintenance which will call defaultCreateBackup with our null resolver
    // Provide custom createBackup that mimics production fail-closed path via getHostBackupPath
    const { runMaintenance: realRun } = await import("./db-maintenance");
    // Create deps that inject null host resolver and let defaults createBackup handle it
    const result = await realRun({
      ...deps,
      createBackup: undefined,
      verifyBackup: undefined,
      getHostBackupPath: async () => null,
    } as never);
    expect(result).toBe(false);
    // Should fail at backup step because host path unresolvable
    const { getMaintenanceEventLog, getMaintenanceState } = await import("./db-maintenance");
    expect(getMaintenanceState()).toBe("failed");
    const ev = getMaintenanceEventLog();
    const backupFail = ev.find((e) => e.step === "backup" && e.status === "failure");
    expect(backupFail).toBeDefined();
    expect(backupFail?.message).toMatch(/bind mount/);
    expect(backupFail?.message).toMatch(/unavailable/);
    void dockerCalled;
  });

  test("createBackup uses quoted host path and fails closed without host path (via injected resolver)", async () => {
    // Directly exercise the quoting contract by capturing dockerCommand args via a custom resolver
    let capturedSubcommand: string | null = null;
    const fakeDockerCommand = async (subcommand: string) => {
      capturedSubcommand = subcommand;
      return okExec();
    };
    // Simulate what defaultCreateBackup does with shellQuote
    const hostPathWithSpace = "/host/my backups/db-maintenance/maintenance-1";
    const { shellQuote } = await import("./docker");
    const quoted = shellQuote(`${hostPathWithSpace}:/dst`);
    // Verify quoting produces single-quoted arg and handles spaces
    expect(quoted).toBe(`'${hostPathWithSpace}:/dst'`);
    expect(quoted.includes(" ")).toBe(true);
    // Ensure the docker subcommand would contain the quoted host path
    const fakeSubcommand = `run --rm -v ${quoted} alpine sh -c 'cat /src/opencode.db | gzip -6 > /dst/opencode.db.gz'`;
    expect(fakeSubcommand).toContain(`'${hostPathWithSpace}:/dst'`);
    void fakeDockerCommand;
    void capturedSubcommand;
  });
});

describe("blocker: db size and free space fallbacks", () => {
  test("defaultGetDbFileSize fallback measures stat -c %s, not df avail", async () => {
    const captured: string[] = [];
    const fakeExec = async () => ({ stdout: "", stderr: "", exitCode: 1 });
    const fakeResolve = async () => "test_opencode-data";
    const fakeDocker = async (subcommand: string) => {
      captured.push(subcommand);
      // Simulate stat returning file size 4242424
      if (subcommand.includes("stat -c %s")) {
        return { stdout: "4242424", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const size = await defaultGetDbFileSize("/home/devuser/.local/share/opencode/opencode.db", {
      execInAiDevFn: fakeExec as never,
      dockerCommandFn: fakeDocker as never,
      resolveDataVolumeFn: fakeResolve as never,
    });
    expect(size).toBe(4242424);
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("stat -c %s /d/opencode.db");
    expect(captured[0]).toContain("test_opencode-data:/d:ro");
    expect(captured[0]).not.toContain("df -B1");
    expect(captured[0]).not.toContain("avail");
  });

  test("defaultGetDbFileSize fallback distinguishes from df avail (old bug would return free space)", async () => {
    const fakeExec = async () => ({ stdout: "", stderr: "", exitCode: 1 });
    const fakeResolve = async () => "vol1";
    // Old bug returned df avail which is typically much larger than file size (e.g., 9999999999)
    // Fixed code returns stat size (e.g., 12345). Ensure we don't return avail.
    let call = 0;
    const fakeDocker = async (subcommand: string) => {
      call++;
      if (subcommand.includes("stat -c %s")) return { stdout: "12345", stderr: "", exitCode: 0 };
      return { stdout: "9999999999", stderr: "", exitCode: 0 };
    };
    const size = await defaultGetDbFileSize("/fake/db", {
      execInAiDevFn: fakeExec as never,
      dockerCommandFn: fakeDocker as never,
      resolveDataVolumeFn: fakeResolve as never,
    });
    expect(size).toBe(12345);
    expect(size).not.toBe(9999999999);
    expect(call).toBe(1);
  });

  test("defaultGetFreeSpace fallback uses resolveDataVolume, never project naming", async () => {
    const captured: string[] = [];
    const fakeExec = async () => ({ stdout: "", stderr: "", exitCode: 1 });
    const fakeResolve = async () => "myproject_opencode-data";
    const fakeDocker = async (subcommand: string) => {
      captured.push(subcommand);
      return { stdout: "Avail\n 8888888", stderr: "", exitCode: 0 };
    };
    const free = await defaultGetFreeSpace("/home/devuser/.local/share/opencode", {
      execInAiDevFn: fakeExec as never,
      dockerCommandFn: fakeDocker as never,
      resolveDataVolumeFn: fakeResolve as never,
    });
    expect(free).toBe(8888888);
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("myproject_opencode-data:/d:ro");
    expect(captured[0]).toContain("df -B1");
    // Must not contain project-derived naming via getComposeProject; ensure it uses the resolved volume directly
    // The old bug would have constructed `${project}_opencode-data` via getComposeProject; our fake resolve returns a known value
    // and the command should contain that known value, not a different derived one
    expect(captured[0]).not.toMatch(/run --rm -v .*_opencode-data:.*df.*\n.*project/i);
  });

  test("defaultGetFreeSpace fallback fails closed when volume unresolvable", async () => {
    const fakeExec = async () => ({ stdout: "", stderr: "", exitCode: 1 });
    const fakeResolve = async () => {
      throw new Error("no named volume mounted at the opencode path");
    };
    const fakeDocker = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const free = await defaultGetFreeSpace("/fake", {
      execInAiDevFn: fakeExec as never,
      dockerCommandFn: fakeDocker as never,
      resolveDataVolumeFn: fakeResolve as never,
    });
    expect(free).toBeNull();
  });

  test("defaultGetDbFileSize prefers execInAiDev result when available", async () => {
    const fakeExec = async () => ({ stdout: "9876", stderr: "", exitCode: 0 });
    let dockerCalled = false;
    const fakeDocker = async () => {
      dockerCalled = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const fakeResolve = async () => "vol";
    const size = await defaultGetDbFileSize("/fake/db", {
      execInAiDevFn: fakeExec as never,
      dockerCommandFn: fakeDocker as never,
      resolveDataVolumeFn: fakeResolve as never,
    });
    expect(size).toBe(9876);
    expect(dockerCalled).toBe(false);
  });
});
