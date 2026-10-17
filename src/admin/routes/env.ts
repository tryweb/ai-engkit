import { Hono } from "hono";
import { readEnvFile, upsertEnvVar, envFileExists } from "../lib/env";
import { PROVIDER_ENV_KEY, parseProviders } from "../lib/providers";
import { execInAiDev } from "../lib/docker";
import { restartAiDev } from "../lib/restart-ai-dev";
import { EnvEditorPage } from "../views/env-editor";
import { ENV_SCHEMA } from "../lib/env-schema";

const env = new Hono();

env.get("/api/env", (c) => {
  const vars = readEnvFile();
  return c.json(vars);
});

env.put("/api/env/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json();
  const value = body.value;

  if (typeof value !== "string") {
    return c.json({ error: "Value must be a string" }, 400);
  }

  if (key === PROVIDER_ENV_KEY) {
    const parsed = parseProviders(value);
    if ("error" in parsed) {
      return c.json({ error: `OPENCODE_PROVIDER must be valid JSON: ${parsed.error}` }, 400);
    }
  }

  upsertEnvVar(key, value);
  return c.json({ ok: true });
});

env.get("/api/env/schema", (c) => {
  return c.json(ENV_SCHEMA);
});

env.post("/api/env/from-template", async (c) => {
  const result = await execInAiDev(
    "curl -sS https://raw.githubusercontent.com/tryweb/ai-engkit/v2/.env.v2.example 2>/dev/null || true",
    15_000,
  );
  if (result.exitCode !== 0 || !result.stdout) {
    return c.json({ error: "Could not fetch template" }, 500);
  }
  return c.json({ content: result.stdout });
});

env.post("/api/env/restart", async (c) => {
  const result = await restartAiDev();
  if ("error" in result) return c.json({ error: result.error }, 500);
  return c.json({ ok: true });
});

env.get("/env", async (c) => {
  const envVars = readEnvFile();
  return c.html(EnvEditorPage(envVars, ENV_SCHEMA));
});

export default env;
