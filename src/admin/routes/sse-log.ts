/**
 * Shared SSE event-log endpoint helper (db-maintenance + host-maintenance).
 *
 * Semantics (byte-identical to the original db-maintenance implementation):
 * - `?history=1` returns the buffered log as JSON.
 * - Otherwise streams past events, then live events, as `text/event-stream`.
 * - A terminal event unsubscribes immediately and closes the stream 1s later
 *   so the client can flush; abort/cancel closes immediately.
 * - Enqueue-after-close never throws (terminal/abort races are normal).
 */

export interface SseLogEvent {
  step: string;
  status: string;
}

export interface SseLogSource<T extends SseLogEvent> {
  getEventLog: () => T[];
  subscribe: (fn: (event: T) => void) => () => void;
  isTerminalEvent?: (event: T) => boolean;
}

/** Minimal structural surface used from a Hono context (keeps this helper framework-light). */
export interface SseContext {
  req: {
    query: (name: string) => string | undefined;
    raw: { signal: AbortSignal };
  };
  header: (name: string, value: string) => void;
  json: (value: unknown) => Response;
  body: (body: ReadableStream<string>) => Response | Promise<Response>;
}

const defaultIsTerminalEvent = (event: SseLogEvent): boolean =>
  event.step === "verify" && (event.status === "success" || event.status === "failure");

export function handleSseLog<T extends SseLogEvent>(
  c: SseContext,
  source: SseLogSource<T>,
): Response | Promise<Response> {
  if (c.req.query("history") === "1") {
    return c.json(source.getEventLog());
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  let closed = false;
  let cleaned = false;
  let unsub: (() => void) | null = null;
  let ctrl: ReadableStreamDefaultController<string> | null = null;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    unsub?.();
  };
  const safeClose = (): void => {
    if (closed) return;
    closed = true;
    cleanup();
    try {
      ctrl?.close();
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
    }
  };
  const safeEnqueue = (data: string): void => {
    if (closed) return;
    ctrl?.enqueue(data);
  };
  const isTerminal = source.isTerminalEvent ?? defaultIsTerminalEvent;
  const stream = new ReadableStream<string>({
    start(controller) {
      ctrl = controller;
      for (const event of source.getEventLog()) {
        safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
      }
      unsub = source.subscribe((event) => {
        safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
        if (isTerminal(event)) {
          cleanup();
          setTimeout(() => safeClose(), 1000);
        }
      });
      c.req.raw.signal.addEventListener("abort", () => {
        safeClose();
      }, { once: true });
    },
    cancel() {
      safeClose();
    },
  });

  return c.body(stream);
}
