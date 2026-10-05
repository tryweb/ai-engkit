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
