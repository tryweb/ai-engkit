import { describe, expect, test } from "bun:test";
import {
  fetchGoUsage,
  formatMonthlyLabel,
  formatResetsIn,
  monthlyTone,
  toUsageItemWindows,
} from "./opencode-go-usage";
import type { GoFetch } from "./opencode-go-usage";

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const usage = {
  usage: {
    rolling: { status: "ok", percent: 12, resetsAt: "2026-01-18T18:00:00.000Z" },
    weekly: { status: "ok", percent: 55, resetsAt: "2026-01-18T18:00:00.000Z" },
    monthly: { status: "ok", percent: 39, resetsAt: "2026-01-18T18:00:00.000Z" },
  },
};

describe("opencode-go usage", () => {
  test("formats reset windows and monthly labels", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(formatResetsIn("2026-01-18T17:00:00.000Z", now)).toBe("17d 17h");
    expect(formatResetsIn("2026-01-01T05:04:00.000Z", now)).toBe("5h 4m");
    expect(formatResetsIn("2026-01-01T00:42:00.000Z", now)).toBe("42m");
    expect(formatResetsIn("2026-01-01T00:00:30.000Z", now)).toBe("<1m");
    expect(formatResetsIn("not-a-date", now)).toBe("—");
    expect(formatMonthlyLabel(39, "ok", "17d 17h")).toBe("Monthly 39% · resets 17d 17h");
    expect(formatMonthlyLabel(undefined, "invalid_key")).toBe("invalid key");
    expect(formatMonthlyLabel(undefined, "no_subscription")).toBe("no subscription");
  });

  test("assigns monthly tones", () => {
    expect(monthlyTone(69, "ok")).toBe("ok");
    expect(monthlyTone(70, "ok")).toBe("warn");
    expect(monthlyTone(89, "ok")).toBe("warn");
    expect(monthlyTone(90, "ok")).toBe("bad");
    expect(monthlyTone(20, "exhausted")).toBe("bad");
    expect(monthlyTone(undefined, "ok")).toBe("muted");
  });

  test("caches a successful response for the second call", async () => {
    let calls = 0;
    const fetchFn: GoFetch = async () => {
      calls += 1;
      return response(200, usage);
    };
    const first = await fetchGoUsage("cache-test-key", fetchFn);
    const second = await fetchGoUsage("cache-test-key", fetchFn);
    expect("usage" in first && first.cached).toBe(false);
    expect("usage" in second && second.cached).toBe(true);
    expect(calls).toBe(1);
  });

  test("maps authentication and subscription failures", async () => {
    const invalid = await fetchGoUsage("invalid-test-key", async () => response(401, {}));
    const unsubscribed = await fetchGoUsage("unsubscribed-test-key", async () => response(403, {}));
    expect(invalid).toEqual({ ok: false, code: "invalid_key", cached: false });
    expect(unsubscribed).toEqual({ ok: false, code: "no_subscription", cached: false });
  });

  test("marks a non-ok usage status as bad", () => {
    const item = toUsageItemWindows("key-1", "sk-t…-test", {
      usage: { ...usage, usage: { ...usage.usage, monthly: { ...usage.usage.monthly, status: "exhausted" } } },
      cached: false,
    });
    expect(item.monthly.tone).toBe("bad");
  });
});
