import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("managed V2 startup configuration", () => {
  for (const mode of ["0", "1"]) {
    test(`startup preserves managed values only on V2 (OMO_ENABLED=${mode})`, async () => {
      const source = await readFile(new URL("../../../entrypoint.d/02-init-config.sh", import.meta.url), "utf8");
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
