---
name: check-updates
description: Check upstream versions, update Dockerfile pins, build, test, and commit changes
---

# Check & Update Versions Skill

One-shot workflow: check pinned versions against upstream, apply updates to Dockerfile,
rebuild the image, run integration tests, and commit.

## Triggers

- "Check for upstream updates"
- "Update Dockerfile versions"
- "Bump pinned dependencies"
- "Upgrade Docker/OpenCode/Playwright/..."
- "檢查上游版本"
- "更新相依套件版本"

---

## Workflow

### 0. Detect the release line

Determine which line this checkout follows before running anything:

```bash
git branch --show-current
```

- **The v2 line branch** (currently `v2`; its name is tracked by the
  `V2_BRANCH` repository variable — see
  `docs/knowledge/tooling/v2-branch-wiring.md`) → V2 mode: prefix every
  `check-versions.sh` invocation with `CHECK_V2_LINE=1`. In V2 mode the script
  resolves `OPENCODE_CLI_PACKAGE`/`OPENCODE_CLI_VERSION`/`OPENCHAMBER_VERSION`
  from `docker-compose.v2.yml` build args (the V2 line's effective pins) and
  **skips `OH_MY_OPENAGENT_VERSION` entirely** (D1: the v2 line carries no OMO
  runtime). Without the prefix you get V1 defaults, including two false
  positives (`opencode-ai` 1.x track, OMO bump) and one hidden true positive
  (`@opencode/cli` 2.x latest).
- **Anything else (`main`, v1.x)** → run as-is (V1 defaults).

### 1. Check Current Status

Run the version check script to see which pins are outdated:

```bash
.opencode/scripts/check-versions.sh outdated
```

- **exit 0** → nothing outdated. Inform the user and stop.
- **exit 1** → at least one pin has a newer upstream. Proceed.

If exit 1, also run the full table for the user to review:

```bash
.opencode/scripts/check-versions.sh check
```

### 2. Present Updates to User

Show the user which packages have newer versions available. Ask:

> "Found N outdated packages. Update all, pick specific ones, or cancel?"

If they want to pick specific ones, let them name which ones (e.g., "just OpenCode and Docker").

### 3. Apply Updates to Dockerfile

For each package to update, use `sed` to replace the ARG line:

```bash
# Format:
sed -i "s/^ARG <NAME>=.*/ARG <NAME>=<NEW_VERSION>/" Dockerfile

# Example:
sed -i "s/^ARG OPENCODE_VERSION=.*/ARG OPENCODE_VERSION=1.18.4/" Dockerfile
```

Use `check-versions.sh json` to fetch the correct latest version for each ARG:

```bash
# Get the latest version for a specific ARG (from the json output)
LATEST=$(bash .opencode/scripts/check-versions.sh json | python3 -c "
import json,sys
d=json.load(sys.stdin)
name='OPENCODE_VERSION'
if name in d and d[name]['status'] == 'outdated':
    print(d[name]['latest'])
")
```

Then apply:

```bash
if [ -n "$LATEST" ]; then
  sed -i "s/^ARG OPENCODE_VERSION=.*/ARG OPENCODE_VERSION=${LATEST}/" Dockerfile
  echo "Updated OPENCODE_VERSION to ${LATEST}"
fi
```

**Repeat for each outdated package** the user chose to update.

**Derived pin: `BUN_VERSION`.** This pin is not compared against Bun's own
latest release. `check-versions.sh` reports its target as the Bun release the
pinned `OPENCHAMBER_VERSION` requires: the `packageManager` field
(`"bun@X.Y.Z"`) of `package.json` at that OpenChamber git tag, fetched from
`github.com/openchamber/openchamber` (source label
`github:openchamber/openchamber`). Drift is exact-equality: pinned ahead OR
behind the required version both report `outdated`, because the image must
ship the Bun version OpenChamber declares.

Ordering matters when `OPENCHAMBER_VERSION` is also outdated: update it first,
then re-run `check-versions.sh json`. The Bun target derives from the
`OPENCHAMBER_VERSION` pinned in the Dockerfile, so the recheck reads the new
OpenChamber tag and reports the correct `BUN_VERSION` target. If it drifted,
apply the same `sed` flow. (CI already derives the Bun target from the
candidate OpenChamber version when both pins update in the same run.)

**Playwright pair: `PLAYWRIGHT_VERSION` + `PLAYWRIGHT_MCP_VERSION`.** These are
independent pins. `PLAYWRIGHT_MCP_VERSION` depends on an *alpha* playwright
(always ahead of npm stable), while `PLAYWRIGHT_VERSION` pins npm stable; the
two tracks never align, so do not try to sync their version numbers. The
bundled Chromium revision is controlled solely by `PLAYWRIGHT_VERSION`.
Compatibility between the MCP driver and that Chromium is verified ONLY by the
integration tests (headless Chromium launch must pass) — do not skip them after
any bump of either pin.

`OH_MY_OPENAGENT_VERSION` is a Dockerfile pin and is included in the standard
`outdated` and `json` output. Update it with the same `ARG` replacement flow;
do not use `--latest` for OMO because that flag is only for packages without a
Dockerfile pin.

**Also sync the baked OMO schema reference.** `.opencode/omo.jsonc.default`
pins the OMO JSON schema to a versioned tag in its `$schema` URL (e.g.
`https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/v4.19.3/assets/omo.schema.json`).
This is NOT tracked by `check-versions.sh` — it must be updated manually with
the same version every time `OH_MY_OPENAGENT_VERSION` is bumped, otherwise the
file's schema reference silently lags the installed plugin:

```bash
# After updating ARG OH_MY_OPENAGENT_VERSION=<NEW_VERSION>:
OMO_SCHEMA_TAG="${LATEST#v}"
sed -i "s|https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/v[0-9.]*/assets/omo.schema.json|https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/v${OMO_SCHEMA_TAG}/assets/omo.schema.json|" .opencode/omo.jsonc.default
```

Validate the result (the only `vX.Y.Z` left in the file should be the new one):

```bash
grep -o 'oh-my-openagent/v[0-9.]*/assets/omo.schema.json' .opencode/omo.jsonc.default
```

The `$schema` field is editor-only (runtime merge ignores it), but keeping it
aligned avoids stale IDE validation after the plugin moves forward.

> **V2 line: skip OMO entirely.** Do not bump `OH_MY_OPENAGENT_VERSION` and do
> not touch `.opencode/omo.jsonc.default` — the V2 line carries no OMO runtime
> (the `docker-compose.v2.yml` default is a dead parameter). The script already
> omits the OMO row in V2 mode.

### 3b. Apply Updates on the V2 line

`OPENCODE_CLI_VERSION`, `OPENCHAMBER_VERSION` (and their dependents) live in
`docker-compose.v2.yml` build args on the v2 line, not in Dockerfile defaults.
Use these patterns (values from `check-versions.sh json` in V2 mode):

```bash
# Format: - NAME=${NAME:-default}  →  replace the default after :-
sed -i -E "s/^([[:space:]]*-[[:space:]]*OPENCODE_CLI_VERSION=.*:-)[^}]+(\})/\1${LATEST}\2/" docker-compose.v2.yml
sed -i -E "s/^([[:space:]]*-[[:space:]]*OPENCHAMBER_VERSION=)[^[:space:]]+/\1${LATEST}/" docker-compose.v2.yml
```

After changing `OPENCHAMBER_VERSION`, re-run `check-versions.sh json` in V2
mode: the `BUN_VERSION` target derives from the new OpenChamber tag. Also
cross-check the OpenCode CLI floor the new OpenChamber requires (v2 docs carry
`requires OpenCode 2.0.x+` style floors) — never ship a mispaired 2.x/1.x
stack; the script's locked-pair guard only sees what you feed it.

### 4. Build the Dev Image

```bash
docker compose -p dev -f docker-compose.dev.yml build ai-dev
```

> **V2 line:** build the V2 image instead, with the `v2-b` builder (the
> default BuildKit worker fails its network prestart hook in this environment
> with a `libnftables.so.1` error):
>
> ```bash
> docker buildx build --builder v2-b --load --network=host \
>   --build-arg OPENCODE_CLI_PACKAGE=@opencode/cli \
>   --build-arg OPENCODE_CLI_VERSION=<NEW> \
>   --build-arg OPENCHAMBER_VERSION=<NEW> \
>   -t ai-engkit-ai-v2 .
> ```

If the build fails, report the error to the user and stop. Do not proceed.

### 5. Run Integration Tests

Start the dev container and run tests:

```bash
docker compose -p dev -f docker-compose.dev.yml up -d

# Wait for container to be ready
for i in $(seq 1 30); do
  STATUS=$(docker inspect ai-engkit-dev --format='{{.State.Status}}' 2>/dev/null)
  [ "$STATUS" = "running" ] && break
  [ "$i" -eq 30 ] && echo "ERROR: Container failed to start" && exit 1
  sleep 2
done
sleep 5

# Resolve the ai-dev service inside the dev project; do not depend on Compose listing order.
CONTAINER=$(docker compose -p dev -f docker-compose.dev.yml ps -q ai-dev 2>/dev/null)

# Run tests
./test/run-tests.sh "$CONTAINER"
```

> **V2 line:** replace the gate with the V2 gates — `test/test-v2.sh`
> cells, `bun test src/`, plus the Admin live checks. After any Playwright pin
> bump, the headless Chromium launch must pass through the V2 container's
> `pw-mcp` path specifically.

If any test fails, report and stop. Do not commit.

### 5.5. Reconcile Deferred Vulnerability Register

Check whether the updates just applied resolve any rows in the deferred
vulnerability register (`docs/DEFERRED_VULNERABILITIES.md`). Rows there track
upstream-blocked alerts dismissed as `won't fix`; a dependency bump or a
bundled-runtime repackage can satisfy their resolution condition.

```bash
# For each Active row whose package was just updated, verify directly.
# Example — codegraph rows resolve when the bundled node is patched:
~/.bun/install/global/node_modules/@colbymchenry/codegraph-linux-x64/node --version
# >= 24.18.1 → resolved, move the row from Active to Resolved

# Alert state check (CI must rebuild for this to flip; local check may lag):
gh api repos/tryweb/ai-engkit/code-scanning/alerts/<ALERT_NUMBER> --jq '.state'
# fixed → resolved; dismissed → still waiting on upstream
```

If any rows resolved, include the register update in the commit:

```bash
git add Dockerfile docs/DEFERRED_VULNERABILITIES.md
git commit -m "feat: bump <pkg> <old> → <new>, resolve deferred <CVE>"
```

Do not drop rows silently — always move resolved rows to the Resolved section
to preserve the audit trail.

### 6. Commit (Ask First)

If build + tests passed, offer to commit:

```
Build and tests passed. All N updated packages verified.
Commit these changes? (yes/no)
```

If confirmed:

```bash
# Build a commit message listing what was updated
# Example: "feat: bump OpenCode 1.18.3 → 1.18.4, glab 1.108.0 → 1.109.0"
# V2 line: stage docker-compose.v2.yml instead of (or in addition to) Dockerfile.
git add Dockerfile
git commit -m "feat: <summary of what was updated>"
```

Tell the user they can now run `/release` to tag and publish.

---

## Rules

- Always show the user what's outdated before making changes
- Always ask before updating (unless they said "update all")
- Never skip the build step
- Never skip the test step
- Never commit without user confirmation
- If build or tests fail, stop — do not proceed to commit
- Use the exact `sed` patterns from the CI workflow for consistency
