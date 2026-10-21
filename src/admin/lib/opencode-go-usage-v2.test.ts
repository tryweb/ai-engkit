import { describe, expect, test } from "bun:test";
import {
  __clearGoUsageV2CacheForTest,
  buildGoUsageV2Script,
  fetchGoUsageV2,
  isValidV2CredentialId,
} from "./opencode-go-usage-v2";

function okExec(stdout: string) {
  return async () => ({ stdout, stderr: "", exitCode: 0 });
}

const USAGE_STDOUT = JSON.stringify({
  ok: true,
  http: 200,
  usage: {
    rolling: { status: "ok", percent: 8, resetsAt: "2026-08-17T17:10:09.580Z" },
    weekly: { status: "ok", percent: 4, resetsAt: "2026-08-24T00:00:00.580Z" },
    monthly: { status: "ok", percent: 39, resetsAt: "2026-09-13T04:26:00.580Z" },
  },
});

describe("opencode-go-usage-v2", () => {
  test("validates credential ids before shell use", () => {
    expect(isValidV2CredentialId("cred_abc123")).toBe(true);
    expect(isValidV2CredentialId("cred_a.b-c_d")).toBe(true);
    expect(isValidV2CredentialId("cred_x'; rm -rf /; echo '")).toBe(false);
    expect(isValidV2CredentialId("k-123")).toBe(false);
    expect(isValidV2CredentialId("")).toBe(false);
  });

  test("remote script never embeds a key and pins integration + url", () => {
    const script = buildGoUsageV2Script("cred_abc123");
    expect(script).toContain("integration_id='opencode-go'");
    expect(script).toContain("https://opencode.ai/zen/go/v1/usage");
    expect(script).toContain("cred_abc123");
    expect(script).toContain(".key");
    expect(script).not.toMatch(/oc_sk_|sk-[A-Za-z0-9]{8,}/);
  });

  test("rejects invalid credential id without exec", async () => {
    __clearGoUsageV2CacheForTest();
    let called = 0;
    const r = await fetchGoUsageV2("k-123", {
      execInAiDev: async () => {
        called += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(called).toBe(0);
    if ("code" in r) expect(r.code).toBe("nocred");
    else throw new Error("expected failure");
  });

  test("parses remote usage and caches per credential", async () => {
    __clearGoUsageV2CacheForTest();
    let calls = 0;
    const deps = {
      execInAiDev: async (command: string) => {
        calls += 1;
        expect(command).toContain("cred_cache1");
        expect(command).not.toMatch(/oc_sk_/);
        return { stdout: USAGE_STDOUT, stderr: "", exitCode: 0 };
      },
    };
    const first = await fetchGoUsageV2("cred_cache1", deps, 1000);
    expect(first.ok).toBe(true);
    if ("usage" in first) expect(first.usage.monthly?.percent).toBe(39);
    const second = await fetchGoUsageV2(
      "cred_cache1",
      {
        execInAiDev: async () => {
          throw new Error("must use cache");
        },
      },
      2000,
    );
    expect(second.ok).toBe(true);
    expect(calls).toBe(1);
    __clearGoUsageV2CacheForTest();
  });

  test("maps remote http codes", async () => {
    __clearGoUsageV2CacheForTest();
    const at = async (http: number, usage: unknown = null) =>
      fetchGoUsageV2(
        `cred_map${http}`,
        { execInAiDev: okExec(JSON.stringify({ ok: true, http, usage })) },
        Date.now(),
      );
    const denied = await at(401);
    if ("code" in denied) expect(denied.code).toBe("invalid_key");
    else throw new Error("expected failure");
    const nosub = await at(403);
    if ("code" in nosub) expect(nosub.code).toBe("no_subscription");
    else throw new Error("expected failure");
    const bad = await at(200, { nope: 1 });
    if ("code" in bad) expect(bad.code).toBe("upstream");
    else throw new Error("expected failure");
    const badcred = await fetchGoUsageV2(
      "cred_badcred",
      { execInAiDev: okExec(JSON.stringify({ ok: false, code: "badcred" })) },
      Date.now(),
    );
    if ("code" in badcred) expect(badcred.code).toBe("upstream");
    else throw new Error("expected failure");
    __clearGoUsageV2CacheForTest();
  });
});
