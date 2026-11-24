# OpenCode Provider Catalog Is Not the Connected Provider Set

> Historical V1/OMO context below; V2 no longer loads the OMO plugin.

## Context

OpenCode exposes provider information through the managed server `GET /provider` API. The response contains both `connected` provider IDs and an `all` provider/model catalog.

## Problem

Treating every entry in `.all` as a provider configured for the environment produces false conclusions. The catalog can contain hundreds of providers and models that are known to OpenCode but are not connected or authenticated in the running environment.

For example, on `192.168.11.195`, OpenChamber showed one actual provider, `OpenCode Zen` (`opencode`), with seven models, while the raw `.all` catalog also listed `openai`, `vercel`, `nvidia`, and many other providers.

## Solution

Determine the active provider set from `.connected` first, then intersect it with `.all`:

```text
connectedProviders = response.connected
activeProviders = response.all where provider.id is in connectedProviders
activeModels = activeProviders[].models
```

The repository implementation follows this rule in `parseProviderSnapshot()`: it builds a set from `parsed.connected` and only adds models from providers in that set.

## Why It Works

- `connected` represents the providers OpenCode currently reports as connected.
- `all` is the global provider/model registry and is useful for discovery, not proof of configuration or authentication.
- A model should be labelled `request-verified` only after a successful assistant message returns its `providerID` and `modelID`.
- The OpenChamber UI provider list is a useful cross-check for the user-visible configured provider set.

## Side Effects / Tradeoffs

- Provider connectivity can change after authentication, logout, provider refresh, or container restart; query the live endpoint rather than relying on a stale cache.
- A connected provider's catalog still does not prove that every listed model will successfully answer a request; use a real request probe for final validation.
- `auth.json` alone is not a complete authority: OpenCode may report a connected provider through another supported configuration or session mechanism.

## Evidence

- `192.168.11.195` OpenChamber displayed `Total 1`, `OpenCode Zen`, provider ID `opencode`, and `Available Models (7)`.
- The same environment's live `/provider` response reported `connected: ["opencode"]` during that observation, while `.all` contained many additional providers.
- A later live query demonstrated that the connected set can change; the correct report must always use the current `.connected` value.
- The seven `opencode` models observed were `big-pickle`, `hy3-free`, `mimo-v2.5-free`, `muse-spark-1.2-contributor-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, and `x-preview-f-free`.

## Related Files

- `src/admin/lib/agent-model-live.ts` — live provider snapshot parsing and connected-model filtering.
- `Dockerfile` — installs OpenCode and the Admin Dashboard into the shared image.
- `.opencode/omo.jsonc.default` — OMO agent model defaults; not a live provider inventory.
- `entrypoint.d/02-init-config.sh` — persistent OMO/OpenCode configuration initialization.

## Tags

`opencode`, `provider`, `connected`, `catalog`, `authentication`, `model-discovery`, `openchamber`
