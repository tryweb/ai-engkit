/**
 * One local domain Compose overlay for the `ai-dev` service.
 *
 * AI-EngKit owns the upstream base Compose file; the domain project owns exactly
 * one overlay referenced by `AI_ENGKIT_COMPOSE_OVERLAY`. This module is the
 * single resolution boundary used by every Admin-managed ai-dev recreate path
 * (upgrade, restart, DB maintenance, agent commands), so the overlay cannot be
 * accidentally dropped by patching only one caller.
 *
 * Security posture: the overlay path must be a canonical descendant of the
 * fixed read-only `/opt/ai-engkit/extensions/` directory, and the overlay may
 * only extend `ai-dev` with environment, networks, volumes, labels, and
 * healthchecks. Protected fields (image, container identity, command,
 * entrypoint, published ports, privilege/security settings, Docker socket
 * mounts, other services) fail validation before any mutation. Validation
 * output is sanitized and overlay contents / `.env` values are never logged.
 */

import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { composeCommand, shellQuote, type ExecResult } from "./docker";

export const EXTENSIONS_DIR = "/opt/ai-engkit/extensions";
export const COMPOSE_PROJECT_DIR = "/opt/ai-engkit";
export const ACTIVE_COMPOSE_FILE = "/opt/ai-engkit/compose.yml";
export const UPGRADE_BASE_FILE = "/opt/ai-engkit/compose-upgrade-base.yml";
export const UPGRADE_STAGING_FILE = "/opt/ai-engkit/admin-data/upgrade-base.yml.staging";
export const ENV_FILE = "/opt/ai-engkit/.env";
export const OVERLAY_ENV_KEY = "AI_ENGKIT_COMPOSE_OVERLAY";

export interface OverlayPaths {
  readonly extensionsDir: string;
  readonly activeFile: string;
  readonly stagedBaseFile: string;
  readonly envFile: string;
}

export const DEFAULT_OVERLAY_PATHS: OverlayPaths = {
  extensionsDir: EXTENSIONS_DIR,
  activeFile: ACTIVE_COMPOSE_FILE,
  stagedBaseFile: UPGRADE_BASE_FILE,
  envFile: ENV_FILE,
};

/** A configured overlay that passed path confinement and readability checks. */
export interface ActiveOverlay {
  readonly active: true;
  /** The value as configured in `AI_ENGKIT_COMPOSE_OVERLAY`. */
  readonly reference: string;
  /** Canonical absolute path beneath the extensions directory. */
  readonly canonicalPath: string;
}

export interface InactiveOverlay {
  readonly active: false;
}

export type OverlayResolution = ActiveOverlay | InactiveOverlay;

/** Thrown for a configured-but-invalid overlay so callers fail closed. */
export class OverlayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverlayConfigError";
  }
}

/** Injectable filesystem seam so path logic is testable without root paths. */
export interface OverlayFs {
  readonly exists: (path: string) => boolean;
  readonly realpath: (path: string) => string;
  readonly isFile: (path: string) => boolean;
  readonly isReadable: (path: string) => boolean;
  readonly size: (path: string) => number | null;
}

const REAL_FS: OverlayFs = {
  exists: (path) => existsSync(path),
  realpath: (path) => realpathSync(path),
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  isReadable: (path) => {
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  size: (path) => {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
};

export interface OverlayConfigDeps {
  readonly readEnv?: () => Record<string, string>;
  readonly fs?: OverlayFs;
  readonly paths?: Partial<OverlayPaths>;
}

function pathsFor(deps: OverlayConfigDeps): OverlayPaths {
  return { ...DEFAULT_OVERLAY_PATHS, ...deps.paths };
}

function fsFor(deps: OverlayConfigDeps): OverlayFs {
  return deps.fs ?? REAL_FS;
}

/** Strip control characters from an operator-supplied value before reporting. */
function stripControlChars(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? "?" : char;
  }
  return out;
}

function sanitizePathForReport(value: string): string {
  return stripControlChars(value).slice(0, 400);
}

/**
 * Resolve `AI_ENGKIT_COMPOSE_OVERLAY`. Missing/empty means "no overlay"
 * (existing single-file behavior). Any configured value that is not a
 * canonical readable regular file beneath the extensions directory throws
 * `OverlayConfigError`; the error names the path only, never file contents.
 */
export function resolveOverlay(deps: OverlayConfigDeps = {}): OverlayResolution {
  const readEnv = deps.readEnv;
  const env = readEnv ? readEnv() : {};
  const raw = env[OVERLAY_ENV_KEY];
  if (raw === undefined) return { active: false };
  const reference = raw.trim();
  if (reference.length === 0) return { active: false };

  const paths = pathsFor(deps);
  const fs = fsFor(deps);

  const candidate = isAbsolute(reference) ? reference : join(paths.extensionsDir, reference);
  const normalized = resolve(candidate);
  const extensionPrefix = paths.extensionsDir.endsWith(sep)
    ? paths.extensionsDir
    : `${paths.extensionsDir}${sep}`;

  if (!normalized.startsWith(extensionPrefix)) {
    throw new OverlayConfigError(
      `${OVERLAY_ENV_KEY} must resolve beneath ${paths.extensionsDir} (got ${sanitizePathForReport(reference)})`,
    );
  }

  if (!fs.exists(normalized)) {
    throw new OverlayConfigError(
      `${OVERLAY_ENV_KEY} is not readable: ${sanitizePathForReport(normalized)} does not exist`,
    );
  }

  let canonical: string;
  try {
    canonical = fs.realpath(normalized);
  } catch {
    throw new OverlayConfigError(
      `${OVERLAY_ENV_KEY} is not readable: cannot canonicalize ${sanitizePathForReport(normalized)}`,
    );
  }

  // A symlink inside extensions can still point outside; confine the canonical
  // target, not just the lexical path.
  if (!canonical.startsWith(extensionPrefix)) {
    throw new OverlayConfigError(
      `${OVERLAY_ENV_KEY} must resolve beneath ${paths.extensionsDir} (got ${sanitizePathForReport(reference)})`,
    );
  }

  if (!fs.isFile(canonical)) {
    throw new OverlayConfigError(
      `${OVERLAY_ENV_KEY} must reference a regular file: ${sanitizePathForReport(canonical)}`,
    );
  }

  if (!fs.isReadable(canonical)) {
    throw new OverlayConfigError(
      `${OVERLAY_ENV_KEY} is not readable: ${sanitizePathForReport(canonical)}`,
    );
  }

  return { active: true, reference, canonicalPath: canonical };
}

/** Non-throwing overlay status for the Admin API/SSE surface. */
export interface OverlayStatus {
  readonly configured: boolean;
  readonly active: boolean;
  readonly reference: string | null;
  readonly error: string | null;
}

export function getOverlayStatus(deps: OverlayConfigDeps = {}): OverlayStatus {
  const env = deps.readEnv ? deps.readEnv() : {};
  const raw = env[OVERLAY_ENV_KEY];
  const reference = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
  const configured = reference !== null;
  try {
    const resolved = resolveOverlay(deps);
    return {
      configured,
      active: resolved.active,
      reference: resolved.active ? resolved.reference : reference,
      error: null,
    };
  } catch (error: unknown) {
    return {
      configured,
      active: false,
      reference,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Ordered Compose inputs for one effective configuration. */
export interface EffectiveCompose {
  readonly overlayActive: boolean;
  readonly files: readonly string[];
  readonly overlayReference: string | null;
}

/**
 * Build the deterministic ordered Compose file list: staged upstream base first,
 * local overlay second (later-file precedence). With no overlay the single
 * active file is returned so existing behavior is byte-identical.
 */
export function resolveEffectiveCompose(
  overlay: OverlayResolution,
  deps: { readonly paths?: Partial<OverlayPaths>; readonly fs?: OverlayFs } = {},
): EffectiveCompose {
  const paths = { ...DEFAULT_OVERLAY_PATHS, ...deps.paths };
  const fs = deps.fs ?? REAL_FS;
  if (!overlay.active) {
    return { overlayActive: false, files: [paths.activeFile], overlayReference: null };
  }

  const stagedBase = paths.stagedBaseFile;
  const stagedUsable =
    fs.exists(stagedBase) && fs.isFile(stagedBase) && (fs.size(stagedBase) ?? 0) > 0;
  const activeUsable = fs.exists(paths.activeFile) && fs.isFile(paths.activeFile);
  const base = stagedUsable ? stagedBase : activeUsable ? paths.activeFile : null;
  if (base === null) {
    throw new OverlayConfigError(
      `overlay is configured but no Compose base is available (${sanitizePathForReport(stagedBase)} and ${sanitizePathForReport(paths.activeFile)} are both missing)`,
    );
  }

  return { overlayActive: true, files: [base, overlay.canonicalPath], overlayReference: overlay.reference };
}

export interface RecreateSubcommandOptions {
  readonly project: string;
  readonly envFile: string;
  readonly effective: EffectiveCompose;
  /** Compose action, e.g. `up -d --force-recreate ai-dev`. */
  readonly action: string;
  /** Optional trace suffix, e.g. ` 2>&1`, preserved for existing no-overlay callers. */
  readonly trace?: string;
}

/**
 * Build the `docker compose` subcommand for a recreate action. The no-overlay
 * form is identical to the historical single-file command; the overlay form
 * adds `--project-directory /opt/ai-engkit` so relative host paths keep the
 * installation-root semantics under Docker-out-of-Docker.
 */
export function buildRecreateSubcommand(options: RecreateSubcommandOptions): string {
  const { project, envFile, effective, action, trace = "" } = options;
  if (effective.files.length === 0) {
    throw new OverlayConfigError("effective Compose configuration has no files");
  }
  const fileFlags = effective.overlayActive
    ? `-f ${effective.files[0]} -f ${shellQuote(effective.files[1] ?? "")}`
    : `-f ${effective.files[0]}`;
  const projectDir = effective.overlayActive ? ` --project-directory ${COMPOSE_PROJECT_DIR}` : "";
  return `compose -p ${project}${projectDir} --env-file ${envFile} ${fileFlags} ${action}${trace}`;
}

const ALLOWED_TOP_LEVEL_KEYS = new Set(["name", "services", "networks", "volumes"]);
const ALLOWED_SERVICE_KEYS = new Set(["environment", "networks", "volumes", "labels", "healthcheck"]);
/** Fields with clearer wording than a generic "unsupported key" rejection. */
const PROTECTED_SERVICE_KEYS = new Set([
  "image",
  "container_name",
  "command",
  "entrypoint",
  "ports",
  "expose",
  "privileged",
  "cap_add",
  "cap_drop",
  "security_opt",
  "devices",
  "pid",
  "ipc",
  "uts",
  "userns_mode",
  "sysctls",
  "network_mode",
  "restart",
  "deploy",
  "runtime",
  "profiles",
  "build",
  "hostname",
  "domainname",
  "dns",
  "dns_search",
  "extra_hosts",
  "cgroup_parent",
  "group_add",
  "mem_limit",
  "mem_reservation",
  "cpus",
  "cpu_shares",
  "shm_size",
  "stop_signal",
  "stop_grace_period",
  "init",
  "tty",
  "stdin_open",
  "read_only",
  "working_dir",
  "user",
]);

export type ValidationResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

function invalid(error: string): ValidationResult {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reject overlay volumes that bind-mount any host path: a domain overlay may
 * only reference named volumes, never host files or directories. The Docker
 * socket keeps its explicit message; every other bind source is rejected too
 * so paths like `/` or `/etc` cannot expose the host filesystem.
 */
function findDisallowedBindMount(volumes: unknown): string | null {
  if (!Array.isArray(volumes)) return null;
  for (const entry of volumes) {
    if (!isRecord(entry)) continue;
    const type = entry["type"];
    const source = entry["source"];
    if (type !== "bind" || typeof source !== "string") continue;
    if (source === "/var/run/docker.sock" || source === "/run/docker.sock" || source.endsWith("/docker.sock")) {
      return `overlay must not mount the Docker socket (${source})`;
    }
    return `overlay must not bind-mount host paths (${source})`;
  }
  return null;
}

/**
 * Inspect the overlay-only normalized Compose JSON (produced with
 * `config --no-consistency`) and enforce the V1 allowed surface. Only the
 * overlay's own keys are inspected, so a protected key from the base cannot
 * mask (or be mistaken for) an overlay one.
 */
export function validateOverlayAloneJson(jsonText: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return invalid("overlay Compose config did not produce valid JSON");
  }
  if (!isRecord(parsed)) return invalid("overlay Compose config is not an object");

  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return invalid(`overlay uses unsupported top-level key "${key}"`);
    }
  }

  for (const section of ["networks", "volumes"] as const) {
    const value = parsed[section];
    if (value === undefined) continue;
    if (!isRecord(value)) return invalid(`overlay "${section}" must be a mapping`);
    for (const [name, declaration] of Object.entries(value)) {
      if (!isRecord(declaration)) {
        return invalid(`overlay ${section} entry "${name}" must be a mapping`);
      }
    }
  }

  const services = parsed["services"];
  if (!isRecord(services)) return invalid("overlay must declare a services mapping");

  const foreign = Object.keys(services).filter((name) => name !== "ai-dev");
  if (foreign.length > 0) {
    return invalid(`overlay must not define service(s): ${foreign.join(", ")}`);
  }
  if (!("ai-dev" in services)) return invalid("overlay must define the ai-dev service");

  const dev = services["ai-dev"];
  if (!isRecord(dev)) return invalid("overlay ai-dev service must be a mapping");

  for (const [key, value] of Object.entries(dev)) {
    if (ALLOWED_SERVICE_KEYS.has(key)) continue;
    // Compose normalization always emits null command/entrypoint for an
    // otherwise-undeclared service; only a non-null value is an overlay change.
    if ((key === "command" || key === "entrypoint") && value === null) continue;
    if (PROTECTED_SERVICE_KEYS.has(key)) {
      return invalid(`overlay must not change protected ai-dev field "${key}"`);
    }
    return invalid(`overlay uses unsupported ai-dev field "${key}"`);
  }

  const bindError = findDisallowedBindMount(dev["volumes"]);
  if (bindError) return invalid(bindError);

  return { ok: true };
}

/** Require the merged effective configuration to still contain ai-dev. */
export function requireAiDevService(jsonText: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return invalid("effective Compose config did not produce valid JSON");
  }
  if (!isRecord(parsed)) return invalid("effective Compose config is not an object");
  const services = parsed["services"];
  if (!isRecord(services) || !("ai-dev" in services)) {
    return invalid("effective base+overlay configuration has no ai-dev service");
  }
  return { ok: true };
}

/** Redact assignment-like substrings so validation errors never echo secrets. */
export function sanitizeComposeError(raw: string): string {
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "no diagnostic output";
  const redacted = firstLine.replace(/([A-Za-z_][A-Za-z0-9_]*)=[^\s]+/g, "$1=[redacted]");
  return stripControlChars(redacted).slice(0, 300);
}

export interface ValidateEffectiveOptions {
  readonly overlay: ActiveOverlay;
  readonly baseFile: string;
  readonly project: string;
  readonly envFile?: string;
  readonly compose?: (subcommand: string, timeoutMs: number) => Promise<ExecResult>;
}

/**
 * Validate the overlay alone, then the ordered base+overlay configuration.
 * Runs before any active configuration mutation or recreate and returns a
 * sanitized error on the first failure.
 */
export async function validateEffectiveCompose(options: ValidateEffectiveOptions): Promise<ValidationResult> {
  const compose = options.compose ?? composeCommand;
  const envFile = options.envFile ?? ENV_FILE;
  const prefix = `-p ${options.project} --project-directory ${COMPOSE_PROJECT_DIR} --env-file ${envFile}`;
  const overlayArg = shellQuote(options.overlay.canonicalPath);

  const aloneSubcommand = `${prefix} -f ${overlayArg} config --no-consistency --format json`;
  const alone = await compose(aloneSubcommand, 60_000);
  if (alone.exitCode !== 0) {
    return invalid(`overlay validation failed: ${sanitizeComposeError(alone.stderr || alone.stdout)}`);
  }
  const overlayCheck = validateOverlayAloneJson(alone.stdout);
  if (!overlayCheck.ok) return overlayCheck;

  const mergedSubcommand = `${prefix} -f ${options.baseFile} -f ${overlayArg} config --format json`;
  const merged = await compose(mergedSubcommand, 60_000);
  if (merged.exitCode !== 0) {
    return invalid(`effective base+overlay validation failed: ${sanitizeComposeError(merged.stderr || merged.stdout)}`);
  }
  return requireAiDevService(merged.stdout);
}

/** Overlay file basename for status messages (never logs file contents). */
export function overlayLabel(overlay: OverlayResolution): string | null {
  return overlay.active ? basename(overlay.canonicalPath) : null;
}

export interface ResolveValidatedComposeDeps extends OverlayConfigDeps {
  readonly project: string;
  readonly envFile?: string;
  readonly compose?: (subcommand: string, timeoutMs: number) => Promise<ExecResult>;
}

/**
 * Resolve the configured overlay and validate the ordered base+overlay
 * configuration before returning it. Inactive overlays keep the historical
 * single-file behavior and run no validation. An active overlay that fails
 * validation throws `OverlayConfigError` (sanitized) so callers fail closed
 * rather than applying an unvalidated overlay.
 */
export async function resolveValidatedEffectiveCompose(
  deps: ResolveValidatedComposeDeps,
): Promise<EffectiveCompose> {
  const overlay = resolveOverlay(deps);
  const effective = resolveEffectiveCompose(overlay, { paths: deps.paths, fs: deps.fs });
  if (!overlay.active) return effective;

  const baseFile = effective.files[0];
  if (baseFile === undefined) {
    throw new OverlayConfigError("effective Compose configuration has no base file");
  }

  const validation = await validateEffectiveCompose({
    overlay,
    baseFile,
    project: deps.project,
    envFile: deps.envFile,
    compose: deps.compose,
  });
  if (!validation.ok) {
    const detail = "error" in validation ? validation.error : "unknown validation failure";
    throw new OverlayConfigError(`Effective Compose validation failed: ${detail}`);
  }
  return effective;
}
