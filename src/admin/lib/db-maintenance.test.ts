import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  runMaintenance,
  getMaintenanceState,
  getMaintenanceStatus,
  subscribeMaintenance,
  getMaintenanceEventLog,
  cutoffEpochMs,
  getDeleteCounts,
  _resetMaintenanceState,
  type DbMaintenanceDeps,
  type MaintenanceEvent,
} from "./db-maintenance";
import type { ExecResult } from "./docker";

function okExec(stdout = "ok"): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}
function failExec(stderr = "fail", exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

function createFixtureDb(dir: string, nowMs: number): { dbPath: string; db: Database } {
  const dbPath = join(dir, "opencode.db");
  const db = new Database(dbPath, { create: true });
  // Minimal opencode-like schema with FKs mirroring production:
  // session(id PK, time_updated INTEGER), event_sequence(aggregate_id FK? no FK to session, but we mimic), event(id PK, aggregate_id FK->event_sequence)
  // For the FK-correct test we need: event -> event_sequence ON DELETE CASCADE, and session cascades to message/part.
  db.exec(`PRAGMA journal_mode=WAL;`);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE event_sequence (
      aggregate_id TEXT PRIMARY KEY,
      dummy TEXT
    );
    CREATE TABLE event (
      id TEXT PRIMARY KEY,
      aggregate_id TEXT REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
      data TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT REFERENCES message(id) ON DELETE CASCADE
    );
  `);

  const now = nowMs;
  const old = now - 40 * 24 * 60 * 60 * 1000; // 40 days ago
  const recent = now - 5 * 24 * 60 * 60 * 1000; // 5 days ago

  const insertSession = db.prepare("INSERT INTO session (id, time_updated) VALUES (?, ?)");
  const insertSeq = db.prepare("INSERT INTO event_sequence (aggregate_id, dummy) VALUES (?, ?)");
  const insertEvent = db.prepare("INSERT INTO event (id, aggregate_id, data) VALUES (?, ?, ?)");
  const insertMsg = db.prepare("INSERT INTO message (id, session_id) VALUES (?, ?)");
  const insertPart = db.prepare("INSERT INTO part (id, message_id) VALUES (?, ?)");

  // 4 sessions: 2 old (should be deleted with cutoff 30d), 2 recent
  insertSession.run("s-old-1", old);
  insertSession.run("s-old-2", old);
  insertSession.run("s-new-1", recent);
  insertSession.run("s-new-2", recent);

  // event_sequences: one per session, plus one orphan aggregate_id not matching any session (edge)
  for (const sid of ["s-old-1", "s-old-2", "s-new-1", "s-new-2"]) {
    insertSeq.run(sid, "x");
  }

  // events: 3 per old session, 2 per new
  let eIdx = 0;
  for (const sid of ["s-old-1", "s-old-2"]) {
    for (let i = 0; i < 3; i++) insertEvent.run(`e-${eIdx++}`, sid, "{}");
  }
  for (const sid of ["s-new-1", "s-new-2"]) {
    for (let i = 0; i < 2; i++) insertEvent.run(`e-${eIdx++}`, sid, "{}");
  }

  // messages/parts for cascade check
  insertMsg.run("m-old-1", "s-old-1");
  insertMsg.run("m-new-1", "s-new-1");
  insertPart.run("p-old-1", "m-old-1");
  insertPart.run("p-new-1", "m-new-1");

  return { dbPath, db };
}

function makeSqlRunner(db: Database): (sql: string) => Promise<ExecResult> {
  return async (sql: string): Promise<ExecResult> => {
    // Handle PRAGMA checks and multi-statement SQL
    const stmts = sql.split(";").map((s) => s.trim()).filter(Boolean);
    let lastStdout = "";
    for (const stmt of stmts) {
      const upper = stmt.toUpperCase();
      if (upper.startsWith("PRAGMA FOREIGN_KEYS=ON")) {
        db.exec("PRAGMA foreign_keys=ON;");
        lastStdout = "";
        continue;
      }
      if (upper.startsWith("PRAGMA FOREIGN_KEYS")) {
        const row = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number } | null;
        lastStdout = String(row?.foreign_keys ?? 0);
        continue;
      }
      if (upper.startsWith("PRAGMA QUICK_CHECK")) {
        const row = db.query("PRAGMA quick_check").get() as Record<string, string> | null;
        // quick_check returns rows; we just check if ok
        const val = row ? Object.values(row)[0] : "ok";
        lastStdout = String(val ?? "ok");
        continue;
      }
      if (upper.startsWith("PRAGMA WAL_CHECKPOINT")) {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        lastStdout = "0|0|0";
        continue;
      }
      if (upper === "VACUUM") {
        db.exec("VACUUM;");
        lastStdout = "";
        continue;
      }
      if (upper.startsWith("SELECT COUNT")) {
        const row = db.query(stmt).get() as Record<string, number> | null;
        const v = row ? Object.values(row)[0] : 0;
        lastStdout = String(v ?? 0);
        continue;
      }
      if (upper.startsWith("SELECT CHANGES")) {
        const row = db.query("SELECT changes() as c").get() as { c: number } | null;
        lastStdout = String(row?.c ?? 0);
        continue;
      }
      if (upper.startsWith("DELETE FROM")) {
        db.exec(`${stmt};`);
        // record changes for following SELECT changes()
        continue;
      }
      // generic
      try {
        const q = db.query(stmt);
        const r = q.get() as unknown;
        if (r !== undefined && r !== null) lastStdout = JSON.stringify(r);
      } catch {
        db.exec(`${stmt};`);
      }
    }
    return okExec(lastStdout || "0");
  };
}

function baseDeps(overrides: Partial<DbMaintenanceDeps> = {}): DbMaintenanceDeps {
  return {
    dbPath: "/fake/opencode.db",
    backupDir: "/tmp/fake-backup",
    readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
    getDbFileSize: async () => 10 * 1024 * 1024, // 10 MB
    getFreeSpace: async () => 100 * 1024 * 1024, // 100 MB free
    getWalMtime: async () => 1000,
    stopAiDev: async () => okExec(),
    startAiDev: async () => okExec(),
    isAiDevRunning: async () => true,
    waitForIdle: async () => "idle",
    sleepMs: async () => {},
    createBackup: async () => okExec(),
    verifyBackup: async () => okExec("ok"),
    runSql: async () => okExec("ok"),
    runSqlOnVolume: async () => okExec("ok"),
    headroomMultiplier: 1.5,
    criticalFloorBytes: 1024 * 1024, // 1 MB for tests
    nowMs: () => Date.now(),
    ...overrides,
  };
}

describe("db-maintenance state machine and concurrent lock", () => {
  beforeEach(() => _resetMaintenanceState());
  afterEach(() => _resetMaintenanceState());

  test("concurrent trigger returns conflict (second run throws)", async () => {
    const deps = baseDeps({
      createBackup: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return okExec();
      },
      verifyBackup: async () => okExec("ok"),
      getFreeSpace: async () => 100 * 1024 * 1024,
    });

    const first = runMaintenance(deps);
    // State should be running immediately (backup step started)
    // give event loop a tick so the async backup starts
    await new Promise((r) => setTimeout(r, 10));
    expect(getMaintenanceState()).toBe("running");

    await expect(runMaintenance(deps)).rejects.toThrow("Maintenance already in progress");

    const result = await first;
    expect(result).toBe(true);
    expect(getMaintenanceState()).toBe("done");
  });

  test("progress events mirror upgrade subscribe/emit pattern", async () => {
    const events: MaintenanceEvent[] = [];
    const unsub = subscribeMaintenance((e) => events.push(e));

    const deps = baseDeps();
    const ok = await runMaintenance(deps);
    expect(ok).toBe(true);
    unsub();

    const steps = events.map((e) => `${e.step}:${e.status}`);
    expect(steps).toContain("backup:running");
    expect(steps).toContain("backup:success");
    expect(steps).toContain("quiesce:running");
    expect(steps).toContain("quiesce:success");
    expect(steps).toContain("delete:running");
    expect(steps).toContain("delete:success");
    expect(steps).toContain("reclaim:running");
    expect(steps).toContain("reclaim:success");
    expect(steps).toContain("verify:running");
    expect(steps).toContain("verify:success");
    expect(getMaintenanceStatus().progress_pct).toBe(100);
    expect(getMaintenanceStatus().state).toBe("done");
  });

  test("unsubscribe stops receiving events", async () => {
    const events: MaintenanceEvent[] = [];
    const unsub = subscribeMaintenance((e) => events.push(e));
    unsub();
    await runMaintenance(baseDeps());
    expect(events.length).toBe(0);
  });
});

describe("compressed backup with gzip integrity gating", () => {
  beforeEach(() => _resetMaintenanceState());
  afterEach(() => _resetMaintenanceState());

  test("corrupt/interrupted backup fails before any delete", async () => {
    let deleteCalled = false;
    const deps = baseDeps({
      createBackup: async () => okExec(),
      verifyBackup: async () => failExec("gzip: unexpected end of file", 1),
      runSql: async (sql: string) => {
        if (sql.includes("DELETE FROM")) deleteCalled = true;
        return okExec("ok");
      },
    });

    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(deleteCalled).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    const ev = getMaintenanceEventLog();
    const backupFail = ev.find((e) => e.step === "backup" && e.status === "failure");
    expect(backupFail).toBeDefined();
    expect(backupFail?.message).toMatch(/Backup verification failed/);
  });

  test("backup creation failure fails before delete", async () => {
    let deleteCalled = false;
    const deps = baseDeps({
      createBackup: async () => failExec("docker: no space", 1),
      runSql: async (sql: string) => {
        if (sql.includes("DELETE FROM")) deleteCalled = true;
        return okExec("ok");
      },
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(deleteCalled).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
  });
});

describe("quiesce and restart with health poll", () => {
  beforeEach(() => _resetMaintenanceState());
  afterEach(() => _resetMaintenanceState());

  test("restart failure surfaces failed state without marking success", async () => {
    const deps = baseDeps({
      startAiDev: async () => failExec("restart failed", 1),
      isAiDevRunning: async () => false,
      runSql: async () => okExec("ok"),
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    expect(getMaintenanceStatus().last_success_at).toBeNull();
    const ev = getMaintenanceEventLog();
    const verifyFail = ev.find((e) => e.step === "verify" && e.status === "failure");
    expect(verifyFail).toBeDefined();
    expect(verifyFail?.message).toMatch(/Failed to restart ai-dev|did not become healthy/);
  });

  test("health poll timeout surfaces failed", async () => {
    const deps = baseDeps({
      isAiDevRunning: async () => false,
      healthTimeoutMs: 10,
      pollIntervalMs: 2,
      runSql: async () => okExec("ok"),
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    expect(getMaintenanceEventLog().some((e) => e.message.includes("did not become healthy"))).toBe(true);
  });

  test("WAL not frozen aborts quiesce", async () => {
    let call = 0;
    const deps = baseDeps({
      getWalMtime: async () => {
        call++;
        return call === 1 ? 1000 : 2000; // mtime advanced
      },
      runSql: async () => okExec("ok"),
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    expect(getMaintenanceEventLog().some((e) => e.message.includes("WAL not frozen"))).toBe(true);
  });

  test("busy sessions defer the run without stopping ai-dev", async () => {
    let stopped = false;
    let deleted = false;
    const deps = baseDeps({
      waitForIdle: async () => "timeout",
      stopAiDev: async () => {
        stopped = true;
        return okExec();
      },
      runSql: async (sql: string) => {
        if (sql.includes("DELETE FROM")) deleted = true;
        return okExec("ok");
      },
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(stopped).toBe(false);
    expect(deleted).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    const ev = getMaintenanceEventLog();
    expect(ev.some((e) => e.step === "quiesce" && e.status === "failure")).toBe(true);
    expect(ev.some((e) => e.message.includes("refusing to stop ai-dev"))).toBe(true);
  });

  test("unavailable session status fails closed", async () => {
    let stopped = false;
    const deps = baseDeps({
      waitForIdle: async () => "unavailable",
      stopAiDev: async () => {
        stopped = true;
        return okExec();
      },
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(stopped).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    expect(getMaintenanceEventLog().some((e) => e.message.includes("cannot confirm idleness"))).toBe(true);
  });

  test("unknown database size refuses to start", async () => {
    let deleted = false;
    const deps = baseDeps({
      getDbFileSize: async () => null,
      runSql: async (sql: string) => {
        if (sql.includes("DELETE FROM")) deleted = true;
        return okExec("ok");
      },
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(deleted).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    expect(getMaintenanceEventLog().some((e) => e.message.includes("Unable to determine database size"))).toBe(true);
  });
});

describe("FK-correct delete with cascade deltas on fixture DB", () => {
  let dir: string;
  let db: Database;
  let dbPath: string;
  const nowMs = Date.now();

  beforeEach(() => {
    _resetMaintenanceState();
    dir = mkdtempSync(join(tmpdir(), "db-maint-"));
    const fixture = createFixtureDb(dir, nowMs);
    dbPath = fixture.dbPath;
    db = fixture.db;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
    _resetMaintenanceState();
  });

  test("cascade deltas match pre-counts and event_sequence deleted before session", async () => {
    const runSql = makeSqlRunner(db);

    // Pre-counts
    const preSessions = (db.query("SELECT COUNT(*) as c FROM session").get() as { c: number }).c;
    const preSeq = (db.query("SELECT COUNT(*) as c FROM event_sequence").get() as { c: number }).c;
    const preEvents = (db.query("SELECT COUNT(*) as c FROM event").get() as { c: number }).c;
    const preMessages = (db.query("SELECT COUNT(*) as c FROM message").get() as { c: number }).c;
    const preParts = (db.query("SELECT COUNT(*) as c FROM part").get() as { c: number }).c;

    // Expected to-delete via cutoff
    const cutoff = cutoffEpochMs({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }, nowMs);
    const toDeleteSessions = (db.query(`SELECT COUNT(*) as c FROM session WHERE time_updated < ${cutoff}`).get() as { c: number }).c;
    const toDeleteSeq = (
      db.query(
        `SELECT COUNT(*) as c FROM event_sequence WHERE aggregate_id IN (SELECT id FROM session WHERE time_updated < ${cutoff})`,
      ).get() as { c: number }
    ).c;

    expect(toDeleteSessions).toBe(2);
    expect(toDeleteSeq).toBe(2);

    // Track FK enforcement and order
    const sqlLog: string[] = [];
    const trackingRunner = async (sql: string): Promise<ExecResult> => {
      sqlLog.push(sql);
      return runSql(sql);
    };

    const deps = baseDeps({
      dbPath,
      runSqlOnVolume: trackingRunner,
      nowMs: () => nowMs,
      getDbFileSize: async () => 1024 * 1024,
      getFreeSpace: async () => 100 * 1024 * 1024,
    });

    const ok = await runMaintenance(deps);
    expect(ok).toBe(true);
    expect(getMaintenanceState()).toBe("done");

    // Assert FK pragma was set
    expect(sqlLog.some((s) => s.includes("foreign_keys=ON"))).toBe(true);
    // Assert event_sequence deleted before session
    const seqIdx = sqlLog.findIndex((s) => s.includes("DELETE FROM event_sequence"));
    const sessIdx = sqlLog.findIndex((s) => s.includes("DELETE FROM session WHERE time_updated"));
    expect(seqIdx).toBeGreaterThan(-1);
    expect(sessIdx).toBeGreaterThan(-1);
    expect(seqIdx).toBeLessThan(sessIdx);

    // Post-counts: verify deltas match pre-counts
    const postSessions = (db.query("SELECT COUNT(*) as c FROM session").get() as { c: number }).c;
    const postSeq = (db.query("SELECT COUNT(*) as c FROM event_sequence").get() as { c: number }).c;
    const postEvents = (db.query("SELECT COUNT(*) as c FROM event").get() as { c: number }).c;
    const postMessages = (db.query("SELECT COUNT(*) as c FROM message").get() as { c: number }).c;
    const postParts = (db.query("SELECT COUNT(*) as c FROM part").get() as { c: number }).c;

    expect(preSessions - postSessions).toBe(toDeleteSessions);
    expect(preSeq - postSeq).toBe(toDeleteSeq);
    // Events cascade from event_sequence: 3 per old session = 6
    expect(preEvents - postEvents).toBe(6);
    // Message/part cascade from session: 1 message + 1 part for s-old-1
    expect(preMessages - postMessages).toBe(1);
    expect(preParts - postParts).toBe(1);

    // Verify no orphaned events (every remaining event has a parent sequence)
    const orphanEvents = (
      db.query(`SELECT COUNT(*) as c FROM event WHERE aggregate_id NOT IN (SELECT aggregate_id FROM event_sequence)`).get() as {
        c: number;
      }
    ).c;
    expect(orphanEvents).toBe(0);
  });

  test("getDeleteCounts matches live counts for confirm screen", async () => {
    const counts = await getDeleteCounts({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }, {
      runSql: makeSqlRunner(db),
      nowMs: () => nowMs,
    });
    expect(counts.sessions).toBe(2);
    expect(counts.eventSequences).toBe(2);
  });

  test("quick_check verification reads handle unrecovered WAL artifact", async () => {
    // Simulate readonly open of WAL DB failing with CANTOPEN by making quick_check return error first,
    // but our runner uses rw mount while stopped so it should still succeed.
    // Here we verify that a failing quick_check surfaces failure without marking done.
    const deps = baseDeps({
      dbPath,
      runSqlOnVolume: async (sql: string) => {
        if (sql.includes("quick_check")) return failExec("unable to open database file", 14);
        return makeSqlRunner(db)(sql);
      },
      nowMs: () => nowMs,
      getDbFileSize: async () => 1024 * 1024,
      getFreeSpace: async () => 100 * 1024 * 1024,
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    expect(getMaintenanceEventLog().some((e) => e.step === "verify" && e.status === "failure")).toBe(true);
  });
});

describe("reclaim guards: pre-start headroom and mid-run floor abort", () => {
  beforeEach(() => _resetMaintenanceState());
  afterEach(() => _resetMaintenanceState());

  test("guard refusal: insufficient free space refuses to start (no delete)", async () => {
    let deleteCalled = false;
    const deps = baseDeps({
      getDbFileSize: async () => 10 * 1024 * 1024,
      getFreeSpace: async () => 5 * 1024 * 1024, // less than 1.5x headroom (15 MB needed)
      runSql: async (sql: string) => {
        if (sql.includes("DELETE FROM")) deleteCalled = true;
        return okExec("ok");
      },
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(deleteCalled).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    expect(getMaintenanceEventLog().some((e) => e.message.includes("Insufficient disk space"))).toBe(true);
  });

  test("guard refusal: null free space fails closed", async () => {
    let deleteCalled = false;
    const deps = baseDeps({
      getFreeSpace: async () => null,
      runSql: async (sql: string) => {
        if (sql.includes("DELETE FROM")) deleteCalled = true;
        return okExec("ok");
      },
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(deleteCalled).toBe(false);
    expect(getMaintenanceEventLog().some((e) => e.message.includes("Unable to determine free disk space"))).toBe(true);
  });

  test("guard refusal: below critical floor refuses to start", async () => {
    const deps = baseDeps({
      getDbFileSize: async () => 1024,
      getFreeSpace: async () => 512, // below 1 MB floor and also below headroom
      criticalFloorBytes: 1024 * 1024,
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    // Either headroom or critical floor guard should trigger
    const msgs = getMaintenanceEventLog().map((e) => e.message).join(" ");
    expect(msgs.includes("critical floor") || msgs.includes("Insufficient disk space")).toBe(true);
  });

  test("mid-run floor abort: free space drops before VACUUM, aborts safely", async () => {
    let callCount = 0;
    const deps = baseDeps({
      getFreeSpace: async () => {
        callCount++;
        // First call (pre-start) returns ample space, second (before reclaim) returns below floor
        if (callCount === 1) return 100 * 1024 * 1024;
        return 512; // below floor for mid-run check
      },
      runSqlOnVolume: async (sql: string) => {
        if (sql.includes("VACUUM")) {
          throw new Error("VACUUM should not have been called");
        }
        return okExec(sql.includes("quick_check") ? "ok" : "0");
      },
      getDbFileSize: async () => 1024 * 1024,
      criticalFloorBytes: 1024 * 1024,
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    expect(getMaintenanceEventLog().some((e) => e.step === "reclaim" && e.status === "failure")).toBe(true);
  });

  test("VACUUM failure aborts and surfaces failed (original intact is caller's responsibility)", async () => {
    const deps = baseDeps({
      runSqlOnVolume: async (sql: string) => {
        if (sql.includes("VACUUM")) return failExec("disk I/O error", 1);
        if (sql.includes("quick_check")) return okExec("ok");
        return okExec("0");
      },
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    expect(getMaintenanceEventLog().some((e) => e.message.includes("VACUUM failed"))).toBe(true);
  });

  test("disabled policy refuses to start", async () => {
    const deps = baseDeps({
      readRetentionPolicy: () => ({ enabled: false, cutoffDays: 30, dailyRunAt: "03:00" }),
    });
    const ok = await runMaintenance(deps);
    expect(ok).toBe(false);
    expect(getMaintenanceState()).toBe("failed");
    expect(getMaintenanceEventLog().some((e) => e.message.includes("Retention policy is disabled"))).toBe(true);
  });
});

describe("route layer concurrent trigger conflict", () => {
  test("POST /api/admin/db-maintenance/run while running returns 409", async () => {
    const { createDbMaintenanceRoutes } = await import("../routes/db-maintenance");
    // Make runMaintenance hang
    let release: (() => void) | null = null;
    const fakeRun = () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      });

    const app = createDbMaintenanceRoutes({
      getState: () => "idle" as const,
      getStatus: () => ({
        state: "idle" as const,
        events: [],
        current_step: "" as const,
        progress_pct: 0,
        last_success_at: null,
        last_error: null,
      }),
      getEventLog: () => [],
      subscribe: () => () => {},
      runMaintenance: fakeRun as unknown as typeof runMaintenance,
      getDeleteCounts: async () => ({ sessions: 0, eventSequences: 0 }),
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
    });

    // First request starts the run (will hang)
    const firstRes = await app.request("/api/admin/db-maintenance/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(firstRes.status).toBe(202);

    // Second request should be rejected with 409 — but our fake getState still returns idle,
    // so the in-flight flag startInFlight should trigger 409
    const secondRes = await app.request("/api/admin/db-maintenance/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(secondRes.status).toBe(409);
    const body = (await secondRes.json()) as { error: string };
    expect(body.error).toMatch(/already in progress/);

    if (release) (release as () => void)();
  });

  test("POST without confirm returns 400", async () => {
    const { createDbMaintenanceRoutes } = await import("../routes/db-maintenance");
    const app = createDbMaintenanceRoutes({
      getState: () => "idle" as const,
      getStatus: () => ({
        state: "idle" as const,
        events: [],
        current_step: "" as const,
        progress_pct: 0,
        last_success_at: null,
        last_error: null,
      }),
      getEventLog: () => [],
      subscribe: () => () => {},
      runMaintenance: async () => true,
      getDeleteCounts: async () => ({ sessions: 0, eventSequences: 0 }),
      readRetentionPolicy: () => ({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
    });
    const res = await app.request("/api/admin/db-maintenance/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: false }),
    });
    expect(res.status).toBe(400);
  });
});
