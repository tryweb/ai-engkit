// MVP constants — mirrors fork constants.ts subset, inline CONTINUATION_PROMPT value
export const PLUGIN_ID = "m3-enforcer";
export const HOOK_NAME = "todo-continuation-enforcer";

// createSystemDirective("TODO_CONTINUATION") expands to "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO_CONTINUATION]"
export const CONTINUATION_PROMPT = `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO_CONTINUATION]

Incomplete tasks remain in your todo list. Continue working on the next pending task.

- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done
- If you believe all work is already complete, the system is questioning your completion claim. Critically re-examine each todo item from a skeptical perspective, verify the work was actually done correctly, and update the todo list accordingly.`;

export const CONTINUATION_COOLDOWN_MS = 5000;
export const COUNTDOWN_SECONDS = 0; // MVP: immediate dispatch, countdown optional (file log proves trigger)
export const DEFAULT_SKIP_AGENTS = ["prometheus", "compaction", "plan"];

// Storage prefix — MUST match fork's TODO_PREFIX
export const TODO_PREFIX = "omo-v2:todos:";

// Arbitration note: routing wins on shared failure (one-line precedence per spec §3, see index.ts)
