#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""AI-EngKit managed-core build and offline recovery CLI.

The AI-EngKit image owns the pinned v1 core (OpenChamber + OpenCode) in an
isolated Bun prefix and ships a root-owned pristine archive plus an integrity
manifest and build metadata. This CLI is the single entry point for that
contract; the reusable primitives live in ``ai_engkit_core_lib.py``.

Subcommands
-----------
``build-baseline``
    Build the integrity manifest, a deterministic offline ``tar.gz`` archive,
    and ``metadata.json`` from an installed core prefix, then print the
    generation id. Run once at image build time.

``verify``
    Verify a live tree exactly against a manifest; exits nonzero on any drift.

``recover``
    Verify the active generation and, when it has drifted, restore the exact
    pinned tree from the offline baseline using a staging directory and an
    atomic ``active`` switch. Fail-closed: a missing or corrupt baseline refuses
    without replacing the active installation.

``status``
    Print ``clean``, ``drift``, ``missing``, or ``unknown`` for a core root.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ai_engkit_core_lib import (  # noqa: E402
    ARCHIVE_NAME,
    MANIFEST_NAME,
    MANIFEST_SCHEMA,
    METADATA_NAME,
    METADATA_SCHEMA,
    CoreError,
    collect_entries,
    compare_tree,
    create_archive,
    extract_archive,
    generation_id,
    link_containment,
    load_baseline,
    load_json,
    sha256_file,
)

ACTIVE_LINK_NAME = "active"
GENERATIONS_DIR_NAME = "generations"


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def cmd_build_baseline(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    if not root.is_dir():
        raise CoreError(f"--root is not a directory: {root}")
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    entries = collect_entries(root)
    for path, entry in entries.items():
        if entry["type"] == "symlink":
            escape = link_containment(path, entry["target"])
            if escape:
                raise CoreError(escape)
    gen_id = generation_id(entries)

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "generation_id": gen_id,
        "entries": [entries[key] for key in sorted(entries)],
    }
    _write_json(out_dir / MANIFEST_NAME, manifest)

    archive = out_dir / ARCHIVE_NAME
    if archive.exists():
        archive.unlink()
    create_archive(root, archive)

    metadata = {
        "schema": METADATA_SCHEMA,
        "generation_id": gen_id,
        "archive_name": ARCHIVE_NAME,
        "manifest_name": MANIFEST_NAME,
        "archive_sha256": sha256_file(archive),
        "opencode_version": args.opencode_version,
        "openchamber_version": args.openchamber_version,
        "bun_version": args.bun_version,
        "ai_engkit_version": args.ai_engkit_version,
    }
    _write_json(out_dir / METADATA_NAME, metadata)

    print(f"[core-baseline] {len(entries)} entries, generation {gen_id}", file=sys.stderr)
    print(gen_id)
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    manifest = load_json(Path(args.manifest), "manifest")
    root = Path(args.root)
    if not root.exists():
        print(f"[core-verify] missing core root: {root}", file=sys.stderr)
        return 1
    problems = compare_tree(root, manifest)
    if problems:
        for problem in problems[:50]:
            print(f"[core-verify] {problem}", file=sys.stderr)
        print(f"[core-verify] drift detected ({len(problems)} problem(s))", file=sys.stderr)
        return 1
    print(f"[core-verify] tree matches {manifest.get('generation_id')}")
    return 0


def _switch_active(core_root: Path, gen_id: str) -> None:
    """Point ``active`` at ``generations/<gen_id>`` atomically."""
    (core_root / GENERATIONS_DIR_NAME).mkdir(parents=True, exist_ok=True)
    active = core_root / ACTIVE_LINK_NAME
    temporary = core_root / f".active.tmp.{os.getpid()}.{random.randrange(1 << 30)}"
    if temporary.is_symlink() or temporary.exists():
        temporary.unlink()
    os.symlink(f"{GENERATIONS_DIR_NAME}/{gen_id}", temporary)
    try:
        if active.is_symlink() or not active.exists():
            os.replace(temporary, active)
        else:
            # Only reachable before the first managed symlink layout exists.
            shutil.rmtree(active)
            os.replace(temporary, active)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def _cleanup_staging(core_root: Path) -> None:
    for candidate in core_root.glob(".staging.*"):
        if candidate.is_dir() and not candidate.is_symlink():
            shutil.rmtree(candidate, ignore_errors=True)


def _prune_generations(core_root: Path, keep: str) -> None:
    generations = core_root / GENERATIONS_DIR_NAME
    if not generations.is_dir():
        return
    for candidate in generations.iterdir():
        if candidate.name == keep:
            continue
        if candidate.is_symlink():
            candidate.unlink()
        elif candidate.is_dir():
            shutil.rmtree(candidate, ignore_errors=True)


def cmd_recover(args: argparse.Namespace) -> int:
    core_root = Path(args.core_root)
    core_root.mkdir(parents=True, exist_ok=True)
    _cleanup_staging(core_root)

    # Fail-closed: an invalid baseline refuses before the active core is touched.
    baseline = load_baseline(Path(args.baseline_dir))

    active = core_root / ACTIVE_LINK_NAME
    if active.exists() or active.is_symlink():
        problems = compare_tree(active, baseline.manifest)
        if not problems:
            print(f"[core-recover] clean: active matches {baseline.generation_id}")
            return 0
        print(
            f"[core-recover] drift detected ({len(problems)} problem(s)); restoring",
            file=sys.stderr,
        )
    else:
        print("[core-recover] active core missing; restoring", file=sys.stderr)

    staging = core_root / f".staging.{os.getpid()}.{random.randrange(1 << 30)}"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    generation = core_root / GENERATIONS_DIR_NAME / baseline.generation_id
    try:
        extract_archive(baseline.archive, staging)
        problems = compare_tree(staging, baseline.manifest)
        if problems:
            for problem in problems[:50]:
                print(f"[core-recover] {problem}", file=sys.stderr)
            raise CoreError(
                f"staged restore does not match manifest ({len(problems)} problem(s))"
            )
        if generation.exists() and not generation.is_symlink():
            if compare_tree(generation, baseline.manifest):
                shutil.rmtree(generation, ignore_errors=True)
            else:
                # An intact generation already exists; drop the staging copy.
                shutil.rmtree(staging, ignore_errors=True)
                _switch_active(core_root, baseline.generation_id)
                _prune_generations(core_root, baseline.generation_id)
                print(f"[core-recover] restored {baseline.generation_id} from baseline")
                return 0
        (core_root / GENERATIONS_DIR_NAME).mkdir(parents=True, exist_ok=True)
        os.replace(staging, generation)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)

    _switch_active(core_root, baseline.generation_id)
    _prune_generations(core_root, baseline.generation_id)
    print(f"[core-recover] restored {baseline.generation_id} from baseline")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    core_root = Path(args.core_root)
    active = core_root / ACTIVE_LINK_NAME
    if not (active.exists() or active.is_symlink()):
        print("missing")
        return 0
    try:
        manifest = load_json(Path(args.baseline_dir) / MANIFEST_NAME, "manifest")
    except CoreError:
        print("unknown")
        return 0
    print("clean" if not compare_tree(active, manifest) else "drift")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build-baseline", help="build manifest, archive and metadata")
    build.add_argument("--root", required=True)
    build.add_argument("--out-dir", required=True)
    build.add_argument("--opencode-version", default="")
    build.add_argument("--openchamber-version", default="")
    build.add_argument("--bun-version", default="")
    build.add_argument("--ai-engkit-version", default="")
    build.set_defaults(func=cmd_build_baseline)

    verify = sub.add_parser("verify", help="verify a tree against a manifest")
    verify.add_argument("--root", required=True)
    verify.add_argument("--manifest", required=True)
    verify.set_defaults(func=cmd_verify)

    recover = sub.add_parser("recover", help="verify and restore the core offline")
    recover.add_argument("--core-root", required=True)
    recover.add_argument("--baseline-dir", required=True)
    recover.set_defaults(func=cmd_recover)

    status = sub.add_parser("status", help="print clean/drift/missing/unknown")
    status.add_argument("--core-root", required=True)
    status.add_argument("--baseline-dir", required=True)
    status.set_defaults(func=cmd_status)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except CoreError as exc:
        print(f"[core] ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
