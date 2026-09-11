# CI Smoke Tests: Avoid `grep -q` Pipelines Under `pipefail`

## Context

The CI integration workflow runs shell-based smoke tests against the Admin UI and also runs host-side entrypoint tests. The incident required four diagnostic rounds because the first failure was fixed before a second, independent smoke-test failure became visible.

## Problem

The first CI failure reported `AGENTS synchronization marker tests failed`. Investigation found that the test helper changes had mixed function-extraction strategies and contained an assertion whose expected casing did not match the generated fixture.

After that was corrected, CI reached the Admin UI smoke tests but reported:

```text
FAIL Upgrade page lists Core tools (expected 'Core')
FAIL Upgrade page lists CLI tools (expected 'CLI')
```

The page source did contain the expected labels, and the MCP and Plugin checks passed. The remaining failure was in the test harness, not the rendered Admin UI.

## Solution

Use a here-string when matching an in-memory response under `set -o pipefail`:

```bash
if grep -qi "$pattern" <<<"$html"; then
  pass "$label"
else
  fail "$label (expected '$pattern')"
fi
```

Apply the same rule to negative assertions. Do not use `echo "$html" | grep -q ...` for large response bodies in pipefail-enabled tests.

The entrypoint test helpers were also restored to their working extraction behavior, while the generated skill-version assertion was aligned with the fixture's actual lowercase output.

## Why It Works

`grep -q` exits as soon as it finds a match. In a pipeline, the producer may still be writing the remaining HTML and receive `SIGPIPE`. With `pipefail`, that producer failure can make the whole pipeline non-zero even though `grep` found the requested text. The here-string passes the complete shell variable to `grep` without a producer process that can fail from an early reader exit.

This explains why early labels such as `Core` and `CLI` were vulnerable while later labels could pass: the result depended on where the first match occurred relative to the amount of data still being written.

## Side Effects / Tradeoffs

- Here-strings add a trailing newline, which is harmless for substring assertions and avoids the pipeline failure mode.
- The smoke test still performs substring matching; use exact or structured matching when the assertion requires a specific HTML element rather than presence of text.
- The local Admin UI endpoint was unavailable during final local smoke-test execution, so end-to-end confirmation came from the CI rerun.

## Evidence

- GitHub Actions run `34494414032` first failed during `AGENTS synchronization marker tests`.
- Commit `445d330` restored the entrypoint test extraction paths and corrected the generated `knowledge-capture v1.1.0` assertion.
- GitHub Actions run `34541641874`, job `103086665008`, passed the AGENTS checks and then showed the two Admin UI failures with `echo` reporting `Broken pipe` at `test/test-admin-ui.sh:38`.
- The relevant failing log lines were:

  ```text
  ./test/test-admin-ui.sh: line 38: echo: write error: Broken pipe
  FAIL Upgrade page lists Core tools (expected 'Core')
  FAIL Upgrade page lists CLI tools (expected 'CLI')
  ```

- After changing both assertions to here-strings, `bash -n test/test-admin-ui.sh` passed, the AGENTS test contract passed locally, and the user confirmed the CI rerun passed.

## Related Files

- `test/test-admin-ui.sh`
- `entrypoint.d/02-init-config.test.sh`
- `entrypoint.d/02-init-config.sh`
- `src/admin/views/versions.tsx`
- `.github/workflows/ci.yml`

## Tags

- `ci`
- `shell`
- `bash`
- `pipefail`
- `SIGPIPE`
- `smoke-test`
