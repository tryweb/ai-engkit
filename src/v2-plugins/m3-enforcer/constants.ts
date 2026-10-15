// MVP constants for the ai-engkit todo-continuation enforcer.
// The continuation prompt below is written for ai-engkit; it is not copied from
// any upstream plugin (see docs/knowledge/tooling/v2-plugin-bake.md).
export const PLUGIN_ID = "m3-enforcer";
export const HOOK_NAME = "todo-continuation-enforcer";

// Neutral directive header keeps the injected turn self-identifying so the
// model treats it as a system directive rather than user input.
export const CONTINUATION_PROMPT = `[SYSTEM DIRECTIVE: TODO_CONTINUATION]

Incomplete tasks remain in your todo list. Continue with the next pending task.

- Proceed without asking for permission
- Mark each task complete as you finish it
- Do not stop until all tasks are done
- If you believe all work is already complete, re-examine each remaining todo item skeptically: verify it was actually done correctly, then update the list to match reality.`;

export const CONTINUATION_COOLDOWN_MS = 5000;
export const COUNTDOWN_SECONDS = 0; // MVP: immediate dispatch, countdown optional (file log proves trigger)
export const DEFAULT_SKIP_AGENTS = ["prometheus", "compaction", "plan"];

// Opaque storage namespace on ctx.storage. Kept stable so todos already written
// by earlier V2 builds survive an upgrade; it is an identifier, not a reference
// to any other product.
export const TODO_PREFIX = "omo-v2:todos:";

// Arbitration note: routing wins on shared failure (one-line precedence per spec §3, see index.ts)
