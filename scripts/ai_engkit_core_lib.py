#!/usr/bin/env python3
"""Shared primitives for the AI-EngKit managed-core baseline and recovery.

Pure, side-effect-free helpers over an installed core prefix: tree inventory,
content hashing, generation identity, archive create/extract, exact-tree
comparison, and baseline loading. The CLI lives in ``ai-engkit-core.py``.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

MANIFEST_SCHEMA = 1
METADATA_SCHEMA = 1
MANIFEST_NAME = "manifest.json"
ARCHIVE_NAME = "core.tar.gz"
METADATA_NAME = "metadata.json"
_CHUNK = 1024 * 1024


class CoreError(RuntimeError):
    """A fail-closed condition that must not mutate the active core."""


@dataclass(frozen=True)
class Baseline:
    """A validated pristine recovery source."""

    manifest: dict
    metadata: dict
    archive: Path
    generation_id: str


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def collect_entries(root: Path) -> dict[str, dict]:
    """Return every descendant of ``root`` keyed by POSIX relative path.

    Symlinks are recorded as links and never followed; no path outside ``root``
    is ever read.
    """
    entries: dict[str, dict] = {}

    def walk(directory: Path) -> None:
        with os.scandir(directory) as scandir:
            children = sorted(scandir, key=lambda entry: entry.name)
        for child in children:
            relative = os.path.relpath(child.path, root).replace(os.sep, "/")
            if child.is_symlink():
                entries[relative] = {
                    "path": relative,
                    "type": "symlink",
                    "target": os.readlink(child.path),
                }
                continue
            stat = child.stat(follow_symlinks=False)
            mode = stat.st_mode & 0o7777
            if child.is_dir(follow_symlinks=False):
                entries[relative] = {"path": relative, "type": "dir", "mode": mode}
                walk(Path(child.path))
            elif child.is_file(follow_symlinks=False):
                entries[relative] = {
                    "path": relative,
                    "type": "file",
                    "mode": mode,
                    "size": stat.st_size,
                    "sha256": sha256_file(Path(child.path)),
                }
            else:
                raise CoreError(f"unsupported special file in core tree: {child.path}")

    walk(root)
    return entries


def _canonical(entries: dict[str, dict]) -> str:
    ordered = [entries[key] for key in sorted(entries)]
    return json.dumps(ordered, sort_keys=True, separators=(",", ":"))


def generation_id(entries: dict[str, dict]) -> str:
    return hashlib.sha256(_canonical(entries).encode("utf-8")).hexdigest()


def link_containment(rel_path: str, target: str) -> str | None:
    """Return an error string when a link escapes its tree, else ``None``."""
    if os.path.isabs(target):
        return f"absolute link target not allowed: {rel_path} -> {target}"
    joined = os.path.normpath(os.path.join(os.path.dirname(rel_path), target))
    if joined == ".." or joined.startswith("../"):
        return f"link target escapes core root: {rel_path} -> {target}"
    return None


def compare_tree(root: Path, manifest: dict) -> list[str]:
    """Return a list of drift problems (empty when the tree matches exactly)."""
    problems: list[str] = []
    expected = {entry["path"]: entry for entry in manifest["entries"]}
    try:
        actual = collect_entries(root)
    except (OSError, CoreError) as exc:
        return [f"cannot read active core tree: {exc}"]

    for path in sorted(set(expected) - set(actual)):
        problems.append(f"missing: {path}")
    for path in sorted(set(actual) - set(expected)):
        problems.append(f"unexpected: {path}")
    for path in sorted(set(expected) & set(actual)):
        if expected[path] != actual[path]:
            problems.append(f"changed: {path}")
    for path, entry in actual.items():
        if entry["type"] == "symlink":
            escape = link_containment(path, entry["target"])
            if escape:
                problems.append(escape)
    return problems


def create_archive(root: Path, archive: Path) -> None:
    """Create a deterministic offline archive of ``root``'s contents."""
    tar = [
        "tar", "-czf", str(archive), "-C", str(root),
        "--sort=name", "--format=posix",
        "--owner=0", "--group=0", "--numeric-owner", "--mtime=@0", ".",
    ]
    result = subprocess.run(tar, capture_output=True, text=True)
    if result.returncode != 0:
        raise CoreError(f"tar create failed: {result.stderr.strip()}")


def extract_archive(archive: Path, destination: Path) -> None:
    """Extract ``archive`` into ``destination`` preserving modes, not owners."""
    destination.mkdir(parents=True, exist_ok=True)
    tar = [
        "tar", "-xzf", str(archive), "-C", str(destination),
        "--no-same-owner", "--same-permissions",
    ]
    result = subprocess.run(tar, capture_output=True, text=True)
    if result.returncode != 0:
        raise CoreError(f"tar extract failed: {result.stderr.strip()}")


def load_json(path: Path, label: str) -> dict:
    if not path.is_file():
        raise CoreError(f"missing {label}: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise CoreError(f"unreadable {label} {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise CoreError(f"{label} root must be an object: {path}")
    return data


def load_baseline(baseline_dir: Path) -> Baseline:
    """Load and integrity-check the pristine baseline; raise on any defect."""
    metadata = load_json(baseline_dir / METADATA_NAME, "metadata")
    manifest = load_json(baseline_dir / MANIFEST_NAME, "manifest")
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise CoreError(f"unsupported manifest schema in {baseline_dir / MANIFEST_NAME}")
    entry_id = manifest.get("generation_id")
    if not isinstance(entry_id, str) or not entry_id:
        raise CoreError("manifest is missing a generation_id")
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise CoreError("manifest entries must be a list")
    if generation_id({entry["path"]: entry for entry in entries}) != entry_id:
        raise CoreError("manifest generation_id does not match its own contents")

    archive = baseline_dir / metadata.get("archive_name", ARCHIVE_NAME)
    if not archive.is_file():
        raise CoreError(f"missing recovery archive: {archive}")
    expected_digest = metadata.get("archive_sha256")
    if not isinstance(expected_digest, str) or not expected_digest:
        raise CoreError("metadata is missing archive_sha256")
    actual_digest = sha256_file(archive)
    if actual_digest != expected_digest:
        raise CoreError(
            "recovery archive digest mismatch "
            f"(expected {expected_digest}, got {actual_digest})"
        )
    return Baseline(manifest=manifest, metadata=metadata, archive=archive, generation_id=entry_id)
