import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const NPM_PACKAGE = "typescript-language-server";
const SERVER_KEY = "typescript";
const MUTATION_KEY = "json";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Password" }).fill(process.env.ADMIN_PASSWORD ?? "testadmin123");
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

async function stubLspApi(page: Page, rows: Array<Record<string, unknown>>) {
  await page.route("**/api/lsp", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ servers: rows }) });
      return;
    }
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/lsp/versions?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ package: NPM_PACKAGE, latest: "6.1.0", versions: ["6.1.0", "6.0.0", "5.4.0", "5.3.0", "5.2.0"] }),
    });
  });
}

function baseRows(overrides: Partial<Record<string, unknown>> = {}): Array<Record<string, unknown>> {
  return [
    {
      serverKey: SERVER_KEY,
      npmPackage: NPM_PACKAGE,
      command: "typescript-language-server --stdio",
      extensions: [".ts", ".tsx"],
      defaultEnabled: false,
      enabled: false,
      pinnedVersion: null,
      installedVersion: null,
      inLspBlock: false,
      drift: null,
      builtinBacked: false,
      ...overrides,
    },
  ];
}

test("LSP page lists the catalog servers and reports v2 unavailability", async ({ page }) => {
  await signIn(page);
  await stubLspApi(page, baseRows());
  await page.goto("/lsp");

  await expect(page.locator("main h2")).toHaveText("LSP Server Management");
  const row = page.locator(`tr[data-key="${SERVER_KEY}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(NPM_PACKAGE);

  const versionSelect = row.locator(`.lsp-version[data-row="${SERVER_KEY}"]`);
  await expect(versionSelect).toBeDisabled();
  await expect(page.getByRole("button", { name: "Apply Changes" })).toBeDisabled();
  await expect(page.locator(".lsp-v2-notice")).toBeVisible();
  await expect(page.locator(".lsp-v2-notice")).toContainText("OpenCode v2");

  // Versions still load into the (disabled) dropdown.
  await expect(page.locator(`select.lsp-version[data-row="${SERVER_KEY}"] option[value="6.1.0"]`)).toHaveCount(1);
});

test("LSP mutations are blocked on OpenCode v2", async ({ page }) => {
  await signIn(page);
  await stubLspApi(page, baseRows());
  await page.goto("/lsp");

  const row = page.locator(`tr[data-key="${MUTATION_KEY}"]`);
  await expect(row.locator(`.lsp-toggle[data-row="${MUTATION_KEY}"]`)).toBeDisabled();
  await expect(row.locator(`.lsp-version[data-row="${MUTATION_KEY}"]`)).toBeDisabled();

  const put = await page.request.put("/api/lsp", {
    data: { overrides: { [MUTATION_KEY]: { enabled: true, version: "6.0.0" } } },
  });
  expect(put.status()).toBe(409);
  expect((await put.json()).error).toContain("unavailable on OpenCode v2");

  const apply = await page.request.post("/api/lsp/apply");
  expect(apply.status()).toBe(409);
  expect((await apply.json()).error).toContain("unavailable on OpenCode v2");
});
