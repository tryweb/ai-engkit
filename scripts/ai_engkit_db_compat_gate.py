#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
# How to run:
#   Imported by scripts/ai-engkit-db-compat.py; not executed directly.
"""Source quiescence checks, private copy orchestration, and the gate entry."""

from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from ai_engkit_db_compat_model import (
    GUIDANCE,
    SIDECAR_SUFFIXES,
    Baseline,
    GateResult,
    Status,
)
from ai_engkit_db_compat_schema import inspect_copy

_CHUNK: Final = 1024 * 1024
_SPACE_MARGIN: Final = 256 * 1024
_PROC: Final = Path("/proc")


@dataclass(frozen=True, slots=True)
class Stamp:
    """Source file metadata used for drift detection."""

    size: int
    mtime_ns: int
    inode: int


def source_files(db_path: Path) -> tuple[Path, ...]:
    """Return the database plus any present sidecars, database first."""
    files = [db_path]
    for suffix in SIDECAR_SUFFIXES:
        sidecar = Path(f"{db_path}{suffix}")
        if sidecar.exists() or sidecar.is_symlink():
            files.append(sidecar)
    return tuple(files)


def _stamp(path: Path) -> Stamp:
    stat = path.stat()
    return Stamp(size=stat.st_size, mtime_ns=stat.st_mtime_ns, inode=stat.st_ino)


def _snapshot(files: tuple[Path, ...]) -> dict[str, Stamp]:
    return {str(path): _stamp(path) for path in files}


def _fd_flags(pid_dir: Path, fd_name: str) -> int | None:
    try:
        text = (pid_dir / "fdinfo" / fd_name).read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        if line.startswith("flags:"):
            try:
                return int(line.split(":", 1)[1].strip(), 8)
            except ValueError:
                return None
    return None


def _fd_target(pid_dir: Path, raw: str) -> str | None:
    target = raw.removesuffix(" (deleted)")
    if os.path.isabs(target):
        return os.path.realpath(target)
    try:
        cwd = os.readlink(pid_dir / "cwd")
    except OSError:
        return None
    return os.path.realpath(os.path.join(cwd, target))


def open_writer_processes(targets: frozenset[str]) -> tuple[str, ...]:
    """Return notes for other processes holding a target open for write.

    Fails closed: a target held open with unreadable flags is reported so the
    gate never claims consistency while a writer may be active.
    """
    if not _PROC.is_dir():
        return ()
    findings: list[str] = []
    self_pid = os.getpid()
    for entry in _PROC.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == self_pid:
            continue
        try:
            fds = list((entry / "fd").iterdir())
        except OSError:
            continue
        for fd in fds:
            try:
                raw = os.readlink(fd)
            except OSError:
                continue
            resolved = _fd_target(entry, raw)
            if resolved is None or resolved not in targets:
                continue
            flags = _fd_flags(entry, fd.name)
            if flags is None:
                findings.append(f"pid {pid} holds {Path(resolved).name} open (flags unknown)")
            elif (flags & os.O_ACCMODE) != os.O_RDONLY:
                findings.append(f"pid {pid} holds {Path(resolved).name} open for writing")
    return tuple(findings)


def _temp_root(db_path: Path) -> tuple[Path | None, str]:
    try:
        root = Path(tempfile.gettempdir()).resolve()
    except OSError as exc:
        return None, f"cannot resolve temporary directory: {exc}"
    data_dir = db_path.parent.resolve()
    if root == data_dir or data_dir in root.parents:
        return None, "temporary directory is inside the session data path"
    return root, ""


def copy_files(files: tuple[Path, ...], dest_dir: Path) -> tuple[Path, ...]:
    copied: list[Path] = []
    for src in files:
        dst = dest_dir / src.name
        with open(src, "rb") as fsrc, open(dst, "wb") as fdst:
            shutil.copyfileobj(fsrc, fdst, length=_CHUNK)
        copied.append(dst)
    return tuple(copied)


def run_gate(baseline: Baseline, db_path: Path) -> GateResult:
    """Copy a quiescent database privately and classify it read-only."""
    db_path = db_path.expanduser()
    if not db_path.exists():
        orphans = [
            suffix for suffix in SIDECAR_SUFFIXES if Path(f"{db_path}{suffix}").exists()
        ]
        if orphans:
            return GateResult(
                Status.REFUSE_ORPHAN_SIDECARS,
                f"sidecars present without a database: {', '.join(orphans)}",
                GUIDANCE[Status.REFUSE_ORPHAN_SIDECARS],
                str(db_path),
                (),
                tuple(orphans),
            )
        return GateResult(Status.ALLOW_ABSENT, "no session database present", "", str(db_path))

    journal = Path(f"{db_path}-journal")
    if journal.exists() and journal.stat().st_size > 0:
        return GateResult(
            Status.REFUSE_LOCKED,
            "rollback journal present; the database may be mid-transaction",
            GUIDANCE[Status.REFUSE_LOCKED],
            str(db_path),
        )

    files = source_files(db_path)
    targets = frozenset(os.path.realpath(str(path)) for path in files)
    writers = open_writer_processes(targets)
    if writers:
        return GateResult(
            Status.REFUSE_LOCKED,
            f"database is open for writing: {'; '.join(sorted(writers))}",
            GUIDANCE[Status.REFUSE_LOCKED],
            str(db_path),
            (),
            tuple(sorted(writers)),
        )

    root, problem = _temp_root(db_path)
    if root is None:
        return GateResult(Status.REFUSE_TEMP, problem, GUIDANCE[Status.REFUSE_TEMP], str(db_path))

    temp_dir: Path | None = None
    try:
        try:
            need = sum(_stamp(path).size for path in files)
        except OSError as exc:
            return GateResult(
                Status.REFUSE_TEMP,
                f"cannot stat source files: {exc}",
                GUIDANCE[Status.REFUSE_TEMP],
                str(db_path),
            )
        if shutil.disk_usage(root).free < need + _SPACE_MARGIN:
            return GateResult(
                Status.REFUSE_SPACE,
                "insufficient free space for a private inspection copy",
                GUIDANCE[Status.REFUSE_SPACE],
                str(db_path),
            )
        try:
            temp_dir = Path(tempfile.mkdtemp(prefix="aek-db-compat-", dir=root))
        except OSError as exc:
            return GateResult(
                Status.REFUSE_TEMP,
                f"cannot create temporary directory: {exc}",
                GUIDANCE[Status.REFUSE_TEMP],
                str(db_path),
            )

        before = _snapshot(files)
        try:
            copied = copy_files(files, temp_dir)
        except OSError as exc:
            return GateResult(
                Status.REFUSE_TEMP,
                f"cannot create inspection copy: {exc}",
                GUIDANCE[Status.REFUSE_TEMP],
                str(db_path),
            )
        after = _snapshot(files)
        if before != after:
            return GateResult(
                Status.REFUSE_UNSTABLE,
                "source database or sidecars changed during the copy",
                GUIDANCE[Status.REFUSE_UNSTABLE],
                str(db_path),
            )
        return inspect_copy(baseline, copied[0], db_path, copied)
    finally:
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)
