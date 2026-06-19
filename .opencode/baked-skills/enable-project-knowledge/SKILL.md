---
name: enable-project-knowledge
description: Bootstrap project-local knowledge base with docs/knowledge/ structure and knowledge-capture skill. Idempotent — delegates to a deterministic shell script.
---

# Enable Project Knowledge

Bootstraps `docs/knowledge/` + `.opencode/skills/knowledge-capture.md` into a target project.
Delegates all file creation to a deterministic script — no inline copy-paste.

## Triggers

- "Enable project knowledge"
- "Bootstrap knowledge base for this project"
- "Initialize project knowledge"
- "為這個專案啟用知識庫"
- "初始化專案知識庫"

---

## Goal

The finished project will contain:

```
<project-root>/
├── .opencode/
│   └── skills/
│       └── knowledge-capture.md
└── docs/
    └── knowledge/
        ├── README.md
        ├── _template.md
        ├── architecture/
        ├── patterns/
        ├── tooling/
        └── troubleshooting/
```

All files are created **only if they don't exist**. Existing content is never overwritten.

The bootstrap script lives at:

```
~/.config/opencode/skills/enable-project-knowledge/bootstrap.sh
```

---

## Step 1 — Determine Project Root

If inside a git repository:

```bash
git rev-parse --show-toplevel
```

If not inside a git repo, ask the user to confirm the intended project directory. Do not guess.

---

## Step 2 — Check if Already Enabled

If `<project-root>/.opencode/skills/knowledge-capture.md` **and** `<project-root>/docs/knowledge/README.md` both exist, report:

> Knowledge base already enabled for this project. Nothing changed.

and stop.

If only one of the two markers exists (partial setup), proceed — the script handles it safely.

---

## Step 3 — Run Bootstrap Script

```bash
bash ~/.config/opencode/skills/enable-project-knowledge/bootstrap.sh <project-root>
```

The script is idempotent, writes files only when they don't exist, and outputs a structured summary.

---

## Step 4 — Seed ctx_knowledge with Project Facts

After the bootstrap script runs, seed the lean-ctx knowledge base with the
project's essential identity facts. This makes the project discoverable via
`ctx_knowledge(action="recall", ...)` in future sessions without re-reading files.

### Required Seeds

From the project root (detected in Step 1), use `lean-ctx knowledge remember`
to store at least these categories:

| Category | Key | What to capture |
|----------|-----|-----------------|
| `project-overview` | `identity` | Project name + purpose + repo URL |
| `project-overview` | `backend-stack` | Language, framework, database (if any) |
| `project-overview` | `frontend-stack` | Frontend framework (if any) |
| `project-overview` | `workspace-location` | Absolute path to project root |

Discover the values by inspecting git remote, config files (package.json,
pyproject.toml, Cargo.toml, vite.config.*, etc.) and the source tree.

### Command Format

```bash
lean-ctx knowledge remember "<concise fact string>" \
  --category <category> --key <key> --confidence 0.9
```

### Graceful Degradation

If `lean-ctx` is not available or the `knowledge remember` subcommand fails
(e.g. inside a restricted environment), skip this step and mention it in the
final report. The file-based bootstrap (Steps 1-3) is the primary deliverable.

### Verification

After seeding, run:

```bash
lean-ctx knowledge status
```

Confirm the expected rooms show active facts. Include the raw output in your
report so the user can see what was stored.

---

## Step 5 — Report Results

Relay both the bootstrap script's output and the ctx_knowledge seeding result
to the user. The script will report each path as `created` or `skipped (exists)`.

If all items were `skipped (exists)`, also say: "Knowledge base already enabled. Nothing changed."
Include the ctx_knowledge status output so the user can verify facts were seeded.

**Note:** The `knowledge-capture` skill is available globally and can be used
immediately — no reload needed. Verify with:

```bash
ls ~/.config/opencode/skills/knowledge-capture/SKILL.md
```

The project-local copy at `.opencode/skills/knowledge-capture.md` (created by
the bootstrap script) exists for git portability outside Codeforge environments.

---

## Rules

- Never overwrite an existing file.
- Never create files outside the detected project root.
- If git root detection fails and the user doesn't confirm a directory, stop.
- Do not create `.gitkeep` files in empty directories; let them be truly empty.
- Do not modify or inline the script's file contents into SKILL.md — only the script is authoritative.
