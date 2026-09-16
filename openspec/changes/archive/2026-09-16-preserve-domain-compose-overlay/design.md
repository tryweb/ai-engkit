## Context

The existing Admin upgrade fetches an upstream `docker-compose.yml`, writes it to the active `/opt/ai-engkit/compose.yml`, and runs Compose with a single `-f` file. Restart and maintenance paths also reconstruct `ai-dev` from that single file. In production the active file is bind-mounted into `ai-admin`, while Docker-out-of-Docker makes file visibility and host path resolution explicit constraints.

The change extends the existing `admin-upgrade` contract; see `proposal.md` and the delta spec for the externally observable behavior.

## Goals / Non-Goals

**Goals:**

- Resolve one trusted local overlay and one upstream base into a deterministic effective Compose configuration.
- Reuse the same Compose-file resolution for upgrade, restart, and Admin-managed ai-dev recreation.
- Validate the effective configuration before mutating the live deployment.
- Preserve enough state to restore the previous effective configuration after recreate or health failure.
- Keep Admin-owned services and domain worker lifecycle ownership separate.
- Verify the actual OpenCode runtime variable names and endpoint behavior instead of treating a guessed environment variable as a listen address.

**Non-Goals:**

- Multiple overlays, ordering/conflict resolution, or an overlay editor.
- Automatic migration of arbitrary hand-edited Compose files.
- Starting, stopping, or backing up domain worker services owned by another Compose project.
- Allowing the overlay to replace the AI-EngKit image, entrypoint, Admin service, Docker socket policy, or other platform security boundaries.

## Decisions

### One explicit overlay reference

Use the singular `AI_ENGKIT_COMPOSE_OVERLAY` configuration value for the overlay path. Resolve it from the persisted local environment, canonicalize it, and require that it is a descendant of the fixed `/opt/ai-engkit/extensions/` directory mounted read-only into `ai-admin`. Do not accept a path or URL from the public upgrade request. The selected upstream base is staged at `/opt/ai-engkit/compose-upgrade-base.yml`, sharing the `/opt/ai-engkit` Compose project directory so relative host paths retain the installation-root semantics.

Alternative rejected: supporting a comma-separated list now. Multiple-file precedence and rollback ownership would make the first implementation harder to reason about without a demonstrated second overlay use case.

### Separate upstream base from domain-owned overlay

Fetch the selected upstream Compose content into `/opt/ai-engkit/compose-upgrade-base.yml` rather than writing it over the domain-owned overlay or active file. Invoke Compose with ordered base then overlay inputs so the overlay has the documented later-file precedence. Production Compose mounts the staging file from `./admin-data/upgrade-base.yml` and mounts `./extensions/` at `/opt/ai-engkit/extensions/`; installation/setup creates both host paths before the Admin container starts.

Alternative rejected: continue treating `/opt/ai-engkit/compose.yml` as both upstream cache and effective configuration. That is the direct source of the data-loss bug.

### Shared effective-file resolver

Create one tested resolution boundary that returns the validated Compose file arguments and overlay state. Upgrade, `restart-ai-dev`, DB maintenance, and agent-triggered ai-dev recreates must call this boundary instead of constructing `-f /opt/ai-engkit/compose.yml` independently.

Alternative rejected: patch only `runUpgrade()`. That would make the integration work after version upgrades but disappear after a later restart or maintenance recreate.

### Validate before mutation

First run `docker compose -f /opt/ai-engkit/extensions/<overlay> config --format json` against the overlay alone and inspect the normalized JSON: only `ai-dev` may be under `services`, only `environment`, `networks`, named `volumes`, `labels`, and `healthcheck` are allowed under that service, and host bind mounts are rejected. Only supported top-level network/volume declarations are accepted. Then run `docker compose -f /opt/ai-engkit/compose-upgrade-base.yml -f /opt/ai-engkit/extensions/<overlay> config --format json` and verify the expected `ai-dev` service exists. Keep validation output sanitized and use exit status plus safe diagnostics for reporting. This avoids relying on merged output to infer whether a protected field came from the overlay.

Alternative rejected: rely on `docker compose up` as validation. It can partially mutate the deployment before exposing a configuration error.

### Backup references and content together

The per-upgrade backup records the prior effective inputs, overlay reference, and required local configuration alongside the existing `.env`, provider keys, and OpenChamber settings. Backup directories are mode `0700` and sensitive files, including `.env`, provider keys, settings, and overlay content, are mode `0600`; no content or secret values are written to upgrade logs. Rollback restores all configuration inputs before rerunning Compose with the old effective arguments.

Alternative rejected: back up only the overlay path. The overlay may point to a file that changes independently, making rollback non-reproducible.

### Narrow ownership boundary

The overlay may extend the supported `ai-dev` integration surface with environment variables, networks, named volumes, labels, and healthchecks. Host bind mounts, including Docker socket mounts, are forbidden. It must not change `image`, `container_name`, `command`, `entrypoint`, ports, privilege settings, Admin services, or domain worker services. It must not manage the domain worker lifecycle; domain worker and external network creation remain the domain project's responsibility.

### Host upgrade bootstrap and safety

Because `upgrade.sh` is an independent destructive upgrade path and is also the bootstrap path for existing installations, it must use the same single-overlay policy. It downloads the target base to a temporary file, validates the overlay-only normalized JSON and the merged base-plus-overlay configuration on the host with `docker compose config --format json` plus `jq`, verifies the target base exposes the required overlay mounts, backs up the current effective inputs, then switches the base and recreates `ai-admin` and `ai-dev` with base plus overlay. Silent fallback to base-only behavior is forbidden. If the host lacks the required validator or the target base cannot expose the overlay, it must stop before replacing the active base.

## Risks / Trade-offs

- **[Risk] DooD path mismatch** → Mount the overlay into `ai-admin`, resolve canonical paths explicitly, and test both the Admin client path and host daemon bind-source behavior.
- **[Risk] Upstream changes the `ai-dev` service shape** → Require the expected service and fail closed when it is absent; verify the resulting network and endpoint contract.
- **[Risk] Compose merge semantics differ for sequences and volumes** → Validate the rendered config and add focused tests for networks, environment, volumes, labels, and healthchecks.
- **[Risk] Container rollback cannot be truly atomic** → Stage and validate first, back up all inputs, attempt restoration of every input before rerunning Compose, and report incomplete rollback explicitly.
- **[Risk] Overlay grants excessive container privileges** → Keep the supported surface narrow, reject or explicitly gate privileged/security-sensitive overrides, and never expose arbitrary path selection through a public API.
- **[Risk] Runtime variable names are wrong** → Confirm `OPENCODE_PORT`, `OPENCHAMBER_OPENCODE_HOSTNAME`, and related settings against the current runtime and verify with an actual authenticated health/job check.
- **[Trade-off] `upgrade.sh` parity increases scope** → Require `jq` as a host prerequisite for overlay-aware upgrades and fail before mutation when the validator or required mounts are unavailable.

## Migration Plan

1. Existing installations without an overlay continue using the current single-file behavior.
2. Installations with domain customizations create the documented local overlay and mount it into `ai-admin` before enabling the overlay setting.
3. The first overlay-aware upgrade validates the merged configuration without recreating on failure.
4. On recreate or health failure, attempt to restore every pre-upgrade effective input and restart the previous configuration; surface any partial rollback.
5. Verify the ep-design contract: shared external network, `ai-dev:4095` reachability, OpenCode runtime configuration, skill discovery, and a real job.
6. If an installation must roll back the feature, remove the overlay setting only after restoring or intentionally accepting the base-only Compose configuration.
