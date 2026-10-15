import { expect, test } from "bun:test";
import { buildLatestManifestCommand, buildVersionCategories, LITERAL_LATEST_REF } from "./versions";

test("update checks always inspect the official latest image", () => {
  expect(LITERAL_LATEST_REF).toBe("ghcr.io/tryweb/ai-engkit:latest");
  expect(buildLatestManifestCommand()).toContain("manifest inspect ghcr.io/tryweb/ai-engkit:latest");
});

test("V2 omits the removed oh-my-openagent row; V1 keeps it", () => {
  const v2 = buildVersionCategories(true);
  expect(v2["plugin"]).toBeUndefined();
  expect(v2["skills"]["superpowers"]).toContain("baked-plugins/superpowers");
  const v1 = buildVersionCategories(false);
  expect(v1["plugin"]["oh-my-openagent"]).toContain("oh-my-openagent");
  expect(v1["skills"]["superpowers"]).toContain("baked-plugins/superpowers");
});

test("V2 probes never resolve npm latest (no unpinned bunx)", () => {
  // V1 keeps its legacy oh-my-openagent probe; on V2 every probe must read
  // something installed, never the registry.
  for (const commands of Object.values(buildVersionCategories(true))) {
    for (const cmd of Object.values(commands)) {
      expect(cmd).not.toContain("bunx ");
    }
  }
});
