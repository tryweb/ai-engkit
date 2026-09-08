import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RETENTION_POLICY,
  readRetentionPolicyFrom,
  validateRetentionPolicy,
  writeRetentionPolicyFrom,
} from "./retention-policy";

describe("validateRetentionPolicy", () => {
  test("accepts valid enabled true cutoff 30", () => {
    expect(validateRetentionPolicy({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" })).toEqual({
      ok: true,
      value: { enabled: true, cutoffDays: 30, dailyRunAt: "03:00" },
    });
  });

  test("accepts boundary values 1 and 365", () => {
    expect(validateRetentionPolicy({ enabled: false, cutoffDays: 1, dailyRunAt: "00:00" }).ok).toBe(true);
    expect(validateRetentionPolicy({ enabled: true, cutoffDays: 365, dailyRunAt: "23:59" }).ok).toBe(true);
  });

  test("rejects missing enabled", () => {
    const result = validateRetentionPolicy({ cutoffDays: 30, dailyRunAt: "03:00" });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.field).toBe("enabled");
  });

  test("rejects enabled not boolean", () => {
    const result = validateRetentionPolicy({ enabled: "true", cutoffDays: 30, dailyRunAt: "03:00" });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.field).toBe("enabled");
      expect(result.message).toContain("boolean");
    }
  });

  test("rejects cutoff 0", () => {
    const result = validateRetentionPolicy({ enabled: true, cutoffDays: 0, dailyRunAt: "03:00" });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.field).toBe("cutoffDays");
  });

  test("rejects cutoff 400", () => {
    const result = validateRetentionPolicy({ enabled: true, cutoffDays: 400, dailyRunAt: "03:00" });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.message).toContain("between 1 and 365");
  });

  test("rejects non-integer cutoff", () => {
    expect(validateRetentionPolicy({ enabled: true, cutoffDays: 30.5, dailyRunAt: "03:00" }).ok).toBe(false);
    expect(validateRetentionPolicy({ enabled: true, cutoffDays: 30.5, dailyRunAt: "03:00" }).ok).toBe(false);
  });

  test("rejects cutoff as string", () => {
    const result = validateRetentionPolicy({ enabled: true, cutoffDays: "30", dailyRunAt: "03:00" });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.field).toBe("cutoffDays");
  });

  test("rejects archive field", () => {
    const result = validateRetentionPolicy({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00", archive: true });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.field).toBe("archive");
      expect(result.message).toContain("not supported");
    }
  });

  test("rejects action field", () => {
    const result = validateRetentionPolicy({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00", action: "archive" });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.field).toBe("action");
  });

  test("rejects unknown field", () => {
    const result = validateRetentionPolicy({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00", extra: 1 });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.field).toBe("extra");
  });

  test("accepts dailyRunAt 03:00 and 23:59", () => {
    expect(validateRetentionPolicy({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }).ok).toBe(true);
    expect(validateRetentionPolicy({ enabled: true, cutoffDays: 30, dailyRunAt: "00:00" }).ok).toBe(true);
    expect(validateRetentionPolicy({ enabled: true, cutoffDays: 30, dailyRunAt: "23:59" }).ok).toBe(true);
  });

  test("rejects missing dailyRunAt", () => {
    const result = validateRetentionPolicy({ enabled: true, cutoffDays: 30 });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.field).toBe("dailyRunAt");
  });

  test("rejects invalid dailyRunAt formats", () => {
    const bad = ["24:00", "3:00", "03:0", "03:60", "ab:cd", "", "03:00:00", " 03:00"];
    for (const v of bad) {
      const r = validateRetentionPolicy({ enabled: true, cutoffDays: 30, dailyRunAt: v });
      expect(r.ok).toBe(false);
      if (r.ok === false) expect(r.field).toBe("dailyRunAt");
    }
  });

  test("rejects non-zero-padded dailyRunAt", () => {
    const r = validateRetentionPolicy({ enabled: true, cutoffDays: 30, dailyRunAt: "3:00" });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.message).toContain("HH:MM");
  });

  test("rejects dailyRunAt not string", () => {
    const r = validateRetentionPolicy({ enabled: true, cutoffDays: 30, dailyRunAt: 300 as unknown as string });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.field).toBe("dailyRunAt");
  });

  test("stored JSON missing dailyRunAt resolves to default via read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-policy-"));
    const filePath = join(directory, "retention-policy.json");
    try {
      await writeFile(filePath, JSON.stringify({ enabled: true, cutoffDays: 30 }) + "\n");
      const policy = readRetentionPolicyFrom(filePath);
      expect(policy.dailyRunAt).toBe("03:00");
      expect(policy.enabled).toBe(true);
      expect(policy.cutoffDays).toBe(30);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("parseRetentionPolicyJSON missing dailyRunAt defaults to 03:00", async () => {
    const { parseRetentionPolicyJSON } = await import("./retention-policy");
    const parsed = parseRetentionPolicyJSON(JSON.stringify({ enabled: false, cutoffDays: 30 }));
    expect(parsed).not.toBeNull();
    expect(parsed?.dailyRunAt).toBe("03:00");
  });

  test("rejects non-object input", () => {
    expect(validateRetentionPolicy(null).ok).toBe(false);
    expect(validateRetentionPolicy("string").ok).toBe(false);
    expect(validateRetentionPolicy([]).ok).toBe(false);
  });
});

describe("retention policy file I/O no partial write", () => {
  test("read returns default when file missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-policy-"));
    const filePath = join(directory, "retention-policy.json");
    try {
      expect(readRetentionPolicyFrom(filePath)).toEqual(DEFAULT_RETENTION_POLICY);
      expect(readRetentionPolicyFrom(filePath).dailyRunAt).toBe("03:00");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("round-trip write and read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-policy-"));
    const filePath = join(directory, "retention-policy.json");
    try {
      writeRetentionPolicyFrom(filePath, { enabled: true, cutoffDays: 90, dailyRunAt: "04:30" });
      expect(readRetentionPolicyFrom(filePath)).toEqual({ enabled: true, cutoffDays: 90, dailyRunAt: "04:30" });
      const text = await readFile(filePath, "utf8");
      expect(JSON.parse(text)).toEqual({ enabled: true, cutoffDays: 90, dailyRunAt: "04:30" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("invalid write does not create file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-policy-"));
    const filePath = join(directory, "retention-policy.json");
    try {
      const invalid = { enabled: true, cutoffDays: 0, dailyRunAt: "03:00" } as unknown as { enabled: boolean; cutoffDays: number; dailyRunAt: string };
      let threw = false;
      try {
        writeRetentionPolicyFrom(filePath, invalid);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      const exists = await readFile(filePath, "utf8").then(() => true).catch(() => false);
      expect(exists).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("invalid write preserves previous valid file with no partial write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-policy-"));
    const filePath = join(directory, "retention-policy.json");
    try {
      writeRetentionPolicyFrom(filePath, { enabled: false, cutoffDays: 30, dailyRunAt: "03:00" });
      const before = await readFile(filePath, "utf8");
      const invalid = { enabled: true, cutoffDays: 400, dailyRunAt: "03:00" } as unknown as { enabled: boolean; cutoffDays: number; dailyRunAt: string };
      try {
        writeRetentionPolicyFrom(filePath, invalid);
      } catch {
        // expected
      }
      const after = await readFile(filePath, "utf8");
      expect(after).toBe(before);
      expect(readRetentionPolicyFrom(filePath)).toEqual({ enabled: false, cutoffDays: 30, dailyRunAt: "03:00" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("read throws on malformed JSON with no silent fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-policy-"));
    const filePath = join(directory, "retention-policy.json");
    try {
      await writeFile(filePath, "not-json\n");
      let threw = false;
      try {
        readRetentionPolicyFrom(filePath);
      } catch (error) {
        threw = true;
        expect(String(error)).toContain("malformed");
      }
      expect(threw).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("read throws on valid JSON but invalid shape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-policy-"));
    const filePath = join(directory, "retention-policy.json");
    try {
      await writeFile(filePath, '{"enabled":"yes","cutoffDays":30}\n');
      let threw = false;
      try {
        readRetentionPolicyFrom(filePath);
      } catch (error) {
        threw = true;
        expect(String(error)).toContain("malformed");
      }
      expect(threw).toBe(true);
      // file content unchanged
      expect(await readFile(filePath, "utf8")).toBe('{"enabled":"yes","cutoffDays":30}\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
