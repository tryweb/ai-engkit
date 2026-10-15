# Third-Party License Scope (MIT boundary, oh-my-openagent, notices in the image)

## Context

AI-EngKit is published under a plain MIT `LICENSE`, and both the git repository
(`github.com/tryweb/ai-engkit`) and the container images (`ghcr.io/tryweb/...`,
pushed by `ci.yml`/`promote.yml`) are public. Two third-party relationships are
tied to `code-yeongyu`:

- **oh-my-openagent** (a.k.a. `oh-my-opencode`) is the V1 agent layer. It is
  **not** MIT: npm reports `license: "SUL-1.0"` (Sustainable Use License 1.0,
  a source-available license, not OSI open source). GitHub's API reports
  `NOASSERTION` because the terms live in `LICENSE.md`.
- **`@code-yeongyu/comment-checker`** is MIT.

This matters whenever content is copied out of those projects into files that
AI-EngKit then redistributes.

## Problem

SUL-1.0 grants copy/modify/derivative rights and permits "your own internal
business purposes", but its **distribution** conditions are narrow: distribute
only free of charge for non-commercial purposes, keep all licensing/copyright
notices, and — if you modified the software — ship a prominent notice saying so.
It grants no sublicense right.

AI-EngKit distributed oh-my-openagent-derived content while claiming MIT for the
whole repository:

- The two V2 behavioral plugins were written under `trial/` and one of them
  reproduced an upstream directive prompt **verbatim**, including the upstream
  product name (`[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO_CONTINUATION]`).
- Several plugin files carried `mirrors fork ...` headers, and the error
  classifier's matcher tables were adapted from upstream's model-core.
- `.opencode/omo.jsonc.default` is a curated copy of oh-my-openagent's default
  agent configuration (agent roster, permission matrix, model chains) and is
  baked into **both** image lines.
- There was no `THIRD-PARTY-NOTICES` file at all, so a recipient of the image or
  the repo received SUL-governed material with no SUL terms.

A misleading MIT claim is the real liability: MIT grants rights AI-EngKit does
not hold for that content.

## Solution

Keep the boundary explicit and pass the upstream terms through.

1. **Promote the plugins out of `trial/`.** `trial/` reads as disposable
   experiment output, but these are shipped product code. They now live in
   `src/v2-plugins/{b1-routing,m3-enforcer}/`; the Docker build copies them from
   there. Image-internal paths (`/opt/opencode/v2-plugins/*.js`) are unchanged,
   so the deploy script, the CI smoke and `test/test-v2.sh` needed no edits.
2. **Rewrite the verbatim prompt.** `m3-enforcer/constants.ts` now uses
   AI-EngKit's own wording with a neutral `[SYSTEM DIRECTIVE: TODO_CONTINUATION]`
   header. The `TODO_PREFIX` storage namespace (`omo-v2:todos:`) is deliberately
   unchanged — it is an opaque KV key, and changing it would orphan todos already
   written into existing volumes.
3. **Keep functional matcher data, drop the borrowed prose.**
   `b1-routing/error-classifier.ts` keeps its pattern tables (they match literal
   provider/SDK error strings; editing them would silently change fallback
   behavior) and documents them as functional matching data.
4. **Add `THIRD-PARTY-NOTICES.md`** with the SUL-1.0 full text, the MIT notices
   for the bundled MIT components, and an explicit modification notice for the
   derived `omo.jsonc.default`.
5. **Scope the MIT claim.** `LICENSE` carries an addendum and `README.md` links
   the notices; neither re-licenses third-party content.
6. **Ship the notices with the image.** `omo.jsonc.default` is baked into the
   image, so the image is a distribution of SUL material. `.dockerignore` excludes
   `*.md`, so it needs `!THIRD-PARTY-NOTICES.md`, and the Dockerfile copies
   `LICENSE THIRD-PARTY-NOTICES.md` to `/etc/opencode/`, next to the derived
   config they cover.

## Why It Works

The SUL "Notices" clause is satisfied per-distribution: the repository carries
`THIRD-PARTY-NOTICES.md`, and the image carries it at
`/etc/opencode/THIRD-PARTY-NOTICES.md` beside the derived file. Removing the
verbatim prompt and the "mirrors fork" framing leaves the plugins as independent
implementations of the same ideas, and the notices file records the one artifact
that is still a derivative (`omo.jsonc.default`).

## Side Effects / Tradeoffs

- **The change was not image-verified in-sandbox.** `RUN` steps cannot execute in
  this DooD environment, so the full `docker compose -f docker-compose.v2.dev.yml
  build` fails at the first `RUN` regardless of these edits. The `.dockerignore`
  negation was verified with a `RUN`-free `busybox` build instead (see Evidence).
  CI (`build-v2`) is the real check.
- **Residual upstream references on the V2 line.** The V2 image still contains
  `/etc/opencode/omo.jsonc.default` (unused: every OMO path is gated on
  `OMO_ENABLED != 0`) and `opencode.json.default` still declares
  `plugin: ["oh-my-openagent@4.19.4"]`. Neither is OMO code, the runtime rewrites
  `opencode.json` to a plugin-free config, and `test/test-v2.sh cell1` asserts
  `~/.omo/omo.jsonc` does not exist. Dropping the derived config from the V2 line
  is an optional hygiene step, not a compliance requirement, once the terms ship.
- **Licensing analysis, not legal advice.**
- `trial/*.md` verification records still quote the old prompt verbatim. They are
  kept as historical evidence rather than rewritten.

## Evidence

- `npm view oh-my-openagent license` → `SUL-1.0` (v5.1.33); GitHub API license →
  `NOASSERTION` with `LICENSE.md`.
- `.dockerignore` negation, proven by a `RUN`-free build:
  - with `!THIRD-PARTY-NOTICES.md` → image contains `LICENSE` and
    `THIRD-PARTY-NOTICES.md` under `/etc/opencode/`.
  - without it → `"/THIRD-PARTY-NOTICES.md": not found`.
- `bun build src/v2-plugins/*/index.ts --external @opencode/plugin` succeeds;
  `bun test src/v2-plugins/b1-routing/` → 16 pass / 0 fail.
- `grep -rn 'OH-MY-OPENCODE\|mirrors\|fork' src/v2-plugins/` → no matches.
- Image `RUN` failure in-sandbox:
  `runc run failed ... libnetwork-setkey: Error loading shared library libnftables.so.1`.

## Related Files

- `THIRD-PARTY-NOTICES.md`
- `LICENSE`, `README.md`
- `.dockerignore`, `Dockerfile`
- `src/v2-plugins/b1-routing/`, `src/v2-plugins/m3-enforcer/`
- `.opencode/omo.jsonc.default`
- `entrypoint.d/02-init-config.sh` (OMO gating), `entrypoint.d/08-deploy-v2-plugins.sh`
- `docs/knowledge/tooling/v2-plugin-bake.md`

## Tags

- licensing
- third-party-notices
- sustainable-use-license
- oh-my-openagent
- v2-line
- docker-image-contents
