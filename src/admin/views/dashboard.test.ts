import { describe, expect, test } from "bun:test";
import { DashboardPage } from "./dashboard";
import {
  createHarness,
  createRestartAdminFromSource,
  getProductionRestartAdminSource,
} from "./dashboard-restart.test-support";

describe("dashboard restartAdmin behavioral — production extraction", () => {
  test("Given old admin remains healthy, When polling, Then does not reload and eventually times out", async () => {
    // Given: baseline uptime 100, digest abc, poll always returns same healthy values
    const harness = createHarness({
      baseline: { uptime: 100, digest: "sha256:abc" },
      postOk: true,
      pollSequence: Array.from({ length: 130 }, () => ({ ok: true, body: { uptime_seconds: 100, image_digest: "sha256:abc" } })),
    });
    const source = getProductionRestartAdminSource();
    const restartAdmin = createRestartAdminFromSource(source, harness.deps);

    // When: execute production restartAdmin
    await restartAdmin();

    // Then: no immediate reload
    expect(harness.isReloaded()).toBe(false);
    for (let i = 0; i < 130; i++) {
      await harness.runNextTimeout();
      if (harness.isReloaded()) break;
      if (harness.getAlerts().some((a) => a.includes("timed out"))) break;
    }
    expect(harness.getAlerts().some((a) => a.includes("timed out"))).toBe(true);
    expect(harness.getButton().disabled).toBe(false);
    expect(harness.getButton().textContent).toBe("↻ Restart");
    expect(harness.isReloaded()).toBe(false);
  });

  test("Given uptime resets, When polling, Then reloads", async () => {
    // Given: baseline uptime 100, poll returns same then lower uptime
    const harness = createHarness({
      baseline: { uptime: 100, digest: "sha256:abc" },
      postOk: true,
      pollSequence: [
        { ok: true, body: { uptime_seconds: 100, image_digest: "sha256:abc" } },
        { ok: true, body: { uptime_seconds: 2, image_digest: "sha256:abc" } },
      ],
    });
    const source = getProductionRestartAdminSource();
    const restartAdmin = createRestartAdminFromSource(source, harness.deps);

    // When
    await restartAdmin();
    await harness.runNextTimeout();
    expect(harness.isReloaded()).toBe(false);
    await harness.runNextTimeout();

    // Then
    expect(harness.isReloaded()).toBe(true);
  });

  test("Given digest changes, When polling, Then reloads", async () => {
    // Given
    const harness = createHarness({
      baseline: { uptime: 100, digest: "sha256:abc" },
      postOk: true,
      pollSequence: [
        { ok: true, body: { uptime_seconds: 100, image_digest: "sha256:abc" } },
        { ok: true, body: { uptime_seconds: 100, image_digest: "sha256:def" } },
      ],
    });
    const source = getProductionRestartAdminSource();
    const restartAdmin = createRestartAdminFromSource(source, harness.deps);

    // When
    await restartAdmin();
    await harness.runNextTimeout();
    expect(harness.isReloaded()).toBe(false);
    await harness.runNextTimeout();

    // Then
    expect(harness.isReloaded()).toBe(true);
  });

  test("Given observed unavailability then healthy, When polling, Then reloads via recovery", async () => {
    // Given: baseline, first poll non-ok, second poll healthy
    const harness = createHarness({
      baseline: { uptime: 100, digest: "sha256:abc" },
      postOk: true,
      pollSequence: [
        { ok: false, body: {} },
        { ok: true, body: { uptime_seconds: 100, image_digest: "sha256:abc" } },
      ],
    });
    const source = getProductionRestartAdminSource();
    const restartAdmin = createRestartAdminFromSource(source, harness.deps);

    // When
    await restartAdmin();
    await harness.runNextTimeout();
    expect(harness.isReloaded()).toBe(false);
    await harness.runNextTimeout();

    // Then
    expect(harness.isReloaded()).toBe(true);
  });

  test("Given poll throws then healthy, When polling, Then reloads", async () => {
    // Given: throw on first poll
    const harness = createHarness({
      baseline: { uptime: 80, digest: "sha256:xyz" },
      postOk: true,
      pollSequence: [
        { ok: true, throw: true },
        { ok: true, body: { uptime_seconds: 80, image_digest: "sha256:xyz" } },
      ],
    });
    const source = getProductionRestartAdminSource();
    const restartAdmin = createRestartAdminFromSource(source, harness.deps);

    // When
    await restartAdmin();
    await harness.runNextTimeout();
    expect(harness.isReloaded()).toBe(false);
    await harness.runNextTimeout();

    // Then
    expect(harness.isReloaded()).toBe(true);
  });

  test("Given POST 500 with server error, When restart attempted, Then alert propagates error and restores button", async () => {
    // Given: POST returns 500 with error JSON
    const harness = createHarness({
      baseline: { uptime: 50, digest: "sha256:abc" },
      postOk: false,
      postBody: { ok: false, error: "Failed to resolve host bind sources for ai-admin restart" },
      pollSequence: [],
    });
    const source = getProductionRestartAdminSource();
    const restartAdmin = createRestartAdminFromSource(source, harness.deps);

    // When
    await restartAdmin();

    // Then: alert contains server error, button restored, no reload, no polling
    expect(harness.getAlerts().length).toBe(1);
    expect(harness.getAlerts()[0].includes("Failed to resolve host bind sources")).toBe(true);
    expect(harness.getButton().disabled).toBe(false);
    expect(harness.getButton().textContent).toBe("↻ Restart");
    expect(harness.isReloaded()).toBe(false);
    expect(harness.getTimeouts().length).toBe(0);
  });

  test("Given POST 500 with unparsable JSON, When restart attempted, Then fallback alert and button restored", async () => {
    // Given: POST returns 500 but json() throws
    const harness = createHarness({
      baseline: { uptime: 50, digest: "sha256:abc" },
      postOk: false,
      pollSequence: [],
    });
    const source = getProductionRestartAdminSource();
    const restartAdmin = createRestartAdminFromSource(source, harness.deps);

    // When
    await restartAdmin();

    // Then: fallback message retained
    expect(harness.getAlerts().length).toBe(1);
    expect(harness.getAlerts()[0]).toBe("Failed to restart admin");
    expect(harness.getButton().disabled).toBe(false);
  });
});

describe("dashboard polish — dev Latest hidden and AI Runtime header removed", () => {
  function baseData(overrides: Partial<Parameters<typeof DashboardPage>[0]>): Parameters<typeof DashboardPage>[0] {
    return {
      container_status: "running",
      uptime_seconds: 100,
      versions: { "AI-EngKit": "v1.0.0", leanctx: "v0.1.0" },
      gh_auth: "authenticated",
      glab_auth: "authenticated",
      git_user: "test",
      project_count: 2,
      ssh_key_count: 1,
      leanctx: null,
      gain: null,
      valueReport: null,
      proveReport: null,
      savingsReport: null,
      update_check: {
        current: "v1.0.0",
        latest: "v1.0.0",
        update_available: false,
        status: "up-to-date",
        configured: null,
        message: "",
      },
      upgrade_state: "idle",
      upgrade_events: [],
      upgrade_current_step: "",
      upgrade_progress_pct: 0,
      admin_version: "v1.0.0",
      admin_version_mismatch: false,
      ...overrides,
    };
  }

  test("Given admin_version dev and up-to-date, When DashboardPage rendered, Then no ✓ Latest in Site Summary or Component Versions", () => {
    // Given: dev version with up-to-date status would previously show Latest in two places
    const html = String(
      DashboardPage(
        baseData({
          admin_version: "dev",
          update_check: {
            current: "v1.0.0",
            latest: "v1.0.0",
            update_available: false,
            status: "up-to-date",
            configured: null,
            message: "",
          },
        }),
      ),
    );
    // Then: Latest badge must not appear at all; other update states are still allowed elsewhere
    expect(html.includes("✓ Latest")).toBe(false);
    // Site summary band should still render but without Latest text
    expect(html.includes('aria-label="Site summary"')).toBe(true);
    // Component Versions card still present with AI-EngKit row but without Latest badge
    expect(html.includes("Component Versions")).toBe(true);
    expect(html.includes("<code>v1.0.0</code>")).toBe(true);
  });

  test("Given admin_version dev and update-available, When rendered, Then Upgrade still visible and Latest hidden", () => {
    // Given: dev with actionable update-available must preserve actionable badge
    const html = String(
      DashboardPage(
        baseData({
          admin_version: "dev",
          update_check: {
            current: "v1.0.0",
            latest: "v1.1.0",
            update_available: true,
            status: "update-available",
            configured: null,
            message: "",
          },
        }),
      ),
    );
    // Then: Upgrade badge must remain; Latest must not leak
    expect(html.includes("▲ Upgrade")).toBe(true);
    expect(html.includes("✓ Latest")).toBe(false);
  });

  test("Given admin_version v2dev and up-to-date, When DashboardPage rendered, Then no ✓ Latest in Site Summary or Component Versions", () => {
    // Given: v2dev local build intentionally skips release-channel comparison; must not claim Latest
    const html = String(
      DashboardPage(
        baseData({
          admin_version: "v2dev",
          update_check: {
            current: "v2dev",
            latest: "v2dev",
            update_available: false,
            status: "up-to-date",
            configured: null,
            message: "",
          },
        }),
      ),
    );
    // Then: Latest badge must not appear; layout remains intact without styling changes
    expect(html.includes("✓ Latest")).toBe(false);
    expect(html.includes('aria-label="Site summary"')).toBe(true);
    expect(html.includes("Component Versions")).toBe(true);
  });

  test("Given admin_version v2dev and update-available, When rendered, Then Upgrade still visible and Latest hidden", () => {
    // Given: v2dev with actionable update-available preserves Upgrade (behavior parity with dev)
    const html = String(
      DashboardPage(
        baseData({
          admin_version: "v2dev",
          update_check: {
            current: "v2dev",
            latest: "v2dev",
            update_available: true,
            status: "update-available",
            configured: null,
            message: "",
          },
        }),
      ),
    );
    expect(html.includes("▲ Upgrade")).toBe(true);
    expect(html.includes("✓ Latest")).toBe(false);
  });

  test("Given a runtime security profile, When rendered, Then its tooltip is described accessibly", () => {
    const html = String(
      DashboardPage(
        baseData({
          runtimeProfile: {
            applyState: "applied",
            source: "applied-snapshot",
            compressionLevel: "lite",
            toolProfile: "standard",
            permissionInheritance: "on",
            crossProjectSearch: true,
            secretDetectionEnabled: true,
            secretRedactionEnabled: true,
            archiveEnabled: true,
            archiveMaxAgeHours: 24,
            archiveMaxDiskMb: 100,
          },
        }),
      ),
    );
    expect(html.includes('aria-describedby="runtime-profile-security-detail"')).toBe(true);
    expect(html.includes('id="runtime-profile-security-detail"')).toBe(true);
    expect(html.includes(" title=\"")).toBe(false);
  });

  test("Given admin_version dev and pinned, When rendered, Then Pinned badge remains visible", () => {
    // Given: dev should not hide unrelated actionable states like pinned
    const html = String(
      DashboardPage(
        baseData({
          admin_version: "dev",
          update_check: {
            current: "v1.0.0",
            latest: "v1.0.0",
            update_available: false,
            status: "pinned",
            configured: "v0.9.0",
            message: "",
          },
        }),
      ),
    );
    expect(html.includes("Pinned")).toBe(true);
    expect(html.includes("v0.9.0")).toBe(true);
  });

  test("Given admin_version v1.2.3 and up-to-date, When rendered, Then Latest visible in Site Summary and Component Versions", () => {
    // Given: non-dev must still show Latest
    const html = String(
      DashboardPage(
        baseData({
          admin_version: "v1.2.3",
          update_check: {
            current: "v1.2.3",
            latest: "v1.2.3",
            update_available: false,
            status: "up-to-date",
            configured: null,
            message: "",
          },
        }),
      ),
    );
    // Then: Latest appears at least once (site summary + AI-EngKit row)
    expect(html.includes("✓ Latest")).toBe(true);
    const latestCount = (html.match(/✓ Latest/g) ?? []).length;
    expect(latestCount).toBe(2);
  });

  test("Given any state, When DashboardPage rendered, Then AI Runtime header has no Manage/Review action but row links remain", () => {
    // Given: standard ready state
    const html = String(
      DashboardPage(
        baseData({
          providerSummary: {
            state: "ready",
            totalCount: 1,
            issueCount: 0,
            label: "1 provider ready",
            tone: "success",
            href: "/providers",
          },
          subagentSummary: {
            state: "effective",
            configuredCount: 1,
            worstCount: 1,
            label: "1/1 effective",
            tone: "success",
            href: "/agent-models",
          },
        }),
      ),
    );
    // Then: header action link is removed entirely
    expect(html.includes("ai-runtime__action")).toBe(false);
    // No header Manage/Review button inside AI Runtime header
    const aiRuntimeHeaderIdx = html.indexOf('aria-label="AI Runtime"');
    const headerSlice = html.slice(aiRuntimeHeaderIdx, aiRuntimeHeaderIdx + 600);
    expect(headerSlice.includes(">Manage<")).toBe(false);
    expect(headerSlice.includes(">Review<")).toBe(false);
    // Row links retain fixed destinations
    expect(html.includes('href="/providers"')).toBe(true);
    expect(html.includes('href="/agent-models"')).toBe(true);
    expect(html.includes("Providers")).toBe(true);
    expect(html.includes("Subagents")).toBe(true);
    // Rows still carry status-pill and aria-label
    expect(html.includes('aria-label="Providers 1 provider ready"')).toBe(true);
    expect(html.includes('aria-label="Subagents 1/1 effective"')).toBe(true);
  });

  test("Given warning state, When rendered, Then AI Runtime still has no header action", () => {
    // Given: warning would previously trigger Review header action
    const html = String(
      DashboardPage(
        baseData({
          providerSummary: {
            state: "needs-credentials",
            totalCount: 2,
            issueCount: 1,
            label: "1 ready · 1 needs credentials",
            tone: "warning",
            href: "/providers",
          },
          subagentSummary: {
            state: "effective",
            configuredCount: 2,
            worstCount: 2,
            label: "2/2 effective",
            tone: "success",
            href: "/agent-models",
          },
        }),
      ),
    );
    expect(html.includes("ai-runtime__action")).toBe(false);
    expect(html.includes('href="/providers"')).toBe(true);
  });

  test("Given dashboard summary data, When rendered, Then operational cards and status values expose the requested destinations", () => {
    const html = String(DashboardPage(baseData({ git_user: "" })));

    expect(html.includes('href="/projects" class="site-summary__item site-summary__item--link"')).toBe(true);
    expect(html.includes('href="/projects" class="card card--link"')).toBe(true);
    expect(html.includes('href="/auth/git-hosting"')).toBe(true);
    expect(html.includes('href="/ssh-keys"')).toBe(true);
    expect(html.includes('aria-label="SSH keys 1"')).toBe(true);
    expect(html.includes('aria-label="Git not configured"')).toBe(true);
    expect(html.includes('href="/upgrade"')).toBe(true);
    expect(html.includes('href="/env"')).toBe(true);
    expect(html.includes('class="dashboard__ops-row"')).toBe(true);
  });
});
