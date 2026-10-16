#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
# How to run:
#   # 1. Pin the v1 baseline from the disposable v1.19.2 fixture (build time, one-off).
#   #    Inspects a private copy only; never starts the OpenCode CLI.
#   python3 scripts/ai-engkit-db-compat.py capture-baseline \
#     --db /tmp/ai-engkit-v119-fixture/data/opencode/opencode.db \
#     --out scripts/db-compat-baseline.json \
#     --opencode-version 1.19.2 --openchamber-version 1.24.2
#   # 2. Gate a database read-only before the v1 binary touches it.
#   #    Exit 0 = allowed (absent / fresh / recognized v1); exit 1 = refused.
#   python3 scripts/ai-engkit-db-compat.py check \
#     --db /home/devuser/.local/share/opencode/opencode.db \
#     --baseline scripts/db-compat-baseline.json [--json]
"""AI-EngKit OpenCode v1 database compatibility preflight CLI (local-only).

This is the read-only data-compatibility screen that runs before the v1 binary
touches session state. It never starts the OpenCode CLI, never writes to the
original database, never restores a backup and never deletes a session: it
inspects a private copy of a quiescent database plus its matching sidecars and
discards it. The reusable primitives live in ``ai_engkit_db_compat_model.py``,
``ai_engkit_db_compat_schema.py`` and ``ai_engkit_db_compat_gate.py``.

Baseline facts are pinned to the disposable OpenCode 1.19.2 fixture
(OpenChamber 1.24.2): 20 tables including ``migration`` with 38 seeded ids, and
no ``session_v2``. A v2.0.30 migration renames ``session`` to ``session_v2`` in
place, and a migrated v1-to-v2 database can retain both, so ``session``
presence alone is not trusted.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

from ai_engkit_db_compat_gate import copy_files, run_gate, source_files
from ai_engkit_db_compat_model import (
    BASELINE_SCHEMA,
    GUIDANCE,
    REQUIRED_CORE_TABLES,
    V1_ONLY_TABLES,
    V2_MARKER_MIGRATIONS,
    V2_MARKER_TABLES,
    GateResult,
    Status,
)
from ai_engkit_db_compat_schema import BaselineError, load_baseline, read_facts, sqlite_uri


def capture_baseline(args: argparse.Namespace) -> int:
    """Capture pinned v1 schema/migration identities from a disposable fixture."""
    db_path = Path(args.db).expanduser()
    if not db_path.is_file():
        print(f"[db-compat] ERROR: fixture database not found: {db_path}", file=sys.stderr)
        return 1
    temp_dir = Path(tempfile.mkdtemp(prefix="aek-db-capture-"))
    try:
        copied = copy_files(source_files(db_path), temp_dir)
        try:
            con = sqlite3.connect(sqlite_uri(copied[0]), uri=True, timeout=5.0)
        except sqlite3.Error as exc:
            print(f"[db-compat] ERROR: cannot open fixture copy: {exc}", file=sys.stderr)
            return 1
        try:
            facts = read_facts(con)
        finally:
            con.close()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    table_set = set(facts.tables)
    v2_present = sorted(table_set & set(V2_MARKER_TABLES))
    v2_ids = sorted(set(facts.migration_ids) & set(V2_MARKER_MIGRATIONS))
    if v2_present or v2_ids:
        print(
            f"[db-compat] ERROR: fixture is not v1 (v2 markers: {v2_present + v2_ids})",
            file=sys.stderr,
        )
        return 1
    missing = sorted(set(REQUIRED_CORE_TABLES) - table_set)
    if not facts.has_migration_table or missing:
        print(
            f"[db-compat] ERROR: fixture is not a recognized v1 database "
            f"(migration={facts.has_migration_table}, missing={missing})",
            file=sys.stderr,
        )
        return 1

    manifest = {
        "schema": BASELINE_SCHEMA,
        "source": {
            "opencode_version": args.opencode_version,
            "openchamber_version": args.openchamber_version,
            "fixture_id": args.fixture_id,
            "note": (
                "Baseline captured from the disposable pinned v1.19.2 fixture with "
                "SQLite stdlib only. Build-time source mapping carries a gitHead "
                "provenance caveat, but this fixture is from the exact pinned binary."
            ),
        },
        "table_count": len(facts.tables),
        "tables": sorted(facts.tables),
        "required_tables": sorted(REQUIRED_CORE_TABLES),
        "v1_only_tables": sorted(V1_ONLY_TABLES),
        "migration_ids": sorted(facts.migration_ids),
        "v2": {
            "tables": sorted(V2_MARKER_TABLES),
            "migration_ids": sorted(V2_MARKER_MIGRATIONS),
        },
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        f"[db-compat] captured {len(facts.tables)} tables, "
        f"{len(facts.migration_ids)} migration ids -> {out}"
    )
    return 0


def _emit(result: GateResult, json_mode: bool) -> None:
    if json_mode:
        print(json.dumps(result.to_report(), sort_keys=True))
        return
    print(result.status.value)
    print(f"[db-compat] reason: {result.reason}", file=sys.stderr)
    if result.extras:
        print(f"[db-compat] detail: {', '.join(result.extras)}", file=sys.stderr)
    if result.guidance:
        print(f"[db-compat] guidance: {result.guidance}", file=sys.stderr)


def cmd_check(args: argparse.Namespace) -> int:
    db_path = Path(args.db)
    try:
        baseline = load_baseline(Path(args.baseline))
    except BaselineError as exc:
        result = GateResult(
            Status.REFUSE_BASELINE,
            str(exc),
            GUIDANCE[Status.REFUSE_BASELINE],
            str(db_path),
        )
        _emit(result, json_mode=args.json)
        return 1
    result = run_gate(baseline, db_path)
    _emit(result, json_mode=args.json)
    return 0 if result.allowed else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    capture = sub.add_parser("capture-baseline", help="pin v1 identities from a fixture")
    capture.add_argument("--db", required=True)
    capture.add_argument("--out", required=True)
    capture.add_argument("--opencode-version", default="")
    capture.add_argument("--openchamber-version", default="")
    capture.add_argument("--fixture-id", default="ai-engkit-v119-fixture")
    capture.set_defaults(func=capture_baseline)

    check = sub.add_parser("check", help="read-only v1 compatibility gate")
    check.add_argument("--db", required=True)
    check.add_argument("--baseline", required=True)
    check.add_argument("--json", action="store_true")
    check.set_defaults(func=cmd_check)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
