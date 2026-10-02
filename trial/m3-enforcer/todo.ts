import type { V2TodoItem } from "./todo-store";

// Mirrors fork todo.ts:getIncompleteCount — counts pending+in_progress only
export function getIncompleteCount(todos: V2TodoItem[]): number {
  return todos.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled"
  ).length;
}

// Snapshot for progress detection (same as session-state.ts:getTodoSnapshot)
export function getTodoSnapshot(todos: V2TodoItem[]): string {
  return todos
    .map((t) => ({ key: t.id ?? `${t.content}:${t.priority}`, status: t.status }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ key, status }) => `${key}=${status}`)
    .join("|");
}
