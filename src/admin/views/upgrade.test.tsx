import { describe, expect, test } from "bun:test";
import { UpgradePage } from "./upgrade";

describe("UpgradePage view", () => {
  test("dev build shows not-available card and no selector", async () => {
    const html = UpgradePage({ devBuild: true }).toString();
    expect(html).toContain("Not Available in Dev Build");
    expect(html).not.toContain('id="version-selector-card"');
    expect(html).not.toContain('id="target-official"');
  });

  test("prod build shows selector radios, select, More, no-target warning, and start button disabled", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain("version-selector-card");
    expect(html).toContain('id="target-official"');
    expect(html).toContain('id="target-specified"');
    expect(html).toContain('id="specified-select"');
    expect(html).toContain('id="more-versions"');
    expect(html).toContain('id="no-target-warning"');
    expect(html).toContain('id="start-upgrade"');
    expect(html).toContain("Start Upgrade");
    // progress card still present
    expect(html).toContain('id="progress-card"');
  });

  test("default (no devBuild) renders prod view", async () => {
    const html = UpgradePage({}).toString();
    expect(html).toContain("version-selector-card");
  });

  test("official radio has latest label handling in static HTML (placeholder)", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain("official-label");
    expect(html).toContain("Official release");
  });

  test("contains script that fetches versions and posts version", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain("/api/upgrade/versions");
    expect(html).toContain("/api/upgrade");
    expect(html).toContain("getSelectedVersion");
    expect(html).toContain("BATCH");
  });

  test("prod build shows current-version-display element", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain('id="current-version-display"');
    expect(html).toContain("Current Version");
  });

  test("dev build shows current-version-display", async () => {
    const html = UpgradePage({ devBuild: true }).toString();
    expect(html).toContain('id="current-version-display"');
  });

  test("prod build shows configured-version-warning element", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain('id="configured-version-warning"');
  });

  test("script reads configured_version from API response", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain("configured_version");
    expect(html).toContain("configuredVersion");
  });

  test("script reads current_version and displays via textContent", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain("current_version");
    expect(html).toContain("current-version-display");
    expect(html).toContain("textContent");
  });

  test("script posts target_type in upgrade request", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain("target_type");
    expect(html).toContain("targetType");
  });

  test("script defaults to official when configuredVersion is null", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain("!configuredVersion");
  });

  test("script shows configured-version-warning when configured version not in discovered list", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain("configured-version-warning");
    expect(html).toContain("is not in the discovered release list");
  });

  test("shell renders component versions loading skeleton with accessible status", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain('id="component-versions-root"');
    expect(html).toContain('id="component-versions-loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('class="spinner"');
    expect(html).toContain('id="component-versions-elapsed"');
    expect(html).toContain('class="skeleton');
    expect(html).toContain('id="component-versions-skeletons"');
    expect(html).toContain('id="component-versions-data"');
    expect(html).toContain('id="component-versions-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('id="component-versions-retry"');
    expect(html).toContain('Retry loading component versions');
  });

  test("shell versions-loading has spinner, aria-busy, elapsed and retry", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain('id="versions-loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('id="versions-elapsed"');
    expect(html).toContain('id="versions-retry"');
    expect(html).toContain('aria-label="Retry loading versions"');
    expect(html).toContain('min-height:44px');
  });

  test("shell script hydrates component metadata via Promise.all and AbortController timeout", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain("loadComponentVersions");
    expect(html).toContain("Promise.all");
    expect(html).toContain('fetch("/api/versions"');
    expect(html).toContain('fetch("/api/versions/image"');
    expect(html).toContain("AbortController");
    expect(html).toContain("COMPONENT_TIMEOUT_MS");
    expect(html).toContain("component-versions-retry");
    expect(html).toContain("renderComponentVersions");
  });

  test("upgrade version loader uses AbortController timeout, spinner/elapsed, retry reuses same loader", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain("upgradeAbortController");
    expect(html).toContain("UPGRADE_TIMEOUT_MS");
    expect(html).toContain("versions-elapsed");
    expect(html).toContain("versions-retry");
    expect(html).toContain('addEventListener("click", loadVersions)');
    expect(html).toContain("Request timed out");
  });

  test("script avoids duplicate event listeners on retry", async () => {
    const html = UpgradePage({ devBuild: false }).toString();
    expect(html).toContain("upgradeListenersBound");
    expect(html).toContain("bindUpgradeControlListenersOnce");
    expect(html).toContain("componentRetryBound");
    expect(html).toContain("upgradeRetryBound");
  });

  test("shell renders immediately with empty Versions props (no blocking data)", async () => {
    const html = UpgradePage({ devBuild: false, versionsByCategory: {}, imageMeta: {} }).toString();
    expect(html).toContain("Loading component versions");
    expect(html).not.toContain("<code>v");
  });

  test("real data rendering still shows tables without skeleton when props provided", async () => {
    const html = UpgradePage({ devBuild: false, versionsByCategory: { core: { Bun: "1.2.0" } }, imageMeta: { image: "ghcr.io/tryweb/ai-engkit:latest" } }).toString();
    expect(html).toContain("<code>1.2.0</code>");
    expect(html).toContain("<code>ghcr.io/tryweb/ai-engkit:latest</code>");
  });
});
