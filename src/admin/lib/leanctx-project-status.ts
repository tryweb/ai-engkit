/**
 * Read-only per-project LeanCTX knowledge projection.
 *
 * Admin has no LeanCTX data volume, so the projection is produced inside
 * ai-dev by one bounded scan over `~/.local/share/lean-ctx/knowledge/*\/knowledge.json`.
 * The scan matches the requested projects by exact canonical `project_root`
 * and emits only normalized counts, a timestamp, and a state — never raw
 * facts, provenance, paths, hashes, or command errors. The opaque LeanCTX
 * project hash is validated (non-empty and equal to the store directory
 * basename) but never recomputed.
 */

/** Normalized wire shape of the per-project `leanctx` overview field. */
export interface LeanCtxProjectStatus {
  state: "available" | "empty";
  activeFacts: number;
  archivedFacts: number;
  patterns: number;
  history: number;
  lastUpdated: string | null;
}

/** Heredoc delimiter for the requested project roots (validated to never appear as a root). */
export const LEANCTX_PROJECT_ROOTS_EOF = "LEANCTX_PROJECT_ROOTS_EOF";

/** A fresh zeroed `empty` projection (all counts zero, no timestamp). */
export function emptyLeanCtxProjectStatus(): LeanCtxProjectStatus {
  return { state: "empty", activeFacts: 0, archivedFacts: 0, patterns: 0, history: 0, lastUpdated: null };
}

/**
 * A root is scannable only when it is non-empty, never equals the heredoc
 * delimiter, and carries no line/record separators that could escape the
 * heredoc body. Unsafe roots are reported as unknown instead of interpolated.
 */
export function isScannableProjectRoot(root: string): boolean {
  return root.length > 0 && root !== LEANCTX_PROJECT_ROOTS_EOF && !/[\n\r\0]/.test(root);
}

/**
 * Build the single batched in-container shell script.
 *
 * Security: roots are embedded only inside a quoted heredoc body, so shell
 * metacharacters are literal; roots are validated by
 * `isScannableProjectRoot` before this is called. The script performs
 * read-only `jq` reads, and its output contains only the normalized
 * projection (`state`, counts, `lastUpdated`) — no paths or hashes.
 */
export function buildLeanCtxProjectScanCommand(projectRoots: readonly string[]): string {
  const record = [
    `{dir:$dir,`,
    `root:(if (.project_root|type)=="string" then .project_root else null end),`,
    `hash:(if (.project_hash|type)=="string" then .project_hash else "" end),`,
    `updated_at:(if (.updated_at|type)=="string" then .updated_at else null end),`,
    `f:(if (.facts|type)=="array" then (.facts|length) else null end),`,
    `a:(if (.facts|type)=="array" then ([.facts[]|select(.valid_until==null)]|length) else null end),`,
    `p:(if (.patterns|type)=="array" then (.patterns|length) else null end),`,
    `y:(if (.history|type)=="array" then (.history|length) else null end)}`,
  ].join("");
  return [
    `base="$HOME/.local/share/lean-ctx"`,
    `tmp="\${TMPDIR:-/tmp}/leanctx-project-scan-$$.jsonl"`,
    `: > "$tmp"`,
    `unreadable=0`,
    `for f in "$base"/knowledge/*/knowledge.json; do`,
    `  [ -f "$f" ] || continue`,
    `  dir=$(basename "$(dirname "$f")")`,
    `  if rec=$(jq -c --arg dir "$dir" '${record}' "$f" 2>/dev/null); then`,
    `    printf '%s\\n' "$rec" >> "$tmp"`,
    `  else`,
    `    unreadable=1`,
    `  fi`,
    `done`,
    `bad=$(jq -s '[.[]|select((.root|type)!="string" or .root=="")]|length' "$tmp" 2>/dev/null || printf '0')`,
    `case $bad in ''|*[!0-9]*) bad=0;; esac`,
    `[ "$bad" -gt 0 ] && unreadable=1`,
    `while IFS= read -r root; do`,
    `  [ -n "$root" ] || continue`,
    `  jq -c -s --arg root "$root" --argjson unreadable "$unreadable" '`,
    `    [ .[] | select(.root == $root) ] as $m`,
    `    | if ($m|length) == 0 then (if $unreadable == 1 then {state:"unknown"} else {state:"empty"} end)`,
    `      elif ($m|length) > 1 then {state:"unknown"}`,
    `      else ($m[0] | if (.hash != "" and .hash == .dir and .f != null and .a != null and .p != null and .y != null and .f >= 0 and .a >= 0 and .p >= 0 and .y >= 0 and .a <= .f) then {state:"available",activeFacts:.a,archivedFacts:(.f-.a),patterns:.p,history:.y,lastUpdated:.updated_at} else {state:"unknown"} end)`,
    `      end' "$tmp"`,
    `done <<'${LEANCTX_PROJECT_ROOTS_EOF}'`,
    ...projectRoots,
    LEANCTX_PROJECT_ROOTS_EOF,
    `rm -f "$tmp"`,
  ].join("\n");
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Parse one normalized scan line; anything unexpected (including `unknown`) → null. */
export function parseLeanCtxProjectStatusLine(line: string): LeanCtxProjectStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.state === "empty") return emptyLeanCtxProjectStatus();
  if (record.state !== "available") return null;
  const activeFacts = nonNegativeInt(record.activeFacts);
  const archivedFacts = nonNegativeInt(record.archivedFacts);
  const patterns = nonNegativeInt(record.patterns);
  const history = nonNegativeInt(record.history);
  if (activeFacts === null || archivedFacts === null || patterns === null || history === null) return null;
  const lastUpdated = typeof record.lastUpdated === "string" && record.lastUpdated !== "" ? record.lastUpdated : null;
  return { state: "available", activeFacts, archivedFacts, patterns, history, lastUpdated };
}

/**
 * Map scan stdout (one JSON line per requested root, in order) back to roots.
 * A line-count mismatch means malformed output → null (whole scan unknown).
 */
export function parseLeanCtxProjectScan(
  stdout: string,
  projectRoots: readonly string[],
): Map<string, LeanCtxProjectStatus | null> | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length !== projectRoots.length) return null;
  const result = new Map<string, LeanCtxProjectStatus | null>();
  for (let index = 0; index < projectRoots.length; index += 1) {
    result.set(projectRoots[index], parseLeanCtxProjectStatusLine(lines[index]));
  }
  return result;
}

/** Heredoc delimiter for the repair target roots (validated to never appear as a root). */
export const LEANCTX_REPAIR_TARGETS_EOF = "LEANCTX_REPAIR_TARGETS_EOF";

/** Structured result emitted by the repair script (stdout JSON). */
export interface LeanCtxRepairResult {
  quarantined: string[];
  refused: string[];
  retry: boolean;
}

/**
 * Build the duplicate-store quarantine script.
 *
 * Policy (never delete, never merge — diagnose and isolate only):
 * - duplicate `project_root` hits keep the `updated_at` newest; the rest move
 *   to `$base/quarantine/<timestamp>-<hash>/` via `mv`;
 * - empty or non-string `project_root` records are always isolated;
 * - a hash guard allows a move only when `project_hash == directory basename`;
 *   otherwise the directory is refused and `retry` is true;
 * - unreadable `knowledge.json` files cannot satisfy the guard and are refused.
 *
 * Roots travel inside a quoted heredoc body (same mechanism as the scan), so
 * shell metacharacters stay literal; callers must still pass only
 * `isScannableProjectRoot` roots. An empty filter repairs every distinct root
 * plus the global empty-root pollution. Output is one JSON line:
 * `{"quarantined":[...],"refused":[...],"retry":bool}` — directory basenames
 * only, never paths, roots, or facts.
 */
export function buildLeanCtxRepairCommand(projectRoots?: readonly string[]): string {
  const targets = (projectRoots ?? []).filter(isScannableProjectRoot);
  const filterProvided = targets.length > 0;
  return [
    `base="$HOME/.local/share/lean-ctx"`,
    `qbase="$base/quarantine"`,
    `tmp="\${TMPDIR:-/tmp}/leanctx-repair-$$.jsonl"`,
    `ttargets="\${TMPDIR:-/tmp}/leanctx-repair-targets-$$.txt"`,
    `qtrack="\${TMPDIR:-/tmp}/leanctx-repair-q-$$.txt"`,
    `rtrack="\${TMPDIR:-/tmp}/leanctx-repair-r-$$.txt"`,
    `: > "$tmp"; : > "$ttargets"; : > "$qtrack"; : > "$rtrack"`,
    `for f in "$base"/knowledge/*/knowledge.json; do`,
    `  [ -f "$f" ] || continue`,
    `  dir=$(basename "$(dirname "$f")")`,
    `  if rec=$(jq -c --arg dir "$dir" '{dir:$dir,root:(if (.project_root|type)=="string" then .project_root else null end),hash:(if (.project_hash|type)=="string" then .project_hash else "" end),updated_at:(if (.updated_at|type)=="string" then .updated_at else "" end)}' "$f" 2>/dev/null); then`,
    `    printf '%s\\n' "$rec" >> "$tmp"`,
    `  else`,
    `    printf '%s\\n' "$dir" >> "$rtrack"`,
    `  fi`,
    `done`,
    ...(filterProvided
      ? [
          `cat >> "$ttargets" <<'${LEANCTX_REPAIR_TARGETS_EOF}'`,
          ...targets,
          LEANCTX_REPAIR_TARGETS_EOF,
        ]
      : [
          `jq -s -r '[.[] | select((.root|type)=="string" and .root!="") | .root] | unique[]' "$tmp" 2>/dev/null > "$ttargets" || : > "$ttargets"`,
        ]),
    `ts=$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%Y%m%dT%H%M%S)`,
    `ts="$ts-$$"`,
    `mkdir -p "$qbase" 2>/dev/null || true`,
    `jq -s -r '[.[] | select((.root|type)!="string" or .root=="") | .dir] | unique | .[]' "$tmp" 2>/dev/null | while IFS= read -r d; do`,
    `  [ -n "$d" ] || continue`,
    `  h=$(jq -s -r --arg dir "$d" '[.[] | select(.dir==$dir)][0] | .hash // ""' "$tmp" 2>/dev/null || printf '')`,
    `  if [ -n "$h" ] && [ "$h" = "$d" ]; then`,
    `    dest="$qbase/$ts-$d"`,
    `    if mv "$base/knowledge/$d" "$dest" 2>/dev/null; then printf '%s\\n' "$d" >> "$qtrack"; else printf '%s\\n' "$d" >> "$rtrack"; fi`,
    `  else`,
    `    printf '%s\\n' "$d" >> "$rtrack"`,
    `  fi`,
    `done`,
    `while IFS= read -r root; do`,
    `  [ -n "$root" ] || continue`,
    `  count=$(jq -s --arg root "$root" '[.[] | select(.root==$root)] | length' "$tmp" 2>/dev/null || printf '0')`,
    `  case $count in ''|*[!0-9]*) count=0;; esac`,
    `  if [ "$count" -gt 1 ]; then`,
    `    ordered=$(jq -s -r --arg root "$root" '[.[] | select(.root==$root)] | sort_by(.updated_at) | reverse | .[].dir' "$tmp" 2>/dev/null || true)`,
    `    first=1`,
    `    for d in $ordered; do`,
    `      if [ "$first" = 1 ]; then first=0; continue; fi`,
    `      h=$(jq -s -r --arg dir "$d" '[.[] | select(.dir==$dir)][0] | .hash // ""' "$tmp" 2>/dev/null || printf '')`,
    `      if [ -n "$h" ] && [ "$h" = "$d" ]; then`,
    `        dest="$qbase/$ts-$d"`,
    `        if mv "$base/knowledge/$d" "$dest" 2>/dev/null; then printf '%s\\n' "$d" >> "$qtrack"; else printf '%s\\n' "$d" >> "$rtrack"; fi`,
    `      else`,
    `        printf '%s\\n' "$d" >> "$rtrack"`,
    `      fi`,
    `    done`,
    `  fi`,
    `done < "$ttargets"`,
    `qjson=$(jq -R -s 'split("\\n") | map(select(length>0)) | unique' "$qtrack" 2>/dev/null || printf '[]')`,
    `rjson=$(jq -R -s 'split("\\n") | map(select(length>0)) | unique' "$rtrack" 2>/dev/null || printf '[]')`,
    `rlen=$(printf '%s' "$rjson" | jq 'length' 2>/dev/null || printf '1')`,
    `retry=false`,
    `case $rlen in ''|*[!0-9]*) retry=true;; *) [ "$rlen" -gt 0 ] && retry=true;; esac`,
    `printf '{"quarantined":%s,"refused":%s,"retry":%s}\\n' "$qjson" "$rjson" "$retry"`,
    `rm -f "$tmp" "$ttargets" "$qtrack" "$rtrack"`,
  ].join("\n");
}

/** Parse the repair script stdout; anything unexpected → null. */
export function parseLeanCtxRepairResult(stdout: string): LeanCtxRepairResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.quarantined) || !record.quarantined.every((v): v is string => typeof v === "string")) return null;
  if (!Array.isArray(record.refused) || !record.refused.every((v): v is string => typeof v === "string")) return null;
  if (typeof record.retry !== "boolean") return null;
  return { quarantined: [...record.quarantined], refused: [...record.refused], retry: record.retry };
}
