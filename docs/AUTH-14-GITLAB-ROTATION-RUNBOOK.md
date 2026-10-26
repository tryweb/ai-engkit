# AUTH-14 GitLab Rotation Verification Runbook

This is a disposable-credential integration harness for GitLab token rotation and GitHub validity checks. It is intentionally a runbook instead of an unattended mutating script: an operator must inspect the host, token owner, and redacted evidence before every revoke or rotation.

**Never use a production host credential. Never paste a token into this file, shell history, CI logs, screenshots, or an issue. Never rotate a production token until the impersonation gate has passed.**

## Preconditions

1. Use a non-production GitLab host, a disposable admin-created test user, and a disposable test repository. Set these shell variables to placeholders for the test environment only:

   ```bash
   export GITLAB_HOST='gitlab.test.example'
   export GITLAB_TEST_USER_ID='<admin-created-test-user-id>'
   export GITLAB_TEST_PROJECT='<group>/rotation-fixture'
   ```

   Abort if any value still contains `<` or `>` or if `GITLAB_HOST` is a production hostname.

2. Confirm the host version and repository access. The version check is a prerequisite, not evidence that impersonation rotation is compatible:

   ```bash
   curl --fail-with-body --silent --show-error "https://${GITLAB_HOST}/api/v4/version" \
     | jq -e '{version: .version}'
   glab api "projects/${GITLAB_TEST_PROJECT//\//%2F}" --hostname "$GITLAB_HOST" \
     | jq -e '{id, path_with_namespace}'
   ```

   PASS: the reported version is `17.9` or newer and the test repository is readable. Preserve the complete version string (for example, `17.9.1`) as `GITLAB_VERSION_REPORTED` when invoking the harness; do not reduce it to only a major/minor value. FAIL: stop; do not create or rotate credentials. Record the version with the hostname redacted if the host name is sensitive.

3. Confirm that the operator has GitLab administrator access to create and revoke credentials for the disposable test user. Confirm that the GitHub test repository is readable if GitHub checks are run.

4. Run the application against isolated `glab`/`git` state, not the normal credential volumes described in [`GIT_AUTHENTICATION.md`](GIT_AUTHENTICATION.md). For a containerized run, use a temporary `HOME`, `XDG_CONFIG_HOME`, and `GLAB_CONFIG_DIR`; destroy them after the run.

   On hosts running multiple Compose projects side by side (for example
   v1/dev/v2/v2dev on one machine), every project has its own independent
   `glab-config`/`gh-config` named volumes, prefixed per project. A
   credential added in one environment is visible only there, so never point
   this harness at a production project's volume — the temporary state above
   is what keeps the run isolated.

   ```bash
   export AUTH14_TMP="$(mktemp -d)"
   export HOME="$AUTH14_TMP/home"
   export XDG_CONFIG_HOME="$AUTH14_TMP/config"
   export GLAB_CONFIG_DIR="$AUTH14_TMP/glab"
   mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$GLAB_CONFIG_DIR"
   trap 'rm -rf "$AUTH14_TMP"' EXIT
   ```

## Credential lifecycle

Every scenario below must follow this lifecycle, even when the scenario fails:

1. **Create:** an administrator creates a token for the disposable test user with the minimum scenario-specific scopes and a short expiry. Capture only token metadata and the token in an in-memory shell variable or secret prompt; never print it.
2. **Verify:** use the token once against the test host/repository before the scenario action. Redact token values from command output and logs.
3. **Act:** perform only the scenario action against the disposable host and test repository.
4. **Capture:** record the expected status/code, version, expiry, scope names, request count, and helper result. Record no token, authorization header, response body token field, or command stderr containing a token.
5. **Revoke/delete:** revoke the token and delete the disposable test user/project if they were created for this run. Revoke both the original and replacement token after rotation. Confirm revocation with a `401` check, then remove temporary config directories.

For PAT creation, use the GitLab administrator API with a unique name and short `expires_at` (for example, tomorrow in UTC). Keep the response token in a protected variable; replace the response token field before saving evidence:

```bash
curl --fail-with-body --silent --show-error \
  --header "PRIVATE-TOKEN: ${GITLAB_ADMIN_TOKEN}" \
  --request POST "https://${GITLAB_HOST}/api/v4/users/${GITLAB_TEST_USER_ID}/personal_access_tokens" \
  --data-urlencode 'name=auth14-pat-<run-id>' \
  --data-urlencode 'scopes[]=read_repository' \
  --data-urlencode 'scopes[]=self_rotate' \
  --data-urlencode 'expires_at=<tomorrow-UTC>' \
  | jq 'del(.token) | {id, name, scopes, expires_at, active, revoked}'
```

Use the same create/verify/revoke lifecycle for impersonation tokens, but create them only for the explicit impersonation scenarios and only on the disposable host. Do not place an admin token in `GITLAB_IMPERSONATION_ROTATION_CONFIRMED_HOSTS`.

## Integration scenarios

The expected codes below are the observable integration contract. A response containing a token is always a failure of evidence redaction, even if the rotation itself succeeded.

### 1. Healthy PAT: no rotation

- **Setup:** Create and verify an active disposable PAT with `read_repository,self_rotate`, expiry comfortably beyond the default seven-day threshold, and `impersonation=false`.
- **Action:** Run the GitLab status/rotation flow for `GITLAB_HOST` with GitLab version `>=17.9`.
- **Expected redacted evidence:** `ok=true`, `rotated=false`, `validity=healthy`; metadata shows active, not revoked, required scopes, and the original expiry. The API call is inspection only; no `/personal_access_tokens/self/rotate` POST occurs.
- **Teardown:** Revoke the PAT, verify the old token returns `401` from `/api/v4/personal_access_tokens/self`, then delete the disposable fixture.

### 2. PAT within threshold: rotation succeeds

- **Setup:** Create and verify a disposable PAT with both required scopes and an expiry within the configured threshold (default seven days). Keep the replacement response token only in protected memory.
- **Action:** Run rotation once with `gitlabVersion` set to the exact version returned by `/api/v4/version`.
- **Expected redacted evidence:** `ok=true`, `rotated=true`, and a new valid `expiresAt`; exactly one `POST /api/v4/personal_access_tokens/self/rotate`. The helper verification succeeds: `git credential fill` exits zero for `GITLAB_HOST`, and a redacted helper lookup identifies the disposable test user without printing a token.
- **Teardown:** Revoke both the original and replacement PATs. Verify the old token is `401`, the replacement is `401` after revocation, and remove isolated helper/config state.

### 3. Expired PAT: no rotation

- **Setup:** Create a disposable PAT that is already expired, or use an admin-created fixture whose expiry is in the past. Verify that the fixture is present without recording its token.
- **Action:** Run the rotation flow.
- **Expected redacted evidence:** `ok=false`, `errorCode=invalid_expired` (the route may return HTTP 200 for this actionable credential state); there is no rotation POST and no helper update.
- **Teardown:** Revoke/delete the expired PAT and fixture. A `401` on the self-token endpoint is the required redacted invalidation evidence.

### 4. PAT missing required scope

- **Setup:** Create a disposable PAT with `read_repository` but without `self_rotate` (or with `self_rotate` but without `read_repository`), then verify the token can reach the test repository as applicable.
- **Action:** Run the rotation flow against a version `>=17.9` host.
- **Expected redacted evidence:** `ok=false`, `errorCode=insufficient_scope` and HTTP 403 at the route; no rotation POST, no replacement token, and no helper update.
- **Teardown:** Revoke/delete the PAT and fixture. Do not “fix” the scope on this token; create a new disposable token for another scenario.

### 5. Old GitLab version

- **Setup:** Use a disposable PAT with both required scopes on a disposable GitLab instance reporting an exact version below `17.9` (for example `17.8.6`). If no such instance is available, use the repository’s integration test environment and pass the recorded old version to the rotation harness; do not mislabel a newer host.
- **Action:** Run rotation with the exact reported old version.
- **Expected redacted evidence:** `ok=false`, `errorCode=unsupported_version` and HTTP 403; no rotation POST. This is a fail-closed gate.
- **Teardown:** Revoke/delete the PAT and fixture. Do not add the host to any confirmation allowlist.

### 6. Impersonation token: compatibility gate accepts only proven hosts

- **Setup:** Create an admin-created disposable impersonation token for the test user on a non-production host. Verify its metadata reports `impersonation=true`, required repository/rotation scopes, and an expiry within the threshold. Confirm the host’s **exact** `/api/v4/version` response and the tested rotation behavior in this run.
- **Action:** First run without `GITLAB_IMPERSONATION_ROTATION_CONFIRMED_HOSTS`; then, only after the exact-version and disposable-token evidence is reviewed, set the variable to the normalized test hostname and run again:

  ```bash
  export GITLAB_IMPERSONATION_ROTATION_CONFIRMED_HOSTS="$GITLAB_HOST"
  ```

- **Expected redacted evidence:** Before confirmation, `ok=false`, `errorCode=impersonation_unconfirmed`, HTTP 403, and no rotation POST. After confirmation, rotation is allowed only if the exact tested version and host evidence are recorded; successful evidence is `rotated=true` plus helper verification, with exactly one rotation POST.
- **Teardown:** Revoke the impersonation token and replacement token, verify both are `401`, unset `GITLAB_IMPERSONATION_ROTATION_CONFIRMED_HOSTS`, and delete the fixture. **Never copy this host allowlist entry to production or infer compatibility from the `>=17.9` check alone.**

### 7. Impersonation token: reject unconfirmed host

- **Setup:** Create and verify a disposable impersonation token on a disposable host or use the same token from scenario 6 before confirmation. Ensure `GITLAB_IMPERSONATION_ROTATION_CONFIRMED_HOSTS` is unset or does not contain the normalized hostname.
- **Action:** Run rotation.
- **Expected redacted evidence:** `ok=false`, `errorCode=impersonation_unconfirmed`, HTTP 403, no rotation POST, and no helper update. This scenario must pass even when the host is `17.9+`.
- **Teardown:** Revoke/delete the impersonation token and fixture; remove any temporary allowlist value.

### 8. Ambiguous timeout: no retry

- **Setup:** Create and verify a disposable PAT within threshold with both required scopes. Arrange a disposable test proxy or controlled integration fault that causes the single rotation request to time out after the server may have accepted it; do not retry at the transport or operator layer.
- **Action:** Run rotation once and count rotation POST requests at the proxy/server boundary.
- **Expected redacted evidence:** `ok=false`, `errorCode=ambiguous_rotation` (HTTP 500); exactly one rotation POST, no automatic retry, and no second token-family operation. Because the server may have rotated successfully, do not assume the old token remains usable.
- **Teardown:** Query the disposable token metadata through the admin control plane, revoke every token in the disposable family including any replacement, verify `401` for each, and delete the fixture. If the outcome cannot be determined, fail the run and quarantine the fixture until an administrator confirms revocation.

## GitLab helper verification

Run this only against the isolated temporary credential state. The command must not print the helper’s secret field:

```bash
HELPER_OUTPUT="$(printf 'protocol=https\nhost=%s\n\n' "$GITLAB_HOST" \
  | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null)"
printf '%s\n' "$HELPER_OUTPUT" \
  | awk -F= '$1 == "protocol" || $1 == "host" || $1 == "username" { print }'
```

PASS: exit status is zero and the redacted output contains the expected disposable host/user. FAIL: treat rotation as `persistence_failed`; revoke the replacement token and remove the isolated helper state. Never print or store the `password` line.

## GitHub validity-only checks

GitHub is validity-only in AUTH-14: do not rotate or revoke a GitHub credential through this runbook. Use a disposable GitHub account/token and a readable test repository, or an isolated device-flow login, and follow the same create/verify/capture/revoke lifecycle.

### 9. GitHub valid credential

- **Setup:** An organization administrator provisions a disposable GitHub test account/repository and its disposable credential; authenticate an isolated `gh` config and verify test-repository read access.
- **Action:** Run both checks without refresh:

  ```bash
  gh auth status --json hosts --no-refresh
  gh api user | jq '{login}'
  ```

- **Expected redacted evidence:** `validity=valid`; expiry is `known-within-threshold` when trusted expiry metadata exists, otherwise `expiry=unknown` and `expiry_unknown=true`. `gh api user` succeeds. No rotation command is run.
- **Teardown:** Revoke/delete the disposable GitHub credential/account fixture, verify subsequent validity is not `valid`, and remove the isolated `gh` config.

### 10. GitHub invalid/revoked/expired credential

- **Setup:** Use the organization-admin-provisioned disposable credential after an administrator has revoked it or allowed it to expire; do not manufacture invalid output by editing logs.
- **Action:** Run the same two validity-only commands.
- **Expected redacted evidence:** `validity=invalid-revoked-expired`, `reauthorization_guidance` is present, and no token or command output containing a token is exposed.
- **Teardown:** Confirm the disposable credential is revoked/deleted and remove isolated state.

### 11. GitHub unknown/unreachable credential state

- **Setup:** Use an organization-admin-provisioned disposable GitHub account/credential in an isolated config and a controlled network fault (or test endpoint/network namespace) that makes GitHub unreachable. Do not use a production credential to test this path.
- **Action:** Run `gh auth status --json hosts --no-refresh` and `gh api user` once each.
- **Expected redacted evidence:** `validity=unreachable`, `expiry=unknown`, `expiry_unknown=true`, and no reauthorization guidance for a connectivity-only failure. No retry or rotation is attempted.
- **Teardown:** Restore connectivity, revoke/delete any disposable credential, and remove isolated state.

## Fail-closed completion gate

The run passes only when every applicable scenario has redacted evidence, exactly the expected request count, and a completed revoke/delete lifecycle. A failed, missing, ambiguous, or unredacted scenario fails the run.

Set `GITLAB_IMPERSONATION_ROTATION_CONFIRMED_HOSTS` only after the exact host version, disposable impersonation-token metadata, successful compatibility evidence, and helper verification have been reviewed. Keep it unset for all unconfirmed hosts. Do not rotate production tokens until this gate passes.

At the end, verify the working tree contains only the new runbook and that no token-like value was written to repository files, logs, shell history, or test artifacts.
