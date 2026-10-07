import {
  buildJqWriteCommand,
  buildRoutingWriteCommand,
  displayNameToKey,
  parseAgentModelsConfig,
  parseRoutingConfig,
  validateAgentChain,
  validateFallbackModels,
} from "./agent-model-config";
import { createAgentModelLiveClient } from "./agent-model-live";
import {
  CONFIGURABLE_NATIVE_AGENTS,
  NATIVE12_AGENTS,
  OMO_CONFIG,
  OPENCODE_JSON,
  ROUTING_CONFIG,
  VARIANTS,
  type AgentModelConfig,
  type AgentModelChange,
  type AgentModelEntry,
  type AgentModelsDeps,
  type ApplyResult,
  type ChainEntry,
  type FallbackModelEntry,
  type ResolvedModel,
  type RoutingConfig,
  type VerificationMode,
} from "./agent-model-types";
import { execInAiDev } from "./docker";
import { readEnvFile } from "./env";
import { restartManagedOpenCode } from "./restart-ai-dev";
import { parseModelReference, probeModel } from "./model-probe";
import { readPinnedAgents } from "./agent-model-pinned";

function isV2(): boolean {
  return process.env.OMO_ENABLED === "0";
}

export {
  buildJqWriteCommand,
  buildRoutingWriteCommand,
  CONFIGURABLE_NATIVE_AGENTS,
  NATIVE12_AGENTS,
  displayNameToKey,
  OMO_CONFIG,
  OPENCODE_JSON,
  ROUTING_CONFIG,
  parseRoutingConfig,
  validateAgentChain,
  validateFallbackModels,
  VARIANTS,
};
export type {
  AgentModelConfig,
  AgentModelChange,
  AgentModelEntry,
  AgentModelsDeps,
  ApplyResult,
  FallbackModelEntry,
  ResolvedModel,
} from "./agent-model-types";

export const REAL_DEPS: AgentModelsDeps = {
  exec: execInAiDev,
  restart: restartManagedOpenCode,
  readEnv: readEnvFile,
};

export function createAgentModelsLib(deps: AgentModelsDeps = REAL_DEPS) {
  const live = createAgentModelLiveClient(deps);

  async function readAgentModelsConfig(): Promise<Record<string, AgentModelConfig>> {
    const result = await deps.exec(`jq -c '.agents // {}' ${OMO_CONFIG} 2>/dev/null || echo '{}'`, 10_000);
    return result.exitCode === 0 ? parseAgentModelsConfig(result.stdout) : {};
  }

  async function readRoutingConfig(): Promise<RoutingConfig> {
    const result = await deps.exec(`jq -c '.' ${ROUTING_CONFIG} 2>/dev/null || echo '{"version":1,"chains":{}}'`, 10_000);
    return result.exitCode === 0 ? parseRoutingConfig(result.stdout) : { version: 1, chains: {} };
  }

  async function writeAgentFallbackModels(
    agent: string,
    entries: readonly FallbackModelEntry[],
  ): Promise<{ readonly ok: boolean; readonly error?: string }> {
    if (isV2()) {
      const chain: readonly ChainEntry[] = entries as readonly ChainEntry[];
      const perAgentErr = validateAgentChain(chain as unknown);
      if (chain.length > 0 && perAgentErr !== null) return { ok: false, error: perAgentErr };
      const result = await deps.exec(buildRoutingWriteCommand(agent, chain), 30_000);
      if (result.exitCode !== 0) return { ok: false, error: result.stderr || result.stdout || "jq routing write failed" };
      return { ok: true };
    }
    const result = await deps.exec(buildJqWriteCommand(agent, entries), 30_000);
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr || result.stdout || "jq write failed" };
    }
    return { ok: true };
  }

  async function writeAgentChain(agent: string, chain: readonly ChainEntry[]): Promise<{ readonly ok: boolean; readonly error?: string }> {
    return writeAgentFallbackModels(agent, chain as unknown as readonly FallbackModelEntry[]);
  }

  async function snapshotAgentModelsConfig(): Promise<string | null> {
    const result = await deps.exec(
      `snapshot=$(mktemp /tmp/omo.jsonc.snapshot.XXXXXX) && cat ${OMO_CONFIG} > "$snapshot" 2>/dev/null && printf '%s' "$snapshot"`,
      10_000,
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;
    return result.stdout.trim();
  }

  async function snapshotRoutingConfig(): Promise<string | null> {
    const result = await deps.exec(
      `snap_r=$(mktemp /tmp/routing.json.snapshot.XXXXXX) && snap_o=$(mktemp /tmp/opencode.json.snapshot.XXXXXX) && cat ${ROUTING_CONFIG} > "$snap_r" 2>/dev/null; cat ${OPENCODE_JSON} > "$snap_o" 2>/dev/null; printf '%s:%s' "$snap_r" "$snap_o"`,
      10_000,
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;
    return result.stdout.trim();
  }

  async function restoreAgentModelsConfig(snapshotFile: string): Promise<{ readonly ok: boolean; readonly error?: string }> {
    const result = await deps.exec(
      `cat '${snapshotFile}' > ${OMO_CONFIG}.tmp && mv ${OMO_CONFIG}.tmp ${OMO_CONFIG} && rm -f '${snapshotFile}'`,
      15_000,
    );
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr || result.stdout || "restore failed" };
    }
    return { ok: true };
  }

  async function restoreRoutingConfig(snapshotFile: string): Promise<{ readonly ok: boolean; readonly error?: string }> {
    const [snapR, snapO] = snapshotFile.split(":");
    const result = await deps.exec(
      `cat '${snapR ?? ""}' > ${ROUTING_CONFIG}.tmp && mv ${ROUTING_CONFIG}.tmp ${ROUTING_CONFIG} 2>/dev/null; cat '${snapO ?? ""}' > ${OPENCODE_JSON}.tmp && mv ${OPENCODE_JSON}.tmp ${OPENCODE_JSON} 2>/dev/null; rm -f '${snapR ?? ""}' '${snapO ?? ""}'`,
      15_000,
    );
    if (result.exitCode !== 0) return { ok: false, error: result.stderr || result.stdout || "routing restore failed" };
    return { ok: true };
  }

  function getServerPassword(): string | null {
    const trimmed = deps.readEnv()["OPENCODE_SERVER_PASSWORD"]?.trim();
    return trimmed ? trimmed : null;
  }

  async function verifyAppliedAgent(agent: string, entries: readonly FallbackModelEntry[], verification: VerificationMode = "readiness", isAborted: () => boolean = () => false): Promise<ApplyResult> {
    if (isAborted()) {
      return { ok: false, status: "unverified", error: verification === "inference" ? "Apply timed out after 300 seconds; the configuration was written but verification did not complete. Check provider quota and try again." : "Apply timed out after 180 seconds; the configuration was written but readiness verification did not complete. Try again or check managed OpenCode health." };
    }
    const password = getServerPassword();
    if (password === null) {
      return { ok: false, status: "unverified", error: "OPENCODE_SERVER_PASSWORD missing after restart" };
    }
    if (isV2() && verification === "readiness") {
      const configuredV2 = entries[0]?.model;
      if (configuredV2 === undefined) {
        const resolvedMapV2 = await live.fetchResolvedAgentModels(password);
        const resolvedV2 = resolvedMapV2?.get(agent)
          ?? [...(resolvedMapV2?.entries() ?? [])].find(([name]) => displayNameToKey(name, new Set([agent])) === agent)?.[1]
          ?? null;
        return { ok: true, status: "cleared", resolved: resolvedV2, requestVerified: null };
      }
      const parsedV2 = parseModelReference(configuredV2);
      if (parsedV2 === null) {
        return { ok: false, status: "runtime_mismatch", configured: configuredV2, resolved: null, requestVerified: null, error: `Configured model ${configuredV2} is not a valid provider/model reference` };
      }
      if (isAborted()) {
        return { ok: false, status: "unverified", error: "Apply timed out after 180 seconds; the configuration was written but readiness verification did not complete. Try again or check managed OpenCode health." };
      }
      const providerSnapshotV2 = await live.fetchProviderSnapshot(password);
      if (!providerSnapshotV2.connectedProviders.includes(parsedV2.providerID)) {
        return { ok: false, status: "unverified", error: `provider ${parsedV2.providerID} is not connected` };
      }
      if (isAborted()) {
        return { ok: false, status: "unverified", error: "Apply timed out after 180 seconds; the configuration was written but readiness verification did not complete. Try again or check managed OpenCode health." };
      }
      const resolvedMapV2 = await live.fetchResolvedAgentModels(password);
      const resolvedV2 = resolvedMapV2?.get(agent)
        ?? [...(resolvedMapV2?.entries() ?? [])].find(([name]) => displayNameToKey(name, new Set([agent])) === agent)?.[1]
        ?? null;
      return { ok: true, status: "configured", resolved: resolvedV2, requestVerified: null };
    }
    if (isV2() && verification === "inference") {
      const configuredV2 = entries[0]?.model;
      if (configuredV2 === undefined) {
        const resolvedMapV2 = await live.fetchResolvedAgentModels(password);
        const resolvedV2 = resolvedMapV2?.get(agent)
          ?? [...(resolvedMapV2?.entries() ?? [])].find(([name]) => displayNameToKey(name, new Set([agent])) === agent)?.[1]
          ?? null;
        return { ok: true, status: "cleared", resolved: resolvedV2, requestVerified: null };
      }
      const parsedV2 = parseModelReference(configuredV2);
      if (parsedV2 === null) {
        return { ok: false, status: "runtime_mismatch", configured: configuredV2, resolved: null, requestVerified: null, error: `Configured model ${configuredV2} is not a valid provider/model reference` };
      }
      if (isAborted()) {
        return { ok: false, status: "unverified", error: "Apply timed out after 300 seconds; the configuration was written but verification did not complete. Check provider quota and try again." };
      }
      const providerSnapshotV2 = await live.fetchProviderSnapshot(password);
      const connectedProviders = new Set(providerSnapshotV2.connectedProviders);
      if (!entries.some((entry) => {
        const parsed = parseModelReference(entry.model);
        return parsed !== null && connectedProviders.has(parsed.providerID);
      })) {
        return { ok: false, status: "unverified", error: "no configured chain provider is connected" };
      }
      if (isAborted()) {
        return { ok: false, status: "unverified", error: "Apply timed out after 300 seconds; the configuration was written but verification did not complete. Check provider quota and try again." };
      }
      const resolvedMapV2 = await live.fetchResolvedAgentModels(password);
      const resolvedV2 = resolvedMapV2?.get(agent)
        ?? [...(resolvedMapV2?.entries() ?? [])].find(([name]) => displayNameToKey(name, new Set([agent])) === agent)?.[1]
        ?? null;
      if (isAborted()) {
        return { ok: false, status: "unverified", error: "Apply timed out after 300 seconds; the configuration was written but verification did not complete. Check provider quota and try again." };
      }
      const requestVerified = await live.fetchSuccessfulRequestModel(password, agent);
      if (requestVerified === null) {
        return { ok: false, status: "unverified", error: `no successful ${agent} request returned assistant model metadata; the request may have timed out or failed` };
      }
      const requestActual = `${requestVerified.providerID}/${requestVerified.modelID}`;
      if (!entries.some((entry) => entry.model === requestActual)) {
        return {
          ok: false,
          status: "runtime_mismatch",
          configured: configuredV2,
          resolved: resolvedV2,
          requestVerified,
          error: `Configured chain for ${agent} did not include request-verified ${requestActual}`,
        };
      }
      return { ok: true, status: "verified", resolved: resolvedV2, requestVerified };
    }
    const resolvedMap = await live.fetchResolvedAgentModels(password);
    if (resolvedMap === null) {
      return { ok: false, status: "unverified", error: "could not reach the managed opencode /agent endpoint after restart" };
    }

    const resolved = resolvedMap.get(agent)
      ?? [...resolvedMap.entries()].find(([name]) => displayNameToKey(name, new Set([agent])) === agent)?.[1]
      ?? null;
    if (resolved === null) {
      return { ok: false, status: "unverified", error: `live agent ${agent} did not resolve a model after restart` };
    }
    const configured = entries[0]?.model;
    if (configured === undefined) {
      return { ok: true, status: "cleared", resolved, requestVerified: null };
    }
    const providerSnapshot = await live.fetchProviderSnapshot(password);
    if (!providerSnapshot.connectedProviders.includes(resolved.providerID)) {
      return { ok: false, status: "unverified", error: `provider ${resolved.providerID} is not connected` };
    }
    if (verification === "readiness") {
      if (isAborted()) {
        return { ok: false, status: "unverified", error: "Apply timed out after 180 seconds; the configuration was written but readiness verification did not complete. Try again or check managed OpenCode health." };
      }
      const configuredActual = `${resolved.providerID}/${resolved.modelID}`;
      if (configuredActual !== configured) {
        return {
          ok: false,
          status: "runtime_mismatch",
          configured,
          resolved,
          requestVerified: null,
          error: `Configured model ${configured} did not match assigned ${configuredActual}`,
        };
      }
      return { ok: true, status: "verified", resolved, requestVerified: null };
    }
    if (isAborted()) {
      return { ok: false, status: "unverified", error: "Apply timed out after 300 seconds; the configuration was written but verification did not complete. Check provider quota and try again." };
    }
    const requestVerified = await live.fetchSuccessfulRequestModel(password, agent);
    if (requestVerified === null) {
      return { ok: false, status: "unverified", error: `a successful request for ${agent} did not return model metadata` };
    }
    const configuredActual = `${resolved.providerID}/${resolved.modelID}`;
    const requestActual = `${requestVerified.providerID}/${requestVerified.modelID}`;
    if (configuredActual !== configured || requestActual !== configured || requestActual !== configuredActual) {
      return {
        ok: false,
        status: "runtime_mismatch",
        configured,
        resolved,
        requestVerified,
        error: `Configured model ${configured} did not match assigned ${configuredActual} and request-verified ${requestActual}`,
      };
    }

    const parsedConfigured = parseModelReference(configured);
    if (parsedConfigured === null) {
      return {
        ok: false,
        status: "runtime_mismatch",
        configured,
        resolved,
        requestVerified,
        error: `Configured model ${configured} is not a valid provider/model reference`,
      };
    }
    if (isAborted()) {
      return { ok: false, status: "unverified", error: "Apply timed out after 300 seconds; the configuration was written but verification did not complete. Check provider quota and try again." };
    }
    const probe = await probeModel(deps, parsedConfigured.providerID, parsedConfigured.modelID);
    if (probe.status === "healthy") {
      return { ok: true, status: "verified", resolved, requestVerified };
    }
    if (probe.status === "mismatch") {
      return {
        ok: false,
        status: "runtime_mismatch",
        configured,
        resolved,
        requestVerified,
        error: probe.reason ?? `Probe resolved a different model than ${configured}`,
      };
    }
    if (probe.status === "quota_exceeded") {
      return {
        ok: true,
        status: "applied_with_quota_warning",
        resolved,
        requestVerified,
        warning: probe.reason ?? `provider quota exhausted for ${configured}`,
      };
    }
    if (probe.status === "retryable" || probe.status === "unreachable") {
      return { ok: false, status: "unverified", error: probe.reason ?? "model probe could not be completed" };
    }
    return { ok: false, status: "probe_failed", error: probe.reason ?? `model ${configured} is unavailable` };
  }

  async function syncNativeAgentOverrides(): Promise<{ readonly ok: boolean; readonly error?: string }> {
    if (isV2()) return { ok: true };
    const op = "$HOME/.config/opencode/opencode.json";
    const omo = "$HOME/.omo/omo.jsonc";
    const cmd = `tmp="${op}.native-agent-overrides.tmp"; if [ ! -f "${op}" ] || [ ! -f "${omo}" ]; then printf '%s\n' 'native override source file missing' >&2; exit 1; fi; if jq -s '.[0] as $opencode | .[1] as $omo | reduce ["general", "plan"][] as $name ($opencode; ($omo.agents[$name] // {}) as $override | if (($override.model | type) == "string" and ($override.model | test("^[^/[:space:]]+/[^[:space:]]+$"))) then .agent = (.agent // {}) | .agent[$name].model = $override.model | if (($override.variant | type) == "string" and ($override.variant | length) > 0) then .agent[$name].variant = $override.variant else del(.agent[$name].variant) end else del(.agent[$name]) end)' "${op}" "${omo}" > "$tmp" 2>/dev/null && mv "$tmp" "${op}"; then exit 0; else code=$?; rm -f "$tmp"; exit "$code"; fi`;
    try {
      const result = await deps.exec(cmd, 10_000);
      return result.exitCode === 0
        ? { ok: true }
        : { ok: false, error: result.stderr || result.stdout || "native override synchronization failed" };
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function applyAndVerifyBatch(changes: readonly AgentModelChange[], verification: VerificationMode = "readiness"): Promise<ReadonlyMap<string, ApplyResult>> {
    const backendTimeoutMs = verification === "inference" ? 300_000 : 180_000;
    const timeoutError: ApplyResult = { ok: false, status: "unverified", error: verification === "inference" ? "Apply timed out after 300 seconds; the configuration was written but verification did not complete. Check provider quota and try again." : "Apply timed out after 180 seconds; the configuration was written but readiness verification did not complete. Try again or check managed OpenCode health." };
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error("timeout"));
      }, backendTimeoutMs);
    });

    const work = async (): Promise<ReadonlyMap<string, ApplyResult>> => {
      const results = new Map<string, ApplyResult>();
      if (changes.length === 0) return results;

      if (isV2()) {
        const snapshot = await snapshotRoutingConfig();
        if (timedOut) {
          for (const change of changes) if (!results.has(change.agent)) results.set(change.agent, timeoutError);
          return results;
        }
        if (snapshot === null) {
          for (const change of changes) {
            results.set(change.agent, { ok: false, status: "write_failed", error: "could not snapshot routing config before applying" });
          }
          return results;
        }
        const succeeded: AgentModelChange[] = [];
        for (const change of changes) {
          if (timedOut) { if (!results.has(change.agent)) results.set(change.agent, timeoutError); continue; }
          const chain = change.entries as unknown as readonly ChainEntry[];
          if (chain.length > 0) {
            const chainErr = validateAgentChain(chain as unknown);
            if (chainErr !== null) { results.set(change.agent, { ok: false, status: "write_failed", error: chainErr }); continue; }
          }
          const write = await deps.exec(buildRoutingWriteCommand(change.agent, chain), 30_000);
          if (timedOut) { if (!results.has(change.agent)) results.set(change.agent, timeoutError); continue; }
          if (write.exitCode !== 0) {
            results.set(change.agent, { ok: false, status: "write_failed", error: write.stderr || write.stdout || "jq routing write failed" });
            continue;
          }
          succeeded.push(change);
        }
        if (succeeded.length === 0) {
          return results;
        }
        const restart = await deps.restart();
        if (timedOut) {
          for (const change of succeeded) if (!results.has(change.agent)) results.set(change.agent, timeoutError);
          return results;
        }
        if ("error" in restart) {
          const rollback = await restoreRoutingConfig(snapshot);
          for (const change of succeeded) {
            results.set(change.agent, rollback.ok
              ? { ok: false, status: "restart_failed", error: restart.error }
              : { ok: false, status: "rollback_failed", error: `${restart.error}; ${rollback.error ?? "rollback failed"}` });
          }
          return results;
        }
        const quotaModels = new Set<string>();
        const quotaWarningByModel = new Map<string, ApplyResult>();
        for (const change of succeeded) {
          if (timedOut) { if (!results.has(change.agent)) results.set(change.agent, timeoutError); continue; }
          const configured = (change.entries as unknown as readonly ChainEntry[])[0]?.model;
          if (verification === "inference" && configured !== undefined && quotaModels.has(configured)) {
            const cached = quotaWarningByModel.get(configured);
            if (cached !== undefined) { results.set(change.agent, cached); continue; }
          }
          const result = await verifyAppliedAgent(change.agent, change.entries, verification, () => timedOut);
          if (timedOut && !results.has(change.agent)) { results.set(change.agent, timeoutError); continue; }
          results.set(change.agent, result);
          if (result.ok && result.status === "applied_with_quota_warning" && configured !== undefined) {
            quotaModels.add(configured);
            quotaWarningByModel.set(configured, result);
          }
        }
        if (timedOut) {
          for (const change of succeeded) if (!results.has(change.agent)) results.set(change.agent, timeoutError);
          return results;
        }
        const probeFailure = [...results.entries()].find(([, result]) => !result.ok && result.status === "probe_failed");
        if (probeFailure !== undefined) {
          const probeFailureError = "error" in probeFailure[1] ? probeFailure[1].error : "model probe failed";
          const rollback = await restoreRoutingConfig(snapshot);
          const recovery = rollback.ok ? await deps.restart() : { ok: false, error: "recovery restart skipped" };
          if (!rollback.ok || "error" in recovery) {
            for (const change of succeeded) {
              results.set(change.agent, { ok: false, status: "rollback_failed", error: `${probeFailureError}; ${rollback.error ?? ("error" in recovery ? recovery.error : "rollback failed")}` });
            }
          } else {
            for (const [agent] of results) {
              if (agent !== probeFailure[0]) results.set(agent, { ok: false, status: "rollback_failed", error: `batch rolled back after ${probeFailure[0]} probe failure` });
            }
          }
        }
        return results;
      }

      const snapshot = await snapshotAgentModelsConfig();
      if (timedOut) {
        for (const change of changes) if (!results.has(change.agent)) results.set(change.agent, timeoutError);
        return results;
      }
      if (snapshot === null) {
        for (const change of changes) {
          results.set(change.agent, { ok: false, status: "write_failed", error: "could not snapshot ~/.omo/omo.jsonc before applying the model" });
        }
        return results;
      }

      const write = await deps.exec(changes.map(({ agent, entries }) => buildJqWriteCommand(agent, entries)).join(" && "), 30_000);
      if (timedOut) {
        for (const change of changes) if (!results.has(change.agent)) results.set(change.agent, timeoutError);
        return results;
      }
      if (write.exitCode !== 0) {
        const rollback = await restoreAgentModelsConfig(snapshot);
        for (const change of changes) {
          results.set(change.agent, rollback.ok
            ? { ok: false, status: "write_failed", error: write.stderr || write.stdout || "jq write failed" }
            : { ok: false, status: "rollback_failed", error: `${write.stderr || write.stdout || "jq write failed"}; ${rollback.error ?? "rollback failed"}` });
        }
        return results;
      }

      const nativeSync = await syncNativeAgentOverrides();
      if (timedOut) {
        for (const change of changes) if (!results.has(change.agent)) results.set(change.agent, timeoutError);
        return results;
      }
      if (!nativeSync.ok) {
        const rollback = await restoreAgentModelsConfig(snapshot);
        for (const change of changes) {
          results.set(change.agent, rollback.ok
            ? { ok: false, status: "write_failed", error: nativeSync.error ?? "native override synchronization failed" }
            : { ok: false, status: "rollback_failed", error: `${nativeSync.error ?? "native override synchronization failed"}; ${rollback.error ?? "rollback failed"}` });
        }
        return results;
      }
      const restart = await deps.restart();
      if (timedOut) {
        for (const change of changes) if (!results.has(change.agent)) results.set(change.agent, timeoutError);
        return results;
      }
      if ("error" in restart) {
        const rollback = await restoreAgentModelsConfig(snapshot);
        for (const change of changes) {
          results.set(change.agent, rollback.ok
            ? { ok: false, status: "restart_failed", error: restart.error }
            : { ok: false, status: "rollback_failed", error: `${restart.error}; ${rollback.error ?? "rollback failed"}` });
        }
        return results;
      }

      const quotaModels = new Set<string>();
      const quotaWarningByModel = new Map<string, ApplyResult>();
      for (const change of changes) {
        if (timedOut) {
          if (!results.has(change.agent)) results.set(change.agent, timeoutError);
          continue;
        }
        const configured = change.entries[0]?.model;
        if (verification === "inference" && configured !== undefined && quotaModels.has(configured)) {
          const cached = quotaWarningByModel.get(configured);
          if (cached !== undefined) {
            results.set(change.agent, cached);
            continue;
          }
        }
        if (timedOut) {
          if (!results.has(change.agent)) results.set(change.agent, timeoutError);
          continue;
        }
        const result = await verifyAppliedAgent(change.agent, change.entries, verification, () => timedOut);
        if (timedOut && !results.has(change.agent)) {
          results.set(change.agent, timeoutError);
          continue;
        }
        results.set(change.agent, result);
        if (result.ok && result.status === "applied_with_quota_warning" && configured !== undefined) {
          quotaModels.add(configured);
          quotaWarningByModel.set(configured, result);
        }
      }

      if (timedOut) {
        for (const change of changes) if (!results.has(change.agent)) results.set(change.agent, timeoutError);
        return results;
      }

      const probeFailure = [...results.entries()].find(([, result]) => !result.ok && result.status === "probe_failed");
      if (probeFailure !== undefined) {
        if (timedOut) {
          for (const change of changes) if (!results.has(change.agent)) results.set(change.agent, timeoutError);
          return results;
        }
        const probeFailureError = "error" in probeFailure[1] ? probeFailure[1].error : "model probe failed";
        const rollback = await restoreAgentModelsConfig(snapshot);
        const recovery = rollback.ok ? await deps.restart() : { ok: false, error: "recovery restart skipped" };
        if (!rollback.ok || "error" in recovery) {
          for (const change of changes) {
            results.set(change.agent, {
              ok: false,
              status: "rollback_failed",
              error: `${probeFailureError}; ${rollback.error ?? ("error" in recovery ? recovery.error : "rollback failed")}`,
            });
          }
        } else {
          for (const agent of results.keys()) {
            if (agent !== probeFailure[0]) {
              results.set(agent, { ok: false, status: "rollback_failed", error: `batch rolled back after ${probeFailure[0]} probe failure` });
            }
          }
        }
      }
      return results;
    };

    try {
      const result = await Promise.race([work(), timeoutPromise]);
      if (timeoutId) clearTimeout(timeoutId);
      return result;
    } catch (error: unknown) {
      if (timeoutId) clearTimeout(timeoutId);
      if (timedOut) {
        const results = new Map<string, ApplyResult>();
        for (const change of changes) results.set(change.agent, timeoutError);
        return results;
      }
      throw error;
    }
  }

  async function applyAndVerify(agent: string, entries: readonly FallbackModelEntry[], verification: VerificationMode = "readiness"): Promise<ApplyResult> {
    return (await applyAndVerifyBatch([{ agent, entries }], verification)).get(agent)
      ?? { ok: false, status: "write_failed", error: "agent model apply returned no result" };
  }

  async function verifyAgent(agent: string, entries: readonly FallbackModelEntry[], verification: VerificationMode): Promise<ApplyResult> {
    return verifyAppliedAgent(agent, entries, verification);
  }

  return {
    readAgentModelsConfig,
    readRoutingConfig,
    writeAgentFallbackModels,
    writeAgentChain,
    snapshotAgentModelsConfig,
    snapshotRoutingConfig,
    restoreAgentModelsConfig,
    restoreRoutingConfig,
    applyAndVerifyBatch,
    getServerPassword,
    fetchConnectedCatalog: live.fetchConnectedCatalog,
    fetchProviderSnapshot: live.fetchProviderSnapshot,
    fetchRecentRequestModels: live.fetchRecentRequestModels,
    fetchRecentSuccessfulRequestModel: live.fetchRecentSuccessfulRequestModel,
    fetchSuccessfulRequestModel: live.fetchSuccessfulRequestModel,
    fetchResolvedAgentModels: live.fetchResolvedAgentModels,
    fetchSubagentNames: live.fetchSubagentNames,
    applyAndVerify,
    verifyAgent,
    readPinnedAgents: () => readPinnedAgents(deps),
  };
}

export type AgentModelsLib = ReturnType<typeof createAgentModelsLib>;

export type AgentModelStateSource = {
  readonly readAgentModelsConfig: () => Promise<Record<string, AgentModelConfig>>;
  readonly readRoutingConfig?: () => Promise<RoutingConfig>;
  readonly fetchResolvedAgentModels: (password: string) => Promise<ReadonlyMap<string, ResolvedModel> | null>;
  readonly fetchProviderSnapshot: (password: string | null) => Promise<{ readonly connectedProviders: readonly string[]; readonly catalog: readonly string[] }>;
  readonly fetchSubagentNames: (password: string) => Promise<readonly string[]>;
  readonly fetchRecentRequestModels: (password: string) => Promise<{ readonly models: readonly { readonly agent: string; readonly modelID: string; readonly providerID: string; readonly completedAt: number }[]; readonly truncated: boolean; readonly warning?: string }>;
  readonly readPinnedAgents?: () => Promise<ReadonlySet<string>>;
};

/** Per-agent view state shared by the admin UI and the center agent protocol. */
export type AgentModelsViewState = {
  agents: AgentModelEntry[];
  catalog: string[];
  providers: string[];
  hasPassword: boolean;
  catalogAvailable: boolean;
  historyTruncated?: boolean;
  historyWarning?: string;
};

/** Merge configured agents with live /agent names into per-agent view entries. */
export async function collectAgentModelState(
  lib: AgentModelStateSource,
  password: string | null,
): Promise<AgentModelsViewState> {
  const v2 = isV2();
  const routingOrConfigPromise = v2 && typeof lib.readRoutingConfig === "function"
    ? lib.readRoutingConfig()
    : lib.readAgentModelsConfig();
  const [rawConfig, resolvedMap, providerSnapshot, subagentNames, pinnedAgents] = await Promise.all([
    routingOrConfigPromise as Promise<Record<string, AgentModelConfig> | RoutingConfig>,
    password !== null ? lib.fetchResolvedAgentModels(password) : Promise.resolve(null),
    lib.fetchProviderSnapshot(password),
    password !== null ? lib.fetchSubagentNames(password) : Promise.resolve([]),
    password !== null && typeof lib.readPinnedAgents === "function" ? lib.readPinnedAgents() : Promise.resolve(new Set<string>()),
  ]);
  let config: Record<string, AgentModelConfig>;
  if (v2 && rawConfig !== null && typeof rawConfig === "object" && "chains" in (rawConfig as Record<string, unknown>)) {
    const routing = rawConfig as RoutingConfig;
    config = {};
    for (const [agent, chainVal] of Object.entries(routing.chains)) {
      const chain = chainVal.chain;
      const primary = chain[0];
      const invalid = chain.length < 1 || chain.length > 10 || chain.some((e) => typeof e.model !== "string" || !/^[^/\s]+\/\S+$/.test(e.model));
      config[agent] = {
        model: primary?.model,
        variant: primary?.variant,
        models: chain as unknown as readonly FallbackModelEntry[],
        invalid,
      };
    }
  } else {
    config = rawConfig as Record<string, AgentModelConfig>;
  }

  const knownKeys = new Set(Object.keys(config));
  // /agent returns display names ("Sisyphus - ultraworker"); map them back to
  // config keys so configured rows and resolved models line up.
  const resolvedByKey = new Map<string, ResolvedModel>();
  for (const [displayName, resolved] of resolvedMap ?? []) {
    const key = displayNameToKey(displayName, knownKeys) ?? displayName;
    if (!resolvedByKey.has(key)) resolvedByKey.set(key, resolved);
  }

  // Include the opencode-native subagents that are safe to configure (e.g.
  // general); internal mechanism agents (compaction, summary, title, build)
  // stay out because changing their model can break opencode internals.
  const configurableKeys = new Set<string>();
  const gatingAgents: readonly string[] = v2 ? (NATIVE12_AGENTS as readonly string[]) : (CONFIGURABLE_NATIVE_AGENTS as readonly string[]);
  for (const displayName of subagentNames) {
    const key = displayNameToKey(displayName, knownKeys) ?? displayName.toLowerCase();
    if ((gatingAgents as readonly string[]).includes(key) || (!v2 && knownKeys.has(key))) {
      configurableKeys.add(key);
    }
  }
  if (v2) {
    for (const agent of NATIVE12_AGENTS) configurableKeys.add(agent);
    for (const key of Object.keys(config)) {
      if ((gatingAgents as readonly string[]).includes(key)) configurableKeys.add(key);
    }
  }

  const names = [...configurableKeys].sort();

  const recentRequestResult = password === null
    ? { models: [], truncated: false }
    : await lib.fetchRecentRequestModels(password);
  const recentRequestModels = recentRequestResult.models;
  const resolvedDisplayNames = new Set(resolvedMap ? resolvedMap.keys() : []);
  const recentRequestByKey = new Map<string, (typeof recentRequestModels)[number]>();
  for (const request of recentRequestModels) {
    const directKey = request.agent.toLowerCase().trim();
    const mappedKey = displayNameToKey(request.agent, knownKeys);
    const key = knownKeys.has(directKey)
      ? directKey
      : mappedKey !== null && resolvedDisplayNames.has(request.agent)
        ? mappedKey
        : request.agent;
    const previous = recentRequestByKey.get(key);
    if (previous === undefined || request.completedAt >= previous.completedAt) recentRequestByKey.set(key, request);
  }
  const requestVerifiedByKey = new Map<string, (typeof recentRequestModels)[number] | null>();
  for (const name of names) {
    const entry = config[name];
    if (entry?.invalid === true) {
      requestVerifiedByKey.set(name, null);
      continue;
    }
    const match = recentRequestByKey.get(name);
    requestVerifiedByKey.set(name, match ?? null);
  }

  const agents: AgentModelEntry[] = names.map((name) => {
    const entry = config[name];
    const configured: readonly FallbackModelEntry[] = v2 && entry?.models && entry.models.length > 0
      ? entry.models as readonly FallbackModelEntry[]
      : entry?.model ? [{ model: entry.model, ...(entry.variant ? { variant: entry.variant } : {}) }] : [];
    const resolved = resolvedByKey.get(name) ?? null;
    const request = requestVerifiedByKey.get(name) ?? null;
    const requestVerified = request === null ? null : { modelID: request.modelID, providerID: request.providerID };
    const providerConnected = v2 && configured.length > 0
      ? (() => {
          const cm = configured[0]?.model;
          const parsed = cm ? parseModelReference(cm) : null;
          return parsed !== null && providerSnapshot.connectedProviders.includes(parsed.providerID);
        })()
      : resolved !== null && providerSnapshot.connectedProviders.includes(resolved.providerID);
    let source: AgentModelEntry["source"] = "plugin";
    if (configured.length > 0) {
      source = "configured";
    } else if (!v2 && name === "plan" && config["prometheus"]?.model !== undefined) {
      source = "inherited";
    }
    let effectiveness: AgentModelEntry["effectiveness"] = "plugin";
    if (entry?.invalid === true) {
      effectiveness = "invalid";
    } else if (configured.length > 0) {
      if (v2) {
        const configuredModel = configured[0]?.model;
        const parsed = configuredModel ? parseModelReference(configuredModel) : null;
        const isConnected = parsed !== null && providerSnapshot.connectedProviders.includes(parsed.providerID);
        if (configuredModel === undefined || !isConnected) {
          effectiveness = "unverified";
        } else {
          if (requestVerified === null) {
            effectiveness = "awaiting_request";
          } else {
            const requestedModel = `${requestVerified.providerID}/${requestVerified.modelID}`;
            effectiveness = configured.some((entry) => entry.model === requestedModel) ? "effective" : "runtime_mismatch";
          }
        }
      } else {
        const configuredModel = configured[0]?.model;
        const resolvedModel = resolved === null ? null : `${resolved.providerID}/${resolved.modelID}`;
        const requestedModel = requestVerified === null ? null : `${requestVerified.providerID}/${requestVerified.modelID}`;
        if (resolvedModel === null || configuredModel === undefined || !providerConnected) {
          effectiveness = "unverified";
        } else if (resolvedModel !== configuredModel) {
          effectiveness = "runtime_mismatch";
        } else if (requestedModel === configuredModel) {
          effectiveness = "effective";
        } else {
          effectiveness = "awaiting_request";
        }
      }
    }
    return {
      name,
      configured,
      resolved,
      requestVerified,
      lastSuccessfulRequestAt: request?.completedAt ?? null,
      providerConnected,
      source,
      pinned: pinnedAgents.has(name),
      invalid: entry?.invalid ?? false,
      effectiveness,
    };
  });

  return {
    agents,
    catalog: [...providerSnapshot.catalog],
    providers: [...providerSnapshot.connectedProviders].sort(),
    hasPassword: password !== null,
    catalogAvailable: providerSnapshot.catalog.length > 0,
    ...(recentRequestResult.truncated ? { historyTruncated: true, historyWarning: recentRequestResult.warning } : {}),
  };
}
