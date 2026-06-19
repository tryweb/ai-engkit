#!/usr/bin/env bash
# bootstrap.sh — Deterministic project knowledge base bootstrap
#
# Creates the docs/knowledge/ directory scaffold, README, _template,
# and .opencode/skills/knowledge-capture.md in the given project root.
#
# Usage: bootstrap.sh <project-root>
#
# Idempotent — never overwrites an existing file.
# Outputs a summary table matching the SKILL.md report format.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: bootstrap.sh <project-root>" >&2
  exit 1
fi

ROOT="$1"
if [[ ! -d "$ROOT" ]]; then
  echo "Error: not a directory: $ROOT" >&2
  exit 1
fi

ROOT="${ROOT%/}"

CREATED=()
SKIPPED=()

mk() {
  local dir="$1"
  if [[ -d "$dir" ]]; then
    SKIPPED+=("$dir/")
  else
    mkdir -p "$dir"
    CREATED+=("$dir/")
  fi
}

put() {
  local dest="$1"
  if [[ -f "$dest" ]]; then
    SKIPPED+=("$dest")
    return
  fi
  mkdir -p "$(dirname "$dest")"
  cat > "$dest"
  CREATED+=("$dest")
}

mk "$ROOT/docs/knowledge"
mk "$ROOT/docs/knowledge/architecture"
mk "$ROOT/docs/knowledge/patterns"
mk "$ROOT/docs/knowledge/tooling"
mk "$ROOT/docs/knowledge/troubleshooting"
mk "$ROOT/.opencode/skills"

put "$ROOT/docs/knowledge/README.md" <<'README'
# Knowledge Base

This directory stores **reusable, human-readable, git-backed** knowledge for this project.

## Purpose

Capture knowledge that future contributors and agents can find and use.
Task-local working notes belong in `.sisyphus/notepads/`. Promote into this
directory only when the information is likely to be reused.

## Directory Layout

- `architecture/` — design constraints, rationale, system boundaries
- `patterns/` — reusable coding or workflow patterns
- `tooling/` — environment, build, CI/CD, CLI, automation
- `troubleshooting/` — bugs, failure modes, concrete fixes

## Entry Standard

Every entry must follow this structure:

```md
# Title

## Context
## Problem
## Solution
## Why It Works
## Side Effects / Tradeoffs
## Evidence
## Related Files
## Tags
```

## Promotion Rule

Promote a note here only if it is:
1. reusable,
2. evidence-backed,
3. narrowly scoped,
4. likely to help a future task.

## Usage

Use the `knowledge-capture` skill (in `.opencode/skills/knowledge-capture.md`)
to manually write and validate entries after completing relevant tasks.
README

put "$ROOT/docs/knowledge/_template.md" <<'TEMPLATE'
# <Title>

## Context

Where this issue or pattern appears, and when it matters.

## Problem

The exact failure mode, ambiguity, or decision point.

## Solution

The minimum fix, rule, or pattern that resolved it.

## Why It Works

Explain the mechanism or rationale.

## Side Effects / Tradeoffs

Limits, risks, or follow-up considerations.

## Evidence

- Tests:
- Diagnostics:
- Logs / observed behavior:
- Docs / source references:

## Related Files

- `path/to/file`

## Tags

- tag-1
- tag-2
TEMPLATE

put "$ROOT/.opencode/skills/knowledge-capture.md" <<'SKILL'
---
name: knowledge-capture
description: Manually capture reusable project knowledge into docs/knowledge markdown for Phase 1 validation.
---

# Knowledge Capture Skill

Use this skill to manually write a knowledge entry after completing a task.

## Triggers

- "Capture project knowledge"
- "Document this task as knowledge"
- "Write a knowledge entry"
- "Summarize this fix into docs"
- "整理成知識庫"
- "把這次任務寫成 knowledge"

---

## When To Use

Use only when the work is done and at least one is true:
- the task revealed a non-obvious fix,
- the task exposed a repeated pitfall,
- the task established a reusable pattern,
- the task clarified a design decision,
- the task produced a decision future contributors will need.

Do **not** use for trivial edits, obvious refactors, or one-off experiments.

---

## Required Inputs

Before writing, gather from the completed task:
- task summary,
- changed files,
- validation evidence (tests, diagnostics, build result, observed behavior),
- the key problem,
- the actual solution,
- any tradeoffs or side effects.

---

## Output Location Rules

- `docs/knowledge/troubleshooting/` — bug fixes, incident patterns
- `docs/knowledge/patterns/` — reusable implementation patterns
- `docs/knowledge/architecture/` — design constraints or rationale
- `docs/knowledge/tooling/` — environment, build, CI/CD, CLI

If no file exists for the topic, create a new kebab-case markdown file.

---

## Required Document Format

```
# <Title>

## Context
## Problem
## Solution
## Why It Works
## Side Effects / Tradeoffs
## Evidence
## Related Files
## Tags
```

---

## Writing Rules

- Prefer facts over summaries.
- Prefer short paragraphs and bullets over long prose.
- Preserve concrete terms exactly: error text, env vars, commands, paths, versions.
- Keep one file focused on one reusable lesson.
- Merge into an existing file if the lesson is the same concept.
- If the knowledge is task-local and not reusable, leave it in `.sisyphus/notepads/`.

---

## Validation Checklist

After drafting, verify:
1. **Reusable** — future tasks could benefit.
2. **Scoped** — one concept, not a task dump.
3. **Evidence-backed** — every claim is traceable.
4. **Readable** — a human can skim it.
5. **Non-duplicative** — no unnecessary repeat of existing entries.

---

## Rules

- Never write knowledge before the task is complete.
- Never record guesses as facts.
- Never dump raw transcripts into `docs/knowledge/`.
- Never create a giant catch-all file.
- If evidence is missing, stop and ask.
SKILL

echo ""
echo "| Path | Action |"
echo "|------|--------|"
for p in "${CREATED[@]}"; do
  echo "| \`$p\` | **created** |"
done
for p in "${SKIPPED[@]}"; do
  echo "| \`$p\` | skipped (exists) |"
done
echo ""

if [[ ${#CREATED[@]} -eq 0 ]]; then
  echo "Knowledge base already enabled. Nothing changed."
fi
