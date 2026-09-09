import { describe, expect, test } from "bun:test";
import { VersionsContent } from "./versions";

describe("VersionsContent view", () => {
  test("empty props renders loading skeleton with accessible markup", async () => {
    const html = VersionsContent({ versionsByCategory: {}, imageMeta: {} }).toString();
    expect(html).toContain('id="component-versions-root"');
    expect(html).toContain('id="component-versions-loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('class="spinner"');
    expect(html).toContain('id="component-versions-elapsed"');
    expect(html).toContain('class="skeleton');
    expect(html).toContain('id="component-versions-skeletons"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('id="component-versions-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('id="component-versions-retry"');
    expect(html).toContain('Retry loading component versions');
    expect(html).toContain('min-height:44px');
    expect(html).toContain("Component Versions");
  });

  test("empty props uses dark-zinc tokens via skeleton class", async () => {
    const html = VersionsContent({ versionsByCategory: {}, imageMeta: {} }).toString();
    expect(html).toContain("skeleton-text");
  });

  test("non-empty props renders real tables without skeleton busy state", async () => {
    const html = VersionsContent({
      versionsByCategory: { core: { Bun: "1.2.3", Docker: "20.10" } },
      imageMeta: { image: "ghcr.io/tryweb/ai-engkit:latest", version: "v1.2.0" },
    }).toString();
    expect(html).toContain("Image Metadata");
    expect(html).toContain("<code>ghcr.io/tryweb/ai-engkit:latest</code>");
    expect(html).toContain("<code>1.2.3</code>");
    expect(html).toContain("Core");
    expect(html).not.toContain('aria-busy="true"');
    expect(html).toContain('id="component-versions-root"');
  });

  test("non-empty keeps imageMeta label mapping", async () => {
    const html = VersionsContent({
      versionsByCategory: {},
      imageMeta: { digest: "sha256:abc", created: "2024-01-01" },
    }).toString();
    expect(html).toContain("Digest");
    expect(html).toContain("Created");
    expect(html).toContain("sha256:abc");
  });
});
