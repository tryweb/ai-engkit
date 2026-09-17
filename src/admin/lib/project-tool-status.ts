import type { ProjectCommand } from "./projects-overview";
import {
  buildLeanCtxProjectScanCommand,
  isScannableProjectRoot,
  parseLeanCtxProjectScan,
  type LeanCtxProjectStatus,
} from "./leanctx-project-status";

/**
 * Per-project tool status probes for the Admin projects overview.
 *
 * The Admin container has no workspace or lean-ctx volumes, so every probe is
 * one `sh -c` command executed inside ai-dev through the injected
 * `ProjectCommand` (the same abstraction all other project operations use).
 *
 * Probes are read-only, time-bounded, cached with a TTL, and bounded in
 * concurrency; a failed probe yields `null` for that project and never blocks
 * the rest of the overview.
 */

export interface CodegraphIndexStatus {
  builtWithVersion?: string;
  builtWithExtractionVersion?: string;
  currentExtractionVersion?: string;
  reindexRecommended?: boolean;
  state?: string;
  pendingRefs?: string[];
}

/** Shape of `codegraph status --json <path>` (subset the Admin surfaces). */
export interface CodegraphStatus {
  initialized: boolean;
  version?: string;
  projectPath?: string;
  indexPath?: string;
  lastIndexed?: string | null;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  dbSizeBytes?: number;
  backend?: string;
  journalMode?: string;
  nodesByKind?: Record<string, number>;
  languages?: Record<string, number>;
  pendingChanges?: { added: number; modified: number; removed: number };
  worktreeMismatch?: boolean;
  index?: CodegraphIndexStatus;
}

/**
 * Site-level leanCTX statistics aggregated across every knowledge dir.
 * These remain the Dashboard aggregate; per-project fact-store metadata is
 * surfaced separately through `probeLeanCtx` and is never derived from this.
 */
export interface LeanCtxSiteStats {
  /** Number of projects with at least one stored memory fact. */
  projectsWithFacts: number;
  /** Total memory facts across all projects. */
  totalMemoryFacts: number;
  /** Distinct projects with agent activity within the last 24 hours. */
  activeProjects24h: number;
  /** Projects with a cached health score. */
  healthCoverage: number;
}

/**
 * LeanCTX token-savings telemetry surfaced from `lean-ctx gain --json` plus
 * `lean-ctx savings verify` (SHA-256 ledger chain check). All values are
 * aggregates; none include paths, prompts, or code.
 */
export interface GainStats {
  /** Gross tokens saved before stream overhead. */
  tokensSaved: number;
  /** Net tokens saved after injected stream overhead. */
  netTokensSaved: number;
  /** Effective compression percentage (0-100). */
  compressionPct: number;
  /** Gross USD saved by compression. */
  grossUsdSaved: number;
  /** USD saved after stream overhead. */
  netUsdSaved: number;
  /** USD cost of injected stream overhead (re-reads/bounce). */
  overheadUsd: number;
  /** Bounce tokens — savings lost to cache misses. */
  bounceTokens: number;
  /** SHA-256 savings ledger chain verified intact. */
  ledgerVerified: boolean;
  /** Number of ledger events in the verified chain. */
  ledgerEvents: number;
}

/** One task's value-gate assessment from `lean-ctx value-report --live --format json`. */
export interface ValueReportTask {
  taskId: string;
  model: string;
  totalTokens: number;
  costMicros: number;
  outcomeAccepted: boolean;
  cpaoMicros: number | null;
  evidence: string[];
  timestamp: string;
}

/** Value-gate telemetry surfaced from `lean-ctx value-report --live --format json`. */
export interface ValueReportStats {
  totalTasks: number;
  acceptedRate: number;
  cpaoMicros: number;
  etpaoTokens: number;
  totalCostMicros: number;
  savingsUsd: number;
  tasks: ValueReportTask[];
}

/** One task's Decision Loop evidence-chain entry from `lean-ctx prove --format json`. */
export interface ProveReportTask {
  taskId: string;
  query: string;
  profileIntent: string;
  profileComplexity: string;
  envelopeCreated: boolean;
  referencesFound: string[];
  bundleCandidates: number;
  receiptSources: string[];
  costMicros: number;
  outcomeAccepted: boolean;
  cpaoMicros: number;
  evidenceStages: string[];
}

/** Provenance ledger metadata embedded in the prove report. */
export interface ProvenanceLedger {
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
  itemCount: number;
}

/** Decision Loop evidence-chain telemetry surfaced from `lean-ctx prove --format json`. */
export interface ProveReportStats {
  acceptedRate: number;
  aggregateCpaoMicros: number;
  evidenceChainComplete: boolean;
  ledger: ProvenanceLedger;
  totalTasks: number;
  tasks: ProveReportTask[];
}

/** Period-scoped savings with tool breakdown from `lean-ctx savings --format json`. */
export interface SavingsReportStats {
  period: string;
  totalTasks: number;
  acceptedTasks: number;
  tokensProcessed: number;
  tokensSaved: number;
  compressionPercent: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  totalSavingsUsd: number;
  savingsPercent: number;
  cpaoUsd: number;
  etpao: number;
  topSources: Array<[string, number]>;
}

export interface ProjectToolStatus {
  codegraph: CodegraphStatus | null;
}

export interface ProjectToolStatusProvider {
  probe(name: string): Promise<ProjectToolStatus>;
  /**
   * One batched, cached, read-only LeanCTX scan keyed by canonical project
   * root. `null` means unknown (failure/malformed/duplicate/mismatch); a zeroed
   * `empty` object means no matching store. Optional for backward compatibility.
   */
  probeLeanCtx?(projectRoots: readonly string[]): Promise<Map<string, LeanCtxProjectStatus | null>>;
  probeSite(): Promise<LeanCtxSiteStats | null>;
  probeGain(): Promise<GainStats | null>;
  probeValueReport(): Promise<ValueReportStats | null>;
  probeProveReport(): Promise<ProveReportStats | null>;
  probeSavingsReport(): Promise<SavingsReportStats | null>;
  invalidate(name?: string): void;
}

export interface ToolStatusProbeOptions {
  command: ProjectCommand;
  workspaceRoot: string;
  /** Cache TTL in ms (default 300_000). */
  ttlMs?: number;
  /** Max probes in flight, clamped to [4, 8] (default 6). */
  concurrency?: number;
  /** Per-probe command timeout in ms (default 10_000). */
  probeTimeoutMs?: number;
}

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

interface CacheEntry {
  at: number;
  value: ProjectToolStatus;
}

/** Single-quote for POSIX sh: ' → '\'' (all other characters are literal). */
function shq(value: string): string {
  return "'" + value.replace(/'/g, `'\\''`) + "'";
}

function createSemaphore(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      return new Promise((resolve) => {
        if (active < max) {
          active += 1;
          resolve();
        } else {
          queue.push(resolve);
        }
      });
    },
    release(): void {
      active -= 1;
      const next = queue.shift();
      if (next) {
        active += 1;
        next();
      }
    },
  };
}

/**
 * Scans every leanCTX knowledge/registry/graph dir and prints site-level
 * aggregates: `projects_with_facts`, `total_memory_facts`, `active_24h`,
 * `health_coverage`. Missing dirs keep zero defaults and the command always
 * exits 0, so parsing decides the result (non-zero exit / thrown command
 * means the scan itself failed → null).
 */
const LEANCTX_SITE_SCRIPT = `
base="$HOME/.local/share/lean-ctx"
dirs=0
facts=0
for f in "$base"/knowledge/*/knowledge.json; do
  [ -f "$f" ] || continue
  dirs=$((dirs+1))
  n=$(jq -r '(.facts | length) // 0' "$f" 2>/dev/null || printf '0')
  case $n in ''|*[!0-9]*) n=0;; esac
  facts=$((facts+n))
done
active=0
reg="$base/agents/registry.json"
if [ -f "$reg" ]; then
  active=$(jq -r '[.agents[] | select(.last_active != null) | (.last_active | sub("\\\\.[0-9]+Z$"; "Z") | fromdateiso8601) | select(. >= (now - 86400))] | length' "$reg" 2>/dev/null || printf '0')
fi
health=0
for g in "$base"/graphs/*/health.json; do
  [ -f "$g" ] || continue
  health=$((health+1))
done
printf 'projects_with_facts=%s\\ntotal_memory_facts=%s\\nactive_24h=%s\\nhealth_coverage=%s\\n' "$dirs" "$facts" "$active" "$health"
`.trim();

function parseLeanCtxSiteStats(output: string): LeanCtxSiteStats | null {
  const projects = /^projects_with_facts=(\d+)$/m.exec(output);
  const facts = /^total_memory_facts=(\d+)$/m.exec(output);
  const active = /^active_24h=(\d+)$/m.exec(output);
  const health = /^health_coverage=(\d+)$/m.exec(output);
  if (!projects || !facts || !active || !health) return null;
  return {
    projectsWithFacts: Number(projects[1]),
    totalMemoryFacts: Number(facts[1]),
    activeProjects24h: Number(active[1]),
    healthCoverage: Number(health[1]),
  };
}

/** `gain --json` emits the full summary (model pricing, tasks, heatmap); only the aggregate subset is surfaced. */
const GAIN_JSON_COMMAND = "lean-ctx gain --json 2>/dev/null";
/** `savings verify` prints e.g. "OK — 5812 event(s), SHA-256 chain intact." */
const SAVINGS_VERIFY_COMMAND = "lean-ctx savings verify 2>/dev/null";
/** `value-report --live` emits task value-gate JSON; `--live` is required for JSON output when no persisted data exists. */
const VALUE_REPORT_COMMAND = "lean-ctx value-report --live --format json 2>/dev/null";
/** `prove` emits Decision Loop evidence-chain JSON. */
const PROVE_REPORT_COMMAND = "lean-ctx prove --format json 2>/dev/null";
/** `savings` emits period-scoped savings JSON with a tool breakdown. */
const SAVINGS_REPORT_COMMAND = "lean-ctx savings --format json 2>/dev/null";

function parseGainStats(gainOutput: string, verifyOutput: string): GainStats | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(gainOutput);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const summary = (parsed as Record<string, unknown>).summary;
  if (typeof summary !== "object" || summary === null) return null;
  const stream = (summary as Record<string, unknown>).stream_savings;
  if (typeof stream !== "object" || stream === null) return null;

  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const chainMatch = /(\d+) event\(s\),? SHA-256 chain intact/im.exec(verifyOutput);
  return {
    tokensSaved: num((summary as Record<string, unknown>).tokens_saved),
    netTokensSaved: num((summary as Record<string, unknown>).net_tokens_saved),
    compressionPct: num((summary as Record<string, unknown>).effective_compression_pct),
    grossUsdSaved: num((stream as Record<string, unknown>).gross_usd_saved),
    netUsdSaved: num((stream as Record<string, unknown>).net_usd_saved),
    overheadUsd: num((stream as Record<string, unknown>).overhead_usd),
    bounceTokens: num((stream as Record<string, unknown>).bounce_tokens),
    ledgerVerified: chainMatch !== null,
    ledgerEvents: chainMatch !== null ? Number(chainMatch[1]) : 0,
  };
}

function parseValueReportStats(output: string): ValueReportStats | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const bool = (value: unknown): boolean => value === true;
  const tasksRaw = Array.isArray(record.tasks) ? record.tasks : [];
  const tasks: ValueReportTask[] = tasksRaw.map((task) => {
    const t = (typeof task === "object" && task !== null ? task : {}) as Record<string, unknown>;
    const evidence = Array.isArray(t.evidence) ? t.evidence.filter((e): e is string => typeof e === "string") : [];
    const cpao = t.cpao_micros;
    return {
      taskId: str(t.task_id),
      model: str(t.model),
      totalTokens: num(t.total_tokens),
      costMicros: num(t.cost_micros),
      outcomeAccepted: bool(t.outcome_accepted),
      cpaoMicros: typeof cpao === "number" && Number.isFinite(cpao) ? cpao : null,
      evidence,
      timestamp: str(t.timestamp),
    };
  });
  return {
    totalTasks: num(record.total_tasks),
    acceptedRate: num(record.accepted_rate),
    cpaoMicros: num(record.cpao_micros),
    etpaoTokens: num(record.etpao_tokens),
    totalCostMicros: num(record.total_cost_micros),
    savingsUsd: num(record.savings_usd),
    tasks,
  };
}

function parseProveReportStats(output: string): ProveReportStats | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const bool = (value: unknown): boolean => value === true;
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((e): e is string => typeof e === "string") : []);
  const tasksRaw = Array.isArray(record.tasks) ? record.tasks : [];
  const tasks: ProveReportTask[] = tasksRaw.map((task) => {
    const t = (typeof task === "object" && task !== null ? task : {}) as Record<string, unknown>;
    return {
      taskId: str(t.task_id),
      query: str(t.query),
      profileIntent: str(t.profile_intent),
      profileComplexity: str(t.profile_complexity),
      envelopeCreated: bool(t.envelope_created),
      referencesFound: strings(t.references_found),
      bundleCandidates: num(t.bundle_candidates),
      receiptSources: strings(t.receipt_sources),
      costMicros: num(t.cost_micros),
      outcomeAccepted: bool(t.outcome_accepted),
      cpaoMicros: num(t.cpao_micros),
      evidenceStages: strings(t.evidence_stages),
    };
  });
  const ledgerRaw = (typeof record.evidence_ledger === "object" && record.evidence_ledger !== null ? record.evidence_ledger : {}) as Record<string, unknown>;
  const ledger: ProvenanceLedger = {
    createdAt: str(ledgerRaw.created_at),
    updatedAt: str(ledgerRaw.updated_at),
    schemaVersion: num(ledgerRaw.schema_version),
    itemCount: num(ledgerRaw.items),
  };
  return {
    acceptedRate: num(record.accepted_rate),
    aggregateCpaoMicros: num(record.aggregate_cpao_micros),
    evidenceChainComplete: bool(record.evidence_chain_complete),
    ledger,
    totalTasks: tasks.length,
    tasks,
  };
}

function parseSavingsReportStats(output: string): SavingsReportStats | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const topSourcesRaw = Array.isArray(record.top_sources) ? record.top_sources : [];
  const topSources: Array<[string, number]> = topSourcesRaw.flatMap((entry): Array<[string, number]> => {
    if (!Array.isArray(entry) || entry.length < 2) return [];
    const [name, count] = entry;
    if (typeof name !== "string" || typeof count !== "number" || !Number.isFinite(count)) return [];
    return [[name, count]];
  });
  return {
    period: str(record.period),
    totalTasks: num(record.total_tasks),
    acceptedTasks: num(record.accepted_tasks),
    tokensProcessed: num(record.tokens_processed),
    tokensSaved: num(record.tokens_saved),
    compressionPercent: num(record.compression_percent),
    estimatedCostUsd: num(record.estimated_cost_usd),
    actualCostUsd: num(record.actual_cost_usd),
    totalSavingsUsd: num(record.total_savings_usd),
    savingsPercent: num(record.savings_percent),
    cpaoUsd: num(record.cpao_usd),
    etpao: num(record.etpao),
    topSources,
  };
}

export function createToolStatusProbe(options: ToolStatusProbeOptions): ProjectToolStatusProvider {
  const { command, workspaceRoot } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const concurrency = Math.min(8, Math.max(4, options.concurrency ?? DEFAULT_CONCURRENCY));
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const cache = new Map<string, CacheEntry>();
  const semaphore = createSemaphore(concurrency);
  let siteCache: { at: number; value: LeanCtxSiteStats | null } | null = null;
  let leanCtxCache: { at: number; rootsKey: string; value: Map<string, LeanCtxProjectStatus | null> } | null = null;
  const leanCtxInFlight = new Map<string, Promise<Map<string, LeanCtxProjectStatus | null>>>();
  let gainCache: { at: number; value: GainStats | null } | null = null;
  let valueReportCache: { at: number; value: ValueReportStats | null } | null = null;
  let proveReportCache: { at: number; value: ProveReportStats | null } | null = null;
  let savingsReportCache: { at: number; value: SavingsReportStats | null } | null = null;

  async function probeCodegraph(projectRoot: string): Promise<CodegraphStatus | null> {
    try {
      const result = await command(`codegraph status --json ${shq(projectRoot)} 2>/dev/null`, probeTimeoutMs);
      if (result.exitCode !== 0) return null;
      const stdout = result.stdout.trim();
      if (stdout === "") return null;
      const parsed: unknown = JSON.parse(stdout);
      if (typeof parsed !== "object" || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (typeof record.initialized !== "boolean") return null;
      return record as unknown as CodegraphStatus;
    } catch {
      return null;
    }
  }

  async function runLeanCtxProjectScan(
    projectRoots: readonly string[],
  ): Promise<Map<string, LeanCtxProjectStatus | null>> {
    const result = new Map<string, LeanCtxProjectStatus | null>();
    try {
      const exec = await command(buildLeanCtxProjectScanCommand(projectRoots), probeTimeoutMs);
      const parsed = exec.exitCode === 0 ? parseLeanCtxProjectScan(exec.stdout, projectRoots) : null;
      for (const root of projectRoots) result.set(root, parsed?.get(root) ?? null);
    } catch {
      for (const root of projectRoots) result.set(root, null);
    }
    return result;
  }

  async function probeLeanCtx(
    projectRoots: readonly string[],
  ): Promise<Map<string, LeanCtxProjectStatus | null>> {
    const result = new Map<string, LeanCtxProjectStatus | null>();
    const scanRoots: string[] = [];
    for (const root of new Set(projectRoots)) {
      if (isScannableProjectRoot(root)) scanRoots.push(root);
      else result.set(root, null);
    }
    if (scanRoots.length === 0) return result;

    const rootsKey = JSON.stringify([...scanRoots].sort());
    const now = Date.now();
    if (leanCtxCache !== null && now - leanCtxCache.at < ttlMs && leanCtxCache.rootsKey === rootsKey) {
      for (const root of scanRoots) result.set(root, leanCtxCache.value.get(root) ?? null);
      return result;
    }

    let inFlight = leanCtxInFlight.get(rootsKey);
    if (inFlight === undefined) {
      const run = runLeanCtxProjectScan(scanRoots).then((value) => {
        leanCtxCache = { at: Date.now(), rootsKey, value };
        return value;
      });
      inFlight = run.finally(() => {
        leanCtxInFlight.delete(rootsKey);
      });
      leanCtxInFlight.set(rootsKey, inFlight);
    }
    const value = await inFlight;
    for (const root of scanRoots) result.set(root, value.get(root) ?? null);
    return result;
  }

  async function probeLeanCtxSite(): Promise<LeanCtxSiteStats | null> {
    const now = Date.now();
    if (siteCache !== null && now - siteCache.at < ttlMs) return siteCache.value;
    try {
      const result = await command(LEANCTX_SITE_SCRIPT, probeTimeoutMs);
      const value = result.exitCode === 0 ? parseLeanCtxSiteStats(result.stdout) : null;
      siteCache = { at: Date.now(), value };
      return value;
    } catch {
      siteCache = { at: Date.now(), value: null };
      return null;
    }
  }

  async function probeGain(): Promise<GainStats | null> {
    const now = Date.now();
    if (gainCache !== null && now - gainCache.at < ttlMs) return gainCache.value;
    try {
      const [gainResult, verifyResult] = await Promise.all([
        command(GAIN_JSON_COMMAND, probeTimeoutMs),
        command(SAVINGS_VERIFY_COMMAND, probeTimeoutMs),
      ]);
      const value = gainResult.exitCode === 0 ? parseGainStats(gainResult.stdout, verifyResult.stdout) : null;
      gainCache = { at: Date.now(), value };
      return value;
    } catch {
      gainCache = { at: Date.now(), value: null };
      return null;
    }
  }

  async function probeValueReport(): Promise<ValueReportStats | null> {
    const now = Date.now();
    if (valueReportCache !== null && now - valueReportCache.at < ttlMs) return valueReportCache.value;
    try {
      const result = await command(VALUE_REPORT_COMMAND, probeTimeoutMs);
      const value = result.exitCode === 0 ? parseValueReportStats(result.stdout) : null;
      valueReportCache = { at: Date.now(), value };
      return value;
    } catch {
      valueReportCache = { at: Date.now(), value: null };
      return null;
    }
  }

  async function probeProveReport(): Promise<ProveReportStats | null> {
    const now = Date.now();
    if (proveReportCache !== null && now - proveReportCache.at < ttlMs) return proveReportCache.value;
    try {
      const result = await command(PROVE_REPORT_COMMAND, probeTimeoutMs);
      const value = result.exitCode === 0 ? parseProveReportStats(result.stdout) : null;
      proveReportCache = { at: Date.now(), value };
      return value;
    } catch {
      proveReportCache = { at: Date.now(), value: null };
      return null;
    }
  }

  async function probeSavingsReport(): Promise<SavingsReportStats | null> {
    const now = Date.now();
    if (savingsReportCache !== null && now - savingsReportCache.at < ttlMs) return savingsReportCache.value;
    try {
      const result = await command(SAVINGS_REPORT_COMMAND, probeTimeoutMs);
      const value = result.exitCode === 0 ? parseSavingsReportStats(result.stdout) : null;
      savingsReportCache = { at: Date.now(), value };
      return value;
    } catch {
      savingsReportCache = { at: Date.now(), value: null };
      return null;
    }
  }

  return {
    async probe(name: string): Promise<ProjectToolStatus> {
      const now = Date.now();
      const entry = cache.get(name);
      if (entry !== undefined && now - entry.at < ttlMs) return entry.value;

      await semaphore.acquire();
      try {
        // Another probe for the same project may have filled the cache while
        // we were waiting for a concurrency slot.
        const fresh = cache.get(name);
        if (fresh !== undefined && Date.now() - fresh.at < ttlMs) return fresh.value;

        const projectRoot = `${workspaceRoot}/${name}`;
        const value: ProjectToolStatus = { codegraph: await probeCodegraph(projectRoot) };
        cache.set(name, { at: Date.now(), value });
        return value;
      } finally {
        semaphore.release();
      }
    },
    probeSite: probeLeanCtxSite,
    probeLeanCtx,
    probeGain,
    probeValueReport,
    probeProveReport,
    probeSavingsReport,
    invalidate(name?: string): void {
      if (name !== undefined) cache.delete(name);
      else cache.clear();
      siteCache = null;
      leanCtxCache = null;
      leanCtxInFlight.clear();
      gainCache = null;
      valueReportCache = null;
      proveReportCache = null;
      savingsReportCache = null;
    },
  };
}
