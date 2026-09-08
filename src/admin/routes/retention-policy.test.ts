import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRetentionPolicyRoutes } from "./retention-policy";

describe("Retention policy routes", () => {
  test("reads default policy when no file exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      const response = await app.request("http://localhost/api/admin/retention-policy");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ enabled: false, cutoffDays: 30, dailyRunAt: "03:00" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("round-trip persistence: PUT then GET returns stored values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      const putResponse = await app.request("http://localhost/api/admin/retention-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" }),
      });
      expect(putResponse.status).toBe(200);
      expect(await putResponse.json()).toEqual({ ok: true, enabled: true, cutoffDays: 30, dailyRunAt: "03:00" });

      const getResponse = await app.request("http://localhost/api/admin/retention-policy");
      expect(getResponse.status).toBe(200);
      expect(await getResponse.json()).toEqual({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" });

      const fileContent = JSON.parse(await readFile(policyPath, "utf8"));
      expect(fileContent).toEqual({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects cutoff 0 with field-level error and preserves previous policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      await app.request("http://localhost/api/admin/retention-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false, cutoffDays: 30, dailyRunAt: "03:00" }),
      });
      const before = await readFile(policyPath, "utf8");

      const response = await app.request("http://localhost/api/admin/retention-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, cutoffDays: 0, dailyRunAt: "03:00" }),
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("cutoffDays");
      expect(body.error).toContain("between 1 and 365");

      expect(await readFile(policyPath, "utf8")).toBe(before);
      const getResponse = await app.request("http://localhost/api/admin/retention-policy");
      expect(await getResponse.json()).toEqual({ enabled: false, cutoffDays: 30, dailyRunAt: "03:00" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects cutoff 400 with field-level error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      const response = await app.request("http://localhost/api/admin/retention-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, cutoffDays: 400, dailyRunAt: "03:00" }),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain("cutoffDays");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects invalid enabled type with field-level error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      const response = await app.request("http://localhost/api/admin/retention-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: "true", cutoffDays: 30, dailyRunAt: "03:00" }),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain("enabled");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects archive field with field-level error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      const response = await app.request("http://localhost/api/admin/retention-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, cutoffDays: 30, dailyRunAt: "03:00", archive: true }),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain("archive");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects non-object body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      const response = await app.request("http://localhost/api/admin/retention-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify("not-object"),
      });
      expect(response.status).toBe(400);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects invalid dailyRunAt with field-level error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      const response = await app.request("http://localhost/api/admin/retention-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, cutoffDays: 30, dailyRunAt: "24:00" }),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain("dailyRunAt");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects non-zero-padded dailyRunAt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      const response = await app.request("http://localhost/api/admin/retention-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, cutoffDays: 30, dailyRunAt: "3:00" }),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain("dailyRunAt");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("stored policy missing dailyRunAt defaults to 03:00 on read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    await writeFile(policyPath, JSON.stringify({ enabled: true, cutoffDays: 30 }) + "\n");
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      const response = await app.request("http://localhost/api/admin/retention-policy");
      expect(response.status).toBe(200);
      const body = await response.json() as { dailyRunAt: string };
      expect(body.dailyRunAt).toBe("03:00");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serves retention policy page with time input and server time hint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      const response = await app.request("http://localhost/retention-policy");
      const html = await response.text();
      expect(html).toContain('id="retention-dailyRunAt"');
      expect(html).toContain('type="time"');
      expect(html).toContain("(server time)");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports malformed policy without overwriting file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    await writeFile(policyPath, '{"enabled":"yes","cutoffDays":30}\n');
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      const response = await app.request("http://localhost/api/admin/retention-policy");
      expect(response.status).toBe(500);
      expect((await response.json() as { error: string }).error).toContain("malformed");
      expect(await readFile(policyPath, "utf8")).toBe('{"enabled":"yes","cutoffDays":30}\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serves retention policy page HTML", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-routes-"));
    const policyPath = join(directory, "retention-policy.json");
    const app = createRetentionPolicyRoutes({ policyPath });
    try {
      const response = await app.request("http://localhost/retention-policy");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Retention Policy");
      expect(html).toContain('id="retention-enabled"');
      expect(html).toContain('id="retention-cutoff"');
      expect(html).toContain('id="save-retention"');
      expect(html).toContain('loadRetentionPolicy');
      expect(html).toContain('saveRetentionPolicy');
      expect(html).toContain('/api/admin/retention-policy');
      expect(html).toContain('id="run-counts"');
      expect(html).toContain('id="run-confirm"');
      expect(html).toContain('id="run-maintenance"');
      expect(html).toContain('id="run-status"');
      expect(html).toContain('id="run-progress"');
      expect(html).toContain('id="run-result"');
      expect(html).toContain('Run maintenance now');
      expect(html).toContain('I understand this permanently deletes');
      expect(html).toContain('loadDeleteCounts');
      expect(html).toContain('runMaintenanceNow');
      expect(html).toContain('updateRunButtonState');
      expect(html).toContain('/api/admin/db-maintenance/counts');
      expect(html).toContain('/api/admin/db-maintenance/run');
      expect(html).toContain('/api/admin/db-maintenance/log');
      expect(html).toContain('EventSource');
      expect(html).toContain('confirm');
      expect(html).toContain('hard-deleted');
      expect(html).toContain('Enable the policy first');
      expect(html).toContain('already in progress');
      expect(html).toContain('status-pill--success');
      expect(html).toContain('status-pill--danger');
      expect(html).toContain('status-pill--warning');
      expect(html).toContain('Maintenance status');
      expect(html).toContain('id="maint-detail"');
      expect(html).toContain('id="db-detail"');
      expect(html).toContain('loadMaintenanceStatus');
      expect(html).toContain('loadDbHealth');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
