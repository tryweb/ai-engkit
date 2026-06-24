#!/usr/bin/env bash
set -euo pipefail

REPO="${GH_REPO:-tryweb/ai-engkit}"
PARALLEL="${VULN_PARALLEL:-8}"
MAX_RETRIES="${VULN_RETRY:-3}"

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo " * $*"; }
ok()   { echo " + $*"; }
warn() { echo " ! $*"; }

alerts() {
  local filter="$1"
  gh api "repos/${REPO}/code-scanning/alerts" \
    --paginate \
    --jq "[.[] | select(.state == \"open\") | ${filter}]" \
    2>/dev/null | jq -s 'add'
}

cmd_list() {
  local total
  total=$(alerts '.number' | jq 'length')
  info "Open alerts: ${total}"
  if [[ "$total" -gt 0 ]]; then
    alerts '{path: .most_recent_instance.location.path, rule: .rule.id, severity: .rule.security_severity_level}' \
      | jq -r '
          group_by(.path)
          | sort_by(length) | reverse[]
          | .[0].path + " (" + (length|tostring) + ") " + ([.[].severity] | unique | join(","))
        '
  fi
}

cmd_count() {
  alerts '.number' | jq 'length'
}

cmd_dismiss() {
  local reason="${1:-won t fix}"
  local comment="${2:-Container image scan Grype accepted risk for pinned versions}"

  info "Fetching open alert numbers..."
  local tmp_numbers
  tmp_numbers=$(mktemp /tmp/vuln-numbers-XXXXXX.json)
  alerts '.number' > "$tmp_numbers"
  local total
  total=$(jq 'length' "$tmp_numbers")
  if [[ "$total" -eq 0 ]]; then
    ok "No open alerts to dismiss."
    rm -f "$tmp_numbers"
    return 0
  fi

  info "Dismissing ${total} alerts"
  local tmp_list
  tmp_list=$(mktemp /tmp/vuln-list-XXXXXX.txt)
  jq -r '.[]' "$tmp_numbers" > "$tmp_list"
  rm -f "$tmp_numbers"

  local tmp_out
  tmp_out=$(mktemp /tmp/vuln-out-XXXXXX.txt)

  export REPO MAX_RETRIES reason comment

  xargs -P "$PARALLEL" -I {} bash -c '
    n="$1"
    r=3
    while [[ "$r" -gt 0 ]]; do
      r=$((r - 1))
      s=$(gh api -X PATCH "repos/${REPO}/code-scanning/alerts/${n}" \
        -f state="dismissed" \
        -f dismissed_reason="$reason" \
        -f dismissed_comment="$comment" \
        --jq ".state" 2>/dev/null || echo "FAILED")
      if [[ "$s" == "dismissed" ]]; then
        echo "OK:${n}"
        exit 0
      elif [[ "$s" == "FAILED" ]]; then
        s2=$(gh api "repos/${REPO}/code-scanning/alerts/${n}" --jq ".state" 2>/dev/null || echo "unknown")
        if [[ "$s2" == "dismissed" ]]; then
          echo "SKIP:${n}"
          exit 0
        fi
        [[ "$r" -gt 0 ]] && sleep $(( (3 - r) * 2 ))
      else
        echo "OK:${n}"
        exit 0
      fi
    done
    echo "FAIL:${n}"
    exit 1
  ' _ {} < "$tmp_list" > "$tmp_out" 2>/dev/null || true

  local ok_count=0 skip_count=0 fail_count=0
  while IFS= read -r line; do
    case "$line" in
      OK:*)   ok_count=$((ok_count + 1)) ;;
      SKIP:*) skip_count=$((skip_count + 1)) ;;
      FAIL:*) fail_count=$((fail_count + 1)) ;;
    esac
  done < "$tmp_out"
  rm -f "$tmp_list" "$tmp_out"

  echo ""
  ok "Dismissed: ${ok_count}"
  if [[ "$skip_count" -gt 0 ]]; then warn "Skipped already dismissed: ${skip_count}"; fi
  if [[ "$fail_count" -gt 0 ]]; then
    warn "Failed: ${fail_count}"
    warn "Run vuln-scan.sh verify"
    return 1
  fi
  ok "All alerts dismissed."
}

cmd_verify() {
  local remaining
  remaining=$(alerts '.number' | jq 'length')
  if [[ "$remaining" -eq 0 ]]; then
    ok "No open alerts."
    return 0
  else
    warn "${remaining} open alerts remain."
    alerts '{path: .most_recent_instance.location.path, rule: .rule.id, severity: .rule.security_severity_level}' \
      | jq -r '
          group_by(.path)
          | sort_by(length) | reverse[]
          | .[0].path + " (" + (length|tostring) + ") " + ([.[].severity] | unique | join(","))
        '
    return 1
  fi
}

main() {
  local cmd="${1:-}"
  if [[ -z "$cmd" ]]; then
    echo "Usage: vuln-scan.sh <list|count|dismiss|verify>" >&2
    exit 1
  fi
  if ! gh auth status 2>/dev/null | grep -q "Logged in"; then
    die "gh is not authenticated. Run gh auth login first."
  fi
  case "$cmd" in
    list)    cmd_list ;;
    count)   cmd_count ;;
    dismiss) shift; cmd_dismiss "$@" ;;
    verify)  cmd_verify ;;
    *)
      echo "Unknown command: $cmd" >&2
      exit 1
      ;;
  esac
}

main "$@"
