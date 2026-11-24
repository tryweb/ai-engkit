import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "Password" }).fill(process.env.ADMIN_PASSWORD ?? "testadmin123");
  await page.getByRole("button", { name: "Sign In" }).click();
}

test("project drawer never overlaps the sidebar column at tablet widths", async ({ page }) => {
  const projectName = `e2e-tablet-${Date.now()}`;
  await signIn(page);
  const created = await page.request.post("/api/projects", { data: { name: projectName, git_init: false } });
  expect(created.ok()).toBeTruthy();
  try {
    await page.goto("/projects", { waitUntil: "networkidle" });
    const row = page.locator(`[data-project="${projectName}"]`);
    await row.waitFor();

    for (const width of [1024, 768, 767]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload({ waitUntil: "networkidle" });
      await row.waitFor();
      await row.locator(".project-name-btn").click();
      const drawer = page.locator("#project-drawer");
      await expect(drawer).toBeVisible();
      await expect(drawer.locator("#drawer-name")).toHaveText(projectName);

      const drawerBox = await drawer.boundingBox();
      const sidebarBox = await page.locator(".sidebar").boundingBox();
      expect(drawerBox).not.toBeNull();
      expect(sidebarBox).not.toBeNull();
      // The drawer must never cover the fixed sidebar column.
      expect(drawerBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width);
      // In the tablet range (>=768) the drawer is capped so the content
      // column between sidebar and drawer stays readable.
      if (width >= 768) {
        expect(drawerBox!.width).toBeLessThanOrEqual(360);
      }
    }
  } finally {
    await page.request.post(`/api/projects/${encodeURIComponent(projectName)}/delete`, {
      data: { confirmation_name: projectName },
    });
  }
});
