import { createAgentModelReconciler } from "./agent-model-reconciler";
import { REAL_DEPS } from "./agent-models";
import { restartManagedOpenCode } from "./restart-ai-dev";
import type { ExecResult } from "./docker";

async function localExec(command: string, timeoutMs = 30_000): Promise<ExecResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const proc = Bun.spawn(["sh", "-c", command], { signal: controller.signal });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { stdout: "", stderr: `Command timed out after ${timeoutMs}ms`, exitCode: -1 };
    }
    return { stdout: "", stderr: String(err), exitCode: -1 };
  } finally {
    clearTimeout(timer);
  }
}

const deps: typeof REAL_DEPS = {
  exec: localExec,
  restart: () => restartManagedOpenCode({ exec: localExec, readEnv: () => ({ ...process.env }) as Record<string, string> }),
  readEnv: (): Record<string, string> => ({ ...process.env }) as Record<string, string>,
};

try {
  const summary = await createAgentModelReconciler(deps).reconcileAll();
  for (const result of summary.results) {
    console.error(
      `[agent-models] result ${JSON.stringify({
        agent: result.agent,
        status: result.status,
        error: result.error,
        resolved: result.resolved === null
          ? null
          : `${result.resolved.providerID}/${result.resolved.modelID}`,
      })}`,
    );
  }
  console.error(
    `[agent-models] reconciled: changed=${summary.changed} applied=${summary.applied} failed=${summary.failed}`,
  );
  if (summary.failed > 0) process.exitCode = 1;
} catch (error) { // no-excuse-ok: catch
  console.error("[agent-models] reconciliation failed", error);
  process.exitCode = 1;
}
