#!/usr/bin/env bash
set -uo pipefail

# ============================================================
# Host overlay-aware upgrade integration test
# Usage: ./test/test-overlay-host-upgrade.sh
#
# Exercises upgrade.sh with a fake docker/curl so the overlay workflow is
# verified without touching a real deployment:
#   - valid overlay: stage -> validate -> back up -> atomic switch -> recreate
#   - invalid overlay / missing admin mounts: refuse before replacing the base
#   - missing jq: refuse
#   - path confinement: refuse an overlay outside ./extensions
#   - no overlay: base-only behavior unchanged
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PASS=0
FAIL=0
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${NC} $1"; }

if [ ! -S /var/run/docker.sock ]; then
    echo "  ${YELLOW}SKIP${NC} overlay-host-upgrade: /var/run/docker.sock not present"
    exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
    echo "  ${YELLOW}SKIP${NC} overlay-host-upgrade: jq is required"
    exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"

BASE_YML='services:
  ai-dev:
    image: new-upstream
  ai-admin:
    volumes:
      - ./extensions:/opt/ai-engkit/extensions:ro
      - ./admin-data/upgrade-base.yml:/opt/ai-engkit/compose-upgrade-base.yml:rw
'

cat > "$BIN/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
log="${FAKE_DOCKER_LOG:-/dev/null}"
printf '%s\n' "$*" >> "$log" 2>/dev/null || true
case "${1:-}" in
  --version) echo "Docker version 29.0.0, build fake"; exit 0 ;;
  info) exit 0 ;;
  cp) exit 0 ;;
  exec) echo '{"added":0}'; exit 0 ;;
  images)
    if [[ " $* " == *" --format "* ]]; then echo "latest"; else echo "abc123def456"; fi
    exit 0 ;;
  image) echo "Total reclaimed space: 0B"; exit 0 ;;
  rmi) exit 0 ;;
  compose)
    joined=" $* "
    if [[ "$joined" == *" config "* ]]; then
      if [[ "$joined" == *" --no-consistency "* ]]; then
        [ -n "${FAKE_OVERLAY_JSON:-}" ] && printf '%s' "$FAKE_OVERLAY_JSON" || printf '%s' "$DEFAULT_OVERLAY_JSON"
      else
        [ -n "${FAKE_MERGED_JSON:-}" ] && printf '%s' "$FAKE_MERGED_JSON" || printf '%s' "$DEFAULT_MERGED_JSON"
      fi
      exit 0
    fi
    if [[ "$joined" == *" version "* ]]; then echo "Docker Compose version v2.30.0"; exit 0; fi
    if [[ "$joined" == *" ps "* ]]; then
      if [[ "$joined" == *" --format json "* ]]; then echo '[{"Status":"running"}]'; else echo "NAME STATUS"; fi
      exit 0
    fi
    if [[ "$joined" == *" up "* ]]; then exit 0; fi
    if [[ "$joined" == *" pull"* ]]; then exit 0; fi
    exit 0 ;;
  *) exit 0 ;;
esac
FAKE_DOCKER
chmod +x "$BIN/docker"

cat > "$BIN/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
url=""; dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "$dest" ] || exit 0
case "$url" in
  *docker-compose.yml)
    base="${FAKE_BASE_YML:-}"
    [ -n "$base" ] || base='services: {}'
    printf '%s' "$base" > "$dest" ;;
  *.env.example) printf '# noop\n' > "$dest" ;;
  *) : > "$dest" ;;
esac
exit 0
FAKE_CURL
chmod +x "$BIN/curl"

DEFAULT_OVERLAY_JSON='{"name":"ai-engkit","services":{"ai-dev":{"command":null,"entrypoint":null,"environment":{"OPENCHAMBER_OPENCODE_HOSTNAME":"0.0.0.0","OPENCHAMBER_OPENCODE_PORT":"4095"},"networks":{"ep-design_interop":null},"labels":{"owner":"domain"},"healthcheck":{"test":["CMD","true"]}}},"networks":{"ep-design_interop":{"external":true}}}'
DEFAULT_MERGED_JSON='{"name":"ai-engkit","services":{"ai-dev":{"image":"new-upstream"},"ai-admin":{"volumes":[{"type":"bind","source":"/host/extensions","target":"/opt/ai-engkit/extensions","read_only":true},{"type":"bind","source":"/host/admin-data/upgrade-base.yml","target":"/opt/ai-engkit/compose-upgrade-base.yml","read_only":false}]}},"networks":{}}'

make_install() {
  local d="$1" overlay_env="$2"
  mkdir -p "$d/extensions" "$d/admin-data"
  cp "$PROJECT_DIR/upgrade.sh" "$d/upgrade.sh"
  printf 'services:\n  ai-dev:\n    image: old-domain\n' > "$d/docker-compose.yml"
  printf 'services:\n  ai-dev:\n    image: prior-base\n' > "$d/admin-data/upgrade-base.yml"
  printf 'services:\n  ai-dev:\n    environment:\n      FOO: bar\n' > "$d/extensions/ep.yml"
  {
    printf 'BACKUP_RETENTION=5\nCHAMBER_PORT=8000\n'
    [ -n "$overlay_env" ] && printf 'AI_ENGKIT_COMPOSE_OVERLAY=%s\n' "$overlay_env"
  } > "$d/.env"
}

run_upgrade() {
  local d="$1"
  (
    cd "$d" || exit 1
    PATH="$BIN:$PATH" SKIP_SYSTEM_CHECK=1 UPGRADE_SELF_UPDATED=1 \
      FAKE_DOCKER_LOG="$d/docker.log" FAKE_BASE_YML="$BASE_YML" \
      DEFAULT_OVERLAY_JSON="$DEFAULT_OVERLAY_JSON" DEFAULT_MERGED_JSON="$DEFAULT_MERGED_JSON" \
      bash "$d/upgrade.sh" > "$d/out.log" 2>&1
  )
}

real_overlay() { realpath "$1/extensions/ep.yml"; }

echo "== Overlay-aware host upgrade integration =="

# ── Valid overlay: stage, validate, back up, switch, recreate ──
D="$WORK/valid"; make_install "$D" "ep.yml"
if run_upgrade "$D"; then
    pass "valid overlay: upgrade exits successfully"
else
    fail "valid overlay: upgrade failed ($(tail -3 "$D/out.log" | tr '\n' ' '))"
fi
printf '%s' "$BASE_YML" > "$WORK/expected-base.yml"
[ "$(cmp -s "$WORK/expected-base.yml" "$D/admin-data/upgrade-base.yml"; echo $?)" = "0" ] \
    && pass "valid overlay: staged base atomically installed" \
    || fail "valid overlay: staged base not installed ($(diff "$WORK/expected-base.yml" "$D/admin-data/upgrade-base.yml" 2>&1 | head -5 | tr '\n' ' '))"
[ ! -e "$D/admin-data/upgrade-base.yml.staging" ] \
    && pass "valid overlay: staging file removed" \
    || fail "valid overlay: staging file left behind"
[ "$(cat "$D/docker-compose.yml")" = "services:
  ai-dev:
    image: old-domain" ] \
    && pass "valid overlay: domain-owned docker-compose.yml untouched" \
    || fail "valid overlay: docker-compose.yml was overwritten"

OV="$(real_overlay "$D")"
grep -F -- "--no-consistency" "$D/docker.log" | grep -Fq "$OV" \
    && pass "valid overlay: overlay-only config validated with --no-consistency" \
    || fail "valid overlay: overlay-only validation call missing"
grep -F -- "up -d --force-recreate ai-admin ai-dev" "$D/docker.log" | grep -Fq -- "--project-directory $D" \
    && pass "valid overlay: recreate uses the installation-root project directory" \
    || fail "valid overlay: recreate missing project directory"
grep -F -- "up -d --force-recreate ai-admin ai-dev" "$D/docker.log" | grep -Fq -- "-f ./admin-data/upgrade-base.yml -f $OV" \
    && pass "valid overlay: recreate uses base + overlay" \
    || fail "valid overlay: recreate did not use base + overlay"

BACKUP="$(find "$D" -maxdepth 1 -type d -name 'backup_*' | head -1)"
[ -n "$BACKUP" ] && [ -f "$BACKUP/compose-upgrade-base.yml" ] && [ -f "$BACKUP/overlay/ep.yml" ] && [ -f "$BACKUP/overlay-reference.txt" ] && [ -f "$BACKUP/.env" ] \
    && pass "valid overlay: effective inputs backed up before mutation" \
    || fail "valid overlay: backup incomplete"
[ "$(stat -c '%a' "$BACKUP" 2>/dev/null)" = "700" ] \
    && pass "valid overlay: backup directory is mode 0700" \
    || fail "valid overlay: backup directory mode is not 0700"

# ── Invalid overlay is rejected before replacing the base ──
D="$WORK/bad-overlay"; make_install "$D" "ep.yml"
ORIGINAL_BASE="$(cat "$D/admin-data/upgrade-base.yml")"
if FAKE_OVERLAY_JSON='{"services":{"ai-dev":{"container_name":"hacked"}}}' run_upgrade "$D"; then
    fail "invalid overlay: upgrade should have failed"
else
    pass "invalid overlay: upgrade refused"
fi
grep -q "protected\|unsupported ai-dev field" "$D/out.log" \
    && pass "invalid overlay: sanitized validation error reported" \
    || fail "invalid overlay: expected allowlist error"
[ "$(cat "$D/admin-data/upgrade-base.yml")" = "$ORIGINAL_BASE" ] \
    && pass "invalid overlay: active base unchanged" \
    || fail "invalid overlay: active base was modified"
grep -q "up -d" "$D/docker.log" \
    && fail "invalid overlay: containers were recreated" \
    || pass "invalid overlay: no recreate attempted"

# ── Any host bind mount is rejected; named volumes stay allowed ──
D="$WORK/bind-overlay"; make_install "$D" "ep.yml"
ORIGINAL_BASE="$(cat "$D/admin-data/upgrade-base.yml")"
if FAKE_OVERLAY_JSON='{"services":{"ai-dev":{"volumes":[{"type":"bind","source":"/","target":"/host"}]}}}' run_upgrade "$D"; then
    fail "bind overlay: upgrade should have failed"
else
    pass "bind overlay: host bind mount refused"
fi
grep -q "bind-mount" "$D/out.log" \
    && pass "bind overlay: sanitized bind rejection reported" \
    || fail "bind overlay: expected bind rejection error"
[ "$(cat "$D/admin-data/upgrade-base.yml")" = "$ORIGINAL_BASE" ] \
    && pass "bind overlay: active base unchanged" \
    || fail "bind overlay: active base was modified"
grep -q "up -d" "$D/docker.log" \
    && fail "bind overlay: containers were recreated" \
    || pass "bind overlay: no recreate attempted"

D="$WORK/socket-overlay"; make_install "$D" "ep.yml"
if FAKE_OVERLAY_JSON='{"services":{"ai-dev":{"volumes":[{"type":"bind","source":"/var/run/docker.sock","target":"/var/run/docker.sock"}]}}}' run_upgrade "$D"; then
    fail "socket overlay: upgrade should have failed"
else
    pass "socket overlay: docker socket bind refused"
fi
grep -q "must not mount the Docker socket" "$D/out.log" \
    && pass "socket overlay: explicit Docker socket error preserved" \
    || fail "socket overlay: expected explicit socket error"

D="$WORK/named-volume-overlay"; make_install "$D" "ep.yml"
if FAKE_OVERLAY_JSON='{"services":{"ai-dev":{"volumes":[{"type":"volume","source":"ep-data","target":"/data"}]}},"volumes":{"ep-data":null}}' run_upgrade "$D"; then
    pass "named-volume overlay: allowed"
else
    fail "named-volume overlay: named volume was rejected ($(tail -3 "$D/out.log" | tr '\n' ' '))"
fi

# ── Missing ai-admin mounts is rejected before replacing the base ──
D="$WORK/missing-mount"; make_install "$D" "ep.yml"
ORIGINAL_BASE="$(cat "$D/admin-data/upgrade-base.yml")"
if FAKE_MERGED_JSON='{"services":{"ai-dev":{"image":"x"},"ai-admin":{"volumes":[]}}}' run_upgrade "$D"; then
    fail "missing mounts: upgrade should have failed"
else
    pass "missing mounts: upgrade refused"
fi
grep -q "missing the ai-admin" "$D/out.log" \
    && pass "missing mounts: actionable mount error reported" \
    || fail "missing mounts: expected mount error"
[ "$(cat "$D/admin-data/upgrade-base.yml")" = "$ORIGINAL_BASE" ] \
    && pass "missing mounts: active base unchanged" \
    || fail "missing mounts: active base was modified"

# ── Missing jq is rejected ──
OUT="$(bash -c 'set +e; source "$1/upgrade.sh"; OVERLAY_ACTIVE=1; PATH=/nonexistent; require_jq_for_overlay' bash "$PROJECT_DIR" 2>&1)"
if printf '%s' "$OUT" | grep -q "jq is required"; then
    pass "missing jq: overlay upgrade refuses with actionable message"
else
    fail "missing jq: expected jq requirement message (got: $OUT)"
fi

# ── Path confinement rejects escapes and maps container paths ──
OUT="$(cd "$WORK/valid" && bash -c 'set +e; source "$1/upgrade.sh"; detect_overlay_configuration; OVERLAY_REF="../escape.yml"; overlay_resolve_host_path' bash "$PROJECT_DIR" 2>&1)"
printf '%s' "$OUT" | grep -q "must resolve beneath" \
    && pass "path confinement: parent-directory escape rejected" \
    || fail "path confinement: escape not rejected (got: $OUT)"

OUT="$(cd "$WORK/valid" && bash -c 'set +e; source "$1/upgrade.sh"; OVERLAY_REF="/etc/passwd"; overlay_resolve_host_path' bash "$PROJECT_DIR" 2>&1)"
printf '%s' "$OUT" | grep -q "must resolve beneath" \
    && pass "path confinement: absolute outside path rejected" \
    || fail "path confinement: absolute path not rejected (got: $OUT)"

D="$WORK/container-path"; make_install "$D" "/opt/ai-engkit/extensions/ep.yml"
HOST_MAPPED="$(cd "$D" && bash -c 'source "$1/upgrade.sh"; detect_overlay_configuration; overlay_resolve_host_path; printf "%s" "$OVERLAY_HOST"' bash "$PROJECT_DIR")"
[ "$HOST_MAPPED" = "$(real_overlay "$D")" ] \
    && pass "path confinement: container path maps to host ./extensions" \
    || fail "path confinement: container path mapped to '$HOST_MAPPED'"

# ── No overlay keeps the base-only behavior ──
D="$WORK/no-overlay"; make_install "$D" ""
if run_upgrade "$D"; then
    pass "no overlay: upgrade exits successfully"
else
    fail "no overlay: upgrade failed ($(tail -3 "$D/out.log" | tr '\n' ' '))"
fi
[ "$(cmp -s "$WORK/expected-base.yml" "$D/docker-compose.yml"; echo $?)" = "0" ] \
    && pass "no overlay: docker-compose.yml updated as before" \
    || fail "no overlay: docker-compose.yml not updated ($(diff "$WORK/expected-base.yml" "$D/docker-compose.yml" 2>&1 | head -5 | tr '\n' ' '))"
if grep -F -- "up -d --force-recreate" "$D/docker.log" | grep -Fq -- "--project-directory"; then
    fail "no overlay: base-only recreate gained overlay flags"
else
    pass "no overlay: base-only recreate leaves existing command unchanged"
fi

echo ""
echo "============================================"
echo " Overlay host upgrade: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "============================================"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
