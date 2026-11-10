import { createHash } from "crypto";
import { mkdir, readFile, writeFile, rename, chmod, rm } from "fs/promises";
import { filterToSchema } from "./leanctx-schema";
import type { DashboardRuntimeProfile } from "./dashboard-aggregates";

export const APPLIED_SNAPSHOT_PATH = "/opt/ai-engkit/admin-data/leanctx-applied-snapshot.json";
const SNAPSHOT_VERSION = 1 as const;

export interface LeanCtxAppliedSnapshot {
  readonly version: 1;
  readonly fingerprint: string;
  readonly compressionLevel: "off" | "lite" | "standard" | "max" | null;
  readonly toolProfile: "minimal" | "standard" | "power" | null;
  readonly permissionInheritance: "on" | "off" | null;
  readonly crossProjectSearch: boolean | null;
  readonly secretDetectionEnabled: boolean | null;
  readonly secretRedactionEnabled: boolean | null;
  readonly allowIdeConfigDirs?: boolean | null;
  readonly archiveEnabled: boolean | null;
  readonly archiveMaxAgeHours: number | null;
  readonly archiveMaxDiskMb: number | null;
}

const VALID_COMPRESSION = new Set<string>(["off", "lite", "standard", "max"]);
const VALID_TOOL = new Set<string>(["minimal", "standard", "power"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompressionLevel(value: string): value is NonNullable<LeanCtxAppliedSnapshot["compressionLevel"]> {
  return VALID_COMPRESSION.has(value);
}

function isToolProfile(value: string): value is NonNullable<LeanCtxAppliedSnapshot["toolProfile"]> {
  return VALID_TOOL.has(value);
}

function sanitizeRuntimeProfileFields(config: Record<string, unknown>): Omit<LeanCtxAppliedSnapshot, "version" | "fingerprint"> {
  const compRaw = config["compression_level"];
  const compressionLevel = typeof compRaw === "string" && isCompressionLevel(compRaw) ? compRaw : null;
  const toolRaw = config["tool_profile"];
  const toolProfile = typeof toolRaw === "string" && isToolProfile(toolRaw) ? toolRaw : null;
  const permRaw = config["permission_inheritance"];
  const permissionInheritance = permRaw === "on" || permRaw === "off" ? permRaw : null;

  // boundary_policy.cross_project_search may be nested as {boundary_policy:{cross_project_search}} or flat? filterToSchema retains nesting based on schema keys: "boundary_policy.cross_project_search" -> filter produces {boundary_policy: {cross_project_search}} ?
  // Check filterToSchema behavior: it keeps nesting prefix as object key. So we must support both nested and flat.
  function getNested(obj: Record<string, unknown>, path: string[]): unknown {
    let cur: unknown = obj;
    for (const seg of path) {
      if (!isRecord(cur)) return undefined;
      cur = cur[seg];
    }
    return cur;
  }
  const crossProjectSearchRaw = getNested(config, ["boundary_policy", "cross_project_search"]) ?? config["boundary_policy.cross_project_search"];
  const crossProjectSearch = typeof crossProjectSearchRaw === "boolean" ? crossProjectSearchRaw : null;

  const secretEnabledRaw = getNested(config, ["secret_detection", "enabled"]) ?? config["secret_detection.enabled"];
  const secretDetectionEnabled = typeof secretEnabledRaw === "boolean" ? secretEnabledRaw : null;
  const secretRedactRaw = getNested(config, ["secret_detection", "redact"]) ?? config["secret_detection.redact"];
  const secretRedactionEnabled = typeof secretRedactRaw === "boolean" ? secretRedactRaw : null;
  const allowIdeConfigDirsRaw = config["allow_ide_config_dirs"];
  const allowIdeConfigDirs = typeof allowIdeConfigDirsRaw === "boolean" ? allowIdeConfigDirsRaw : null;

  const archiveEnabledRaw = getNested(config, ["archive", "enabled"]) ?? config["archive.enabled"];
  const archiveEnabled = typeof archiveEnabledRaw === "boolean" ? archiveEnabledRaw : null;
  const archiveHoursRaw = getNested(config, ["archive", "max_age_hours"]) ?? config["archive.max_age_hours"];
  const archiveMaxAgeHours = typeof archiveHoursRaw === "number" && Number.isFinite(archiveHoursRaw) ? archiveHoursRaw : null;
  const archiveDiskRaw = getNested(config, ["archive", "max_disk_mb"]) ?? config["archive.max_disk_mb"];
  const archiveMaxDiskMb = typeof archiveDiskRaw === "number" && Number.isFinite(archiveDiskRaw) ? archiveDiskRaw : null;

  return {
    compressionLevel,
    toolProfile,
    permissionInheritance,
    crossProjectSearch,
    secretDetectionEnabled,
    secretRedactionEnabled,
    allowIdeConfigDirs,
    archiveEnabled,
    archiveMaxAgeHours,
    archiveMaxDiskMb,
  };
}

export function canonicalizeAndFingerprint(config: Record<string, unknown>): { canonicalJson: string; fingerprint: string; supported: Record<string, unknown> } {
  const supported = filterToSchema(config);
  // Recursively sort keys for stable serialization
  const sorted = sortKeysDeep(supported);
  const canonicalJson = JSON.stringify(sorted);
  const fingerprint = createHash("sha256").update(canonicalJson).digest("hex");
  return { canonicalJson, fingerprint, supported };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isRecord(value)) {
    const obj = value;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = sortKeysDeep(obj[k]);
    }
    return sorted;
  }
  return value;
}

export function deriveProfileFromConfig(config: Record<string, unknown>): DashboardRuntimeProfile & { fingerprint: string } {
  const { fingerprint, supported } = canonicalizeAndFingerprint(config);
  const fields = sanitizeRuntimeProfileFields(supported);
  const profile: DashboardRuntimeProfile & { fingerprint: string } = {
    applyState: "applied",
    source: "applied-snapshot",
    ...fields,
    fingerprint,
  };
  return profile;
}

export function snapshotToProfile(snapshot: LeanCtxAppliedSnapshot): DashboardRuntimeProfile {
  return {
    applyState: "applied",
    source: "applied-snapshot",
    compressionLevel: snapshot.compressionLevel,
    toolProfile: snapshot.toolProfile,
    permissionInheritance: snapshot.permissionInheritance,
    crossProjectSearch: snapshot.crossProjectSearch,
    secretDetectionEnabled: snapshot.secretDetectionEnabled,
    secretRedactionEnabled: snapshot.secretRedactionEnabled,
    allowIdeConfigDirs: snapshot.allowIdeConfigDirs ?? null,
    archiveEnabled: snapshot.archiveEnabled,
    archiveMaxAgeHours: snapshot.archiveMaxAgeHours,
    archiveMaxDiskMb: snapshot.archiveMaxDiskMb,
  };
}

function isPermissionInheritanceField(value: unknown): value is LeanCtxAppliedSnapshot["permissionInheritance"] {
  return value === null || value === "on" || value === "off";
}

function isCompressionLevelField(value: unknown): value is LeanCtxAppliedSnapshot["compressionLevel"] {
  return value === null || (typeof value === "string" && isCompressionLevel(value));
}

function isToolProfileField(value: unknown): value is LeanCtxAppliedSnapshot["toolProfile"] {
  return value === null || (typeof value === "string" && isToolProfile(value));
}

function isBooleanOrNull(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

export async function readAppliedSnapshot(path: string = APPLIED_SNAPSHOT_PATH): Promise<LeanCtxAppliedSnapshot | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsedUnknown: unknown = JSON.parse(raw);
    if (!isRecord(parsedUnknown)) return null;
    const parsed = parsedUnknown;
    if (parsed["version"] !== SNAPSHOT_VERSION) return null;
    if (typeof parsed["fingerprint"] !== "string") return null;
    // Validate whitelist keys exist and no extra secret fields present
    const allowed = new Set(["version", "fingerprint", "compressionLevel", "toolProfile", "permissionInheritance", "crossProjectSearch", "secretDetectionEnabled", "secretRedactionEnabled", "allowIdeConfigDirs", "archiveEnabled", "archiveMaxAgeHours", "archiveMaxDiskMb"]);
    for (const k of Object.keys(parsed)) {
      if (!allowed.has(k)) return null;
    }
    const fingerprint: string = parsed["fingerprint"];

    const compressionRaw = parsed["compressionLevel"] === undefined ? null : parsed["compressionLevel"];
    if (!isCompressionLevelField(compressionRaw)) return null;
    const compressionLevel = compressionRaw;

    const toolRaw = parsed["toolProfile"] === undefined ? null : parsed["toolProfile"];
    if (!isToolProfileField(toolRaw)) return null;
    const toolProfile = toolRaw;

    const permissionRaw = parsed["permissionInheritance"] === undefined ? null : parsed["permissionInheritance"];
    if (!isPermissionInheritanceField(permissionRaw)) return null;
    const permissionInheritance = permissionRaw;

    const crossProjectRaw = parsed["crossProjectSearch"] === undefined ? null : parsed["crossProjectSearch"];
    if (!isBooleanOrNull(crossProjectRaw)) return null;
    const crossProjectSearch = crossProjectRaw;

    const secretEnabledRaw = parsed["secretDetectionEnabled"] === undefined ? null : parsed["secretDetectionEnabled"];
    if (!isBooleanOrNull(secretEnabledRaw)) return null;
    const secretDetectionEnabled = secretEnabledRaw;

    const secretRedactRaw = parsed["secretRedactionEnabled"] === undefined ? null : parsed["secretRedactionEnabled"];
    if (!isBooleanOrNull(secretRedactRaw)) return null;
    const secretRedactionEnabled = secretRedactRaw;

    const allowIdeConfigDirsRaw = parsed["allowIdeConfigDirs"] === undefined ? null : parsed["allowIdeConfigDirs"];
    if (!isBooleanOrNull(allowIdeConfigDirsRaw)) return null;
    const allowIdeConfigDirs = allowIdeConfigDirsRaw;

    const archiveEnabledRaw = parsed["archiveEnabled"] === undefined ? null : parsed["archiveEnabled"];
    if (!isBooleanOrNull(archiveEnabledRaw)) return null;
    const archiveEnabled = archiveEnabledRaw;

    const archiveHoursRaw = parsed["archiveMaxAgeHours"] === undefined ? null : parsed["archiveMaxAgeHours"];
    if (!isNumberOrNull(archiveHoursRaw)) return null;
    const archiveMaxAgeHours = archiveHoursRaw;

    const archiveDiskRaw = parsed["archiveMaxDiskMb"] === undefined ? null : parsed["archiveMaxDiskMb"];
    if (!isNumberOrNull(archiveDiskRaw)) return null;
    const archiveMaxDiskMb = archiveDiskRaw;

    return {
      version: 1,
      fingerprint,
      compressionLevel,
      toolProfile,
      permissionInheritance,
      crossProjectSearch,
      secretDetectionEnabled,
      secretRedactionEnabled,
      allowIdeConfigDirs,
      archiveEnabled,
      archiveMaxAgeHours,
      archiveMaxDiskMb,
    };
  } catch (error) {
    void error;
    return null;
  }
}

export async function writeAppliedSnapshot(
  config: Record<string, unknown>,
  path: string = APPLIED_SNAPSHOT_PATH,
): Promise<void> {
  const { fingerprint, supported } = canonicalizeAndFingerprint(config);
  const fields = sanitizeRuntimeProfileFields(supported);
  const snapshot: LeanCtxAppliedSnapshot = {
    version: SNAPSHOT_VERSION,
    fingerprint,
    ...fields,
  };
  const dir = path.slice(0, path.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const content = JSON.stringify(snapshot, null, 2);
  try {
    // exclusive creation with mode 0600
    await writeFile(tmp, content, { flag: "wx", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (error) {
    try {
      await rm(tmp, { force: true });
    } catch (cleanupError) {
      void cleanupError;
    }
    throw error;
  }
}

export async function tryWriteAppliedSnapshotSafe(config: Record<string, unknown>, path: string = APPLIED_SNAPSHOT_PATH): Promise<boolean> {
  try {
    await writeAppliedSnapshot(config, path);
    return true;
  } catch (error) {
    void error;
    return false;
  }
}

// Derive applyState for Dashboard
export function deriveDashboardRuntimeState(
  savedConfig: Record<string, unknown> | null,
  snapshot: LeanCtxAppliedSnapshot | null,
): { profile: DashboardRuntimeProfile; snapshotFingerprint: string | null } {
  if (snapshot) {
    const base = snapshotToProfile(snapshot);
    if (savedConfig) {
      const { fingerprint: savedFp } = canonicalizeAndFingerprint(savedConfig);
      if (savedFp === snapshot.fingerprint) {
        return { profile: { ...base, applyState: "applied" }, snapshotFingerprint: snapshot.fingerprint };
      }
      return { profile: { ...base, applyState: "pending" }, snapshotFingerprint: snapshot.fingerprint };
    }
    return { profile: { ...base, applyState: "applied" }, snapshotFingerprint: snapshot.fingerprint };
  }
  if (savedConfig) {
    const fields = sanitizeRuntimeProfileFields(filterToSchema(savedConfig));
    return {
      profile: {
        applyState: "saved-only",
        source: "saved-config",
        ...fields,
      },
      snapshotFingerprint: null,
    };
  }
  // both unavailable
  return {
    profile: {
      applyState: "runtime-unavailable",
      source: "unavailable",
      compressionLevel: null,
      toolProfile: null,
      permissionInheritance: null,
      crossProjectSearch: null,
      secretDetectionEnabled: null,
      secretRedactionEnabled: null,
      allowIdeConfigDirs: null,
      archiveEnabled: null,
      archiveMaxAgeHours: null,
      archiveMaxDiskMb: null,
    },
    snapshotFingerprint: null,
  };
}
