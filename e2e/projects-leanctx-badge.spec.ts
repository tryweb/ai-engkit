import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "Password" }).fill(process.env.ADMIN_PASSWORD ?? "testadmin123");
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

type OverviewEntry = {
  features: Record<string, boolean>;
  remote: string | null;
  disabled: boolean;
  codegraph: unknown;
  leanctx: unknown;
  stats: unknown;
};

function project(overrides: Partial<OverviewEntry> = {}): OverviewEntry {
  return {
    features: { knowledge: false, maintenance: false, openspec: false, superpowers: false },
    remote: null,
    disabled: false,
    codegraph: null,
    leanctx: null,
    stats: null,
    ...overrides,
  };
}

// Stubbed overview keeps every LeanCTX state deterministic: available with
// counts, empty, and a failed probe (null). `rawFacts` proves the UI renders
// only the approved projection fields.
const overview: Record<string, OverviewEntry> = {
  "lk-available": project({
    codegraph: {
      initialized: true,
      fileCount: 12,
      nodeCount: 30,
      edgeCount: 40,
      index: { reindexRecommended: false, state: "indexed" },
      lastIndexed: "2026-09-16T00:00:00.000Z",
    },
    leanctx: {
      state: "available",
      activeFacts: 4,
      archivedFacts: 2,
      patterns: 1,
      history: 3,
      lastUpdated: "2026-09-15T00:00:00.000Z",
      rawFacts: ["SECRET_FACT_VALUE"],
    },
  }),
  "lk-empty": project({
    leanctx: { state: "empty", activeFacts: 0, archivedFacts: 0, patterns: 0, history: 0, lastUpdated: null },
  }),
  "lk-unknown": project(),
};

async function openProjects(page: Page) {
  await signIn(page);
  await page.route("**/api/projects/overview", (route) => route.fulfill({ json: overview }));
  await page.goto("/projects", { waitUntil: "networkidle" });
}

function row(page: Page, name: string) {
  return page.locator(`[data-project="${name}"]`);
}

test("renders explicit LeanCTX Knowledge badge states beside CodeGraph", async ({ page }) => {
  await openProjects(page);

  const available = row(page, "lk-available").getByRole("button", { name: /LeanCTX Knowledge/ });
  await expect(available).toHaveText("LK");
  await expect(available).toHaveAttribute("aria-label", /4 active facts/);
  await expect(available).toHaveAttribute("title", /4 active facts/);

  const empty = row(page, "lk-empty").getByRole("button", { name: /LeanCTX Knowledge/ });
  await expect(empty).toHaveText("no knowledge");
  await expect(empty).toHaveAttribute("aria-label", /no knowledge/);

  const unknown = row(page, "lk-unknown").getByRole("button", { name: /LeanCTX Knowledge/ });
  await expect(unknown).toHaveText("LK unknown");
  await expect(unknown).toHaveAttribute("aria-label", /status unknown/);

  // Existing CodeGraph rendering is unchanged.
  await expect(
    row(page, "lk-available").getByRole("button", { name: "CodeGraph indexed — view details" }),
  ).toHaveText("CG");
  await expect(
    row(page, "lk-unknown").getByRole("button", { name: "CodeGraph status unknown — view details" }),
  ).toHaveText("CG?");
});

test("drawer shows the LeanCTX summary without raw facts or mutation controls", async ({ page }) => {
  await openProjects(page);

  await row(page, "lk-available").getByRole("button", { name: /LeanCTX Knowledge/ }).click();
  const drawer = page.locator("#project-drawer");
  await expect(drawer).toBeVisible();
  const section = drawer.locator("#drawer-leanctx");
  await expect(section).toContainText("4 active facts · 2 archived facts");
  await expect(section).toContainText("1 pattern · 3 history entries");
  await expect(section).toContainText("Last updated");
  await expect(section).toContainText("Project-scoped counts");
  await expect(drawer).not.toContainText("SECRET_FACT_VALUE");
  await expect(section.locator("button, input, select, textarea, a")).toHaveCount(0);
  // CodeGraph keeps its Reindex control.
  await expect(drawer.locator("#drawer-codegraph").getByRole("button", { name: "Reindex" })).toBeVisible();

  // Empty state stays neutral: no "Status unknown" leakage.
  await drawer.locator("#drawer-close").click();
  await row(page, "lk-empty").getByRole("button", { name: /LeanCTX Knowledge/ }).click();
  await expect(drawer.locator("#drawer-leanctx")).toContainText("No knowledge stored");
  await expect(drawer.locator("#drawer-leanctx")).not.toContainText("Status unknown");

  // Unknown state renders an explicit placeholder.
  await drawer.locator("#drawer-close").click();
  await row(page, "lk-unknown").getByRole("button", { name: /LeanCTX Knowledge/ }).click();
  await expect(drawer.locator("#drawer-leanctx")).toContainText("Status unknown");
});

test("badge cluster stays within the viewport and is keyboard operable", async ({ page }) => {
  await openProjects(page);

  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(row(page, "lk-available")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  const badge = row(page, "lk-available").getByRole("button", { name: /LeanCTX Knowledge/ });
  await badge.focus();
  await expect(badge).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#project-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#project-drawer")).toBeHidden();
});
