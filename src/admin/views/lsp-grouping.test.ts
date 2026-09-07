import { describe, expect, test } from "bun:test";
import type { LspRow } from "./lsp";
import { groupLspRows } from "./lsp";

function row(
  serverKey: string,
  options: { builtinBacked?: boolean; enabled?: boolean; drift?: LspRow["drift"] } = {},
): LspRow {
  return {
    serverKey,
    npmPackage: `${serverKey}-package`,
    command: [serverKey],
    extensions: [`.${serverKey}`],
    defaultEnabled: false,
    builtinBacked: options.builtinBacked ?? false,
    enabled: options.enabled ?? false,
    pinnedVersion: null,
    installedVersion: null,
    inLspBlock: false,
    drift: options.drift ?? null,
  };
}

describe("groupLspRows", () => {
  test("groups servers and sorts drifted rows before alphabetical in-sync rows", () => {
    const groups = groupLspRows([
      row("typescript", { builtinBacked: true }),
      row("pyright", { builtinBacked: true, drift: "version_mismatch" }),
      row("biome", { enabled: true }),
      row("json", { enabled: true, drift: "missing_install" }),
      row("html"),
      row("css"),
    ]);

    expect(groups.map((group) => group.key)).toEqual(["builtin", "enabled", "available"]);
    expect(groups.map((group) => group.rows.map((item) => item.serverKey))).toEqual([
      ["pyright", "typescript"],
      ["json", "biome"],
      ["css", "html"],
    ]);
  });

  test("keeps built-in rows in the built-in group even when enabled is false", () => {
    const groups = groupLspRows([row("yaml-ls", { builtinBacked: true, enabled: false })]);

    expect(groups[0].rows.map((item) => item.serverKey)).toEqual(["yaml-ls"]);
    expect(groups[1].rows).toEqual([]);
    expect(groups[2].rows).toEqual([]);
  });
});
