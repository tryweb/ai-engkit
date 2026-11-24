import { afterAll, expect, test } from "bun:test";
import { createSessionCookie } from "./lib/auth";
import { getAgentStatus } from "./agent";

const originalAdminPassword = process.env.ADMIN_PASSWORD;
process.env.ADMIN_PASSWORD = "test-admin-password";
afterAll(() => {
  if (originalAdminPassword === undefined) {
    delete process.env.ADMIN_PASSWORD;
  } else {
    process.env.ADMIN_PASSWORD = originalAdminPassword;
  }
});

const { app, maintenanceScheduler, hostMaintenanceScheduler } = await import("./server");

test("importing the app does not start background services", async () => {
  await Bun.sleep(10);
  expect(maintenanceScheduler.isStarted()).toBe(false);
  expect(hostMaintenanceScheduler.isStarted()).toBe(false);
  expect(getAgentStatus().state).toBe("disabled");
});

test("OpenChamber settings API requires an admin session", async () => {
  const response = await app.request("http://localhost/api/openchamber/settings");

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
});

test("OpenChamber settings writes require an admin session", async () => {
  const response = await app.request("http://localhost/api/openchamber/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ showOpenCodeUpdateNotifications: true }),
  });

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
});

test("OpenChamber settings page redirects unauthenticated users", async () => {
  const response = await app.request("http://localhost/openchamber", { redirect: "manual" });

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/login");
});

test("session cookie is matched by exact name, not substring (oc_ui_session shadowing)", async () => {
  // Security regression: unanchored /session=([^;]+)/ matched the first "session="
  // substring, so a sibling cookie (oc_ui_session) could shadow the real session.
  const cookie = createSessionCookie();
  const token = cookie.split(";")[0].split("=")[1];

  const response = await app.request("http://localhost/api/openapi.json", {
    headers: { Cookie: `oc_ui_session=stale.junk; session=${token}` },
  });

  expect(response.status).toBe(200);
});

test("malformed session signature is rejected, not a server error", async () => {
  // Security regression: crypto.timingSafeEqual throws on length mismatch, so a
  // crafted short signature decoded into a 500 instead of a clean 401/redirect.
  const response = await app.request("http://localhost/api/openchamber/settings", {
    headers: { Cookie: "session=abc.def" },
  });

  expect(response.status).toBe(401);
});
