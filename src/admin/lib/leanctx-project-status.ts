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

export function buildLeanCtxRepairCommand(projectRoot?: string): string {
  const projectFilter = projectRoot === undefined ? "true" : `.root == ${JSON.stringify(projectRoot)}`;
  return [
    `base="$HOME/.local/share/lean-ctx"`,
    `knowledge="$base/knowledge"`,
    `quarantine="$base/quarantine"`,
    `mkdir -p "$quarantine"`,
    `tmp="\${TMPDIR:-/tmp}/leanctx-repair-$$.jsonl"`,
    `moves="$tmp.moves"`,
    `moved="$tmp.moved"`,
    `moved_dirs="$tmp.moved_dirs"`,
    `refused="$tmp.refused"`,
    `: > "$tmp"`,
    `: > "$moved"`,
    `: > "$moved_dirs"`,
    `: > "$refused"`,
    `for f in "$knowledge"/*/knowledge.json; do`,
    `  [ -f "$f" ] || continue`,
    `  dir=$(basename "$(dirname "$f")")`,
    `  jq -c --arg dir "$dir" '{dir:$dir,root:.project_root,hash:.project_hash,updated_at:.updated_at,facts:(if (.facts|type)=="array" then (.facts|length) else 0 end),valid:(.project_hash==$dir and (.facts|type)=="array" and (.patterns|type)=="array" and (.history|type)=="array")}' "$f" >> "$tmp" 2>/dev/null || jq -cn --arg dir "$dir" '{dir:$dir,root:null,hash:null,updated_at:null,facts:0,valid:false}' >> "$tmp"`,
    `done`,
    `jq -sr '[.[] | select((.root|type)!="string" or .root=="") | .dir] | .[]' "$tmp" > "$moves"`,
    `jq -sr '[.[] | select((.root|type)=="string" and .root!="") | select(${projectFilter})] | group_by(.root)[] | if length > 1 then (sort_by(.updated_at // "") | .[:-1][]) | .dir else empty end' "$tmp" >> "$moves"`,
    `jq -sr '[.[] | select((.root|type)=="string" and .root!="") | select(${projectFilter})] | group_by(.root) | map({root:.[0].root,before:(if length==1 and .[0].valid then "available" else "unknown" end),count:length,dirs:map(.dir),valid:map(.valid)})' "$tmp" > "$tmp.roots"`,
    `retry=false`,
    `while IFS= read -r dir; do`,
    `  [ -n "$dir" ] || continue`,
    `  hash=$(jq -sr --arg dir "$dir" '[.[] | select(.dir==$dir)][0].hash | if type=="string" then . else "" end' "$tmp")`,
    `  if [ "$hash" != "$dir" ]; then printf '%s\n' "$dir" >> "$refused"; retry=true; continue; fi`,
    `  stamp=$(date -u +%Y%m%dT%H%M%SZ)`,
    `  dest="$quarantine/$stamp-$hash"`,
    `  if [ -e "$dest" ]; then dest="$dest-$$"; fi`,
    `  if mv "$knowledge/$dir" "$dest"; then printf '%s\n' "$(basename "$dest")" >> "$moved"; printf '%s\n' "$dir" >> "$moved_dirs"; else printf '%s\n' "$dir" >> "$refused"; retry=true; fi`,
    `done < "$moves"`,
    `after=$(jq -c --argjson moved "$(jq -Rsc 'split("\\n") | map(select(length>0))' "$moved_dirs")" --argjson retry "$retry" '[.[] | . as $r | ($r.dirs - $moved) as $remaining | {root:$r.root,before:$r.before,after:(if ($remaining|length)==1 and $r.valid[($r.dirs|index($remaining[0]))] == true and $retry==false then "available" else "unknown" end)}]' "$tmp.roots")`,
    `jq -cn --argjson before "$(jq -c '[.[] | {root,before}]' "$tmp.roots")" --argjson after "$after" --argjson quarantined "$(jq -Rsc 'split("\\n") | map(select(length>0))' "$moved")" --argjson refused "$(jq -Rsc 'split("\\n") | map(select(length>0))' "$refused")" --argjson retry "$retry" '{roots:[range(0; $before|length) as $i | {root:$before[$i].root,before:$before[$i].before,after:$after[$i].after}],quarantined:$quarantined,refused:$refused,retry:$retry}'`,
    `rm -f "$tmp" "$moves" "$moved" "$moved_dirs" "$refused" "$tmp.roots"`,
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
