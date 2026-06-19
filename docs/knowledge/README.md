# Knowledge Base

This directory is the Phase 1 validation area for project knowledge capture.

## Purpose

Store **reusable, human-readable, git-backed** knowledge that can help future contributors and agents.

This is not a raw task log. Task-local notes still belong in `.sisyphus/notepads/`. Only promote information here when it is likely to matter again.

## Directory Layout

- `architecture/` — design constraints, rationale, and system boundaries
- `patterns/` — reusable coding or workflow patterns
- `tooling/` — environment, build, CI/CD, CLI, and automation behaviors
- `troubleshooting/` — bugs, failure modes, and concrete fixes

## Entry Standard

Each file should follow the same shape:

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

Promote a note into this directory only if it is:

1. reusable,
2. evidence-backed,
3. narrowly scoped,
4. likely to help a future task.

## Phase 1 Goal

Use the `knowledge-capture` skill manually after completed tasks to test:

- whether entries are easy to write,
- whether they remain concise,
- whether future tasks can find and use them,
- whether the format avoids duplicate or stale knowledge.
