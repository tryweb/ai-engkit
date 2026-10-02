// KV todo store on ctx.storage — mirrors fork v2/stores.ts:createTodoStore
// Handles blocked→pending, deleted→omit normalization at write (Q7), and whole-list poisoning defense.
import { TODO_PREFIX } from "./constants";

export type V2TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type RawTodoStatus = V2TodoStatus | "blocked" | "deleted";

export interface V2TodoItem {
  id?: string;
  content: string;
  status: V2TodoStatus;
  priority?: string;
}

export interface RawTodoItem {
  id?: string;
  content: string;
  status: RawTodoStatus;
  priority?: string;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface V2Storage {
  get(key: string): Promise<unknown>;
  set(key: string, value: JsonValue): Promise<void>;
  remove(key: string): Promise<void>;
  scan(opts: { prefix: string; after?: string; limit: number }): Promise<{ entries: { key: string; value: unknown }[]; next?: string }>;
}

// --- normalization: blocked→pending, deleted→omit (Q7) ---
export function normalizeTodosForStore(todos: RawTodoItem[]): V2TodoItem[] {
  const out: V2TodoItem[] = [];
  for (const t of todos) {
    if (t.status === "deleted") continue; // omit
    const status: V2TodoStatus = t.status === "blocked" ? "pending" : (t.status as V2TodoStatus);
    const item: V2TodoItem = { content: t.content, status };
    if (t.id !== undefined) item.id = t.id;
    if (t.priority !== undefined) item.priority = t.priority;
    out.push(item);
  }
  return out;
}

// asTodoList validation — returns undefined if any entry has illegal status (poison whole list)
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asTodoList(value: unknown): V2TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: V2TodoItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry["content"] !== "string") return undefined;
    const status = entry["status"];
    if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "cancelled") {
      return undefined; // illegal status poisons entire list — caller falls back to []
    }
    const item: V2TodoItem = { content: entry["content"], status };
    if (typeof entry["id"] === "string") item.id = entry["id"];
    if (typeof entry["priority"] === "string") item.priority = entry["priority"];
    items.push(item);
  }
  return items;
}

export interface V2TodoStore {
  get(sessionID: string): Promise<V2TodoItem[]>;
  set(sessionID: string, todos: RawTodoItem[] | V2TodoItem[]): Promise<void>;
  setRaw(sessionID: string, todos: RawTodoItem[]): Promise<void>;
}

export function createTodoStore(storage: V2Storage): V2TodoStore {
  return {
    async get(sessionID: string): Promise<V2TodoItem[]> {
      return asTodoList(await storage.get(`${TODO_PREFIX}${sessionID}`)) ?? [];
    },
    async set(sessionID: string, todos: RawTodoItem[] | V2TodoItem[]): Promise<void> {
      // auto-normalize if caller passes blocked/deleted
      const normalized = normalizeTodosForStore(todos as RawTodoItem[]);
      await storage.set(`${TODO_PREFIX}${sessionID}`, [...normalized] as unknown as JsonValue);
    },
    async setRaw(sessionID: string, todos: RawTodoItem[]): Promise<void> {
      // write without normalization — for testing poisoning behavior only
      await storage.set(`${TODO_PREFIX}${sessionID}`, [...todos] as unknown as JsonValue);
    },
  };
}
