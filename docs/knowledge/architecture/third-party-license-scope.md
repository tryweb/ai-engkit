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
  agent configuration (agent roster, permission matrix, model chains) and was
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
6. **Ship the notices with the image.** Both image lines bundle MIT-licensed
   baked components and the V1 line also carries the SUL-derived
   `omo.jsonc.default`, so the image is a distribution of third-party material.
   `.dockerignore` excludes `*.md`, so it needs `!THIRD-PARTY-NOTICES.md`, and
   the Dockerfile copies `LICENSE THIRD-PARTY-NOTICES.md` to `/etc/opencode/`,
   next to the derived config they cover.
7. **Keep the derived config off the V2 line.** The V2 line carries no OMO (D1),
   so the Dockerfile writes `omo.jsonc.default` only when the V1 CLI is in use,
   and the default `opencode.json` ships an empty plugin list on V2. The file is
   supplied to that `RUN` with `--mount=type=bind` rather than `COPY`: a `COPY`
   would put it in a layer on *both* lines, and a later `rm` would only white it
   out — the blob would still ship inside the image.

## Why It Works

The SUL "Notices" clause is satisfied per-distribution: the repository carries
`THIRD-PARTY-NOTICES.md`, and the image carries it at
`/etc/opencode/THIRD-PARTY-NOTICES.md` beside the derived file. Removing the
verbatim prompt and the "mirrors fork" framing leaves the plugins as independent
implementations of the same ideas, and the notices file records the remaining
derivative (`omo.jsonc.default`), which now exists only on the V1 line. The V2
image carries no oh-my-openagent-derived content at all.

## Side Effects / Tradeoffs

- **Do not "remove" a file with a later `rm`.** Docker layers are immutable: an
  `rm` in a later instruction only writes a whiteout, and the deleted bytes still
  ship in the earlier layer's blob. To keep a file out of an image, never write
  it there — gate the `COPY`/`RUN` that creates it (here: a bind-mounted `RUN`
  keyed on the V1/V2 discriminator).
- **`RUN --mount=type=bind` requires BuildKit.** That is already a hard
  requirement in this Dockerfile (`RUN <<'EOF'` heredocs), so the mount adds no
  new constraint; a legacy (`DOCKER_BUILDKIT=0`) build was already impossible.
- **Reference-only OMO strings remain in the V2 image.** The baked
  `/docker-compose.yml` still names the V1 `omo-config` / `ohmyopencode-cache`
  volumes, and `AGENTS.md.default` mentions OMO in prose. Both are AI-EngKit's own
  V1 artifacts carried for reference and contain no upstream-derived content.
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
- **V2 image, built with the compose args** (`docker build --network=host`, the
  flag `docker compose build` cannot pass):
  - `/etc/opencode/THIRD-PARTY-NOTICES.md` and `LICENSE` present; notices contain
    "Sustainable Use License".
  - `/opt/opencode/v2-plugins/{b1-routing,m3-enforcer}.js` rebuilt from
    `src/v2-plugins/`; the shipped `m3-enforcer.js` contains
    `SYSTEM DIRECTIVE: TODO_CONTINUATION` and zero occurrences of
    `OH-MY-OPENCODE`.
  - `/etc/opencode/omo.jsonc.default` **absent**, and `/etc/opencode/opencode.json.default`
    declares `plugin: []`.
- **V1 image** (same Dockerfile, `OPENCODE_CLI_PACKAGE=opencode-ai`):
  `/etc/opencode/omo.jsonc.default` present and `opencode.json.default` declares
  `plugin: ["oh-my-openagent@4.19.4"]` — `test/run-tests.sh` §8.3.1 still passes.

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
