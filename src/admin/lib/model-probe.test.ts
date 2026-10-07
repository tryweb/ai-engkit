import { unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { AgentModelsDeps } from "./agent-model-types";
import {
  classifyProbeResponse,
  computeProviderCredentialFingerprint,
  buildProbeScript,
  invalidateProbeCacheForProvider,
  pruneStaleProbeCacheForProvider,
  probeModel,
  sanitizeProbeReason,
} from "./model-probe";

type AuthStore = Record<string, unknown>;

function stubDeps(auth: AuthStore, initialCache: Record<string, unknown> = {}) {
  let cache = JSON.stringify(initialCache);
  let probeCount = 0;
  let probeExitCode = 0;
  let probeFailureOutput = "probe failed";
  const calls: string[] = [];
  const deps: Pick<AgentModelsDeps, "exec" | "readEnv"> = {
    exec: async (command: string) => {
      calls.push(command);
      if (command.includes("auth.json")) {
        const encoded = command.match(/printf '%s' '([^']+)' \| base64 -d/)?.[1] ?? "";
        const providerID = Buffer.from(encoded, "base64").toString("utf8");
        const entry = auth[providerID];
        return { stdout: entry === undefined ? "" : JSON.stringify(entry), stderr: "", exitCode: 0 };
      }
      if (command.includes("agent-model-health.json.tmp")) {
        const encoded = command.match(/printf '%s' '([^']+)'/i)?.[1] ?? "";
        cache = Buffer.from(encoded, "base64").toString("utf8");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("agent-model-health.json")) {
        return { stdout: cache, stderr: "", exitCode: 0 };
      }
      probeCount += 1;
      if (probeExitCode !== 0) return { stdout: "", stderr: probeFailureOutput, exitCode: probeExitCode };
      return {
        stdout: JSON.stringify({ info: { role: "assistant", modelID: "model", providerID: "provider" } }),
        stderr: "",
        exitCode: 0,
      };
    },
    readEnv: () => ({ OPENCODE_SERVER_PASSWORD: "testpass" }),
  };
  return {
    deps,
    auth,
    calls,
    get probeCount() { return probeCount; },
    readCache: (): Record<string, { retryAfter: number; observedAt: string; status: string; reason?: string }> => JSON.parse(cache),
    setProbeFailure: (output = "probe failed") => { probeExitCode = 1; probeFailureOutput = output; },
  };
}

const credential = { type: "oauth", access: "access-a", refresh: "refresh-a", expires: 123, accountId: "account-a" };

const observedNvidia410Payload = [{
  info: {
    role: "assistant",
    modelID: "deepseek-ai/deepseek-v4-flash",
    providerID: "nvidia",
    error: {
      name: "APIError",
      data: {
        message: 'Gone: {"status":410,"detail":"The model has reached its end of life and is no longer available."}',
        statusCode: 410,
        responseBody: '{"status":410,"detail":"The model has reached its end of life and is no longer available."}',
      },
    },
  },
  parts: [],
}];

test("generated jq filter matches the observed NVIDIA 410 payload", async () => {
  const script = buildProbeScript("encoded-auth", "nvidia", "deepseek-ai/deepseek-v4-flash");
  const filterLine = script.split("\n").find((line) => line.includes("test("));
  const filter = filterLine?.match(/jq -e '([^']+)'/)?.[1];
  expect(filter).toBeDefined();
  const path = `/tmp/model-probe-${crypto.randomUUID()}.json`;
  await Bun.write(path, JSON.stringify(observedNvidia410Payload));
  try {
    const result = Bun.spawnSync(["jq", "-e", filter ?? "", path], { stdout: "pipe", stderr: "pipe" });
    expect({ exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }).toEqual({ exitCode: 0, stderr: "" });
  } finally {
    await unlink(path);
  }
});

test("classifies the observed NVIDIA 410 payload as retired", () => {
  const result = classifyProbeResponse(JSON.stringify(observedNvidia410Payload), "nvidia", "deepseek-ai/deepseek-v4-flash");
  expect(result.status).toBe("retired");
  expect(result.reason).toContain("410");
});


test("classifies NVIDIA Function not found for account as wrong endpoint", () => {
  const payload = JSON.stringify([{
    info: {
      role: "assistant",
      error: {
        data: {
          message: "Function 123e4567-e89b-12d3-a456-426614174000: Not found for account test-account",
          statusCode: 404,
        },
      },
    },
  }]);

  expect(classifyProbeResponse(payload, "nvidia", "google/gemma-3-12b-it")).toEqual({
    status: "wrong_endpoint",
    reason: expect.stringContaining("Not found for account"),
  });
});

test("classifies plaintext endpoint 404 as wrong endpoint", () => {
  expect(classifyProbeResponse("404 page not found", "nvidia", "google/google-paligemma")).toEqual({
    status: "wrong_endpoint",
    reason: "404 page not found",
  });
});

test("classifies JSON endpoint 404 as wrong endpoint", () => {
  expect(classifyProbeResponse(JSON.stringify({ info: { role: "assistant", error: "404 page not found" } }), "nvidia", "meta/esmfold").status).toBe("wrong_endpoint");
});

test("classifies tool unsupported responses as unavailable", () => {
  expect(classifyProbeResponse("tool use is not supported for this model", "openrouter", "model").status).toBe("unavailable");
  expect(classifyProbeResponse(JSON.stringify({ info: { role: "assistant", error: "Function calling is not supported" } }), "openrouter", "model").status).toBe("unavailable");
});

test("classifies non-JSON NVIDIA 410 responses as retired", () => {
  expect(classifyProbeResponse("Gone: 410 — the model has reached its end of life", "nvidia", "model").status).toBe("retired");
});

test("preserves the credential label while redacting its value", () => {
  expect(sanitizeProbeReason("api_key=secret-value")).toBe("api_key=[redacted]");
});
describe("provider credential scoped model probe cache", () => {
  test("same fingerprint and model reuses the cached result", async () => {
    const fixture = stubDeps({ provider: credential });

    const first = await probeModel(fixture.deps, "provider", "model");
    const second = await probeModel(fixture.deps, "provider", "model");

    expect(first).toEqual({ status: "healthy" });
    expect(second.status).toBe(first.status);
    expect(fixture.probeCount).toBe(1);
  });

  test("changed credentials cause a cache miss and re-probe", async () => {
    const fixture = stubDeps({ provider: credential });
    await probeModel(fixture.deps, "provider", "model");
    fixture.auth.provider = { ...credential, access: "access-b" };
    await probeModel(fixture.deps, "provider", "model");
    expect(fixture.probeCount).toBe(2);
  });

  test("stale credential fingerprint entries are pruned on re-probe", async () => {
    const fixture = stubDeps({ provider: credential });
    await probeModel(fixture.deps, "provider", "model");
    fixture.auth.provider = { ...credential, access: "access-b" };
    await probeModel(fixture.deps, "provider", "model");
    const keys = Object.keys(fixture.readCache());
    expect(keys).toHaveLength(1);
    expect(keys[0]).toStartWith("provider|");
    expect(keys[0]).toContain("|provider/model");
  });

  test("stale credential entries are pruned when the replacement probe is unreachable", async () => {
    const fixture = stubDeps({ provider: credential });
    await probeModel(fixture.deps, "provider", "model");
    fixture.auth.provider = { ...credential, access: "access-b" };
    fixture.setProbeFailure();

    const result = await probeModel(fixture.deps, "provider", "model");

    expect(result.status).toBe("unreachable");
    expect(Object.keys(fixture.readCache())).toHaveLength(0);
  });

  test("provider A credential changes do not invalidate provider B", async () => {
    const fixture = stubDeps({ providerA: credential, providerB: credential });

    await probeModel(fixture.deps, "providerB", "model");
    await probeModel(fixture.deps, "providerA", "model");
    fixture.auth.providerA = { ...credential, access: "access-a2" };
    await probeModel(fixture.deps, "providerB", "model");
    expect(fixture.probeCount).toBe(2);
  });

  test("legacy bare-model keys are misses", async () => {
    const fixture = stubDeps({ provider: credential }, { "provider/model": { status: "healthy", reason: "", retryAfter: 9_999_999_999 } });

    await probeModel(fixture.deps, "provider", "model");

    expect(fixture.probeCount).toBe(1);
  });

  test("invalidating a provider removes only that provider entries", async () => {
    const fixture = stubDeps({ "opencode-go": credential, openai: credential });
    await probeModel(fixture.deps, "opencode-go", "model");
    await probeModel(fixture.deps, "openai", "model");
    await invalidateProbeCacheForProvider(fixture.deps, "opencode-go");
    const after = fixture.readCache();

    expect(Object.keys(after)).toHaveLength(1);
    expect(Object.keys(after)[0]).toStartWith("openai|");
  });

  test("provider cache rotation prunes stale entries even without a model probe", async () => {
    const fixture = stubDeps({ provider: credential, other: credential });
    await probeModel(fixture.deps, "provider", "model");
    await probeModel(fixture.deps, "other", "model");
    fixture.auth.provider = { ...credential, access: "access-b" };

    await pruneStaleProbeCacheForProvider(fixture.deps, "provider");

    const keys = Object.keys(fixture.readCache());
    expect(keys).toHaveLength(1);
    expect(keys[0]).toStartWith("other|");
  });

  test("fingerprints and credentials are not exposed in probe results", async () => {
    const fixture = stubDeps({ provider: credential });
    const fingerprint = await computeProviderCredentialFingerprint(fixture.deps, "provider");
    const result = await probeModel(fixture.deps, "provider", "model");

    expect(fingerprint).toBe(createHash("sha256").update(JSON.stringify({ access: "access-a", accountId: "account-a", expires: 123, refresh: "refresh-a", type: "oauth" })).digest("hex"));
    expect(JSON.stringify(result)).not.toContain(fingerprint);
    expect(JSON.stringify(result)).not.toContain("access-a");
  });

  test("provider IDs are passed to jq without shell interpolation", async () => {
    const providerID = "nvidia'\"; echo pwned; #";
    const fixture = stubDeps({ [providerID]: credential });

    const fingerprint = await computeProviderCredentialFingerprint(fixture.deps, providerID);

    expect(fingerprint).toBe(createHash("sha256").update(JSON.stringify({ access: "access-a", accountId: "account-a", expires: 123, refresh: "refresh-a", type: "oauth" })).digest("hex"));
    expect(fixture.calls[0]).not.toContain(providerID);
    expect(fixture.calls[0]).toContain("--arg provider");
  });

  test("quota markers are classified as quota_exceeded in JSON and text", async () => {
    const markers = [
      "FreeUsageLimitError",
      "free usage exceeded",
      "insufficient_quota",
      "credit_balance_exhausted",
      "credit exhausted",
      "spend_limit_exceeded",
      "quota_exceeded",
      "Key limit exceeded (total limit)",
    ];
    for (const marker of markers) {
      const json = JSON.stringify({ info: { role: "assistant", error: marker } });
      expect(classifyProbeResponse(json, "model").status).toBe("quota_exceeded");
      expect(classifyProbeResponse(marker, "model").status).toBe("quota_exceeded");
      expect(classifyProbeResponse(JSON.stringify({ info: { role: "assistant", error: { message: marker, code: 429 } } }), "model").status).toBe("quota_exceeded");
    }
  });

  test("session status free-tier retry records are terminal quota failures", () => {
    const status = JSON.stringify({ session: { type: "retry", message: "Free usage exceeded, subscribe to Go" } });
    const keyedStatus = JSON.stringify({ session_123: { type: "retry", message: "Free usage exceeded, subscribe to Go" } });

    expect(classifyProbeResponse(status, "provider", "model").status).toBe("quota_exceeded");
    expect(classifyProbeResponse(keyedStatus, "provider", "model").status).toBe("quota_exceeded");
  });

  test("rate-limit responses are terminal and preserve their reason", async () => {
    let callCount = 0;
    const fixture = stubDeps({ provider: credential });
    const originalExec = fixture.deps.exec;
    const replacementExec: AgentModelsDeps["exec"] = async (command) => {
      if (command.includes("agent-model-health.json")) return originalExec(command);
      if (command.includes("auth.json")) return originalExec(command);
      callCount += 1;
      if (callCount === 1) {
        return { stdout: JSON.stringify({ info: { role: "assistant", error: "429 rate limited, Retry-After: 2" } }), stderr: "", exitCode: 0 };
      }
      return { stdout: JSON.stringify({ info: { role: "assistant", modelID: "model", providerID: "provider" } }), stderr: "", exitCode: 0 };
    };
    Object.defineProperty(fixture.deps, "exec", { value: replacementExec });
    const result = await probeModel(fixture.deps, "provider", "model");
    expect(result.status).toBe("quota_exceeded");
    expect(result.reason).toContain("rate limited");
    expect(callCount).toBe(1);
  });

  test("preserves a rate-limit reason from a non-JSON probe response", () => {
    const result = classifyProbeResponse("429 Rate limit exceeded; Retry-After: 60", "provider", "model");

    expect(result.status).toBe("quota_exceeded");
    expect(result.reason).toContain("Rate limit exceeded");
  });

  test("preserves and classifies curl timeout diagnostics", async () => {
    const fixture = stubDeps({ provider: credential });
    const originalExec = fixture.deps.exec;
    const replacementExec: AgentModelsDeps["exec"] = async (command) => {
      if (command.includes("agent-model-health.json") || command.includes("auth.json")) return originalExec(command);
      return { stdout: "", stderr: "curl: (28) Operation timed out after 90000 milliseconds", exitCode: 28 };
    };
    Object.defineProperty(fixture.deps, "exec", { value: replacementExec });

    const result = await probeModel(fixture.deps, "provider", "model");

    expect(result.status).toBe("timeout");
    expect(result.reason).toContain("Operation timed out");
  });

  test("redacts credentials while preserving a useful failure reason", () => {
    const result = classifyProbeResponse("Rate limit exceeded; Authorization: Basic c2Vuc2l0aXZl; sk-secret-token-value", "provider", "model");

    expect(result.reason).toContain("Rate limit exceeded");
    expect(result.reason).not.toContain("c2Vuc2l0aXZl");
    expect(result.reason).not.toContain("sk-secret-token-value");
  });

  test("probe script preserves session and message diagnostics", () => {
    const script = buildProbeScript("encoded-auth", "provider", "model");

    expect(script).toContain("CREATE=");
    expect(script).toContain("prompt_async");
    expect(script).not.toContain("POST \"$BASE/session/$SID/message\"");
    expect(script).toContain("$BASE/session/$SID/message");
    expect(script).toContain("$BASE/session/status");
    expect(script).toContain("sleep 0.5");
    expect(script).toContain("seq 1 120");
    expect(script).toContain("-X DELETE \"$BASE/session/$SID\"");
    expect(script).toContain("2>&1 || true");
    expect(script).toContain("LAST_ERROR");
    expect(script).toContain("AUTH_B64=");
    expect(script).not.toContain('AUTH="Basic encoded-auth"');
    expect(script).toContain('test("\\\\S")');
    expect(script.indexOf("$BASE/session/status")).toBeLessThan(script.indexOf("$BASE/session/$SID/message"));
    expect(script).toContain(".info.role? == \"assistant\"");
    expect(script).toContain("to_entries");
    expect(script).toContain("busy");
    expect(script).toContain(".parts[]?.text?");
  });

  test("probe script does not embed raw auth or model identifiers", () => {
    const auth = "secret'\"; echo pwned; #";
    const providerID = "nvidia'\"; echo pwned; #";
    const modelID = "model'\"; echo pwned; #";
    const script = buildProbeScript(auth, providerID, modelID);

    expect(script).not.toContain(auth);
    expect(script).not.toContain(providerID);
    expect(script).not.toContain(modelID);
    expect(script).toContain("AUTH_B64=");
  });

  test("timeout diagnostics survive reload through the probe cache", async () => {
    const fixture = stubDeps({ provider: credential });
    fixture.setProbeFailure("curl: (28) Operation timed out after 90000 milliseconds");

    const result = await probeModel(fixture.deps, "provider", "model");
    const cached = fixture.readCache();
    const record = cached[Object.keys(cached)[0] ?? ""];

    expect(result).toEqual({ status: "timeout", reason: "curl: (28) Operation timed out after 90000 milliseconds" });
    expect(record?.status).toBe("timeout");
    expect(record?.reason).toContain("Operation timed out");
  });

  test("non-healthy cache entries without reasons are re-probed", async () => {
    const fingerprint = createHash("sha256").update(JSON.stringify({ access: "access-a", accountId: "account-a", expires: 123, refresh: "refresh-a", type: "oauth" })).digest("hex");
    const fixture = stubDeps({ provider: credential }, {
      [`provider|${fingerprint}|provider/model`]: {
        providerID: "provider",
        fingerprint,
        status: "timeout",
        reason: "",
        observedAt: new Date().toISOString(),
        retryAfter: Math.floor(Date.now() / 1000) + 300,
      },
    });

    const result = await probeModel(fixture.deps, "provider", "model");

    expect(result.status).toBe("healthy");
    expect(fixture.probeCount).toBe(1);
  });

  test("unknown error remains retryable", async () => {
    expect(classifyProbeResponse(JSON.stringify({ info: { role: "assistant", error: "some unknown failure" } }), "model").status).toBe("retryable");
    expect(classifyProbeResponse("not json at all", "model").status).toBe("retryable");
  });

  test("quota result is cached for 900s and suppresses second probe", async () => {
    const fixture = stubDeps({ provider: credential });
    const quotaResponse = JSON.stringify({ info: { role: "assistant", error: "insufficient_quota" } });
    let probeCalls = 0;
    const originalExec = fixture.deps.exec;
    const replacementExec: AgentModelsDeps["exec"] = async (command) => {
      if (command.includes("agent-model-health.json")) return originalExec(command);
      if (command.includes("auth.json")) return originalExec(command);
      probeCalls += 1;
      return { stdout: quotaResponse, stderr: "", exitCode: 0 };
    };
    Object.defineProperty(fixture.deps, "exec", { value: replacementExec });
    const first = await probeModel(fixture.deps, "provider", "model");
    expect(first.status).toBe("quota_exceeded");
    const cache = fixture.readCache();
    const key = Object.keys(cache)[0] ?? "";
    const record = cache[key];
    if (!record) throw new Error("missing cache record");
    const ttl = record.retryAfter - Math.floor(new Date(record.observedAt).getTime() / 1000);
    expect(ttl).toBe(900);
    probeCalls = 0;
    const second = await probeModel(fixture.deps, "provider", "model");
    expect(second.status).toBe("quota_exceeded");
    expect(probeCalls).toBe(0);
  });
});

describe("listUnhealthyModels", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const past = Math.floor(Date.now() / 1000) - 3600;
  function cacheDeps(cache: Record<string, unknown>) {
    const deps: Pick<AgentModelsDeps, "exec"> = {
      exec: async () => ({ stdout: JSON.stringify(cache), stderr: "", exitCode: 0 }),
    };
    return deps;
  }
  function record(status: string, retryAfter: number, reason = "probe failed") {
    return { providerID: "p", fingerprint: "f", status, reason, observedAt: new Date().toISOString(), retryAfter };
  }

  test("lists only unexpired terminal failures with model refs", async () => {
    const { listUnhealthyModels } = await import("./model-probe");
    const deps = cacheDeps({
      "p|f|p/dead-model": record("retired", future),
      "p|f|p/gone-model": record("unavailable", future),
      "p|f|p/wrong-model": record("mismatch", future),
      "p|f|p/bad-endpoint": record("wrong_endpoint", future),
      "p|f|p/stale-model": record("retired", past),
      "p|f|p/quota-model": record("quota_exceeded", future),
      "p|f|p/ok-model": record("healthy", future),
      "p|f|p/retry-model": record("retryable", future),
      "not-a-key": record("retired", future),
    });
    const result = await listUnhealthyModels(deps);
    const models = result.map((r) => r.model).sort();
    expect(models).toEqual(["p/bad-endpoint", "p/dead-model", "p/gone-model", "p/wrong-model"]);
    expect(result.find((r) => r.model === "p/dead-model")?.status).toBe("retired");
  });

  test("returns empty list when cache is missing or malformed", async () => {
    const { listUnhealthyModels } = await import("./model-probe");
    expect(await listUnhealthyModels({ exec: async () => ({ stdout: "", stderr: "", exitCode: 1 }) })).toEqual([]);
    expect(await listUnhealthyModels({ exec: async () => ({ stdout: "not json", stderr: "", exitCode: 0 }) })).toEqual([]);
  });
});
