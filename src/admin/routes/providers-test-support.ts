import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RegistryFixture {
  directory: string;
  registryPath: string;
  binPath: string;
  execCallsPath: string;
  cleanup: () => Promise<void>;
}

export async function fixture(seed: string, restartFails = true): Promise<RegistryFixture> {
  const directory = await mkdtemp(join(tmpdir(), "provider-keys-routes-"));
  const registryPath = join(directory, "provider-keys.json");
  const binPath = join(directory, "bin");
  const execCallsPath = join(directory, "exec-calls");
  await mkdir(binPath);
  const dockerPath = join(binPath, "docker");
  const restartExit = restartFails ? 1 : 0;
  await writeFile(dockerPath, `#!/bin/sh
case "$1" in
  exec) case "$*" in *"opencode --version"*) printf '%s\n' 'opencode v1.18.32'; exit 0 ;; esac; printf '%s\n' "$FAKE_AUTH_JSON"; [ -z "$FAKE_EXEC_CALLS" ] || printf '%s\n' "$*" >> "$FAKE_EXEC_CALLS"; exit 0 ;;
  inspect|restart) echo 'restart failed' >&2; exit ${restartExit} ;;
  ps) exit 0 ;;
  *) exit 1 ;;
esac
`);
  await chmod(dockerPath, 0o755);
  await writeFile(registryPath, seed);
  const previousExecutablePath = Bun.env.PATH;
  Bun.env.PATH = `${binPath}:${previousExecutablePath ?? ""}`;
  return {
    directory,
    registryPath,
    binPath,
    execCallsPath,
    cleanup: async () => {
      if (previousExecutablePath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousExecutablePath;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function readRegistry(path: string): Promise<{ providers: Record<string, { keys: Array<Record<string, string>> }> }> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readExecCommands(path: string): Promise<string[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content.split("\n").filter(Boolean);
}

export async function waitForExecCommand(path: string, pattern: string): Promise<string[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const commands = await readExecCommands(path);
    if (commands.some((command) => command.includes(pattern))) return commands;
    await Bun.sleep(0);
  }
  return readExecCommands(path);
}

export function clearReconcileLock(): void {
  rmSync(join(process.env.HOME ?? "", ".cache/openchamber/agent-model-reconcile.lock"), { recursive: true, force: true });
}
