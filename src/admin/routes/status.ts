import { Hono } from "hono";
import { getAgentStatus } from "../agent";
import { execInAiDev } from "../lib/docker";
import { createToolStatusProbe } from "../lib/project-tool-status";
import { collectStatus } from "../lib/status";

const status_route = new Hono();

status_route.get("/api/status", async (c) => {
  const toolStatus = createToolStatusProbe({ command: execInAiDev, workspaceRoot: "/home/devuser/workspace" });
  return c.json({
    ...(await collectStatus({
      probeLeanCtxSite: () => toolStatus.probeSite(),
      probeGain: () => toolStatus.probeGain(),
      probeValueReport: () => toolStatus.probeValueReport(),
      probeProveReport: () => toolStatus.probeProveReport(),
      probeSavingsReport: () => toolStatus.probeSavingsReport(),
    })),
    agent_status: getAgentStatus(),
  });
});

status_route.get("/healthz", (c) => {
  return c.json({ status: "ok" });
});

export default status_route;
