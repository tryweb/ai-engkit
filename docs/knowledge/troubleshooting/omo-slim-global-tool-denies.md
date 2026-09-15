# OMO-slim Tool Denials: Separate Observation from Attribution

## Context

- During the 2026-09-15 slim evaluation, Fixer was reported unable to read files, execute shell commands, or delete files.
- Target: `ai-engkit-dev`, Compose project `dev`, plugin `oh-my-opencode-slim@2.2.20`.
- This is an unresolved investigation record, not a completed fix or proof of an OpenCode V2 regression.

## Problem

The dev global `~/.config/opencode/opencode.json` contained:

```json
{
  "permission": {
    "bash": "deny",
    "glob": "deny",
    "grep": "deny",
    "read": "deny",
    "websearch": "allow"
  }
}
```

- The earlier runtime `/config` inspection also reported these denies.
- OMO-slim agent overrides inspected in the dev configuration had no `permission` or `tools` blocks, including Fixer.
- The session's plugin inspection found no Fixer-specific deny list.
- The generator's `render_opencode_config()` writes only `permission.websearch: allow`. However, the entrypoint also invokes other setup commands, including conditional `lean-ctx setup` and `lean-ctx init`; the generator alone does not exonerate the complete startup chain.

## Solution

### Established findings

- Native tool denies exist in the global configuration; the final effective rules and exposed tools must still be checked per agent/session.
- `opencode.json.bak` contained only `websearch: allow` and had modification time `2026-09-15 09:30:41 +0800`.
- The current configuration file had birth/modification time around `10:03:55 +0800`; the observed managed OpenCode process started at `10:03:58`, while the container started around `09:30:36`.
- `syncNativeAgentOverrides()` and the shell native-override helper update `general`/`plan` model and variant fields while preserving unrelated global configuration.

### Conclusions that must not be repeated

- File timestamps identify a rewrite, not when a particular key was introduced or which process introduced it.
- A backup without denies does not prove host/task injection caused them.
- A negative literal search does not exclude dynamically generated rules or setup-time writers.
- `bash: deny` restricts native bash, but does not by itself prove that every file-deletion path is unavailable.
- Without an old OMO effective-permission/tool snapshot, do not claim that old OMO overrides these denies or that slim introduced them.
- Model metadata advertising tool calls or image input does not demonstrate successful tool execution or image delivery through the agent workflow.

### Next investigation when work resumes

1. Capture exact runtime/plugin versions, global/project configuration, effective agent rules, and child-session tool exposure for each tested combination.
2. Compare old OMO and slim in isolated configurations with equivalent inputs, rather than reusing potentially migrated settings.
3. Trace configuration writers, including setup utilities and configuration APIs. Do not weaken permission inheritance or enable routing as an investigative shortcut.
4. Exercise permitted tools and expected denials with disposable fixtures; distinguish absent tools, permission rejection, and filesystem/path errors.

No permission changes or service restart were performed during the investigation continuation summarized here.

## Why It Works

- Distinguishing configuration, effective permission rules, tool availability, and execution results prevents attribution to the wrong layer.
- Keeping unresolved attribution explicit prevents later sessions from treating an early hypothesis as a verified root cause.

## Side Effects / Tradeoffs

- No corrective patch is prescribed until the writer and effective behavior are established.
- The issue remains open for a resumed experiment; it is not a reason to grant all tools globally.

## Evidence

- Direct dev `jq` inspections returned the global permission object, the backup's `websearch`-only object, and null permission/tools fields in OMO agent overrides.
- Direct `stat` and `ps` inspections produced the timestamps above.
- Source inspection: `entrypoint.d/02-init-config.sh`, `entrypoint.d/lib-native-agent-overrides.bash`, and `src/admin/lib/agent-models.ts:syncNativeAgentOverrides`.
- `bash test/test-omo-config-normalization.sh`: passed during the investigation; includes preserving unsupported deny-all rules without weakening them.
- `bash test/test-native-agent-overrides.sh`: passed during the investigation; malformed JSON emits the expected warning and leaves configuration unchanged.
- These tests validate configuration helpers, not Fixer's end-to-end behavior.
- Related upstream lead: [issue #1153](https://github.com/alvinunreal/oh-my-opencode-slim/issues/1153) and [PR #1178](https://github.com/alvinunreal/oh-my-opencode-slim/pull/1178) were reported by the session's repository-search agent as a councillor-specific V2 permission-adapter issue. This capture does not independently revalidate their current state or establish applicability to Fixer.

## Related Files

- `docs/knowledge/architecture/omo-slim-evaluation-disposition.md`
- `entrypoint.d/02-init-config.sh`
- `entrypoint.d/lib-native-agent-overrides.bash`
- `src/admin/lib/agent-models.ts`
- `test/test-omo-config-normalization.sh`
- `test/test-native-agent-overrides.sh`
- Dev container: `/home/devuser/.config/opencode/opencode.json`
- Dev container: `/home/devuser/.config/opencode/opencode.json.bak`
- Dev container: `/home/devuser/.config/opencode/oh-my-opencode-slim.json`

## Tags

- omo-slim
- permissions
- unresolved-investigation
- configuration-provenance
- fixer
