import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HOST_MAINTENANCE_POLICY,
  validateHostMaintenancePolicy,
} from "./host-maintenance-policy";

const valid = {
  enabled: false,
  dailyRunAt: "03:00",
  builderKeepStorageGb: 5,
  keepAiEngkitVersions: 2,
  watermarkWarnBytes: 10 * 1024 * 1024 * 1024,
  watermarkCritBytes: 8 * 1024 * 1024 * 1024,
  protectedTags: ["postgres:16-alpine"],
};

describe("host maintenance policy", () => {
  test("defaults are fail-closed (disabled)", () => {
    expect(DEFAULT_HOST_MAINTENANCE_POLICY.enabled).toBe(false);
  });

  test("accepts a valid policy", () => {
    const r = validateHostMaintenancePolicy(valid);
    expect(r.ok).toBe(true);
  });

  test("rejects unknown fields", () => {
    const r = validateHostMaintenancePolicy({ ...valid, pruneAll: true });
    expect(r.ok).toBe(false);
  });

  test("rejects bad dailyRunAt", () => {
    const r = validateHostMaintenancePolicy({ ...valid, dailyRunAt: "25:00" });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.field).toBe("dailyRunAt");
  });

  test("rejects crit >= warn", () => {
    const r = validateHostMaintenancePolicy({
      ...valid,
      watermarkWarnBytes: 100,
      watermarkCritBytes: 100,
    });
    expect(r.ok).toBe(false);
  });

  test("rejects out-of-range builder storage", () => {
    const r = validateHostMaintenancePolicy({ ...valid, builderKeepStorageGb: 500 });
    expect(r.ok).toBe(false);
  });
});
