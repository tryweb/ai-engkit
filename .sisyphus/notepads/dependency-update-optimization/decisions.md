# Decisions - Dependency Update Workflow Optimization

## Architecture Decisions
- Single workflow file replaces existing dependency-update.yml
- All version-checking logic is inline Bash (no external scripts to maintain)
- Artifact-based version tracking (not git-stored)
- Decision tree: Dockerfile changes → PR; Latest/apt only + tests pass → Auto-release
- GITHUB_TOKEN only (no PAT available)
- Branch protection fallback: if git push fails → create PR with release changes

## Output Variables
- updates-needed: true/false
- dockerfile-changes-needed: true/false
- latest-changes-detected: true/false
- pinned-updates: JSON
- latest-updates: JSON
- apt-updates: string

## Concurrency
- Group: dependency-update-${{ github.ref }}
- Schedule: weekly Monday 6AM UTC + workflow_dispatch
