import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRYPOINT = "../../../entrypoint.d/02-init-config.sh";
const NORMALISE_BEGIN = "# >>> lean-ctx native-tool permission normalisation >>>";
const NORMALISE_END = "# <<< lean-ctx native-tool permission normalisation <<<";

describe("managed V2 startup configuration", () => {
  for (const mode of ["0", "1"]) {
    test(`startup preserves managed values only on V2 (OMO_ENABLED=${mode})`, async () => {
      const source = await readFile(new URL(ENTRYPOINT, import.meta.url), "utf8");
      const captureStart = source.indexOf('V2_MANAGED_CONFIG="{}"');
      const captureEnd = source.indexOf("# Always regenerate", captureStart);
      const mergeStart = source.indexOf('if [ "${OMO_ENABLED:-1}" = "0" ]; then', source.indexOf('echo "Updating opencode.json'));
      const mergeEnd = source.indexOf('echo "$OPCODE_CONFIG" >', mergeStart);
      expect(captureStart).toBeGreaterThan(0);
      expect(mergeStart).toBeGreaterThan(captureStart);
      const directory = await mkdtemp(join(tmpdir(), "v2-managed-startup-"));
      const path = join(directory, "opencode.json");
      const original = { agent: { oracle: { model: "provider/user-choice", variant: "high" } }, providers: { custom: { package: "native-package", models: { coder: {} } } }, plugin: ["stale-plugin"] };
      try {
        await writeFile(path, JSON.stringify(original));
        const script = `${source.slice(captureStart, captureEnd)}\n${source.slice(mergeStart, mergeEnd)}\nprintf '%s' "$OPCODE_CONFIG"`;
        const process = Bun.spawn(["bash", "-c", script], {
          env: { ...Bun.env, OMO_ENABLED: mode, OPCODE_CONFIG_FILE: path, OPCODE_CONFIG: '{"plugin":[],"mcp":{"codegraph":{"enabled":true}}}' },
        });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
        const parsed: unknown = JSON.parse(stdout);
        expect(parsed).toMatchObject({ plugin: [], mcp: { codegraph: { enabled: true } } });
        if (mode === "0") expect(parsed).toMatchObject({ agent: original.agent, providers: original.providers });
        else expect(parsed).not.toHaveProperty("providers");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

describe("lean-ctx native-tool permission normalisation", () => {
  async function runNormaliser(config: Record<string, unknown>, mode = 0o600) {
    const source = await readFile(new URL(ENTRYPOINT, import.meta.url), "utf8");
    const start = source.indexOf(NORMALISE_BEGIN);
    const end = source.indexOf(NORMALISE_END, start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const directory = await mkdtemp(join(tmpdir(), "leanctx-permission-"));
    const path = join(directory, "opencode.json");
    await writeFile(path, JSON.stringify(config), { mode });
    const script = `set -euo pipefail\nOPCODE_CONFIG_FILE=${JSON.stringify(path)}\n${source.slice(start, end + NORMALISE_END.length)}\n`;
    const process = Bun.spawn(["bash", "-c", script]);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    const after = JSON.parse(await readFile(path, "utf8"));
    const permissions = (await stat(path)).mode & 0o777;
    await rm(directory, { recursive: true, force: true });
    return { stdout, stderr, exitCode, after, permissions };
  }

  test("drops the ask rules lean-ctx setup injects", async () => {
    const { exitCode, stderr, after, permissions } = await runNormaliser({
      agent: { oracle: { model: "provider/user-choice" } },
      permission: { bash: "ask", glob: "ask", grep: "ask", read: "ask" },
      providers: { custom: { package: "native-package" } },
    });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(after).not.toHaveProperty("permission");
    expect(after).toMatchObject({
      agent: { oracle: { model: "provider/user-choice" } },
      providers: { custom: { package: "native-package" } },
    });
    expect(permissions).toBe(0o600);
  });

  test("keeps unrelated permission rules", async () => {
    const { after } = await runNormaliser({
      permission: { bash: "ask", grep: "ask", task: "deny", edit: "allow" },
    });
    expect(after).toEqual({ permission: { task: "deny", edit: "allow" } });
  });

  test("leaves a config without permission rules untouched", async () => {
    const { after, stdout } = await runNormaliser({ agent: {}, providers: {} });
    expect(after).toEqual({ agent: {}, providers: {} });
    expect(stdout).toBe("");
  });
});
