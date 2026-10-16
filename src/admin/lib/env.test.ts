import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envPathIsFile, readEnvFileAt } from "./env";

const root = mkdtempSync(join(tmpdir(), "ai-engkit-env-test-"));
const envFile = join(root, "good.env");
const envDir = join(root, "mis-mounted.env");
const missing = join(root, "absent.env");

writeFileSync(envFile, 'ADMIN_PORT=8080\n# a comment\nADMIN_PASSWORD="secret"\nEMPTY=\n');
mkdirSync(envDir);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("envPathIsFile", () => {
  test("true for a regular file", () => {
    expect(envPathIsFile(envFile)).toBe(true);
  });

  test("false for a directory (DooD auto-created bind source)", () => {
    expect(envPathIsFile(envDir)).toBe(false);
  });

  test("false for a missing path", () => {
    expect(envPathIsFile(missing)).toBe(false);
  });
});

describe("readEnvFileAt", () => {
  test("parses keys, strips quotes, skips comments and blanks", () => {
    const vars = readEnvFileAt(envFile);
    expect(vars.ADMIN_PORT).toBe("8080");
    expect(vars.ADMIN_PASSWORD).toBe("secret");
    expect(vars.EMPTY).toBe("");
    expect(Object.keys(vars)).toHaveLength(3);
  });

  test("returns an empty map for a directory instead of throwing EISDIR", () => {
    expect(() => readEnvFileAt(envDir)).not.toThrow();
    expect(readEnvFileAt(envDir)).toEqual({});
  });

  test("returns an empty map for a missing file", () => {
    expect(readEnvFileAt(missing)).toEqual({});
  });
});
