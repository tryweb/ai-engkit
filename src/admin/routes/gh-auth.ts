import { Hono } from "hono";
import { execInAiDev } from "../lib/docker";
import { getGhStatus, startDeviceFlow, logoutGh, parseScopes } from "../lib/gh-auth";

const ghAuth = new Hono();

interface GhUserInfo {
  login: string;
  avatar_url: string;
  name: string;
  scopes: string[];
}

async function getGhUserInfo(): Promise<GhUserInfo | null> {
  const profileResult = await execInAiDev("gh api user 2>/dev/null || true", 10_000);
  const scopesResult = await execInAiDev(
    "gh auth status 2>&1 | sed -n 's/.*Token scopes: //p' || true",
    10_000,
  );

  let login = "", avatar_url = "", name = "";
  try {
    const profile = JSON.parse(profileResult.stdout);
    login = profile.login || "";
    avatar_url = profile.avatar_url || "";
    name = profile.name || "";
  } catch {
    return null;
  }

  const scopes = parseScopes(scopesResult.stdout);

  return { login, avatar_url, name, scopes };
}

ghAuth.get("/api/auth/gh/status", async (c) => {
  const status = await getGhStatus();
  return c.json({ status });
});

ghAuth.get("/api/auth/gh/user", async (c) => {
  const user = await getGhUserInfo();
  return c.json(user || {});
});

ghAuth.post("/api/auth/gh/start", async (c) => {
  const info = await startDeviceFlow();
  return c.json({ device_code: info.device_code, verification_uri: info.verification_uri });
});

ghAuth.post("/api/auth/gh/logout", async (c) => {
  await logoutGh();
  return c.json({ ok: true });
});

export default ghAuth;
