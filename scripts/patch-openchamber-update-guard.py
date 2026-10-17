# allow: SIZE_OK — version-pinned patch tables for 1.24.2 and 2.3.3 are pure data and must remain inline for fail-closed auditability; splitting would hide anchor drift contract.
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
# How to run:
#   OPENCHAMBER_PACKAGE_DIR=/path/to/@openchamber/web \
#   OPENCHAMBER_EXPECTED_VERSION=1.24.2 \
#   python3 scripts/patch-openchamber-update-guard.py
"""Apply AI-EngKit core update guards to a pinned OpenChamber web package.

The AI-EngKit image is the single authoritative source of the pinned core.
This build-time patcher makes the installed ``@openchamber/web`` package refuse
every self-update path so a running container cannot replace the core out from
under the image pin:

1. ``POST /api/openchamber/update-install`` -> HTTP 409 before the original
   handler runs, so no success acknowledgement and no detached installer spawn.
2. ``executeUpdate`` (the ``openchamber update`` CLI seam) -> returns
   ``{success: false, exitCode: 1}`` without spawning, so the CLI exits nonzero.
3. ``POST /api/opencode/upgrade`` (OpenChamber-managed OpenCode upgrade) -> HTTP
   409 before the original handler runs, so it never forwards ``/global/upgrade``.

The patch is version-checked and anchor-checked. It fails closed: a wrong
package version, a missing or non-unique source anchor, or an unknown/partial
already-patched state aborts with a diagnostic and writes nothing. Re-running it
against an already-patched package is a no-op.

Usage:
    OPENCHAMBER_PACKAGE_DIR=DIR OPENCHAMBER_EXPECTED_VERSION=VER \
      python3 patch-openchamber-update-guard.py
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

SENTINEL = "// AI-ENGKIT-UPDATE-GUARD: begin"
MANAGED_ERROR = (
    "This OpenChamber core is image-managed by AI-EngKit; self-update is refused. "
    "Deploy a new AI-EngKit image to upgrade."
)


@dataclass(frozen=True)
class Patch:
    rel_path: str
    anchor: str
    patched: str


# v1.24.2 patches — exact anchors from the pinned v1 package
PATCHES_V1: tuple[Patch, ...] = (
    Patch(
        rel_path="server/lib/opencode/openchamber-routes.js",
        anchor=(
            "export const registerOpenChamberRoutes = (app, dependencies) => {\n"
            "  const {\n"
        ),
        patched=(
            "export const registerOpenChamberRoutes = (app, dependencies) => {\n"
            "  // AI-ENGKIT-UPDATE-GUARD: begin - the AI-EngKit core is image-managed; refuse web self-update.\n"
            "  app.post('/api/openchamber/update-install', (_req, res) => {\n"
            "    res.status(409).json({\n"
            "      success: false,\n"
            "      code: 'CORE_UPDATE_MANAGED_BY_IMAGE',\n"
            f"      error: '{MANAGED_ERROR}',\n"
            "    });\n"
            "  });\n"
            "  // AI-ENGKIT-UPDATE-GUARD: end\n"
            "\n"
            "  const {\n"
        ),
    ),
    Patch(
        rel_path="server/lib/package-manager.js",
        anchor=(
            "/**\n"
            " * Execute the update (used by CLI)\n"
            " */\n"
            "export function executeUpdate(pm = detectPackageManager(), options = {}) {\n"
            "  const command = getUpdateCommand(pm);\n"
            "  if (!options?.silent) {\n"
            "    console.log(`Updating ${PACKAGE_NAME} using ${pm}...`);\n"
            "    console.log(`Running: ${command}`);\n"
            "  }\n"
            "\n"
            "  const result = spawnSync(command, {\n"
            "    stdio: 'inherit',\n"
            "    shell: true,\n"
            "    ...getSpawnSyncBaseOptions(),\n"
            "  });\n"
            "\n"
            "  return {\n"
            "    success: result.status === 0,\n"
            "    exitCode: result.status,\n"
            "  };\n"
            "}\n"
        ),
        patched=(
            "/**\n"
            " * Execute the update (used by CLI)\n"
            " */\n"
            "export function executeUpdate(_pm = detectPackageManager(), _options = {}) {\n"
            "  // AI-ENGKIT-UPDATE-GUARD: begin - the AI-EngKit core is image-managed; refuse CLI self-update.\n"
            "  console.error('This OpenChamber core is image-managed by AI-EngKit; self-update is refused. Deploy a new AI-EngKit image to upgrade.');\n"
            "  return {\n"
            "    success: false,\n"
            "    exitCode: 1,\n"
            "  };\n"
            "}\n"
        ),
    ),
    Patch(
        rel_path="server/lib/opencode/routes.js",
        anchor=(
            "  let openCodeUpgradePromise = null;\n"
            "\n"
            "  app.post('/api/opencode/upgrade', async (req, res) => {\n"
        ),
        patched=(
            "  let openCodeUpgradePromise = null;\n"
            "\n"
            "  // AI-ENGKIT-UPDATE-GUARD: begin - the AI-EngKit core is image-managed; refuse managed OpenCode upgrade.\n"
            "  app.post('/api/opencode/upgrade', (_req, res) => {\n"
            "    res.status(409).json({\n"
            "      success: false,\n"
            "      code: 'CORE_UPDATE_MANAGED_BY_IMAGE',\n"
            f"      error: '{MANAGED_ERROR}',\n"
            "    });\n"
            "  });\n"
            "  // AI-ENGKIT-UPDATE-GUARD: end\n"
            "\n"
            "  app.post('/api/opencode/upgrade', async (req, res) => {\n"
        ),
    ),
)

# v2.3.3 patches — adapted anchors for the v2 line (same refusal semantics)
PATCHES_V2: tuple[Patch, ...] = (
    Patch(
        rel_path="server/lib/opencode/openchamber-routes.js",
        anchor=(
            "export const registerOpenChamberRoutes = (app, dependencies) => {\n"
            "  const {\n"
        ),
        patched=(
            "export const registerOpenChamberRoutes = (app, dependencies) => {\n"
            "  // AI-ENGKIT-UPDATE-GUARD: begin - the AI-EngKit core is image-managed; refuse web self-update.\n"
            "  app.post('/api/openchamber/update-install', (_req, res) => {\n"
            "    res.status(409).json({\n"
            "      success: false,\n"
            "      code: 'CORE_UPDATE_MANAGED_BY_IMAGE',\n"
            f"      error: '{MANAGED_ERROR}',\n"
            "    });\n"
            "  });\n"
            "  // AI-ENGKIT-UPDATE-GUARD: end\n"
            "\n"
            "  const {\n"
        ),
    ),
    Patch(
        rel_path="server/lib/package-manager.js",
        anchor=(
            "/**\n"
            " * Execute the update (used by CLI).\n"
            " * When an exact target version is given, the globally installed version is\n"
            " * read back after the package manager exits: a zero exit status alone is not\n"
            " * proof the target landed (stale dist-tag resolution, pnpm release-age policy),\n"
            " * and the caller must not report success without the version matching.\n"
            " */\n"
            "export function executeUpdate(pm = detectPackageManager(), options = {}) {\n"
            "  const command = getUpdateCommand(pm, { targetVersion: options.targetVersion });\n"
            "  if (!options?.silent) {\n"
            "    console.log(`Updating ${PACKAGE_NAME} using ${pm}...`);\n"
            "    console.log(`Running: ${command}`);\n"
            "  }\n"
            "\n"
            "  const result = spawnSync(command, {\n"
            "    stdio: 'inherit',\n"
            "    shell: true,\n"
            "    ...getSpawnSyncBaseOptions(),\n"
            "  });\n"
            "\n"
            "  if (result.status !== 0) {\n"
            "    return {\n"
            "      success: false,\n"
            "      exitCode: result.status,\n"
            "      error: `Package manager exited with code ${result.status}`,\n"
            "    };\n"
            "  }\n"
            "\n"
            "  const targetVersion = normalizeTargetVersion(options.targetVersion);\n"
            "  if (!targetVersion) {\n"
            "    return {\n"
            "      success: true,\n"
            "      exitCode: result.status,\n"
            "      installedVersion: null,\n"
            "    };\n"
            "  }\n"
            "\n"
            "  const installedVersion = getInstalledGlobalVersion(pm);\n"
            "  if (!installedVersion) {\n"
            "    return {\n"
            "      success: false,\n"
            "      exitCode: result.status,\n"
            "      error: `Could not determine the globally installed ${PACKAGE_NAME} version after the update; not reporting success`,\n"
            "    };\n"
            "  }\n"
            "\n"
            "  if (compareVersions(installedVersion, targetVersion) !== 0) {\n"
            "    return {\n"
            "      success: false,\n"
            "      exitCode: result.status,\n"
            "      error: `Installed ${PACKAGE_NAME} version ${installedVersion} does not match target ${targetVersion}. The package manager may have resolved different metadata or filtered the release.`,\n"
            "    };\n"
            "  }\n"
            "\n"
            "  return {\n"
            "    success: true,\n"
            "    exitCode: result.status,\n"
            "    installedVersion,\n"
            "  };\n"
            "}\n"
        ),
        patched=(
            "/**\n"
            " * Execute the update (used by CLI).\n"
            " * When an exact target version is given, the globally installed version is\n"
            " * read back after the package manager exits: a zero exit status alone is not\n"
            " * proof the target landed (stale dist-tag resolution, pnpm release-age policy),\n"
            " * and the caller must not report success without the version matching.\n"
            " */\n"
            "export function executeUpdate(_pm = detectPackageManager(), _options = {}) {\n"
            "  // AI-ENGKIT-UPDATE-GUARD: begin - the AI-EngKit core is image-managed; refuse CLI self-update.\n"
            "  console.error('This OpenChamber core is image-managed by AI-EngKit; self-update is refused. Deploy a new AI-EngKit image to upgrade.');\n"
            "  return {\n"
            "    success: false,\n"
            "    exitCode: 1,\n"
            "  };\n"
            "}\n"
        ),
    ),
    Patch(
        rel_path="server/lib/opencode/routes.js",
        anchor=(
            "  let upgradeInFlight = null;\n"
            "  app.post('/api/opencode/upgrade', async (_req, res) => {\n"
        ),
        patched=(
            "  let upgradeInFlight = null;\n"
            "  // AI-ENGKIT-UPDATE-GUARD: begin - the AI-EngKit core is image-managed; refuse managed OpenCode upgrade.\n"
            "  app.post('/api/opencode/upgrade', (_req, res) => {\n"
            "    res.status(409).json({\n"
            "      success: false,\n"
            "      code: 'CORE_UPDATE_MANAGED_BY_IMAGE',\n"
            f"      error: '{MANAGED_ERROR}',\n"
            "    });\n"
            "  });\n"
            "  // AI-ENGKIT-UPDATE-GUARD: end\n"
            "  app.post('/api/opencode/upgrade', async (_req, res) => {\n"
        ),
    ),
)

# Default alias for backwards compat (v1)
PATCHES = PATCHES_V1

# Version -> patches mapping for fail-closed selection
VERSION_PATCHES: dict[str, tuple[Patch, ...]] = {
    "1.24.2": PATCHES_V1,
    "2.3.3": PATCHES_V2,
    # 2.4.0 keeps the v2 line's source shape: the PATCHES_V2 anchors apply
    # unchanged (verified against the @openchamber/web@2.4.0 tarball). Anchor
    # drift on any future version still fails the build closed.
    "2.4.0": PATCHES_V2,
}


def patches_for_version(version: str) -> tuple[Patch, ...]:
    patches = VERSION_PATCHES.get(version)
    if patches is None:
        raise PatchError(
            f"unsupported pinned version {version!r}; "
            f"supported: {', '.join(sorted(VERSION_PATCHES))}"
        )
    return patches


class PatchError(RuntimeError):
    """A fail-closed condition that must abort the build with a diagnostic."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def check_version(package_dir: Path, expected_version: str) -> None:
    manifest = package_dir / "package.json"
    if not manifest.is_file():
        raise PatchError(f"missing package manifest: {manifest}")
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PatchError(f"unparseable package manifest {manifest}: {exc}") from exc
    if not isinstance(data, dict):
        raise PatchError(f"package manifest root must be an object: {manifest}")
    actual = data.get("version")
    if actual != expected_version:
        raise PatchError(
            f"pinned OpenChamber version mismatch: package.json has {actual!r}, "
            f"expected {expected_version!r}"
        )


def classify(patch: Patch, text: str, path: Path) -> str:
    """Return 'apply' or 'already' for a file, raising on any drift."""
    count = text.count(SENTINEL)
    if count > 1:
        raise PatchError(
            f"{path}: found {count} update-guard markers; expected at most one"
        )
    if count == 1:
        if patch.patched not in text:
            raise PatchError(
                f"{path}: partial or unknown already-patched state "
                "(guard marker present but full guard block is not intact)"
            )
        return "already"
    anchor_count = text.count(patch.anchor)
    if anchor_count == 0:
        raise PatchError(f"{path}: expected source anchor not found (anchor drift)")
    if anchor_count > 1:
        raise PatchError(
            f"{path}: source anchor is not unique ({anchor_count} matches)"
        )
    return "apply"


def main() -> int:
    package_dir_value = os.environ.get("OPENCHAMBER_PACKAGE_DIR")
    expected_version = os.environ.get("OPENCHAMBER_EXPECTED_VERSION")
    if not package_dir_value or not expected_version:
        print(
            "[update-guard] ERROR: OPENCHAMBER_PACKAGE_DIR and "
            "OPENCHAMBER_EXPECTED_VERSION are required",
            file=sys.stderr,
        )
        return 1

    package_dir = Path(package_dir_value).resolve()
    try:
        check_version(package_dir, expected_version)
        patches = patches_for_version(expected_version)

        # Validate every file before writing any of them, so a mismatch can
        # never leave a partially patched package behind.
        pending: list[tuple[Path, str]] = []
        for patch in patches:
            path = package_dir / patch.rel_path
            if not path.is_file():
                raise PatchError(f"missing target file: {path}")
            text = path.read_text(encoding="utf-8")
            state = classify(patch, text, path)
            if state == "apply":
                pending.append((path, text.replace(patch.anchor, patch.patched, 1)))
            else:
                print(f"[update-guard] already patched: {patch.rel_path}")
    except PatchError as exc:
        print(f"[update-guard] ERROR: {exc}", file=sys.stderr)
        return 1

    for path, updated in pending:
        path.write_text(updated, encoding="utf-8")
        print(f"[update-guard] patched: {path.relative_to(package_dir)}")

    if pending:
        print(f"[update-guard] applied {len(pending)} guard(s)")
    else:
        print("[update-guard] no changes required")
    return 0


if __name__ == "__main__":
    sys.exit(main())
