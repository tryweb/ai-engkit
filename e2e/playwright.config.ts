import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.ADMIN_BASE_URL;
if (!baseURL) {
  throw new Error(
    "ADMIN_BASE_URL must be set to a disposable E2E target; refusing unsafe default (V1 8081).",
  );
}
if (!process.env.AI_DEV_CONTAINER) {
  throw new Error("AI_DEV_CONTAINER must name the disposable E2E container; refusing the legacy dev default.");
}

const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;

export default defineConfig({
  testDir: ".",
  outputDir: "../.playwright-mcp/e2e",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});
