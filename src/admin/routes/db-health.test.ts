import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createDbHealthRoute } from "./db-health";
import { probeLocalDbHealth } from "../lib/db-health";

function createFixtureDb(dir: string): string {
  const dbPath = join(dir, "fixture.db");
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE event (id TEXT PRIMARY KEY);
    CREATE TABLE message (id TEXT PRIMARY KEY);
    CREATE TABLE part (id TEXT PRIMARY KEY);
  `);
  const s = db.prepare("INSERT INTO session (id) VALUES (?)");
  const e = db.prepare("INSERT INTO event (id) VALUES (?)");
  const m = db.prepare("INSERT INTO message (id) VALUES (?)");
  const p = db.prepare("INSERT INTO part (id) VALUES (?)");
  for (let i = 0; i < 2; i++) s.run(`s-${i}`);
  for (let i = 0; i < 4; i++) e.run(`e-${i}`);
  for (let i = 0; i < 6; i++) m.run(`m-${i}`);
  for (let i = 0; i < 8; i++) p.run(`p-${i}`);
  db.close();
  return dbPath;
}

describe("GET /api/db-health", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-health-route-"));
    dbPath = createFixtureDb(dir);
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      void error;
    }
  });

  test("When health route uses fixture collector, Then it returns read-only values without interruption", async () => {
    const app = createDbHealthRoute({
      collectHealth: () => probeLocalDbHealth(dbPath, { freeSpaceBytes: 555555, freeSpacePath: "/tmp" }),
    });

    const res = await app.request("http://localhost/api/db-health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fileSizeBytes: number;
      freelistCount: number;
      rowCounts: { session: number; event: number; message: number; part: number };
      freeSpaceBytes: number | null;
      dbPath: string;
      collectedAt: string;
    };
    expect(body.fileSizeBytes).toBeGreaterThan(0);
    expect(body.rowCounts.session).toBe(2);
    expect(body.rowCounts.event).toBe(4);
    expect(body.rowCounts.message).toBe(6);
    expect(body.rowCounts.part).toBe(8);
    expect(body.freeSpaceBytes).toBe(555555);
    expect(body.dbPath).toBe(dbPath);
    expect(typeof body.collectedAt).toBe("string");
  });

  test("When collector throws, Then route returns 500 with error", async () => {
    const app = createDbHealthRoute({
      collectHealth: async () => {
        throw new Error("probe failed");
      },
    });
    const res = await app.request("http://localhost/api/db-health");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Failed to collect db health");
  });

  test("When serving traffic, Then concurrent health reads return consistent data", async () => {
    const app = createDbHealthRoute({
      collectHealth: () => probeLocalDbHealth(dbPath, { freeSpaceBytes: 1000, freeSpacePath: "/tmp" }),
    });

    const results = await Promise.all([
      app.request("http://localhost/api/db-health"),
      app.request("http://localhost/api/db-health"),
      app.request("http://localhost/api/db-health"),
    ]);

    for (const r of results) {
      expect(r.status).toBe(200);
      const body = (await r.json()) as { rowCounts: { session: number } };
      expect(body.rowCounts.session).toBe(2);
    }
  });
});
