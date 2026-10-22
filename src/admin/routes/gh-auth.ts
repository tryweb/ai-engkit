import { Hono } from "hono";
import { execInAiDev } from "../lib/docker";
import { getGhStatusDetails, startDeviceFlow, logoutGh } from "../lib/gh-auth";

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
    "gh auth status 2>&1 | grep -oP \"Token scopes: '\\K[^']+\" || true",
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

  const scopes = scopesResult.stdout
    ? scopesResult.stdout.trim().split(",").map((s: string) => s.trim())
    : [];

  return { login, avatar_url, name, scopes };
}

ghAuth.get("/api/auth/gh/status", async (c) => {
  const details = await getGhStatusDetails();
  return c.json({
    status: details.validity === "valid" ? "authenticated" : "not authenticated",
    ...details,
    expiry_known: !details.expiry_unknown,
    guidance: details.reauthorization_guidance,
  });
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
