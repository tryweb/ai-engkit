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
      app: unknown;
      storage: unknown;
      directory?: string;
    };
    function define(p: { id: string; setup: (ctx: Context) => unknown }): unknown;
  }
  export const Plugin: typeof Plugin;
}

// Minimal node:fs surface used for file-logging (runtime is bun-based; full
// @types/node intentionally not added for a trial-scoped plugin).
declare module "node:fs" {
  export function appendFileSync(path: string, data: string): void;
}
