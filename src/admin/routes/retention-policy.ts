import { Hono } from "hono";
import {
  readRetentionPolicyFrom,
  retentionPolicyPath,
  validateRetentionPolicy,
  writeRetentionPolicyFrom,
} from "../lib/retention-policy";
import { RetentionPolicyPage } from "../views/retention-policy";

export interface RetentionPolicyRoutesOptions {
  policyPath?: string;
}

export function createRetentionPolicyRoutes(options: RetentionPolicyRoutesOptions = {}) {
  const policyPath = options.policyPath ?? retentionPolicyPath();
  const retention = new Hono();

  retention.get("/api/admin/retention-policy", (c) => {
    try {
      const policy = readRetentionPolicyFrom(policyPath);
      return c.json(policy);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read retention policy";
      if (message.includes("malformed")) {
        return c.json({ error: "Retention policy is malformed" }, 500);
      }
      return c.json({ error: message }, 500);
    }
  });

  retention.put("/api/admin/retention-policy", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "Request body must be an object" }, 400);
    }

    const result = validateRetentionPolicy(body);
    if (result.ok === false) {
      return c.json({ error: `${result.field} ${result.message}` }, 400);
    }

    try {
      writeRetentionPolicyFrom(policyPath, result.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update retention policy";
      return c.json({ error: message }, 500);
    }

    return c.json({ ok: true, ...result.value });
  });

  retention.get("/retention-policy", (c) => c.html(RetentionPolicyPage()));

  return retention;
}

export default createRetentionPolicyRoutes();
