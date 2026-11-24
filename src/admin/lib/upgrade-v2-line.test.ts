import { describe, expect, test } from "bun:test";
import { resolveStableChannel, resolveImageRef } from "./image-ref";
import { upstreamBase, upstreamComposePath, upstreamEnvExamplePath } from "./upgrade";

describe("native V2 image and asset resolution", () => {
  test("uses the :v2 channel, never :latest", () => {
    expect(resolveStableChannel()).toBe("v2");
    expect(resolveImageRef()).toBe("ghcr.io/tryweb/ai-engkit:v2");
  });

  test("fetches only V2 assets from the v2 branch", () => {
    expect(upstreamBase()).toBe("https://raw.githubusercontent.com/tryweb/ai-engkit/v2");
    expect(upstreamComposePath()).toBe("docker-compose.v2.yml");
    expect(upstreamEnvExamplePath()).toBe(".env.v2.example");
  });

  test("rolling v2-dev resolves to the V2 asset branch", () => {
    expect(upstreamBase("v2-dev")).toBe("https://raw.githubusercontent.com/tryweb/ai-engkit/v2");
  });

  test("pinned V2 release assets use the exact tag", () => {
    expect(upstreamBase("v2.0.27")).toBe("https://raw.githubusercontent.com/tryweb/ai-engkit/v2.0.27");
  });
});
