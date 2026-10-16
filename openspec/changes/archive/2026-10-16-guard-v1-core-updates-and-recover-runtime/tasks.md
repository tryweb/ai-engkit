# Tasks

## 1. Core update refusal guards

- [x] 1.1 Apply a version-checked downstream guard to the pinned OpenChamber web update-install route so it returns HTTP 409 with JSON `{error}` before any success acknowledgement or install scheduling. Verify with a direct POST that the response is 409 and no installer process is spawned.
- [x] 1.2 Guard the `openchamber update` CLI so it exits nonzero with a managed-install explanation. Verify the CLI exits nonzero and prints the explanation instead of invoking the global install.
- [x] 1.3 Guard the OpenChamber-managed OpenCode upgrade endpoint with the same refusal. Verify a direct request to that endpoint is rejected and no upgrade runs.
- [x] 1.4 Make the image build fail when the pinned upstream source version or shape does not match the expected anchors. Verify a deliberately mismatched fixture fails the build with a diagnostic.
- [x] 1.5 Keep OpenChamber update discovery available while refusing installation; leave the separate OpenCode notification preference untouched. Verify on the same fixture that GET update-check reports `available: true` and POST update-install returns 409.
- [x] 1.6 Add an end-to-end browser test that an authenticated user clicking the update action sees the refusal and no installation spawns. Verify the test observes a 409-backed refusal and a zero installer process count.
- [x] 1.7 Update the self-update architecture note to record the synchronous refusal behavior. Verify the note describes the 409-before-success contract and the CLI nonzero exit.

## 2. Managed core isolation and packaging

- [x] 2.1 Install the managed core into a dedicated image-owned prefix with its full transitive, platform-specific, and symlinked dependency closure. Verify the launch executable resolves through the existing PATH with no missing closure element.
- [x] 2.2 Keep launch wrappers compatible with the current PATH and existing script consumers. Verify each current script consumer of the core still runs against the dedicated prefix.
- [x] 2.3 Keep `BUN_PACKAGES` in the user prefix and reject reserved core names in startup install requests before any install, without globally wrapping Bun. Verify unrelated packages leave core hashes unchanged and mixed requests containing a reserved name fail before mutation.
- [x] 2.4 Account for the `bun` executable being supplied by the user prefix. Verify the core launch resolves `bun` from the user prefix and still starts.
- [x] 2.5 Document the dedicated prefix, closure, and isolation boundary in the packaging docs. Verify the documented layout matches the built image.

## 3. Integrity manifest, offline artifact, and recovery

- [x] 3.1 Bake the fully patched core archive, explicit pins, and integrity manifest including contents, modes, link targets and path inventory. Verify root ownership survives boot permission-fixing and that restore retains the update guards.
- [x] 3.2 Emit expected core versions and identifiers from Docker build arguments as build metadata, and read them at runtime instead of parsing the repository. Verify the runtime reads metadata and the running container has no source checkout dependency.
- [x] 3.3 Implement integrity verification and exact-tree restore via a staging directory followed by an atomic switch, with no partially restored core ever active. Verify a partial install and a same-version drift both restore to the exact pinned tree with a matching hash.
- [x] 3.4 Reject missing/corrupt recovery artifacts before replacing active core, and validate exact-tree inventory and staged link containment. Verify corrupt-archive, extra-file, unsafe-link and interrupted-stage fixtures either recover from a valid source or refuse without activating unverified files.
- [x] 3.5 Ensure recovery uses only image-local artifacts with no network reinstall. Verify recovery succeeds with the network disconnected.
- [x] 3.6 Ensure recovery is idempotent. Verify a second run on an already-recovered core reports clean and changes no unrelated files.
- [x] 3.7 Document the offline archive, manifest, and recovery contract. Verify the documentation names the artifact paths and the no-network guarantee.

## 4. Startup ordering and ai-admin exclusion

- [x] 4.1 Order verification and recovery before `01-install-packages`, before configuration generation and application, and before application startup. Verify with a drifted core that recovery completes before the user-package and config stages run.
- [x] 4.2 Ensure the recovery path is not activated for the `ai-admin` command. Verify starting `ai-admin` does not run core recovery.

## 5. Managed CLI selection repair

- [x] 5.1 Repair only the known image-managed or missing legacy path `~/.opencode/bin/opencode`, writing atomically and taking a protected backup. Verify a stale or missing managed path is repaired and the backup exists.
- [x] 5.2 Preserve unrelated fields, file permissions, and valid custom selections during repair. Verify a custom selection and the file mode are unchanged after repair.
- [x] 5.3 Treat an unknown missing custom path as an explicit error and never overwrite it. Verify startup reports the error and leaves the selection untouched.
- [x] 5.4 Reject an existing custom v2 executable, malformed settings, or symlinked settings without replacing them. Verify absent selection uses managed PATH, the old image wrapper still resolves, backups are protected/idempotent, and custom path bytes/modes are preserved.
- [x] 5.5 Document the repair scope and the unknown-path error. Verify the docs state the narrow scope and the backup behavior.

## 6. Data compatibility gate

- [x] 6.1 Capture pinned and supported older-v1 schema/migration identities from disposable fixtures as build metadata. Verify both unchanged and newly populated session fixtures are recognized without content-hash matching.
- [x] 6.2 Implement a read-only gate that allows an absent or fresh database and a recognized v1 database. Verify both a fresh start and a recognized v1 database boot.
- [x] 6.3 Block a v2 or unknown schema with the data files untouched, without starting the old binary to probe the database. Verify startup refuses and all data file hashes are unchanged.
- [x] 6.4 Inspect only a private stable copy of database and matching WAL/SHM files, checking source consistency and cleaning inspection copies. Verify WAL-only schema changes are detected; original database/sidecar hashes and mtimes remain unchanged; unstable copies and unexplained orphan sidecars are refused.
- [x] 6.5 Block locked, corrupt, or unknown databases with operator recovery guidance. Verify each case blocks startup and prints guidance.
- [x] 6.6 Ensure no database backup is restored and no session is deleted automatically. Verify the refusal path restores no backup and deletes no session.
- [x] 6.7 Document the compatibility gate, the recognized-v1 baseline, and the refusal guidance. Verify the docs describe the read-only contract and the preserved-data guarantee.

## 7. Startup failure behavior

- [x] 7.1 Implement a signal-responsive blocked state that skips application/config/user-package startup after preflight refusal. Verify `restart: unless-stopped` does not repeatedly restart the container, application health is not successful, no retries mutate state, and explicit remediation/restart can recover.
- [x] 7.2 Document blocked-state diagnosis, restart versus recreate, image-based upgrade, and sudo/Docker bypass and data-downgrade limitations in the operator recovery guide. Verify examples use effective deployment inputs and never recommend automatic volume/database rollback.

## 8. Integration verification

- [x] 8.1 Verify an authenticated browser update click produces the refusal and spawns no installation, and the managed core hash is unchanged.
- [x] 8.2 Verify direct HTTP and CLI refusal paths: the web endpoint returns 409 JSON `{error}` and the CLI exits nonzero.
- [x] 8.3 Verify disconnected-network restart and recreate using disposable volumes only: recovery restores the exact pinned core with no network reinstall in both cases.
- [x] 8.4 Verify repeated recovery across restart and recreate is idempotent and preserves unrelated data.
- [x] 8.5 Verify application health and that an existing session remains readable after recovery.
- [x] 8.6 Verify an existing healthy v1 configuration and database still boots unchanged.

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Verify the archived result and that `openspec validate --strict` still passes.
