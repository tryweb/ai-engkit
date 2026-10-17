import { readFileSync, writeFileSync, statSync } from "node:fs";
import { isNativeV2Enabled } from "./agent-model-types";

const V1_ENV_PATH = "/opt/ai-engkit/.env";
const V2_ENV_PATH = "/opt/ai-engkit/.env.v2";

/**
 * Line-aware env file path: the V2 line reads `.env.v2`, V1 reads `.env`.
 * Evaluated at call time so tests can toggle lines via `OMO_ENABLED`.
 */
export function resolveEnvPath(): string {
  return isNativeV2Enabled() ? V2_ENV_PATH : V1_ENV_PATH;
}

export interface EnvVars {
  [key: string]: string;
}

/**
 * True only when `path` exists and is a regular file.
 *
 * DooD file-level bind mounts whose host source is missing are auto-created as
 * directories: `existsSync` returns true while `readFileSync` throws EISDIR.
 */
export function envPathIsFile(path: string = resolveEnvPath()): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

export function readEnvFileAt(path: string): EnvVars {
  const vars: EnvVars = {};
  if (!envPathIsFile(path)) return vars;
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

export function readEnvFile(): EnvVars {
  return readEnvFileAt(resolveEnvPath());
}

export function writeEnvFile(vars: EnvVars): void {
  const lines: string[] = [];
  // Preserve existing comments by reading original
  if (envPathIsFile()) {
    const original = readFileSync(resolveEnvPath(), "utf-8");
    for (const line of original.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        lines.push(line);
      }
    }
  }
  for (const [key, value] of Object.entries(vars)) {
    lines.push(`${key}=${value}`);
  }
  writeFileSync(resolveEnvPath(), lines.join("\n") + "\n", "utf-8");
}

export function upsertEnvVar(key: string, value: string): void {
  const vars = readEnvFile();
  vars[key] = value;
  writeEnvFile(vars);
}

export function deleteEnvVar(key: string): void {
  const vars = readEnvFile();
  if (!(key in vars)) return;
  delete vars[key];
  writeEnvFile(vars);
}

export function readEnvAsString(): string {
  if (!envPathIsFile()) return "";
  return readFileSync(resolveEnvPath(), "utf-8");
}

export function envFileExists(): boolean {
  return envPathIsFile();
}
