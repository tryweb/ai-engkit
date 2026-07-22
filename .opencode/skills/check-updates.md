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

### 4. Build the Dev Image

```bash
docker compose -f docker-compose.dev.yml build ai-dev
```

If the build fails, report the error to the user and stop. Do not proceed.

### 5. Run Integration Tests

Start the dev container and run tests:

```bash
docker compose -f docker-compose.dev.yml up -d

# Wait for container to be ready
for i in $(seq 1 30); do
  STATUS=$(docker inspect ai-engkit-dev --format='{{.State.Status}}' 2>/dev/null)
  [ "$STATUS" = "running" ] && break
  [ "$i" -eq 30 ] && echo "ERROR: Container failed to start" && exit 1
  sleep 2
done
sleep 5

# Detect the actual container name
CONTAINER=$(docker compose -f docker-compose.dev.yml ps --format '{{.Name}}' 2>/dev/null | head -1)

# Run tests
./test/run-tests.sh "$CONTAINER"
```

If any test fails, report and stop. Do not commit.

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
