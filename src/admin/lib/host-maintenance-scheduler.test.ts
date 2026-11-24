import { describe, expect, test } from "bun:test";
import { evaluateHostMaintenanceScheduler } from "./host-maintenance-scheduler";
import { DEFAULT_HOST_MAINTENANCE_POLICY } from "./host-maintenance-policy";

describe("host maintenance scheduler", () => {
  test("skips when policy disabled", async () => {
    let runs = 0;
    const result = await evaluateHostMaintenanceScheduler({
      readPolicy: () => ({ ...DEFAULT_HOST_MAINTENANCE_POLICY, enabled: false }),
      runHostMaintenance: async () => {
        runs++;
        return { ok: true };
      },
      readState: () => null,
      writeState: () => {},
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("policy disabled");
    expect(runs).toBe(0);
  });

  test("skips with upgrade_in_progress and makes no prune calls", async () => {
    let runs = 0;
    const result = await evaluateHostMaintenanceScheduler({
      readPolicy: () => ({ ...DEFAULT_HOST_MAINTENANCE_POLICY, enabled: true }),
      getUpgradeState: () => "running",
      runHostMaintenance: async () => {
        runs++;
        return { ok: true };
      },
      readState: () => null,
      writeState: () => {},
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe("upgrade_in_progress");
    expect(runs).toBe(0);
  });

  test("has no manual-run gate: runs when enabled and idle", async () => {
    let runs = 0;
    const result = await evaluateHostMaintenanceScheduler({
      readPolicy: () => ({ ...DEFAULT_HOST_MAINTENANCE_POLICY, enabled: true }),
      getUpgradeState: () => "idle",
      getHostState: () => "idle",
      runHostMaintenance: async () => {
        runs++;
        return { ok: true };
      },
      readState: () => null,
      writeState: () => {},
    });
    expect(result.ran).toBe(true);
    expect(runs).toBe(1);
  });
});
