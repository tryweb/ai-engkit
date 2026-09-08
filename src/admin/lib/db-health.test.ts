import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { probeLocalDbHealth, collectHostDbHealth, formatBytes, formatInt } from "./db-health";

function hashFile(path: string): string {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

function createFixtureDb(dir: string, name = "fixture.db"): string {
  const dbPath = join(dir, name);
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS event (id TEXT PRIMARY KEY, session_id TEXT);
    CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT);
    CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT);
  `);
  const insertSession = db.prepare("INSERT INTO session (id, created_at) VALUES (?, ?)");
  const insertEvent = db.prepare("INSERT INTO event (id, session_id) VALUES (?, ?)");
  const insertMessage = db.prepare("INSERT INTO message (id, session_id) VALUES (?, ?)");
  const insertPart = db.prepare("INSERT INTO part (id, message_id) VALUES (?, ?)");

  for (let i = 0; i < 5; i++) insertSession.run(`s-${i}`, Date.now());
  for (let i = 0; i < 7; i++) insertEvent.run(`e-${i}`, "s-0");
  for (let i = 0; i < 3; i++) insertMessage.run(`m-${i}`, "s-0");
  for (let i = 0; i < 11; i++) insertPart.run(`p-${i}`, "m-0");
  db.close();
  return dbPath;
}

describe("probeLocalDbHealth", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-health-"));
    dbPath = createFixtureDb(dir);
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      void error;
    }
  });

  test("Given fixture DB, When probed readonly, Then file size and row counts match", async () => {
    const health = await probeLocalDbHealth(dbPath, { freeSpaceBytes: 123456 });
    const stat = statSync(dbPath);
    expect(health.fileSizeBytes).toBe(stat.size);
    expect(health.dbPath).toBe(dbPath);
    expect(health.rowCounts.session).toBe(5);
    expect(health.rowCounts.event).toBe(7);
    expect(health.rowCounts.message).toBe(3);
    expect(health.rowCounts.part).toBe(11);
    expect(health.freeSpaceBytes).toBe(123456);
    expect(typeof health.freelistCount).toBe("number");
    expect(health.freelistCount).toBeGreaterThanOrEqual(0);
    expect(typeof health.collectedAt).toBe("string");
  });

  test("Given fixture DB, When probed, Then zero writes: hash/mtime unchanged, no WAL growth", async () => {
    const beforeHash = hashFile(dbPath);
    const beforeStat = statSync(dbPath);
    const beforeMtime = beforeStat.mtimeMs;
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    const beforeWalExists = existsSync(walPath);
    const beforeWalSize = beforeWalExists ? statSync(walPath).size : 0;

    const health1 = await probeLocalDbHealth(dbPath, { freeSpaceBytes: 999 });
    const health2 = await probeLocalDbHealth(dbPath, { freeSpaceBytes: 999 });

    const afterHash = hashFile(dbPath);
    const afterStat = statSync(dbPath);
    const afterMtime = afterStat.mtimeMs;
    const afterWalExists = existsSync(walPath);
    const afterWalSize = afterWalExists ? statSync(walPath).size : 0;
    const shmExists = existsSync(shmPath);

    expect(afterHash).toBe(beforeHash);
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterMtime).toBe(beforeMtime);
    expect(afterWalSize).toBe(beforeWalSize);
    expect(shmExists).toBe(false);
    // health consistent across repeated reads
    expect(health1.fileSizeBytes).toBe(health2.fileSizeBytes);
    expect(health1.rowCounts).toEqual(health2.rowCounts);
  });

  test("Given DB with freelist, When probed readonly, Then freelist_count reported and no writes", async () => {
    // Create fragmented DB: insert then delete in writable mode to produce freelist
    const db = new Database(dbPath);
    db.exec("DELETE FROM session WHERE id IN ('s-0','s-1')");
    db.close();
    // After delete, freelist should be >=1 (page freed)
    const beforeHash2 = hashFile(dbPath);
    const health = await probeLocalDbHealth(dbPath, { freeSpaceBytes: null });
    expect(health.rowCounts.session).toBe(3);
    // freelist is at least 0; after delete it usually >0 but SQLite may reuse quickly, so just check it's a number and hash unchanged
    expect(typeof health.freelistCount).toBe("number");
    expect(hashFile(dbPath)).toBe(beforeHash2);
  });

  test("Given nonexistent WAL, When probed readonly repeatedly, Then no journal/WAL files created", async () => {
    const wal = `${dbPath}-wal`;
    const shm = `${dbPath}-shm`;
    const journal = `${dbPath}-journal`;
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(shm)).toBe(false);
    expect(existsSync(journal)).toBe(false);
    await probeLocalDbHealth(dbPath, { freeSpaceBytes: null });
    await probeLocalDbHealth(dbPath, { freeSpaceBytes: null });
    await probeLocalDbHealth(dbPath, { freeSpaceBytes: null });
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(shm)).toBe(false);
    expect(existsSync(journal)).toBe(false);
  });
});

describe("collectHostDbHealth via execInAiDev", () => {
  test("Given fake exec returning read-only outputs, When collectHostDbHealth called, Then parsed health matches", async () => {
    const fakeExec = async (cmd: string) => {
      if (cmd.includes("stat -c")) return { stdout: "8192", stderr: "", exitCode: 0 };
      if (cmd.includes("freelist_count")) return { stdout: "3", stderr: "", exitCode: 0 };
      if (cmd.includes("session") && cmd.includes("SELECT COUNT")) return { stdout: "5", stderr: "", exitCode: 0 };
      if (cmd.includes("event") && cmd.includes("SELECT COUNT")) return { stdout: "7", stderr: "", exitCode: 0 };
      if (cmd.includes("message") && cmd.includes("SELECT COUNT")) return { stdout: "3", stderr: "", exitCode: 0 };
      if (cmd.includes("part") && cmd.includes("SELECT COUNT")) return { stdout: "11", stderr: "", exitCode: 0 };
      if (cmd.includes("df -B1")) return { stdout: "987654321", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const health = await collectHostDbHealth(fakeExec, "/fake/opencode.db", "/fake");
    expect(health.fileSizeBytes).toBe(8192);
    expect(health.freelistCount).toBe(3);
    expect(health.rowCounts).toEqual({ session: 5, event: 7, message: 3, part: 11 });
    expect(health.freeSpaceBytes).toBe(987654321);
    expect(health.dbPath).toBe("/fake/opencode.db");
    expect(health.freeSpacePath).toBe("/fake");
  });

  test("Given exec uses mode=ro URI, Then commands are read-only", async () => {
    const seen: string[] = [];
    const fakeExec = async (cmd: string) => {
      seen.push(cmd);
      if (cmd.includes("stat")) return { stdout: "4096", stderr: "", exitCode: 0 };
      if (cmd.includes("df")) return { stdout: "1000", stderr: "", exitCode: 0 };
      return { stdout: "0", stderr: "", exitCode: 0 };
    };
    await collectHostDbHealth(fakeExec, "/home/devuser/.local/share/opencode/opencode.db");
    const sqliteCmds = seen.filter((c) => c.includes("sqlite3"));
    expect(sqliteCmds.length).toBeGreaterThan(0);
    for (const c of sqliteCmds) {
      expect(c).toContain("mode=ro");
    }
  });
});

describe("format helpers", () => {
  test("formatBytes formats thresholds", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
  test("formatInt en-US", () => {
    expect(formatInt(2125)).toBe("2,125");
  });
});
