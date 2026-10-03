declare module "@opencode/plugin" {
  export namespace Plugin {
    type Context = {
      session: {
        hook: (name: string, fn: (input: unknown) => unknown) => Promise<unknown>;
        prompt: (arg: unknown) => Promise<void>;
        switchModel: (arg: unknown) => Promise<void>;
        switchAgent: (arg: unknown) => Promise<void>;
        get: (arg: unknown) => Promise<unknown>;
        context: (arg: unknown) => Promise<unknown>;
      };
      event: {
        subscribe: (opts: { signal: AbortSignal }) => AsyncIterable<{ type: string; data: unknown }>;
      };
      tool: {
        transform: (fn: (editor: { add: (info: unknown) => void }) => void | Promise<void>) => Promise<void>;
        list?: () => Promise<unknown[]>;
      };
      storage: {
        get: (k: string) => Promise<unknown>;
        set: (k: string, v: unknown) => Promise<void>;
        remove: (k: string) => Promise<void>;
        scan: (opts: { prefix: string; after?: string; limit: number }) => Promise<{ entries: { key: string; value: unknown }[]; next?: string }>;
      };
      location?: { directory: string };
      directory?: string;
      app: unknown;
    };
    function define(p: { id: string; setup: (ctx: Context) => unknown }): unknown;
  }
  export const Plugin: typeof Plugin;
}

declare module "@opencode-ai/plugin/tool" {
  export const tool: ((input: { description: string; args: Record<string, unknown>; execute: (args: unknown, ctx: unknown) => Promise<unknown> }) => unknown) & {
    schema: {
      string: () => unknown;
      enum: (vals: string[]) => unknown;
      object: (shape: Record<string, unknown>) => unknown;
      array: (inner: unknown) => unknown;
      toJSONSchema: (schema: unknown) => unknown;
    };
  };
}

// Minimal node:fs surface used for file-logging (runtime is bun-based; full
// @types/node intentionally not added for a trial-scoped plugin).
declare module "node:fs" {
  export function appendFileSync(path: string, data: string): void;
}
