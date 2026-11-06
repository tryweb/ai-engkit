import { Hono } from "hono";
import { getGhStatusDetails } from "../lib/gh-auth";
import { listGlabInstances } from "../lib/glab-auth";
import { readGlobalConfig } from "../lib/git-config";
import { loadGitHostingAuthState, updateGitHubAuthState } from "../lib/git-hosting-auth-state";
import { GitHostingPage } from "../views/git-hosting";

const gitHosting = new Hono();

gitHosting.get("/auth/git-hosting", async (c) => {
  const [ghDetails, instances, config] = await Promise.all([getGhStatusDetails(), listGlabInstances(), readGlobalConfig()]);
  let authState = loadGitHostingAuthState();
  try {
    authState = await updateGitHubAuthState(ghDetails);
  } catch {
    console.error("GitHub auth status persistence failed");
  }
  const anyAuth = instances.some((i) => i.authenticated);
  const ghStatus = ghDetails.validity === "valid" ? "authenticated" : "not authenticated";
  return c.html(GitHostingPage(ghStatus, instances, anyAuth ? "authenticated" : "not authenticated", config, authState));
});

export default gitHosting;
