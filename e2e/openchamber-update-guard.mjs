import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.OPENCHAMBER_BASE_URL ?? "http://127.0.0.1:3000";
const password = process.env.OPENCHAMBER_UI_PASSWORD;

assert.ok(password, "OPENCHAMBER_UI_PASSWORD must be provided");

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("**/api/openchamber/update-check**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: true, version: "1.99.0", currentVersion: "1.24.2" }),
    });
  });

  // Given: an authenticated user sees a deterministic available update.
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#openchamber-ui-password").fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
  const updateButton = page.getByRole("button", { name: "Update", exact: true });
  await updateButton.waitFor({ state: "visible" });

  // When: the user confirms the visible update action.
  await updateButton.click();
  await page.getByRole("heading", { name: "Update Available" }).waitFor({ state: "visible" });
  const installResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/openchamber/update-install") &&
    response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Update Now" }).click();
  const installResponse = await installResponsePromise;

  // Then: the real server refuses the request before any installer can run.
  assert.equal(installResponse.status(), 409);
  const body = await installResponse.json();
  assert.equal(body.code, "CORE_UPDATE_MANAGED_BY_IMAGE");
  assert.match(body.error, /image-managed by AI-EngKit/i);
  await page.getByText(/image-managed by AI-EngKit/i).waitFor({ state: "visible" });
  console.log("PASS authenticated update click shows the real HTTP 409 refusal");
} finally {
  await browser.close();
}
