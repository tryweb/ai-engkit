import { expect, test } from "bun:test";
import { buildLatestManifestCommand, buildOmoInstalledVersionCommand, LITERAL_LATEST_REF } from "./versions";

test("update checks always inspect the official latest image", () => {
  expect(LITERAL_LATEST_REF).toBe("ghcr.io/tryweb/ai-engkit:latest");
  expect(buildLatestManifestCommand()).toContain("manifest inspect ghcr.io/tryweb/ai-engkit:latest");
});

test("OMO installed version reads the pinned OpenCode package instead of resolving bunx latest", () => {
  const command = buildOmoInstalledVersionCommand();

  expect(command).toContain("oh-my-openagent@${OH_MY_OPENAGENT_VERSION}/node_modules/oh-my-openagent/package.json");
  expect(command).not.toContain("bunx");
});
