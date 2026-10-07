import type { AgentModelsDeps } from "./agent-model-types";

export const AGENT_MODEL_PINNED_PATH = "$HOME/.config/opencode/agent-model-pinned.json";

interface PinnedFile {
  readonly version: 1;
  readonly agents: readonly string[];
}

function parsePinnedFile(stdout: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Set();
    const agents = (parsed as Record<string, unknown>)["agents"];
    if (!Array.isArray(agents)) return new Set();
    const out = new Set<string>();
    for (const entry of agents) {
      if (typeof entry === "string" && entry.length > 0) out.add(entry);
    }
    return out;
  } catch {
    return new Set();
  }
}

export async function readPinnedAgents(
  deps: Pick<AgentModelsDeps, "exec">,
): Promise<ReadonlySet<string>> {
  const result = await deps.exec(`cat "${AGENT_MODEL_PINNED_PATH}" 2>/dev/null || echo '{}'`, 5_000);
  if (result.exitCode !== 0) return new Set();
  return parsePinnedFile(result.stdout);
}

export async function setPinnedAgent(
  deps: Pick<AgentModelsDeps, "exec">,
  agent: string,
  pinned: boolean,
): Promise<boolean> {
  const current = await readPinnedAgents(deps);
  const next = new Set(current);
  if (pinned) next.add(agent);
  else next.delete(agent);
  const payload: PinnedFile = { version: 1, agents: [...next].sort() };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const result = await deps.exec(
    `mkdir -p "$(dirname "${AGENT_MODEL_PINNED_PATH}")" && printf '%s' '${b64}' | base64 -d > "${AGENT_MODEL_PINNED_PATH}.tmp" && chmod 600 "${AGENT_MODEL_PINNED_PATH}.tmp" && mv "${AGENT_MODEL_PINNED_PATH}.tmp" "${AGENT_MODEL_PINNED_PATH}"`,
    10_000,
  );
  return result.exitCode === 0;
}
