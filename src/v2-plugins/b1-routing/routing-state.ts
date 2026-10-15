import type { ChainEntry } from "./routing-config";

export type SessionRoutingState = {
  chain: ChainEntry[];
  cursor: number;
  attemptCount: number;
  holdUntil: number;
  lastError?: unknown;
};

export function createRoutingStateStore(ttlMs = 10 * 60 * 1000) {
  const map: Record<string, SessionRoutingState & { lastAccess: number }> = {};

  let pruneTimer: ReturnType<typeof setInterval> | undefined;

  function get(sessionID: string): SessionRoutingState | undefined {
    const e = map[sessionID];
    if (!e) return undefined;
    e.lastAccess = Date.now();
    const { lastAccess: _a, ...rest } = e as unknown as { lastAccess: number } & SessionRoutingState;
    return rest as SessionRoutingState;
  }

  function set(sessionID: string, state: SessionRoutingState): void {
    map[sessionID] = { ...state, lastAccess: Date.now() } as SessionRoutingState & { lastAccess: number };
  }

  function del(sessionID: string): void {
    delete map[sessionID];
  }

  function startPrune(): void {
    if (pruneTimer) return;
    pruneTimer = setInterval(() => {
      const now = Date.now();
      for (const k in map) if (now - map[k].lastAccess > ttlMs) delete map[k];
    }, 2 * 60 * 1000);
    // @ts-ignore
    if (pruneTimer && typeof (pruneTimer as unknown as { unref?: () => void }).unref === "function") (pruneTimer as unknown as { unref: () => void }).unref();
  }

  function stopPrune(): void {
    if (pruneTimer) clearInterval(pruneTimer);
    pruneTimer = undefined;
  }

  function cleanup(): void {
    stopPrune();
    for (const k in map) delete map[k];
  }

  return { get, set, delete: del, startPrune, stopPrune, cleanup, _map: map };
}

export type RoutingStateStore = ReturnType<typeof createRoutingStateStore>;
