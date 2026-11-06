#!/usr/bin/env bash
# Run: bash test/test-agent-model-reconcile.sh
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/reconcile-agent-models.sh
source "${SCRIPT_DIR}/scripts/reconcile-agent-models.sh"
TEST_HOME="$(mktemp -d)"
HOME="$TEST_HOME"
trap 'rm -rf "$TEST_HOME"' EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "PASS $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert_eq() { # assert_eq <name> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2] got [$3])"; fi
}

unset NATIVE_AGENTS OPENCODE_SERVER_PASSWORD
skip_log="$(reconcile 2>&1)"
assert_eq "unset password skips reconciliation" \
  "0" "$?"
if [[ "$skip_log" == *"OPENCODE_SERVER_PASSWORD is not set; skipping startup reconciliation"* ]]; then
  ok "unset password logs skip"
else
  bad "unset password logs skip"
fi

if grep -q 'bun run /opt/admin/lib/agent-model-reconcile-cli.ts' \
  "${SCRIPT_DIR}/scripts/reconcile-agent-models.sh"; then
  ok "adapter references reconciler CLI"
else
  bad "adapter references reconciler CLI"
fi

if grep -q 'global/health' "${SCRIPT_DIR}/scripts/reconcile-agent-models.sh"; then
  ok "adapter waits for explicit lifecycle health"
else
  bad "adapter waits for explicit lifecycle health"
fi

if ! grep -q 'sync_native_overrides\|merge_native_agent_overrides\|.omo/omo.jsonc' \
  "${SCRIPT_DIR}/scripts/reconcile-agent-models.sh"; then
  ok "startup reconciliation does not sync legacy OMO overrides"
else
  bad "startup reconciliation does not sync legacy OMO overrides"
fi

if ! grep -q 'migrate-omo-to-routing-v1' "${SCRIPT_DIR}/entrypoint.d/02-init-config.sh"; then
  ok "native startup does not migrate OMO config"
else
  bad "native startup does not migrate OMO config"
fi

if grep -q 'if \[ "${OMO_ENABLED:-1}" != "0" \]; then' "${SCRIPT_DIR}/entrypoint.d/02-init-config.sh" \
  && grep -q 'sync_native_routing_heads.*routing.json' "${SCRIPT_DIR}/entrypoint.d/02-init-config.sh"; then
  ok "OMO_ENABLED=0 startup uses routing heads instead of the OMO bridge"
else
  bad "OMO_ENABLED=0 startup uses routing heads instead of the OMO bridge"
fi

NATIVE_AGENTS=1
native_skip_log="$(reconcile 2>&1)"
if [[ "$native_skip_log" == *"native agents enabled; automatic model reconciliation is disabled"* ]]; then
  ok "native startup skips automatic model reconciliation"
else
  bad "native startup skips automatic model reconciliation"
fi
unset NATIVE_AGENTS
OMO_ENABLED=0
native_skip_log="$(reconcile 2>&1)"
if [[ "$native_skip_log" == *"native agents enabled; automatic model reconciliation is disabled"* ]]; then
  ok "OMO_ENABLED=0 startup skips automatic model reconciliation"
else
  bad "OMO_ENABLED=0 startup skips automatic model reconciliation"
fi
unset OMO_ENABLED

echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
