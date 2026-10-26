---
name: enable-security-audit
description: Bootstrap pinned Cloudflare security-audit skill tree plus AGENTS.md routing note into a project. Opt-in, idempotent — delegates to a deterministic shell script.
---

# Enable Security Audit

Bootstraps the pinned Cloudflare `security-audit` skill tree
(`.opencode/skills/security-audit/`, 21 files) plus the `AGENTS.md`
routing note into a target project.

Delegates all file creation to a deterministic script — no inline copy-paste.

## Triggers

- "Enable security audit"
- "Bootstrap security audit skill"
- "Initialize security audit"
- "為這個專案啟用安全稽核"
- "啟用 security-audit skill"
- "audit this codebase"

---

## Goal

The finished project will contain:

```
<project-root>/
├── .opencode/
│   └── skills/
│       └── security-audit/
│           ├── SKILL.md                      # restored from SKILL.md.template
│           ├── RECONNAISSANCE.md
│           ├── HUNTING.md
│           ├── ATTACK-CLASSES.md
│           ├── MEMORY-SAFETY-AND-BINARY.md
│           ├── AI-AND-LLM.md
│           ├── WEB-PROTOCOL-AND-AUTH.md
│           ├── CLIENT-SIDE.md
│           ├── SUPPLY-CHAIN-AND-RELEASE.md
│           ├── CLOUD-AND-DEPLOYMENT.md
│           ├── PROTOCOLS-RPC-AND-MESSAGING.md
│           ├── RESOURCE-EXHAUSTION-AND-AVAILABILITY.md
│           ├── DATA-ISOLATION-AND-LIFECYCLE.md
│           ├── DESKTOP-MOBILE-AND-LOCAL-IPC.md
│           ├── VALIDATION-AND-REPORTING.md
│           ├── report-schema.json
│           ├── validate-findings.cjs
│           ├── validate-findings.test.cjs
│           ├── validate-coverage-ledger.cjs
│           ├── validate-coverage-ledger.test.cjs
│           └── LICENSE (MIT, Cloudflare)
└── AGENTS.md                                 # routing note appended (or created)
```

The bootstrap script lives at:

```
~/.config/opencode/skills/enable-security-audit/bootstrap.sh
```

---

## Prerequisites

None. This skill has no dependency on `enable-project-knowledge` and no
`team_mode` requirement. On the V2 line there is no `~/.omo/omo.jsonc` at
all; audit runs with native subagents under the skill's write-isolation
boundaries.

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

If `<project-root>/.opencode/skills/security-audit/SKILL.md` exists,
the skill tree is already installed. Report:

> Security audit skill already enabled for this project. Nothing changed.

and stop — unless the user explicitly asks for a refresh, in which case
run the script with `--force` (full tree refresh, including hand edits;
policy is documented in `UPSTREAM.md`).

If only some files exist (partial setup), proceed — the script handles
it safely.

---

## Step 3 — Run Bootstrap Script

```bash
bash ~/.config/opencode/skills/enable-security-audit/bootstrap.sh <project-root>
```

To refresh a stale tree to the pinned version:

```bash
bash ~/.config/opencode/skills/enable-security-audit/bootstrap.sh --force <project-root>
```

The script is idempotent, writes the routing note into the project's
`AGENTS.md` exactly once (never the shared template), and outputs a
structured summary.

---

## Step 4 — Report Results

Relay the bootstrap script's output to the user. The script will report each
path as `created` or `skipped (exists)`.

If all items were `skipped (exists)`, also say:
"Security audit skill already enabled. Nothing changed."

Mention:

- The project-local skill is now at
  `.opencode/skills/security-audit/SKILL.md` and activates on audit
  requests ("security audit this codebase", "find vulnerabilities in
  ./src", "do a security review").
- Validators run with the container's `node` (Bun shim):
  `node .opencode/skills/security-audit/validate-findings.cjs` works;
  `node --test` does not — validator tests run with `bun test`.

---

## Rules

- Never overwrite an existing file without `--force`.
- Never create files outside the detected project root.
- Never write the routing note into the shared template — project `AGENTS.md` only.
- If git root detection fails and the user doesn't confirm a directory, stop.
- Do not modify or inline the script's file contents into SKILL.md — only the script is authoritative.
- Do not rename `SKILL.md.template` back to `SKILL.md` inside the baked
  source tree — the `.template` suffix is what keeps the vendored copy
  from registering as a global skill.
