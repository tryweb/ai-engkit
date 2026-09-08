import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { execInAiDev as defaultExecInAiDev, type ExecResult } from "./docker";

export const DEFAULT_DB_PATH = "/home/devuser/.local/share/opencode/opencode.db";
export const DEFAULT_FREE_SPACE_PATH = "/home/devuser/.local/share/opencode";

export interface DbHealthRowCounts {
  readonly session: number;
  readonly event: number;
  readonly message: number;
  readonly part: number;
}

export interface DbHealth {
  readonly fileSizeBytes: number;
  readonly freelistCount: number;
  readonly rowCounts: DbHealthRowCounts;
  readonly freeSpaceBytes: number | null;
  readonly freeSpacePath: string;
  readonly dbPath: string;
  readonly collectedAt: string;
}

type ExecFn = (command: string, timeoutMs?: number) => Promise<ExecResult>;

function parseCount(raw: string): number {
  const n = parseInt(raw.trim(), 10);
  if (Number.isNaN(n) || n < 0) return 0;
  return n;
}

function countOrZero(db: Database, table: string): number {
  try {
    const row = db.query(`SELECT COUNT(*) as c FROM "${table}"`).get() as { c: number } | null;
    if (!row) return 0;
    const v = row.c;
    if (typeof v !== "number" || Number.isNaN(v) || v < 0) return 0;
    return Math.trunc(v);
  } catch {
    return 0;
  }
}

function freelistOrZero(db: Database): number {
  try {
    const row = db.query("PRAGMA freelist_count").get() as { freelist_count: number } | null;
    if (!row) return 0;
    const v = (row as unknown as Record<string, number>).freelist_count;
    if (typeof v !== "number" || Number.isNaN(v) || v < 0) return 0;
    return Math.trunc(v);
  } catch {
    return 0;
  }
}

/**
 * Read-only probe against a local SQLite file.
 * Opens with `readonly: true, create: false` so no WAL/journal/shm is touched.
 * Safe to run against a live database with active writers when the file is a
 * snapshot/copy; for production use `collectHostDbHealth` via execInAiDev.
 */
export async function probeLocalDbHealth(
  dbPath: string,
  opts: {
    freeSpaceBytes?: number | null;
    freeSpacePath?: string;
    getFreeSpace?: () => Promise<number | null>;
  } = {},
): Promise<DbHealth> {
  const stat = statSync(dbPath);
  const fileSizeBytes = stat.size;

  const db = new Database(dbPath, { readonly: true, create: false });
  let freelistCount = 0;
  let rowCounts: DbHealthRowCounts = { session: 0, event: 0, message: 0, part: 0 };
  try {
    freelistCount = freelistOrZero(db);
    rowCounts = {
      session: countOrZero(db, "session"),
      event: countOrZero(db, "event"),
      message: countOrZero(db, "message"),
      part: countOrZero(db, "part"),
    };
  } finally {
    try {
      db.close();
    } catch (error) {
      void error;
    }
  }

  let freeSpaceBytes: number | null = null;
  if (opts.freeSpaceBytes !== undefined) {
    freeSpaceBytes = opts.freeSpaceBytes;
  } else if (opts.getFreeSpace) {
    try {
      freeSpaceBytes = await opts.getFreeSpace();
    } catch {
      freeSpaceBytes = null;
    }
  }

  return {
    fileSizeBytes,
    freelistCount,
    rowCounts,
    freeSpaceBytes,
    freeSpacePath: opts.freeSpacePath ?? DEFAULT_FREE_SPACE_PATH,
    dbPath,
    collectedAt: new Date().toISOString(),
  };
}

/**
 * Host probe via execInAiDev. Collects size, freelist, counts, and df free space
 * by running read-only commands inside ai-dev. All sqlite invocations use
 * `file:<path>?mode=ro` so no writer lock or WAL mutation occurs.
 */
export async function collectHostDbHealth(
  execFn: ExecFn = defaultExecInAiDev,
  dbPath: string = DEFAULT_DB_PATH,
  freeSpacePath: string = DEFAULT_FREE_SPACE_PATH,
): Promise<DbHealth> {
  const sqliteRo = (sql: string): string =>
    `sqlite3 "file:${dbPath}?mode=ro" "${sql.replace(/"/g, '\\"')}"`;

  const fileSizeRaw = await execFn(`stat -c %s "${dbPath}" 2>/dev/null || stat -f %z "${dbPath}" 2>/dev/null || echo ""`);
  const fileSizeBytes = parseCount(fileSizeRaw.stdout);

  const freelistRaw = await execFn(sqliteRo("PRAGMA freelist_count;"));
  const freelistCount = freelistRaw.exitCode === 0 ? parseCount(freelistRaw.stdout) : 0;

  const tables: (keyof DbHealthRowCounts)[] = ["session", "event", "message", "part"];
  const mutableCounts: Record<keyof DbHealthRowCounts, number> = { session: 0, event: 0, message: 0, part: 0 };
  for (const t of tables) {
    const r = await execFn(sqliteRo(`SELECT COUNT(*) FROM "${t}";`));
    mutableCounts[t] = r.exitCode === 0 ? parseCount(r.stdout) : 0;
  }
  const rowCounts: DbHealthRowCounts = mutableCounts;

  const dfRaw = await execFn(
    `df -B1 --output=avail "${freeSpacePath}" 2>/dev/null | tail -n1 | tr -d ' ' | tr -d '\\n' || df -B1 "${freeSpacePath}" 2>/dev/null | awk 'NR==2{print $4}' | tr -d ' '`,
  );
  let freeSpaceBytes: number | null = null;
  if (dfRaw.exitCode === 0 && dfRaw.stdout.trim()) {
    const n = parseInt(dfRaw.stdout.trim(), 10);
    if (!Number.isNaN(n) && n >= 0) freeSpaceBytes = n;
  }

  return {
    fileSizeBytes,
    freelistCount,
    rowCounts,
    freeSpaceBytes,
    freeSpacePath,
    dbPath,
    collectedAt: new Date().toISOString(),
  };
}

/** Human-readable helpers for dashboard rendering (en-US). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}
