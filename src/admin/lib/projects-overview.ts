import { readDisabledProjects, type SettingsCommand } from "./openchamber-projects";
import type { LeanCtxProjectStatus } from "./leanctx-project-status";
import type { CodegraphStatus, ProjectToolStatusProvider } from "./project-tool-status";

export type ProjectCommand = SettingsCommand;

export interface ProjectFeatures {
  knowledge: boolean;
  maintenance: boolean;
  openspec: boolean;
  superpowers: boolean;
}

export interface KnowledgeStats {
  files: number;
  patterns: number;
  architecture: number;
  tooling: number;
  troubleshooting: number;
  /** Unix epoch milliseconds of the most recently modified knowledge entry. */
  lastModified: number;
}

export interface MaintenanceStats {
  reports: number;
  /** YYYY-MM-DD of the most recent report, derived from filename prefixes. */
  lastReportDate: string | null;
  /** Number of distinct months covered by report dates. */
  months: number;
}

export interface OpenSpecStats {
  active: number;
  archived: number;
  specs: number;
}

export interface ProjectFeatureStats {
  knowledge: KnowledgeStats | null;
  maintenance: MaintenanceStats | null;
  openspec: OpenSpecStats | null;
}

export interface ProjectOverview {
  name: string;
  features: ProjectFeatures;
  remote: string | null;
  disabled: boolean;
  /** Present only when the caller supplies a tool status provider. */
  codegraph?: CodegraphStatus | null;
  /** Present only when the caller supplies a provider with a LeanCTX project scan. */
  leanctx?: LeanCtxProjectStatus | null;
  /** Present only when the caller supplies a tool status provider. */
  stats?: ProjectFeatureStats | null;
}

const projectDir = (workspaceRoot: string, name: string) => JSON.stringify(`${workspaceRoot}/${name}`);

/**
 * One shell invocation emitting a single JSON object of per-feature stats.
 * Pure filesystem reads (find/stat) — cheap, dependency-free.
 * Output: {"knowledge":{...}|null,"maintenance":{...}|null,"openspec":{...}|null}
 * — a disabled feature is null; an enabled one is an object (counters fall back to 0).
 */
export function buildFeatureStatsCommand(projectDir: string): string {
  return [
    `P=${projectDir}`,
    `K=0; M=0; O=0`,
    `[ -f "$P/docs/knowledge/README.md" ] && K=1`,
    `[ -f "$P/docs/knowledge/maintenance/README.md" ] && M=1`,
    `[ -d "$P/openspec" ] && O=1`,
    `KJ=null; MJ=null; OJ=null`,
    `if [ "$K" = 1 ]; then`,
    `  arch=$(find "$P/docs/knowledge/architecture" -name '*.md' ! -name '_template.md' 2>/dev/null | wc -l)`,
    `  patt=$(find "$P/docs/knowledge/patterns" -name '*.md' ! -name '_template.md' 2>/dev/null | wc -l)`,
    `  tool=$(find "$P/docs/knowledge/tooling" -name '*.md' ! -name '_template.md' 2>/dev/null | wc -l)`,
    `  trou=$(find "$P/docs/knowledge/troubleshooting" -name '*.md' ! -name '_template.md' 2>/dev/null | wc -l)`,
    `  files=$((arch + patt + tool + trou))`,
    `  last=$(find "$P/docs/knowledge/architecture" "$P/docs/knowledge/patterns" "$P/docs/knowledge/tooling" "$P/docs/knowledge/troubleshooting" -name '*.md' ! -name '_template.md' -exec stat -c '%Y' {} + 2>/dev/null | sort -n | tail -1)`,
    `  [ -z "$last" ] && last=0`,
    `  last=$((last * 1000))`,
    `  KJ="{\\"files\\":$files,\\"patterns\\":$patt,\\"architecture\\":$arch,\\"tooling\\":$tool,\\"troubleshooting\\":$trou,\\"lastModified\\":$last}"`,
    `fi`,
    `if [ "$M" = 1 ]; then`,
    `  reports=$(find "$P/docs/knowledge/maintenance" -name '*.md' ! -name 'README.md' ! -name '_template.md' 2>/dev/null | wc -l)`,
    `  lastdate=$(find "$P/docs/knowledge/maintenance" -name '*.md' ! -name 'README.md' ! -name '_template.md' 2>/dev/null | sed 's|.*/||' | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' | sort | tail -1)`,
    `  months=$(find "$P/docs/knowledge/maintenance" -name '*.md' ! -name 'README.md' ! -name '_template.md' 2>/dev/null | sed 's|.*/||' | grep -oE '^[0-9]{4}-[0-9]{2}' | sort -u | wc -l)`,
    `  [ -z "$lastdate" ] && lastdate=null || lastdate=\\"$lastdate\\"`,
    `  MJ="{\\"reports\\":$reports,\\"lastReportDate\\":$lastdate,\\"months\\":$months}"`,
    `fi`,
    `if [ "$O" = 1 ]; then`,
    `  active=$(find "$P/openspec/changes" -mindepth 1 -maxdepth 1 -type d ! -name 'archive' 2>/dev/null | wc -l)`,
    `  archived=$(find "$P/openspec/changes/archive" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)`,
    `  specs=$(find "$P/openspec/specs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)`,
    `  OJ="{\\"active\\":$active,\\"archived\\":$archived,\\"specs\\":$specs}"`,
    `fi`,
    `printf '%s\\n' "{\\"knowledge\\":$KJ,\\"maintenance\\":$MJ,\\"openspec\\":$OJ}"`,
  ].join("\n");
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function intOr(value: unknown, fallback: number): number {
  const n = num(value);
  return n === null ? fallback : Math.trunc(n);
}

function parseKnowledgeStats(raw: unknown): KnowledgeStats | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const files = num((raw as Record<string, unknown>).files);
  if (files === null) return null;
  const r = raw as Record<string, unknown>;
  return {
    files,
    patterns: intOr(r.patterns, 0),
    architecture: intOr(r.architecture, 0),
    tooling: intOr(r.tooling, 0),
    troubleshooting: intOr(r.troubleshooting, 0),
    lastModified: intOr(r.lastModified, 0),
  };
}

function parseMaintenanceStats(raw: unknown): MaintenanceStats | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const reports = num(r.reports);
  if (reports === null) return null;
  const lastReportDate = typeof r.lastReportDate === "string" && r.lastReportDate !== "" ? r.lastReportDate : null;
  return { reports, lastReportDate, months: intOr(r.months, 0) };
}

function parseOpenSpecStats(raw: unknown): OpenSpecStats | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const active = num(r.active);
  if (active === null) return null;
  return { active, archived: intOr(r.archived, 0), specs: intOr(r.specs, 0) };
}

export function parseFeatureStats(stdout: string, features: ProjectFeatures): ProjectFeatureStats {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Malformed output: keep every enabled feature null.
  }
  const record = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  return {
    knowledge: features.knowledge ? parseKnowledgeStats(record.knowledge) : null,
    maintenance: features.maintenance ? parseMaintenanceStats(record.maintenance) : null,
    openspec: features.openspec ? parseOpenSpecStats(record.openspec) : null,
  };
}

export async function listProjects(command: ProjectCommand, workspaceRoot: string): Promise<string[]> {
  const root = JSON.stringify(`${workspaceRoot}/`);
  const result = await command(`find ${root} -maxdepth 1 -type d ! -path ${root} ! -name '.*' -exec basename {} \\; 2>/dev/null || true`, 10_000);
  if (result.exitCode !== 0 || !result.stdout) return [];
  return result.stdout.split("\n").filter(Boolean);
}

export async function checkFeature(
  command: ProjectCommand,
  workspaceRoot: string,
  name: string,
  markerCmd: string,
): Promise<boolean> {
  const r = await command(
    `test -e ${projectDir(workspaceRoot, name)}/${markerCmd} && echo yes`,
    5_000,
  );
  return r.stdout.trim() === "yes";
}

export async function collectProjectOverviews(
  command: ProjectCommand,
  workspaceRoot: string,
  settingsPath: string,
  disabledPath: string,
  toolStatus?: ProjectToolStatusProvider,
): Promise<ProjectOverview[]> {
  // settingsPath is part of the pinned read-path signature shared with the
  // agent query handler; the overview itself only needs the disabled list.
  void settingsPath;
  const names = await listProjects(command, workspaceRoot);
  const disabled = new Set(await readDisabledProjects(command, disabledPath));
  const projectRoots = names.map((name) => `${workspaceRoot}/${name}`);
  let leanCtxByRoot: Map<string, LeanCtxProjectStatus | null> | undefined;
  if (toolStatus?.probeLeanCtx !== undefined) {
    try {
      leanCtxByRoot = await toolStatus.probeLeanCtx(projectRoots);
    } catch {
      leanCtxByRoot = new Map(projectRoots.map((root) => [root, null]));
    }
  }
  const results = await Promise.allSettled(names.map(async (name) => {
    const feats = await Promise.all([
      checkFeature(command, workspaceRoot, name, "docs/knowledge/README.md"),
      checkFeature(command, workspaceRoot, name, "docs/knowledge/maintenance/README.md"),
      checkFeature(command, workspaceRoot, name, "openspec"),
      checkFeature(command, workspaceRoot, name, ".opencode/superpowers"),
    ]).then(([knowledge, maintenance, openspec, superpowers]) => ({ knowledge, maintenance, openspec, superpowers }));
    const anyFeature = feats.knowledge || feats.maintenance || feats.openspec || feats.superpowers;
    const [gitRemote, tools, stats] = await Promise.all([
      command(`cd ${projectDir(workspaceRoot, name)} && git remote get-url origin 2>/dev/null || true`, 10_000),
      toolStatus !== undefined ? toolStatus.probe(name).catch(() => undefined) : Promise.resolve(undefined),
      toolStatus !== undefined && anyFeature
        ? command(buildFeatureStatsCommand(projectDir(workspaceRoot, name)), 10_000)
            .then((r) => parseFeatureStats(r.stdout, feats))
        : Promise.resolve(null),
    ]);
    const overview: ProjectOverview = {
      name,
      features: feats,
      remote: gitRemote.stdout.trim() || null,
      disabled: disabled.has(name),
    };
    if (tools !== undefined) {
      overview.codegraph = tools.codegraph;
      if (leanCtxByRoot !== undefined) overview.leanctx = leanCtxByRoot.get(`${workspaceRoot}/${name}`) ?? null;
      if (stats !== null) overview.stats = stats;
    }
    return overview;
  }));
  const overviews: ProjectOverview[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      overviews.push(r.value);
    }
  }
  return overviews;
}
