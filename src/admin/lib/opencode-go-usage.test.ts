import { describe, expect, test } from "bun:test";
import {
  __clearGoUsageCacheForTest,
  fetchGoUsage,
  formatMonthlyLabel,
  formatResetsIn,
  monthlyTone,
  parseGoUsagePayload,
} from "./opencode-go-usage";

describe("opencode-go-usage", () => {
  test("parses official usage payload", () => {
    const usage = parseGoUsagePayload({
      usage: {
        rolling: { status: "ok", percent: 8, resetsAt: "2026-08-17T17:10:09.580Z" },
        weekly: { status: "ok", percent: 4, resetsAt: "2026-08-24T00:00:00.580Z" },
        monthly: { status: "ok", percent: 39, resetsAt: "2026-09-13T04:26:00.580Z" },
      },
    });
    expect(usage?.monthly?.percent).toBe(39);
    expect(usage?.rolling?.percent).toBe(8);
  });

  test("rejects payload without windows", () => {
    expect(parseGoUsagePayload({ usage: {} })).toBeNull();
    expect(parseGoUsagePayload({})).toBeNull();
  });

  test("formats resets countdown concisely", () => {
    const now = Date.parse("2026-08-27T00:00:00.000Z");
    expect(formatResetsIn("2026-09-13T18:00:00.000Z", now)).toBe("17d 18h");
    expect(formatResetsIn("2026-08-27T05:04:00.000Z", now)).toBe("5h 4m");
    expect(formatResetsIn("2026-08-27T00:42:00.000Z", now)).toBe("42m");
    expect(formatResetsIn("not-a-date", now)).toBe("—");
  });

  test("formats monthly label like Monthly 39% resets 17d 18h", () => {
    const now = Date.parse("2026-08-27T00:00:00.000Z");
    const label = formatMonthlyLabel(
      { status: "ok", percent: 39, resetsAt: "2026-09-13T18:00:00.000Z" },
      now,
    );
    expect(label).toBe("Monthly 39% · resets 17d 18h");
  });

  test("monthly tone bands", () => {
    expect(monthlyTone({ status: "ok", percent: 39, resetsAt: "x" })).toBe("ok");
    expect(monthlyTone({ status: "ok", percent: 75, resetsAt: "x" })).toBe("warn");
    expect(monthlyTone({ status: "ok", percent: 95, resetsAt: "x" })).toBe("exhausted");
    expect(monthlyTone({ status: "rate-limited", percent: 10, resetsAt: "x" })).toBe("exhausted");
    expect(monthlyTone(null)).toBe("muted");
  });

  test("fetch maps 401/403 and caches success for 60s", async () => {
    __clearGoUsageCacheForTest();
    let calls = 0;
    const okImpl = async () =>
      new Response(
        JSON.stringify({
          usage: { monthly: { status: "ok", percent: 39, resetsAt: "2026-09-13T04:26:00.580Z" } },
        }),
        { status: 200 },
      );
    const first = await fetchGoUsage("sk-test", { fetchImpl: okImpl as never, now: () => 1000 });
    if ("usage" in first) calls += 1;
    expect(first.ok).toBe(true);
    const second = await fetchGoUsage("sk-test", {
      fetchImpl: (async () => {
        throw new Error("should use cache");
      }) as never,
      now: () => 2000,
    });
    expect(second.ok).toBe(true);
    expect(calls).toBe(1);

    const denied = await fetchGoUsage("sk-bad", {
      fetchImpl: (async () => new Response("no", { status: 401 })) as never,
      noCache: true,
    });
    expect(denied.ok).toBe(false);
    if ("code" in denied) expect(denied.code).toBe("invalid_key");

    const nosub = await fetchGoUsage("sk-free", {
      fetchImpl: (async () => new Response("no", { status: 403 })) as never,
      noCache: true,
    });
    expect(nosub.ok).toBe(false);
    if ("code" in nosub) expect(nosub.code).toBe("no_subscription");
    __clearGoUsageCacheForTest();
  });
});
