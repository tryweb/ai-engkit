import { describe, expect, test, beforeEach } from "bun:test";
import {
  clearGhcrCache,
  compareFormalDescending,
  discoverGhcrVersions,
  GHCR_MANIFEST_ACCEPT,
  getGhcrCache,
  isFormalReleaseTag,
  listAllTags,
  normalizeFormalTags,
  parseFormalVersion,
  resolveOfficialVersion,
  getManifestDigest,
  type FetchImpl,
} from "./ghcr-versions";

// helper to build a mock fetch with canned responses and call capture
type MockEntry = {
  match: (url: string, init?: RequestInit) => boolean;
  response: (url: string, init?: RequestInit) => Response;
};

function makeFetch(entries: MockEntry[], onCall?: (url: string, init?: RequestInit) => void): FetchImpl {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (onCall) onCall(u, init);
    for (const e of entries) {
      if (e.match(u, init)) return e.response(u, init);
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

beforeEach(() => {
  clearGhcrCache();
});

describe("isFormalReleaseTag", () => {
  test("accepts v1.x.y and v2.x.y", () => {
    expect(isFormalReleaseTag("v1.0.0")).toBe(true);
    expect(isFormalReleaseTag("v1.10.20")).toBe(true);
    expect(isFormalReleaseTag("v2.0.0")).toBe(true);
    expect(isFormalReleaseTag("v2.10.20")).toBe(true);
  });
  test("rejects non-release", () => {
    expect(isFormalReleaseTag("latest")).toBe(false);
    expect(isFormalReleaseTag("dev")).toBe(false);
    expect(isFormalReleaseTag("v2dev")).toBe(false);
    expect(isFormalReleaseTag("v2-dev")).toBe(false);
    expect(isFormalReleaseTag("main")).toBe(false);
    expect(isFormalReleaseTag("sha-abc123")).toBe(false);
    expect(isFormalReleaseTag("v1.0.0-rc1")).toBe(false);
    expect(isFormalReleaseTag("v3.0.0")).toBe(false);
    expect(isFormalReleaseTag("v1.0")).toBe(false);
    expect(isFormalReleaseTag("v1.0.0.0")).toBe(false);
  });
});

describe("parseFormalVersion", () => {
  test("parses numeric components", () => {
    expect(parseFormalVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseFormalVersion("v1.10.20")).toEqual({ major: 1, minor: 10, patch: 20 });
    expect(parseFormalVersion("v2.0.0")).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(parseFormalVersion("v2.3.4")).toEqual({ major: 2, minor: 3, patch: 4 });
    expect(parseFormalVersion("latest")).toBeNull();
    expect(parseFormalVersion("v2-dev")).toBeNull();
  });
});

describe("normalizeFormalTags", () => {
  test("filters, dedupes, sorts descending", () => {
    const tags = ["latest", "v1.0.1", "v1.0.10", "v1.0.2", "v1.0.1", "dev", "v1.0.0-rc1", "v1.1.0", "v2.0.0", "sha-abc", "v1.2.0"];
    expect(normalizeFormalTags(tags)).toEqual(["v2.0.0", "v1.2.0", "v1.1.0", "v1.0.10", "v1.0.2", "v1.0.1"]);
  });
  test("numeric ordering not lexical", () => {
    const tags = ["v1.0.9", "v1.0.10", "v1.0.2", "v1.9.0", "v1.10.0"];
    expect(normalizeFormalTags(tags)).toEqual(["v1.10.0", "v1.9.0", "v1.0.10", "v1.0.9", "v1.0.2"]);
  });
  test("compareFormalDescending", () => {
    expect(compareFormalDescending("v1.0.10", "v1.0.2")).toBeLessThan(0); // 10 > 2 so a before b => negative
    expect(compareFormalDescending("v1.0.2", "v1.0.10")).toBeGreaterThan(0);
  });
  test("v2 major sorts before v1", () => {
    expect(compareFormalDescending("v2.0.0", "v1.9.9")).toBeLessThan(0);
    expect(normalizeFormalTags(["v1.9.9", "v2.0.0", "v1.10.0"])).toEqual(["v2.0.0", "v1.10.0", "v1.9.9"]);
  });
});

describe("listAllTags pagination", () => {
  test("single page", async () => {
    const fetch = makeFetch([
      { match: (u) => u.includes("/token"), response: () => jsonResponse({ token: "tok" }) },
      { match: (u) => u.includes("/tags/list"), response: () => jsonResponse({ name: "tryweb/ai-engkit", tags: ["v1.0.0", "v1.0.1"] }) },
    ]);
    // token already handled elsewhere, but listAllTags only needs tags
    const tags = await listAllTags(fetch, "tok");
    expect(tags).toEqual(["v1.0.0", "v1.0.1"]);
  });

  test("paginated via Link header", async () => {
    let calls = 0;
    const fetch = makeFetch([
      {
        match: (u) => u.includes("/tags/list") && !u.includes("last="),
        response: () => {
          calls++;
          return jsonResponse({ name: "tryweb/ai-engkit", tags: ["v1.0.0"] }, { Link: '<https://ghcr.io/v2/tryweb/ai-engkit/tags/list?n=100&last=v1.0.0>; rel="next"' });
        },
      },
      {
        match: (u) => u.includes("last=v1.0.0"),
        response: () => {
          calls++;
          return jsonResponse({ name: "tryweb/ai-engkit", tags: ["v1.0.1"] });
        },
      },
    ]);
    const tags = await listAllTags(fetch, "tok");
    expect(tags).toEqual(["v1.0.0", "v1.0.1"]);
    expect(calls).toBe(2);
  });

  test("paginated via n/last fallback when full page", async () => {
    const fetch = makeFetch([
      {
        match: (u) => u.includes("/tags/list") && !u.includes("last="),
        response: () => {
          const tags = Array.from({ length: 100 }, (_, i) => `v1.0.${i}`);
          return jsonResponse({ name: "tryweb/ai-engkit", tags });
        },
      },
      {
        match: (u) => u.includes("last=v1.0.99"),
        response: () => jsonResponse({ name: "tryweb/ai-engkit", tags: ["v1.1.0"] }),
      },
    ]);
    const tags = await listAllTags(fetch, "tok");
    expect(tags.length).toBe(101);
    expect(tags[100]).toBe("v1.1.0");
  });

  test("registry failure throws GhcrError", async () => {
    const fetch = makeFetch([
      { match: () => true, response: () => new Response("oops", { status: 500 }) },
    ]);
    await expect(listAllTags(fetch, "tok")).rejects.toThrow();
  });
});

describe("getManifestDigest", () => {
  test("uses exact Accept header and reads Docker-Content-Digest", async () => {
    let gotAccept = "";
    const fetch = makeFetch([
      {
        match: (u) => u.includes("/manifests/latest"),
        response: (_u, init) => {
          gotAccept = (init?.headers as Record<string, string>)?.["Accept"] ?? (init?.headers as Headers)?.get?.("Accept") ?? "";
          // Also check via Headers object fallback: if headers is plain object, we already read it
          if (!gotAccept && init?.headers) {
            const h = init.headers as Record<string, string>;
            gotAccept = h["Accept"] || h["accept"] || "";
          }
          return new Response("", { status: 200, headers: { "Docker-Content-Digest": "sha256:abc" } });
        },
      },
    ]);
    const d = await getManifestDigest(fetch, "tok", "latest");
    expect(d).toBe("sha256:abc");
    expect(gotAccept).toBe(GHCR_MANIFEST_ACCEPT);
  });

  test("returns null on 404", async () => {
    const fetch = makeFetch([{ match: () => true, response: () => new Response("", { status: 404 }) }]);
    const d = await getManifestDigest(fetch, "tok", "v1.0.0");
    expect(d).toBeNull();
  });

  test("falls back to GET on 405", async () => {
    let methodSeen: string[] = [];
    const fetch = makeFetch([
      {
        match: () => true,
        response: (_u, init) => {
          const m = (init?.method as string) || "GET";
          methodSeen.push(m);
          if (m === "HEAD") return new Response("", { status: 405 });
          return new Response("", { status: 200, headers: { "Docker-Content-Digest": "sha256:xyz" } });
        },
      },
    ]);
    const d = await getManifestDigest(fetch, "tok", "v1.0.0");
    expect(d).toBe("sha256:xyz");
    expect(methodSeen).toEqual(["HEAD", "GET"]);
  });
});

describe("resolveOfficialVersion", () => {
  test("finds highest matching digest descending", async () => {
    const digests: Record<string, string> = {
      latest: "sha256:same",
      "v1.0.2": "sha256:same",
      "v1.0.1": "sha256:same",
      "v1.0.0": "sha256:other",
    };
    const fetch = makeFetch([
      {
        match: (u) => u.includes("/manifests/"),
        response: (u) => {
          const tag = decodeURIComponent(u.split("/manifests/")[1] ?? "");
          const d = digests[tag] ?? null;
          if (d === null) return new Response("", { status: 404 });
          return new Response("", { status: 200, headers: { "Docker-Content-Digest": d } });
        },
      },
    ]);
    const res = await resolveOfficialVersion(fetch, "tok", ["v1.0.2", "v1.0.1", "v1.0.0"]);
    expect(res.officialVersion).toBe("v1.0.2");
    expect(res.warning).toBeNull();
  });

  test("missing alias returns warning", async () => {
    const fetch = makeFetch([
      {
        match: (u) => u.includes("/manifests/latest"),
        response: () => new Response("", { status: 200, headers: { "Docker-Content-Digest": "sha256:latest-only" } }),
      },
      {
        match: (u) => u.includes("/manifests/v1."),
        response: () => new Response("", { status: 200, headers: { "Docker-Content-Digest": "sha256:other" } }),
      },
    ]);
    const res = await resolveOfficialVersion(fetch, "tok", ["v1.0.1", "v1.0.0"]);
    expect(res.officialVersion).toBeNull();
    expect(res.warning).not.toBeNull();
  });

  test("multiple alias picks highest", async () => {
    const digests: Record<string, string> = {
      latest: "sha256:same",
      "v1.1.0": "sha256:same",
      "v1.0.9": "sha256:same",
    };
    const fetch = makeFetch([
      {
        match: (u) => u.includes("/manifests/"),
        response: (u) => {
          const tag = decodeURIComponent(u.split("/manifests/")[1] ?? "");
          return new Response("", { status: 200, headers: { "Docker-Content-Digest": digests[tag] ?? "sha256:other" } });
        },
      },
    ]);
    const res = await resolveOfficialVersion(fetch, "tok", ["v1.1.0", "v1.0.9", "v1.0.0"]);
    expect(res.officialVersion).toBe("v1.1.0");
  });

  test("manifest error propagates", async () => {
    const fetch = makeFetch([
      { match: (u) => u.includes("/manifests/latest"), response: () => new Response("", { status: 500 }) },
    ]);
    await expect(resolveOfficialVersion(fetch, "tok", ["v1.0.0"])).rejects.toThrow();
  });

  test("uses identical Accept header for latest and candidates", async () => {
    const accepts: string[] = [];
    const fetch = makeFetch([
      {
        match: () => true,
        response: (_u, init) => {
          const h = init?.headers as Record<string, string>;
          const a = h?.["Accept"] ?? "";
          accepts.push(a);
          return new Response("", { status: 200, headers: { "Docker-Content-Digest": "sha256:abc" } });
        },
      },
    ]);
    await resolveOfficialVersion(fetch, "tok", ["v1.0.1", "v1.0.0"]);
    expect(accepts.length).toBeGreaterThanOrEqual(2);
    for (const a of accepts) expect(a).toBe(GHCR_MANIFEST_ACCEPT);
  });
});

describe("discoverGhcrVersions integration + cache", () => {
  function ghcrFetch(tags: string[], digests: Record<string, string>, onCall?: (url: string) => void): FetchImpl {
    return makeFetch(
      [
        {
          match: (u) => u.includes("/token"),
          response: () => jsonResponse({ token: "fake-token" }),
        },
        {
          match: (u) => u.includes("/tags/list"),
          response: (u) => {
            if (onCall) onCall(u);
            return jsonResponse({ name: "tryweb/ai-engkit", tags });
          },
        },
        {
          match: (u) => u.includes("/manifests/"),
          response: (u, init) => {
            if (onCall) onCall(u);
            // verify Accept header
            const h = init?.headers as Record<string, string>;
            const accept = h?.["Accept"];
            if (accept !== GHCR_MANIFEST_ACCEPT) {
              return new Response("bad accept", { status: 400 });
            }
            const tag = decodeURIComponent(u.split("/manifests/")[1] ?? "");
            const d = digests[tag];
            if (!d) return new Response("", { status: 404 });
            return new Response("", { status: 200, headers: { "Docker-Content-Digest": d } });
          },
        },
      ],
      onCall,
    );
  }

  test("successful discovery filters, sorts, resolves official", async () => {
    const tags = ["latest", "v1.0.1", "v1.0.10", "v1.0.2", "dev", "v1.0.0-rc1", "v1.1.0"];
    const digests = { latest: "sha256:same", "v1.1.0": "sha256:same", "v1.0.10": "sha256:other" };
    const result = await discoverGhcrVersions({ fetchImpl: ghcrFetch(tags, digests) });
    expect(result.versions).toEqual(["v1.1.0", "v1.0.10", "v1.0.2", "v1.0.1"]);
    expect(result.officialVersion).toBe("v1.1.0");
    expect(result.warning).toBeNull();
  });

  test("token failure throws", async () => {
    const fetch = makeFetch([{ match: (u) => u.includes("/token"), response: () => new Response("no", { status: 401 }) }]);
    await expect(discoverGhcrVersions({ fetchImpl: fetch })).rejects.toThrow();
  });

  test("tags failure throws", async () => {
    const fetch = makeFetch([
      { match: (u) => u.includes("/token"), response: () => jsonResponse({ token: "tok" }) },
      { match: (u) => u.includes("/tags/list"), response: () => new Response("err", { status: 500 }) },
    ]);
    await expect(discoverGhcrVersions({ fetchImpl: fetch })).rejects.toThrow();
  });

  test("cache reuse and expiry", async () => {
    let fetchCalls = 0;
    const tags = ["v1.0.0"];
    const digests = { latest: "sha256:a", "v1.0.0": "sha256:a" };
    const fetch = ghcrFetch(tags, digests, () => fetchCalls++);
    let now = 0;
    const nowFn = () => now;

    const r1 = await discoverGhcrVersions({ fetchImpl: fetch, now: nowFn });
    expect(r1.versions).toEqual(["v1.0.0"]);
    const callsAfterFirst = fetchCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // second call within TTL reuses cache - no extra fetches
    const r2 = await discoverGhcrVersions({ fetchImpl: fetch, now: nowFn });
    expect(r2).toEqual(r1);
    expect(fetchCalls).toBe(callsAfterFirst);

    // after expiry, refresh
    now = 600_000; // 10 min later, beyond 5 min TTL
    const r3 = await discoverGhcrVersions({ fetchImpl: fetch, now: nowFn });
    expect(r3).toEqual(r1);
    expect(fetchCalls).toBeGreaterThan(callsAfterFirst);
  });

  test("cache stores official warning", async () => {
    const tags = ["v1.0.0"];
    const digests = { latest: "sha256:latest-only", "v1.0.0": "sha256:other" };
    const result = await discoverGhcrVersions({ fetchImpl: ghcrFetch(tags, digests) });
    expect(result.officialVersion).toBeNull();
    expect(result.warning).not.toBeNull();
    const cached = getGhcrCache();
    expect(cached?.result.warning).toBe(result.warning);
  });

  test("v2 channel resolves official via v2 digest, not latest", async () => {
    const tags = ["latest", "v2", "v1.0.0", "v2.0.1", "v2.0.0", "v1.1.0"];
    const digestsLatest = { latest: "sha256:v1", v2: "sha256:v2", "v2.0.1": "sha256:v2", "v2.0.0": "sha256:other", "v1.1.0": "sha256:v1" };
    const rLatest = await discoverGhcrVersions({ fetchImpl: ghcrFetch(tags, digestsLatest), stableTag: "latest" });
    expect(rLatest.officialVersion).toBe("v1.1.0");
    clearGhcrCache();
    const rV2 = await discoverGhcrVersions({ fetchImpl: ghcrFetch(tags, digestsLatest), stableTag: "v2" });
    expect(rV2.officialVersion).toBe("v2.0.1");
  });

  test("cache is per-channel (no collision)", async () => {
    const tagsV1 = ["v1.0.0"];
    const digestsV1 = { latest: "sha256:a", "v1.0.0": "sha256:a" };
    const tagsV2 = ["v2.0.0"];
    const digestsV2 = { v2: "sha256:b", "v2.0.0": "sha256:b" };
    let now = 0;
    const nowFn = () => now;
    const r1 = await discoverGhcrVersions({ fetchImpl: ghcrFetch(tagsV1, digestsV1), now: nowFn, stableTag: "latest" });
    expect(r1.versions).toEqual(["v1.0.0"]);
    const r2 = await discoverGhcrVersions({ fetchImpl: ghcrFetch(tagsV2, digestsV2), now: nowFn, stableTag: "v2" });
    expect(r2.versions).toEqual(["v2.0.0"]);
    // second call for latest should hit cache, not refetch v2
    let fetchCalls = 0;
    const countingFetch = ghcrFetch(tagsV1, digestsV1, () => fetchCalls++);
    const r1Again = await discoverGhcrVersions({ fetchImpl: countingFetch, now: nowFn, stableTag: "latest" });
    expect(r1Again).toEqual(r1);
    expect(fetchCalls).toBe(0);
    expect(getGhcrCache("latest")?.result.versions).toEqual(["v1.0.0"]);
    expect(getGhcrCache("v2")?.result.versions).toEqual(["v2.0.0"]);
  });

  test("defaults to latest channel when no stableTag provided", async () => {
    const tags = ["v1.0.0", "v2.0.0"];
    const digests = { latest: "sha256:a", "v1.0.0": "sha256:a" };
    const result = await discoverGhcrVersions({ fetchImpl: ghcrFetch(tags, digests) });
    expect(result.officialVersion).toBe("v1.0.0");
    expect(result.versions).toEqual(["v2.0.0", "v1.0.0"]);
  });
});

describe("resolveOfficialVersion bounded concurrency (regression)", () => {
  /**
   * Helper: FetchImpl that tracks concurrent manifest calls without wall-clock assertions.
   * Each manifest tag can have a configurable delay and digest/failure.
   */
  function makeTrackedFetch(opts: {
    stableTag: string;
    stableDigest: string | null;
    digests: Record<string, string | null>;
    delaysMs?: Record<string, number>;
    failingTags?: Set<string>;
    defaultDelayMs?: number;
  }): { fetch: FetchImpl; getMaxActive: () => number; getCallOrder: () => string[] } {
    let active = 0;
    let maxActive = 0;
    const callOrder: string[] = [];
    const delaysMs = opts.delaysMs ?? {};
    const failingTags = opts.failingTags ?? new Set<string>();
    const defaultDelayMs = opts.defaultDelayMs ?? 12;

    const fetch: FetchImpl = async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const u = typeof url === "string" ? url : url.toString();
      // Only track manifest fetches (/manifests/)
      if (!u.includes("/manifests/")) {
        throw new Error(`unexpected non-manifest fetch: ${u}`);
      }
      const tag = decodeURIComponent(u.split("/manifests/")[1]?.split("?")[0] ?? "");
      callOrder.push(tag);
      active++;
      if (active > maxActive) maxActive = active;
      const delay = delaysMs[tag] ?? defaultDelayMs;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      active--;
      if (failingTags.has(tag)) {
        return new Response("", { status: 500 });
      }
      let digest: string | null;
      if (tag === opts.stableTag) {
        digest = opts.stableDigest;
      } else {
        digest = opts.digests[tag] ?? null;
      }
      if (digest === null) return new Response("", { status: 404 });
      return new Response("", { status: 200, headers: { "Docker-Content-Digest": digest } });
    };

    return { fetch, getMaxActive: () => maxActive, getCallOrder: () => [...callOrder] };
  }

  test("resolves with bounded concurrent fetches: overlap >1, capped <=10, highest priority wins", async () => {
    const stableTag = "latest";
    const stableDigest = "sha256:stable";
    // 12 formal tags descending: v2.0.11 highest, v2.0.0 lowest
    const formalSorted = Array.from({ length: 12 }, (_, i) => `v2.0.${11 - i}`);
    // Two matches: highest v2.0.11 and lower v2.0.3; should pick v2.0.11 even though lower resolves faster
    const digests: Record<string, string | null> = {};
    for (const t of formalSorted) digests[t] = "sha256:other";
    digests["v2.0.11"] = stableDigest;
    digests["v2.0.3"] = stableDigest;
    const delaysMs: Record<string, number> = {};
    delaysMs["v2.0.11"] = 28; // highest is slow
    delaysMs["v2.0.3"] = 4; // lower is fast
    // rest 12ms default ensures overlap

    const { fetch, getMaxActive } = makeTrackedFetch({
      stableTag,
      stableDigest,
      digests,
      delaysMs,
      defaultDelayMs: 14,
    });

    const res = await resolveOfficialVersion(fetch, "tok", formalSorted, stableTag);
    expect(res.officialVersion).toBe("v2.0.11");
    expect(res.warning).toBeNull();
    // proves concurrency: sequential would have maxActive === 1
    expect(getMaxActive()).toBeGreaterThan(1);
    expect(getMaxActive()).toBeLessThanOrEqual(10);
  });

  test("concurrency is capped at 10 when many tags need probing", async () => {
    const stableTag = "latest";
    const stableDigest = "sha256:stable";
    // 25 tags, none match until last (lowest priority) to force scanning all
    const formalSorted = Array.from({ length: 25 }, (_, i) => `v2.0.${24 - i}`);
    const digests: Record<string, string | null> = {};
    for (const t of formalSorted) digests[t] = "sha256:other";
    // No match at all -> will scan all batches
    const { fetch, getMaxActive } = makeTrackedFetch({
      stableTag,
      stableDigest,
      digests,
      defaultDelayMs: 10,
    });
    const res = await resolveOfficialVersion(fetch, "tok", formalSorted, stableTag);
    expect(res.officialVersion).toBeNull();
    expect(res.warning).not.toBeNull();
    expect(getMaxActive()).toBeGreaterThan(1);
    expect(getMaxActive()).toBeLessThanOrEqual(10);
  });

  test("highest matching tag preserved regardless of faster lower-priority resolution", async () => {
    const stableTag = "latest";
    const stableDigest = "sha256:match";
    const formalSorted = ["v2.0.5", "v2.0.4", "v2.0.3", "v2.0.2"];
    const digests: Record<string, string | null> = {
      "v2.0.5": stableDigest,
      "v2.0.4": "sha256:other",
      "v2.0.3": stableDigest, // lower also matches but should not be picked
      "v2.0.2": "sha256:other",
    };
    const delaysMs: Record<string, number> = {
      "v2.0.5": 24,
      "v2.0.4": 5,
      "v2.0.3": 5,
      "v2.0.2": 5,
    };
    const { fetch } = makeTrackedFetch({ stableTag, stableDigest, digests, delaysMs });
    const res = await resolveOfficialVersion(fetch, "tok", formalSorted, stableTag);
    expect(res.officialVersion).toBe("v2.0.5");
  });

  test("failure from lower-priority tag in same batch does not override higher-priority match", async () => {
    const stableTag = "latest";
    const stableDigest = "sha256:stable";
    // Batch of 3: v2.0.5 matches, v2.0.4 fails, v2.0.3 also would match but lower
    const formalSorted = ["v2.0.5", "v2.0.4", "v2.0.3"];
    const digests: Record<string, string | null> = {
      "v2.0.5": stableDigest,
      "v2.0.4": "sha256:other",
      "v2.0.3": stableDigest,
    };
    const failingTags = new Set<string>(["v2.0.4"]);
    const { fetch } = makeTrackedFetch({ stableTag, stableDigest, digests, failingTags, defaultDelayMs: 10 });
    const res = await resolveOfficialVersion(fetch, "tok", formalSorted, stableTag);
    expect(res.officialVersion).toBe("v2.0.5");
    expect(res.warning).toBeNull();
  });

  test("failure before first matching tag rejects (sequential semantics preserved)", async () => {
    const stableTag = "latest";
    const stableDigest = "sha256:stable";
    // v2.0.5 is 404 (null), v2.0.4 fails (500), v2.0.3 matches but failure is higher priority
    const formalSorted = ["v2.0.5", "v2.0.4", "v2.0.3"];
    const digests: Record<string, string | null> = {
      "v2.0.5": null,
      "v2.0.4": "sha256:other",
      "v2.0.3": stableDigest,
    };
    const failingTags = new Set<string>(["v2.0.4"]);
    const { fetch } = makeTrackedFetch({ stableTag, stableDigest, digests, failingTags, defaultDelayMs: 10 });
    await expect(resolveOfficialVersion(fetch, "tok", formalSorted, stableTag)).rejects.toThrow();
  });
});
