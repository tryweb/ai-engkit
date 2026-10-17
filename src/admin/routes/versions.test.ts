import { expect, test } from "bun:test";
import { buildManifestCommandForTag, buildVersionCategories, LITERAL_LATEST_REF, LITERAL_V2_REF, LITERAL_V2_DEV_REF, isDevVersion, isRollingV2Dev, resolveUpdateStableTag } from "./versions";

test("update checks always inspect the official latest image on V1", () => {
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

test("resolveUpdateStableTag picks v2-dev when rolling, otherwise line stable", () => {
  const previous = process.env.OMO_ENABLED;
  try {
    process.env.OMO_ENABLED = "0";
    expect(resolveUpdateStableTag("v2-dev", null)).toBe("v2-dev");
    expect(resolveUpdateStableTag("v2.0.0", "v2-dev")).toBe("v2-dev");
    process.env.OMO_ENABLED = "1";
    expect(resolveUpdateStableTag("v2-dev", null)).toBe("v2-dev");
    expect(resolveUpdateStableTag("v1.0.0", null)).toBe("latest");
    process.env.OMO_ENABLED = "0";
    expect(resolveUpdateStableTag("v2.0.0", null)).toBe("v2");
  } finally {
    if (previous === undefined) delete process.env.OMO_ENABLED;
    else process.env.OMO_ENABLED = previous;
  }
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
