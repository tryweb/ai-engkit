---
name: enable-security-audit
description: Install the Cloudflare security-audit skill into a project as a git-tracked project-local skill. Idempotent — copies a pinned, vendored upstream tree and never touches existing project files.
---

# Enable Security Audit

Installs the upstream `cloudflare/security-audit-skill` (multi-phase,
evidence-verified vulnerability audit with machine-readable findings) as a
project-local skill.

Delegates all file creation to a deterministic script — no inline copy-paste.

## Triggers

- "Enable security audit skill"
- "Install the Cloudflare security audit skill"
- "Add security-audit to this project"
- "為這個專案啟用安全稽核 skill"
- "安裝 cloudflare security-audit"

---

## Goal

The finished project will contain:

```
<project-root>/
└── .opencode/
    └── skills/
        └── security-audit/
            ├── SKILL.md
            ├── RECONNAISSANCE.md
            ├── HUNTING.md
            ├── ATTACK-CLASSES.md
            ├── VALIDATION-AND-REPORTING.md
            ├── <7 domain companion files>
            ├── report-schema.json
            ├── validate-findings.cjs
            ├── validate-coverage-ledger.cjs
            ├── <2 upstream test files>
            └── LICENSE
```

21 files total, vendored verbatim at a pinned upstream commit (see
`UPSTREAM.md` in the bootstrap directory). Existing project files are never
overwritten.

The bootstrap script lives at:

```
~/.config/opencode/skills/enable-security-audit/bootstrap.sh
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

If `<project-root>/.opencode/skills/security-audit/SKILL.md` exists, the tree is
already installed — skip to Step 6 to ensure the routing note exists, then stop.

To refresh an existing copy to the image's pinned version, run the script with
`--force` instead (the entrypoint also does this automatically after a
`skill-version` bump).

---

## Step 3 — Run Bootstrap Script

```bash
bash ~/.config/opencode/skills/enable-security-audit/bootstrap.sh <project-root>
```

The script is idempotent, writes files only when they don't exist, and outputs
a markdown summary table with `created` / `skipped (exists)` per path.

---

## Step 4 — Verify the Installed Tree

```bash
cd <project-root>/.opencode/skills/security-audit
bun test validate-findings.test.cjs validate-coverage-ledger.test.cjs
printf '[]' > /tmp/findings.json && node validate-findings.cjs /tmp/findings.json
```

Expected: 65 passing upstream tests, then `PASS: 0 findings valid`.
`node` in ai-engkit is Bun's Node-compatibility shim, so `node <file>` works
but `node --test` does not — always run the tests with `bun test`.

---

## Step 5 — Report Results

Relay the bootstrap output. If all items were `skipped (exists)`, also say:
"Security audit skill already enabled. Nothing changed."

Mention that the skill is now active and how to trigger it
(`security audit this codebase`).

---

## Step 6 — Confirm Skill Routing in AGENTS.md

`bootstrap.sh` is the single writer of the `## Security Skill Routing`
section in `<project-root>/AGENTS.md`: it appends the section once (creating
the file if absent, leaving existing content alone, never writing twice).
Confirm the section is present. If the skill tree was installed by an older
bootstrap, just re-run the script — the tree copy is a no-op and only the
note is added.

---

## Choosing Between the Security Skills

| Skill | Use it when | Needs |
|-------|-------------|-------|
| `security-audit` (this one) | You want a rigorous, coverage-led audit with `findings.json`, independent record verification, and a report bundle | Node/Bun; optional sub-agents |
| `security-research` / `security-review` (built-in) | You want the Team Mode 3-hunter + 2-PoC exploitability pass | `team_mode.enabled: true` in OMO config |
| `vuln-scan` (project skill in ai-engkit) | You are triaging GitHub code-scanning alerts or Dockerfile version pins | `gh` auth |

Enabling `security-audit` shifts broad security wording in that project: the
upstream description covers "security reviews", and project skills outrank
built-ins, so plain "security review" now lands here instead of on
`security-research`. That cannot be turned off without forking the vendored
description, so treat routing as explicit in both directions — name
`security-audit` for this skill, and `security-research` or
`/security-research` for Team Mode.

---

## Environment Caveats (ai-engkit)

- **Sandbox requirement.** Upstream only executes target-controlled builds,
  tests, browsers, or fuzzers inside an OS-enforced sandbox with networking
  disabled. ai-engkit containers do not provide one. Without it the skill
  correctly degrades to source-first analysis and marks blocked leads
  `needs_validation` — do not treat that as a bug, and do not hand-run target
  builds against untrusted code to "unblock" a finding.
- **Ephemeral HOME.** The skill's default output path is
  `~/security-audit-skill/<repo>/run-<N>`, and container `$HOME` does not
  survive replacement. Pass an explicit output directory on a mounted volume or
  a gitignored path when results must persist.
- **Defaults are additive.** Re-running an audit against the same output tree
  merges prior ledgers and findings by design; use a new `run-<N>` directory
  for an independent pass.

---

## Rules

- Never overwrite an existing file without `--force`.
- Never edit files under `.opencode/skills/security-audit/` — they are
  upstream-owned and refreshed on upgrade. Put project-specific guidance in
  `AGENTS.md` or a separate skill.
- Never create files outside the detected project root.
- If git root detection fails and the user doesn't confirm a directory, stop.
- Do not modify or inline the script's file contents or the vendored tree into
  this SKILL.md — the script and `skill/` are authoritative.
