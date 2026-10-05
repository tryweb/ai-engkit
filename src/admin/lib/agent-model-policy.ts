import type { AgentModelsDeps } from "./agent-model-types";
import type { SuggestionMode } from "./agent-model-suggestion-policy";

export const AGENT_MODEL_POLICY_PATH = "$HOME/.config/opencode/agent-model-policy.json";

const ALLOWED_MODES = new Set<SuggestionMode>(["free", "economy", "performance"]);

export function parseAgentModelPolicy(stdout: string): SuggestionMode {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const mode = (parsed as Record<string, unknown>).mode;
      if (typeof mode === "string" && ALLOWED_MODES.has(mode as SuggestionMode)) {
        return mode as SuggestionMode;
      }
    }
  } catch {}
  return "free";
}

export async function readAgentModelPolicy(
  deps: Pick<AgentModelsDeps, "exec">,
): Promise<SuggestionMode> {
  const result = await deps.exec(`cat "${AGENT_MODEL_POLICY_PATH}" 2>/dev/null || echo '{}'`, 5_000);
  if (result.exitCode !== 0) return "free";
  return parseAgentModelPolicy(result.stdout);
}

export async function writeAgentModelPolicy(
  deps: Pick<AgentModelsDeps, "exec">,
  mode: SuggestionMode,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  if (!ALLOWED_MODES.has(mode)) return { ok: false, error: `mode must be one of free, economy, performance` };
  const payload = JSON.stringify({ mode, version: 1 });
  const b64 = Buffer.from(payload).toString("base64");
  const result = await deps.exec(
    `mkdir -p "$(dirname "${AGENT_MODEL_POLICY_PATH}")" && printf '%s' '${b64}' | base64 -d > "${AGENT_MODEL_POLICY_PATH}.tmp" && chmod 600 "${AGENT_MODEL_POLICY_PATH}.tmp" && mv "${AGENT_MODEL_POLICY_PATH}.tmp" "${AGENT_MODEL_POLICY_PATH}"`,
    10_000,
  );
  if (result.exitCode !== 0) return { ok: false, error: result.stderr || result.stdout || "policy write failed" };
  return { ok: true };
}

export function validatePolicyMode(value: unknown): SuggestionMode | string {
  if (typeof value !== "string" || !ALLOWED_MODES.has(value as SuggestionMode)) {
    return "mode must be one of free, economy, performance";
  }
  return value as SuggestionMode;
}
