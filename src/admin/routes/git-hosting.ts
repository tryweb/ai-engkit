import { Hono } from "hono";
import { getGhStatus } from "../lib/gh-auth";
import { listGlabInstances } from "../lib/glab-auth";
import { readGlobalConfig } from "../lib/git-config";
import { loadGitHostingAuthState } from "../lib/git-hosting-auth-state";
import { GitHostingPage } from "../views/git-hosting";

const gitHosting = new Hono();

gitHosting.get("/auth/git-hosting", async (c) => {
  const [ghStatus, instances, config] = await Promise.all([getGhStatus(), listGlabInstances(), readGlobalConfig()]);
  const authState = loadGitHostingAuthState();
  return c.html(GitHostingPage(ghStatus, instances, config, authState));
});

export default gitHosting;
