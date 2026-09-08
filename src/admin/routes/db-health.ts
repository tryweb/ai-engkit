import { Hono } from "hono";
import { collectHostDbHealth, type DbHealth } from "../lib/db-health";

export type DbHealthDeps = {
  collectHealth?: () => Promise<DbHealth>;
};

export function createDbHealthRoute(deps: DbHealthDeps = {}) {
  const router = new Hono();

  router.get("/api/db-health", async (c) => {
    try {
      const collect = deps.collectHealth ?? (() => collectHostDbHealth());
      const health = await collect();
      return c.json(health);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "Failed to collect db health", detail: message }, 500);
    }
  });

  return router;
}

const defaultRouter = createDbHealthRoute();
export default defaultRouter;
