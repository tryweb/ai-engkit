import type { RoutingConfig, ChainEntry } from "./routing-config";
import type { SessionRoutingState } from "./routing-state";
import { parseModelString } from "./routing-config";

export type HeadEnforcementResult = {
  readonly entry: ChainEntry;
  readonly parsed: { readonly providerID: string; readonly modelID: string };
  readonly payload: { readonly id: string; readonly providerID: string; readonly variant?: string };
};

export function shouldEnforceHead(state: SessionRoutingState | undefined): boolean {
  if (state === undefined) return true;
  return state.cursor === 0 && state.attemptCount === 0;
}

export type SessionModel = {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractSessionModel(info: unknown): SessionModel | undefined {
  const src = isRecord(info) && isRecord(info["data"]) ? info["data"] : info;
  if (!isRecord(src) || !isRecord(src["model"])) return undefined;
  const model = src["model"];
  if (typeof model["id"] !== "string" || typeof model["providerID"] !== "string") return undefined;
  const result: { id: string; providerID: string; variant?: string } = {
    id: model["id"],
    providerID: model["providerID"],
  };
  if (typeof model["variant"] === "string") result.variant = model["variant"];
  return result;
}

export function isHeadModel(current: SessionModel | undefined, head: HeadEnforcementResult): boolean {
  if (!current) return false;
  return current.providerID === head.parsed.providerID && current.id === head.parsed.modelID;
}

export function resolveHeadEnforcement(
  config: RoutingConfig | undefined,
  agent: string,
  state: SessionRoutingState | undefined,
): HeadEnforcementResult | undefined {
  if (!shouldEnforceHead(state)) return undefined;
  if (!config) return undefined;
  const normalized = agent.toLowerCase().trim();
  if (!normalized) return undefined;
  const chain = config.chains[normalized]?.chain;
  if (!chain || chain.length === 0) return undefined;
  const head = chain[0];
  if (!head) return undefined;
  const parsed = parseModelString(head.model);
  if (!parsed) return undefined;
  const payload: { id: string; providerID: string; variant?: string } = {
    id: parsed.modelID,
    providerID: parsed.providerID,
  };
  if (head.variant) payload.variant = head.variant;
  return { entry: head, parsed, payload };
}
