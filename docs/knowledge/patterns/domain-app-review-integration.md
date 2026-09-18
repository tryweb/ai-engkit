# Domain Application Review-Capability Integration

## Context

AI-EngKit provides a project-aware OpenCode runtime with domain knowledge and
skills. A domain application that wants AI-powered review or report output has
to choose how to reach that runtime: expose `opencode serve` directly, or put
a durable, authorized job API in front of it. This pattern documents the
second shape as a reusable reference architecture, based on a working
deployment ("ep-design") that uses the domain Compose overlay feature
([`DOMAIN_COMPOSE_OVERLAY.md`](../../DOMAIN_COMPOSE_OVERLAY.md)) so the
integration survives AI-EngKit upgrades, restarts, and database maintenance
recreates.

```text
External client
      |
      v
Domain API
  auth, authorization, idempotency, audit
      |
      v
Durable job queue
      |
      v
Domain worker
  approved capability -> skill/agent/model
  timeout, cancellation, retry, artifacts
      |
      v
AI-EngKit / OpenCode runtime
  project workspace + read-only knowledge and skills
```

## Problem

Calling OpenCode directly from an external client couples the public contract
to internal session, filesystem, agent, model, and credential details, and
makes it hard to enforce which project knowledge and skills a caller may use.
Hand-editing the AI-EngKit Compose file to wire in a domain worker is fragile:
Admin upgrades replace the base file and recreate `ai-dev`, silently dropping
the custom network and endpoint settings — the failure mode that motivated
the domain Compose overlay feature
([#72](https://github.com/tryweb/ai-engkit/issues/72)). What is missing is a
documented, reproducible shape for the domain side: where the worker attaches,
which OpenCode settings are required, how the worker authenticates, and how
the deployment is verified.

## Solution

Use the following contract as the default integration shape. The domain
project owns everything outside `ai-dev`; AI-EngKit owns the base runtime.

1. **Separate deployment ownership.** Run the domain application and
   AI-EngKit in independent Compose projects. Connect only the worker and
   the AI-EngKit runtime through a deliberately named external interop
   network. Do not publish the OpenCode port to the host when the worker is
   the only caller.
2. **Declare the integration in a domain overlay.** One overlay under
   `/opt/ai-engkit/extensions/` sets the OpenCode bind settings
   (`OPENCHAMBER_OPENCODE_HOSTNAME: 0.0.0.0`, `OPENCHAMBER_OPENCODE_PORT:
   "4095"`), attaches the interop network, and is selected via
   `AI_ENGKIT_COMPOSE_OVERLAY=<domain>.yml` in the installation `.env`. The
   overlay may only extend `ai-dev` with `environment`, `networks`, named
   `volumes`, `labels`, and `healthcheck` (see the overlay doc for the
   protected surface).
3. **Keep the public API domain-oriented.** Accept a capability such as
   `review.drawing` or `report.summary`, not an arbitrary skill name,
   filesystem path, agent, or model. The domain project maps each capability
   to an approved skill/agent/model/knowledge tuple server-side and denies
   every client-supplied execution-override parameter.
4. **Make execution asynchronous.** The API persists the job and idempotency
   record before returning `202`. The worker owns OpenCode authentication,
   session creation, prompt submission, timeout, cancellation, retry, lease
   recovery, and result persistence.
5. **Keep credentials server-owned.** The worker injects the OpenCode
   credential (HTTP basic auth, user `opencode`, password from the domain
   deployment environment) and redacts it from diagnostics. External callers
   never choose endpoint, project path, agent, model, or credential.
6. **Scope knowledge and skills to a project.** Provision
   `config/opencode/opencode.json` and the reviewer agent into the persistent
   named volume (or mount explicit skill/config files read-only). For
   Docker-out-of-Docker deployments use an absolute host path with a
   required-variable expression such as
   `${DOMAIN_REPO_DIR:?}/config/opencode/...`; never rely on a relative mount
   from the AI-EngKit Compose directory.
7. **Verify the contract statically and at runtime.** Static checks validate
   Compose topology, pins, mounts, and forbidden services. Runtime checks
   validate Compose project ownership, network attachments, API isolation,
   worker DNS, authenticated OpenCode access, and project provisioning. The
   reference implementation's verifier runs 11 checks and gates each
   deployment.
8. **Version the execution inputs.** Pin the AI-EngKit revision, image,
   domain skills, knowledge revision, and profile version so a result can be
   explained and reproduced.

### Capability boundary

The external API should expose a domain capability catalogue:

```text
review.drawing
  -> agent: drawing-reviewer
  -> skills: drawing-review
  -> knowledge: domain-repo@<revision>
  -> inputs: artifact references only
```

The client must not be able to replace any of those mappings. If a project
later needs a knowledge-reading API, expose topic- or search-level operations
with domain authorization; do not expose arbitrary filesystem paths.

## Why It Works

- The API/worker split prevents a slow or unavailable AI runtime from making
  request handling non-durable.
- The worker-only interop attachment prevents the public API from bypassing
  the execution policy and reaching OpenCode directly.
- The domain overlay makes the wiring declarative and upgrade-safe: Admin
  upgrades preserve it by construction instead of by post-upgrade
  reconciliation.
- Read-only knowledge and skill inputs prevent a review or report job from
  modifying the guidance it consumes.
- Server-owned capability mappings prevent arbitrary agent, model, project,
  and tool selection from becoming a remote execution surface.
- Independent Compose projects allow AI-EngKit upgrades and restarts without
  recreating the domain database, API, or worker containers.
- A verifier turns network and deployment assumptions into executable
  acceptance criteria instead of relying on operator memory.

## Side Effects / Tradeoffs

- This pattern is a **reference architecture**, not a drop-in framework:
  each domain still needs a capability catalogue, profile policy, knowledge
  layout, artifact policy, and verifier manifest.
- The reference implementation is single-domain and hardcodes domain names,
  paths, services, volumes, reviewer agent, and model. These must become
  configuration or a project manifest before supporting multiple domains.
- A shared OpenCode runtime can reduce cost but is not sufficient for strong
  tenant isolation. Prefer one project-scoped runtime and workspace first;
  introduce pooling only with gateway-enforced path, credential, memory,
  tool, quota, and audit isolation.
- Filesystem knowledge is simple and Git-traceable but does not provide
  semantic search or cross-project memory by itself.
- OpenCode lifecycle and cancellation remain worker concerns: persist session
  identity, apply request timeouts, translate domain cancellation to runtime
  abort, and reap abandoned sessions.

## Evidence

- The reference deployment uses independent domain and `ai-engkit` Compose
  projects joined by an external interop network; `api` and database stay on
  the application network, only the worker joins interop, and the managed
  OpenCode API listens on `4095` without a host publish.
- The live verifier passed **11/11** checks on the designated deployment
  host (topology, ownership, upstream pin, runtime attachments, API
  isolation, worker DNS, authenticated OpenCode access, project
  provisioning), plus **73/73** focused local tests; remote API and Admin
  health endpoints return `200`.
- The tracked AI base is pinned to the upstream v1.19.0 release commit; the
  deployment may run a newer patch (for example `v1.19.1`) via the
  installation `.env`, and the verifier's expected pin must match the
  deployed version.
- The overlay feature (preserving the domain overlay across upgrades,
  restarts, and database-maintenance recreates) landed upstream in the commit
  range `v1.18.13` (`96c2966`) → `52fcfec` with overlay-aware backups and
  rollback.

## Related Files

- `docs/DOMAIN_COMPOSE_OVERLAY.md`
- `docs/knowledge/architecture/` (design constraints and system boundaries)
- `src/admin/lib/upgrade.ts` (overlay-aware Admin upgrade)
- `docker-compose.yml` (AI-EngKit base)
- `upgrade.sh` (host upgrade path)

## Tags

- ai-engkit
- opencode
- domain-adapter
- capability-catalog
- compose-overlay
- network-isolation
- worker
- verification