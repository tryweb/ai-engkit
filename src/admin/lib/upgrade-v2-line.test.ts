import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveStableChannel, resolveImageRef } from "./image-ref";
import { upstreamBase, upstreamComposePath, upstreamEnvExamplePath } from "./upgrade";

// The V2 line is selected by OMO_ENABLED=0 — the same gate the agent-models
// stack uses. readEnvFile() reads /opt/ai-engkit/.env, which does not exist in
// tests, so these cover the unpinned fallback: the path that used to resolve a
// V2 stack to :latest and main/docker-compose.yml (deploying the V1 image and
// overwriting the V2 compose with the V1 file).
describe("line-aware image and asset resolution", () => {
  const saved = process.env.OMO_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.OMO_ENABLED;
    else process.env.OMO_ENABLED = saved;
  });

  describe("V1 line (OMO_ENABLED unset)", () => {
    beforeEach(() => {
      delete process.env.OMO_ENABLED;
    });

    test("uses the :latest channel and the V1 assets", () => {
      expect(resolveStableChannel()).toBe("latest");
      expect(resolveImageRef()).toBe("ghcr.io/tryweb/ai-engkit:latest");
      expect(upstreamBase()).toBe("https://raw.githubusercontent.com/tryweb/ai-engkit/main");
      expect(upstreamComposePath()).toBe("docker-compose.yml");
      expect(upstreamEnvExamplePath()).toBe(".env.example");
    });
  });

  describe("V2 line (OMO_ENABLED=0)", () => {
    beforeEach(() => {
      process.env.OMO_ENABLED = "0";
    });

    test("uses the :v2 channel, never :latest", () => {
      expect(resolveStableChannel()).toBe("v2");
      expect(resolveImageRef()).toBe("ghcr.io/tryweb/ai-engkit:v2");
    });

    test("fetches the V2 assets from the v2 branch", () => {
      // docker-compose.v2.yml and .env.v2.example do not exist on main, so an
      // unpinned V2 upgrade must resolve against the v2 branch.
      expect(upstreamBase()).toBe("https://raw.githubusercontent.com/tryweb/ai-engkit/v2");
      expect(upstreamComposePath()).toBe("docker-compose.v2.yml");
      expect(upstreamEnvExamplePath()).toBe(".env.v2.example");
    });
  });
});
