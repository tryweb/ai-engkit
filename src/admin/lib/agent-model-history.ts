import { isRecord } from "./agent-model-config";
import type { AgentModelsDeps } from "./agent-model-types";

export type RecentRequestModel = {
  readonly agent: string;
  readonly modelID: string;
  readonly providerID: string;
  readonly completedAt: number;
};

export type RecentRequestModelsResult = {
  readonly models: readonly RecentRequestModel[];
  readonly truncated: boolean;
  readonly warning?: string;
};

function buildRecentRequestModelsScript(auth: string): string {
  const isV2 = process.env.OMO_ENABLED === "0";
  const messageUrl = isV2 ? `"$BASE/api/session/\${SESSION}/message"` : `"$BASE/session/\${SESSION}/message"`;
  const messageFilter = isV2
    ? `'[.data[]?
        | select(.type == "assistant" and (.error == null)
          and (.model.id | type == "string") and (.model.providerID | type == "string"))
        | {agent: (.agent // $agent), modelID: .model.id, providerID: .model.providerID,
           completedAt: ((.time.completed // .time.created // 0)
             | if type == "number" then . else (try (fromdateiso8601 * 1000) catch 0) end)}]
      | map(select(.agent | type == "string"))
      | if length == 0 then empty else max_by(.completedAt) end'`
    : `'[.[]?.info
        | select(.role == "assistant" and (.error == null)
          and (.modelID | type == "string") and (.providerID | type == "string"))
        | {agent: (.agent // $agent), modelID, providerID,
           completedAt: ((.time.completed // .time.created // 0)
             | if type == "number" then . else (try (fromdateiso8601 * 1000) catch 0) end)}]
      | map(select(.agent | type == "string"))
      | if length == 0 then empty else max_by(.completedAt) end'`;
  return `set -u
MAX_DIRECTORIES=64
MAX_PAGES_PER_DIRECTORY=50
MAX_SESSIONS=800
MAX_SECONDS=60
for f in ${"$HOME"}/.config/openchamber/managed-opencode/*.json; do
  [ -f "\$f" ] || continue
  pid=\$(jq -r '.pid' "\$f" 2>/dev/null)
  port=\$(jq -r '.port' "\$f" 2>/dev/null)
  [ -n "\$pid" ] && [ -n "\$port" ] || continue
  kill -0 "\$pid" 2>/dev/null || continue
  BASE="http://127.0.0.1:\${port}"
  WORKSPACE_ROOT="\${WORKSPACE_ROOT:-\$HOME/workspace}"
  START_SECONDS=\$(date +%s)
  umask 077
  SESSIONS_FILE=\$(mktemp /tmp/agent-model-sessions.XXXXXX)
  RESULTS_FILE=\$(mktemp /tmp/agent-model-results.XXXXXX)
  FOUND_FILE=\$(mktemp /tmp/agent-model-found.XXXXXX)
  ATTEMPTS_FILE=\$(mktemp /tmp/agent-model-attempts.XXXXXX)
  CURRENT_FILE=\$(mktemp /tmp/agent-model-current.XXXXXX)
  DIRECTORIES_FILE=\$(mktemp /tmp/agent-model-directories.XXXXXX)
  LIMITED_DIRECTORIES_FILE=\$(mktemp /tmp/agent-model-limited-directories.XXXXXX)
  TRUNCATED_FILE=\$(mktemp /tmp/agent-model-truncated.XXXXXX)
  WARNING_FILE=\$(mktemp /tmp/agent-model-warning.XXXXXX)
  cleanup() { rm -f "\$SESSIONS_FILE" "\$RESULTS_FILE" "\$FOUND_FILE" "\$ATTEMPTS_FILE" "\$CURRENT_FILE" "\$DIRECTORIES_FILE" "\$LIMITED_DIRECTORIES_FILE" "\$TRUNCATED_FILE" "\$WARNING_FILE"; }
  trap cleanup EXIT
  trap 'cleanup; exit 130' INT TERM
  : > "\$TRUNCATED_FILE"
  : > "\$WARNING_FILE"
  mark_truncated() {
    if [ ! -s "\$TRUNCATED_FILE" ]; then
      printf '%s' true > "\$TRUNCATED_FILE"
      printf '%s' "\$1" > "\$WARNING_FILE"
    fi
  }
  deadline_reached() {
    [ \$((\$(date +%s) - START_SECONDS)) -ge "\$MAX_SECONDS" ]
  }
  # lean-ctx: never rm workspace root; only mktemp files are cleanup targets.
  {
    printf '%s\\n' '' "\$WORKSPACE_ROOT"
    find "\$WORKSPACE_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print 2>/dev/null || true
    jq -r --arg prefix "\$WORKSPACE_ROOT/" '.projects[]?.path | select(type == "string" and startswith(\$prefix))' "\$HOME/.config/openchamber/settings.json" 2>/dev/null || true
  } | awk 'NF' | sort -u > "\$DIRECTORIES_FILE"
  DIRECTORY_COUNT=\$(wc -l < "\$DIRECTORIES_FILE")
  if [ "\$DIRECTORY_COUNT" -gt "\$MAX_DIRECTORIES" ]; then
    head -n "\$MAX_DIRECTORIES" "\$DIRECTORIES_FILE" > "\$LIMITED_DIRECTORIES_FILE"
    mark_truncated "directory limit reached"
  else
    cp "\$DIRECTORIES_FILE" "\$LIMITED_DIRECTORIES_FILE"
  fi
  while IFS= read -r DIRECTORY; do
    deadline_reached && { mark_truncated "scan deadline reached"; break; }
    PROJECT_NAME=\${DIRECTORY##*/}
    DISABLED_FILE="\$HOME/.config/openchamber/disabled-projects.json"
    if [ -n "\$PROJECT_NAME" ] && jq -e -r '.disabled[]? // empty' "\$DISABLED_FILE" 2>/dev/null | grep -Fqx "\$PROJECT_NAME"; then
      continue
    fi
    CURSOR=''
    PAGE_COUNT=0
    while :; do
      deadline_reached && { mark_truncated "scan deadline reached"; break; }
      if [ "\$PAGE_COUNT" -ge "\$MAX_PAGES_PER_DIRECTORY" ]; then
        mark_truncated "page limit reached"
        break
      fi
      PAGE_COUNT=\$((PAGE_COUNT + 1))
      if [ -n "\$CURSOR" ]; then
        RESPONSE=\$(curl -fsS -m 10 -H 'Authorization: Basic ${auth}' --get \\
          --data-urlencode "directory=\$DIRECTORY" --data-urlencode 'limit=100' \\
          --data-urlencode "cursor=\$CURSOR" "\$BASE/api/session" 2>/dev/null || true)
      elif [ -n "\$DIRECTORY" ]; then
        RESPONSE=\$(curl -fsS -m 10 -H 'Authorization: Basic ${auth}' --get \\
          --data-urlencode "directory=\$DIRECTORY" --data-urlencode 'limit=100' \\
          "\$BASE/api/session" 2>/dev/null || true)
      else
        RESPONSE=\$(curl -fsS -m 10 -H 'Authorization: Basic ${auth}' \\
          "\$BASE/api/session?limit=100" 2>/dev/null || true)
      fi
      [ -n "\$RESPONSE" ] || break
      printf '%s' "\$RESPONSE" | jq -c --arg scope "\$DIRECTORY" \\
        'if type == "array" then .[] else (.data // [])[] end
         | select(type == "object" and (.id | type == "string"))
         | . + {scope: \$scope}' >> "\$SESSIONS_FILE" 2>/dev/null || true
      if [ "\$(wc -l < "\$SESSIONS_FILE")" -ge "\$MAX_SESSIONS" ]; then
        mark_truncated "session limit reached"
        break
      fi
      NEXT=\$(printf '%s' "\$RESPONSE" | jq -r 'if type == "object" then (.cursor.next // empty) else empty end' 2>/dev/null || true)
      [ -n "\$NEXT" ] || break
      [ "\$NEXT" != "\$CURSOR" ] || break
      CURSOR="\$NEXT"
    done
  done < "\$LIMITED_DIRECTORIES_FILE"
  jq -s -r 'unique_by(.id)
    | sort_by(.time.updated // .time.created // 0) | reverse
    | .[] | select(.agent | type == "string") | [.id, .agent] | @tsv' "\$SESSIONS_FILE" |
  while IFS="$(printf '\\t')" read -r SESSION AGENT; do
    [ -n "\$SESSION" ] || continue
    deadline_reached && { mark_truncated "scan deadline reached"; break; }
    if [ "\$(grep -c . "\$ATTEMPTS_FILE" 2>/dev/null || true)" -ge "\$MAX_SESSIONS" ]; then
      mark_truncated "session scan limit reached"
      break
    fi
    grep -Fqx "\$AGENT" "\$FOUND_FILE" 2>/dev/null && continue
    ATTEMPTS=\$(grep -Fc "\$AGENT" "\$ATTEMPTS_FILE" 2>/dev/null || true)
    [ "\$ATTEMPTS" -le 20 ] || continue
    printf '%s\\n' "\$AGENT" >> "\$ATTEMPTS_FILE"
    OUT=\$(curl -fsS -m 10 -H 'Authorization: Basic ${auth}' \\
      ${messageUrl} 2>/dev/null || true)
    : > "\$CURRENT_FILE"
    printf '%s' "\$OUT" | jq -c --arg agent "\$AGENT" ${messageFilter} \\
      > "\$CURRENT_FILE" 2>/dev/null || true
    CURRENT=\$(cat "\$CURRENT_FILE" 2>/dev/null || true)
    if [ -n "\$CURRENT" ]; then
      printf '%s\\n' "\$CURRENT" >> "\$RESULTS_FILE"
      printf '%s\\n' "\$AGENT" >> "\$FOUND_FILE"
    fi
  done
  MODELS=\$(jq -s -c 'sort_by(.agent) | group_by(.agent) | map(max_by(.completedAt))' "\$RESULTS_FILE")
  TRUNCATED=\$(cat "\$TRUNCATED_FILE")
  WARNING=\$(cat "\$WARNING_FILE")
  jq -cn --argjson models "\$MODELS" --argjson truncated "\${TRUNCATED:-false}" --arg warning "\$WARNING" \\
    '{models: \$models, truncated: \$truncated} + (if \$warning == "" then {} else {warning: \$warning} end)'
  exit 0
done
printf '%s\n' '{"models":[],"truncated":false}'
exit 0`;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function parseRecentRequestModels(stdout: string): RecentRequestModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (isRecord(parsed) && Array.isArray(parsed.models)) parsed = parsed.models;
  if (!Array.isArray(parsed)) return [];

  const latest = new Map<string, RecentRequestModel>();
  for (const value of parsed) {
    if (!isRecord(value)) continue;
    if (typeof value.agent !== "string" || typeof value.modelID !== "string" || typeof value.providerID !== "string") continue;
    const candidate: RecentRequestModel = {
      agent: value.agent,
      modelID: value.modelID,
      providerID: value.providerID,
      completedAt: parseTimestamp(value.completedAt),
    };
    const previous = latest.get(candidate.agent);
    if (previous === undefined || candidate.completedAt >= previous.completedAt) latest.set(candidate.agent, candidate);
  }
  return [...latest.values()];
}

export function parseRecentRequestModelsResult(stdout: string): RecentRequestModelsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { models: [], truncated: false };
  }
  const models = parseRecentRequestModels(stdout);
  if (!isRecord(parsed)) return { models, truncated: false };
  return {
    models,
    truncated: parsed.truncated === true,
    ...(typeof parsed.warning === "string" && parsed.warning.length > 0 ? { warning: parsed.warning } : {}),
  };
}

export function createAgentModelHistoryClient(deps: Pick<AgentModelsDeps, "exec">) {
  async function fetchRecentRequestModels(password: string): Promise<RecentRequestModelsResult> {
    const auth = Buffer.from(`opencode:${password}`).toString("base64");
    const result = await deps.exec(buildRecentRequestModelsScript(auth), 90_000);
    return result.exitCode === 0 ? parseRecentRequestModelsResult(result.stdout) : {
      models: [],
      truncated: true,
      warning: "history collection command failed",
    };
  }

  return { fetchRecentRequestModels };
}
