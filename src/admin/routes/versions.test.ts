import { expect, test } from "bun:test";
import { buildManifestCommandForTag, buildVersionCategories, LITERAL_LATEST_REF, LITERAL_V2_REF, LITERAL_V2_DEV_REF, isDevVersion, isRollingV2Dev, resolveUpdateStableTag } from "./versions";

test("update checks inspect the V2 image", () => {
  expect(LITERAL_LATEST_REF).toBe("ghcr.io/tryweb/ai-engkit:latest");
  expect(buildManifestCommandForTag("latest")).toContain("manifest inspect ghcr.io/tryweb/ai-engkit:latest");
  expect(buildManifestCommandForTag("v2")).toContain("manifest inspect ghcr.io/tryweb/ai-engkit:v2");
  expect(buildManifestCommandForTag("v2-dev")).toContain("manifest inspect ghcr.io/tryweb/ai-engkit:v2-dev");
});

test("stable tag constants for v2 line", () => {
  expect(LITERAL_V2_REF).toBe("ghcr.io/tryweb/ai-engkit:v2");
  expect(LITERAL_V2_DEV_REF).toBe("ghcr.io/tryweb/ai-engkit:v2-dev");
});

test("isDevVersion treats v2dev as dev but not v2-dev", () => {
  expect(isDevVersion("dev")).toBe(true);
  expect(isDevVersion("v2dev")).toBe(true);
  expect(isDevVersion("v2-dev")).toBe(false);
  expect(isDevVersion("v2.0.0")).toBe(false);
});

test("isRollingV2Dev identifies rolling channel", () => {
  expect(isRollingV2Dev("v2-dev", null)).toBe(true);
  expect(isRollingV2Dev("v2.0.0", "v2-dev")).toBe(true);
  expect(isRollingV2Dev("v2.0.0", "v1.0.0")).toBe(false);
  expect(isRollingV2Dev("dev", null)).toBe(false);
});

test("resolveUpdateStableTag picks v2-dev when rolling, otherwise v2", () => {
  expect(resolveUpdateStableTag("v2-dev", null)).toBe("v2-dev");
  expect(resolveUpdateStableTag("v2.0.0", "v2-dev")).toBe("v2-dev");
  expect(resolveUpdateStableTag("v1.0.0", null)).toBe("v2");
  expect(resolveUpdateStableTag("v2.0.0", null)).toBe("v2");
});

test("V2 omits the removed oh-my-openagent row", () => {
  const v2 = buildVersionCategories();
  expect(v2["plugin"]).toBeUndefined();
  expect(v2["skills"]["superpowers"]).toContain("baked-plugins/superpowers");
});

test("V2 probes never resolve npm latest (no unpinned bunx)", () => {
  // Every V2 probe must read something installed, never the registry.
  for (const commands of Object.values(buildVersionCategories())) {
    for (const cmd of Object.values(commands)) {
      expect(cmd).not.toContain("bunx ");
    }
  }
});
