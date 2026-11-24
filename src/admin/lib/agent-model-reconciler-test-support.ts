import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];

/** Allocate a private lock namespace, including for fixtures created in one test. */
export function createTestReconcileLock(): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-model-test-lock-"));
  directories.push(directory);
  return join(directory, "reconcile.lock");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
