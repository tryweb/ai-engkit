// In-memory session state — MVP subset of fork session-state.ts
// Tracks per-session: lastInjectedAt + cooldown, plus TTL prune 10m/2m like B1.

export interface EnforcerSessionState {
  lastInjectedAt?: number;
  allTodosCompletedAt?: number;
}

interface Tracked {
  state: EnforcerSessionState;
  lastAccessedAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 2 * 60 * 1000;

export function createEnforcerStateStore() {
  const map = new Map<string, Tracked>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function getState(sessionID: string): EnforcerSessionState {
    let t = map.get(sessionID);
    if (!t) {
      t = { state: {}, lastAccessedAt: Date.now() };
      map.set(sessionID, t);
    }
    t.lastAccessedAt = Date.now();
    return t.state;
  }

  function getExisting(sessionID: string): EnforcerSessionState | undefined {
    const t = map.get(sessionID);
    if (!t) return undefined;
    t.lastAccessedAt = Date.now();
    return t.state;
  }

  function startPrune(): void {
    if (timer) return;
    timer = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of map.entries()) {
        if (now - v.lastAccessedAt > TTL_MS) map.delete(k);
      }
    }, PRUNE_INTERVAL_MS);
    const unref = (timer as unknown as { unref?: unknown }).unref;
    if (typeof unref === "function") unref();
  }

  function stopPrune(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function cleanup(sessionID: string): void {
    map.delete(sessionID);
  }

  function shutdown(): void {
    stopPrune();
    map.clear();
  }

  return { getState, getExisting, startPrune, stopPrune, cleanup, shutdown, _map: map };
}

export type EnforcerStateStore = ReturnType<typeof createEnforcerStateStore>;
