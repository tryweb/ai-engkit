import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HOST_MAINTENANCE_POLICY,
  parseHostMaintenancePolicyJSON,
  readHostMaintenancePolicyFrom,
  validateHostMaintenancePolicy,
  writeHostMaintenancePolicyFrom,
  type HostMaintenancePolicy,
} from "./host-maintenance-policy";

const VALID: HostMaintenancePolicy = {
  enabled: true,
  dailyRunAt: "03:00",
  builderKeepStorageGb: 5,
  keepAiEngkitVersions: 2,
  watermarkWarnGb: 10,
  watermarkCritGb: 8,
  protectedTags: ["postgres:16-alpine"],
};

describe("validateHostMaintenancePolicy", () => {
  test("accepts a valid policy", () => {
    const result = validateHostMaintenancePolicy(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.protectedTags).toEqual(["postgres:16-alpine"]);
  });

  test("rejects non-objects", () => {
    for (const input of [null, 42, "x", []]) {
      expect(validateHostMaintenancePolicy(input).ok).toBe(false);
    }
  });

  test("rejects bad dailyRunAt", () => {
    expect(validateHostMaintenancePolicy({ ...VALID, dailyRunAt: "3am" }).ok).toBe(false);
    expect(validateHostMaintenancePolicy({ ...VALID, dailyRunAt: "24:00" }).ok).toBe(false);
  });

  test("rejects out-of-range numerics", () => {
    expect(validateHostMaintenancePolicy({ ...VALID, builderKeepStorageGb: 0 }).ok).toBe(false);
    expect(validateHostMaintenancePolicy({ ...VALID, builderKeepStorageGb: 101 }).ok).toBe(false);
    expect(validateHostMaintenancePolicy({ ...VALID, keepAiEngkitVersions: 0 }).ok).toBe(false);
    expect(validateHostMaintenancePolicy({ ...VALID, keepAiEngkitVersions: 11 }).ok).toBe(false);
  });

  test("rejects crit above warn", () => {
    const result = validateHostMaintenancePolicy({ ...VALID, watermarkCritGb: 12, watermarkWarnGb: 10 });
    expect(result).toMatchObject({ ok: false, field: "watermarkCritGb" });
  });

  test("accepts crit equal to warn", () => {
    expect(validateHostMaintenancePolicy({ ...VALID, watermarkCritGb: 10, watermarkWarnGb: 10 }).ok).toBe(true);
  });

  test("rejects bad protectedTags", () => {
    expect(validateHostMaintenancePolicy({ ...VALID, protectedTags: "x" }).ok).toBe(false);
    expect(validateHostMaintenancePolicy({ ...VALID, protectedTags: ["has space"] }).ok).toBe(false);
    expect(validateHostMaintenancePolicy({ ...VALID, protectedTags: new Array(51).fill("a:b") }).ok).toBe(false);
  });
});

describe("host maintenance policy persistence", () => {
  let dir: string;
  let filePath: string;
  let savedEnv: string | undefined;
  let hadEnv: boolean;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hm-policy-"));
    filePath = join(dir, "host-maintenance-policy.json");
    hadEnv = "HOST_MAINTENANCE_POLICY_PATH" in Bun.env;
    savedEnv = Bun.env.HOST_MAINTENANCE_POLICY_PATH;
    Bun.env.HOST_MAINTENANCE_POLICY_PATH = filePath;
  });

  afterEach(() => {
    if (hadEnv) {
      Bun.env.HOST_MAINTENANCE_POLICY_PATH = savedEnv;
    } else {
      delete Bun.env.HOST_MAINTENANCE_POLICY_PATH;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("missing file returns defaults", () => {
    const policy = readHostMaintenancePolicyFrom(filePath);
    expect(policy).toEqual(DEFAULT_HOST_MAINTENANCE_POLICY);
  });

  test("write then read round-trips", () => {
    writeHostMaintenancePolicyFrom(filePath, VALID);
    expect(readHostMaintenancePolicyFrom(filePath)).toEqual(VALID);
  });

  test("malformed file throws", () => {
    writeFileSync(filePath, "{not json");
    expect(() => readHostMaintenancePolicyFrom(filePath)).toThrow();
  });

  test("parse helper backfills dailyRunAt", () => {
    const parsed = parseHostMaintenancePolicyJSON(JSON.stringify({ ...VALID, dailyRunAt: undefined }));
    expect(parsed).not.toBeNull();
  });

  test("parse helper returns null on garbage", () => {
    expect(parseHostMaintenancePolicyJSON("nope")).toBeNull();
    expect(parseHostMaintenancePolicyJSON(JSON.stringify({ enabled: "yes" }))).toBeNull();
  });
});
