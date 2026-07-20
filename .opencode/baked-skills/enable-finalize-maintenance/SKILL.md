---
name: enable-finalize-maintenance
description: Bootstrap docs/knowledge/maintenance/ scaffold with report template, index, and project-local finalize-maintenance skill. Idempotent — delegates to a deterministic shell script.
---

# Enable Finalize Maintenance

Bootstraps `docs/knowledge/maintenance/` directory structure with report
template, index README, and `.opencode/skills/finalize-maintenance.md`
into a target project.

Delegates all file creation to a deterministic script — no inline copy-paste.

## Triggers

- "Enable maintenance reports"
- "Enable finalize maintenance"
- "Bootstrap maintenance workflow"
- "Initialize maintenance reports"
- "為這個專案啟用維護報告"
- "啟用維護完成標準作業"

---

## Goal

The finished project will contain:

```
<project-root>/
├── .opencode/
│   └── skills/
│       └── finalize-maintenance.md
└── docs/
    └── knowledge/
        └── maintenance/
            ├── README.md
            └── _template.md
```

All files are created **only if they don't exist**. Existing content is never overwritten.

The bootstrap script lives at:

```
~/.config/opencode/skills/enable-finalize-maintenance/bootstrap.sh
```

---

## Prerequisites

Before bootstrapping, the target project should already have the
`enable-project-knowledge` baked-skill enabled (so `docs/knowledge/`
and `.opencode/skills/knowledge-capture.md` exist).

If not, run `enable-project-knowledge` first:

```bash
bash ~/.config/opencode/skills/enable-project-knowledge/bootstrap.sh <project-root>
```

---

## Step 1 — Determine Project Root

If inside a git repository:

```bash
git rev-parse --show-toplevel
```

If not inside a git repo, ask the user to confirm the intended project
directory. Do not guess.

---

## Step 2 — Check if Already Enabled

If `<project-root>/.opencode/skills/finalize-maintenance.md` **and**
`<project-root>/docs/knowledge/maintenance/README.md` both exist, report:

> Maintenance workflow already enabled for this project. Nothing changed.

and stop.

If only one of the two markers exists (partial setup), proceed — the script
handles it safely.

---

## Step 3 — Run Bootstrap Script

```bash
bash ~/.config/opencode/skills/enable-finalize-maintenance/bootstrap.sh <project-root>
```

The script is idempotent, writes files only when they don't exist, and outputs
a structured summary.

---

## Step 4 — Report Results

Relay the bootstrap script's output to the user. The script will report each
path as `created` or `skipped (exists)`.

If all items were `skipped (exists)`, also say:
"Maintenance workflow already enabled. Nothing changed."

**Note:** The `finalize-maintenance` project-local skill is now available
in the target project at `.opencode/skills/finalize-maintenance.md`.
The global `finalize-maintenance` skill is also available system-wide:

```bash
ls ~/.config/opencode/skills/finalize-maintenance/SKILL.md
```

---

## Rules

- Never overwrite an existing file.
- Never create files outside the detected project root.
- If git root detection fails and the user doesn't confirm a directory, stop.
- Do not create `.gitkeep` files in empty directories; let them be truly empty.
- Do not modify or inline the script's file contents into SKILL.md — only the script is authoritative.
