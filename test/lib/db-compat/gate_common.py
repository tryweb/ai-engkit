#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
# How to run: imported by the test_gate_*.py modules in this directory.
from __future__ import annotations

import datetime
import hashlib
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
HELPER = REPO / "scripts" / "ai-engkit-db-compat.py"
BASELINE_PATH = REPO / "scripts" / "db-compat-baseline.json"
FIXTURE = Path("/tmp/ai-engkit-v119-fixture/data/opencode/opencode.db")


def _load(module_name: str):
    spec = importlib.util.spec_from_file_location(
        module_name, REPO / "scripts" / f"{module_name}.py"
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load DB gate module {module_name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


MODEL = _load("ai_engkit_db_compat_model")
SCHEMA = _load("ai_engkit_db_compat_schema")
GATE = _load("ai_engkit_db_compat_gate")

BASELINE_JSON = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
TABLES: list[str] = BASELINE_JSON["tables"]
MIGRATION_IDS: list[str] = BASELINE_JSON["migration_ids"]
BASELINE = SCHEMA.load_baseline(BASELINE_PATH)


def _timestamp_ms(migration_id: str) -> int:
    prefix = migration_id.split("_", 1)[0]
    moment = datetime.datetime.strptime(prefix, "%Y%m%d%H%M%S").replace(tzinfo=datetime.UTC)
    return int(moment.timestamp() * 1000)


def _create_v1(path: Path, ids: tuple[str, ...] | None = None) -> None:
    con = sqlite3.connect(path)
    try:
        for table in TABLES:
            if table == "migration":
                con.execute("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
            else:
                con.execute(f'CREATE TABLE "{table}" (id TEXT)')
        for mid in ids if ids is not None else MIGRATION_IDS:
            con.execute("INSERT INTO migration (id, time_completed) VALUES (?, 1)", (mid,))
        con.commit()
    finally:
        con.close()


def _create_tables(path: Path, tables: tuple[str, ...]) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    for table in tables:
        con.execute(f'CREATE TABLE "{table}" (id TEXT)')
    con.commit()
    return con


def _create_legacy(path: Path, *, with_name: bool) -> None:
    con = sqlite3.connect(path)
    try:
        for table in TABLES:
            if table != "migration":
                con.execute(f'CREATE TABLE "{table}" (id TEXT)')
        if with_name:
            con.execute("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, name TEXT)")
            for mid in MIGRATION_IDS:
                con.execute("INSERT INTO __drizzle_migrations (hash, name) VALUES ('h', ?)", (mid,))
        else:
            con.execute(
                "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER)"
            )
            for mid in MIGRATION_IDS:
                con.execute(
                    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h', ?)",
                    (_timestamp_ms(mid),),
                )
        con.commit()
    finally:
        con.close()


def _run_check(
    db: Path,
    baseline: Path = BASELINE_PATH,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(HELPER), "check", "--db", str(db), "--baseline", str(baseline), "--json"],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )


def _status(completed: subprocess.CompletedProcess[str]) -> str:
    return json.loads(completed.stdout)["status"]


def _hashes(directory: Path) -> dict[str, tuple[str, int, int]]:
    out: dict[str, tuple[str, int, int]] = {}
    for entry in sorted(directory.iterdir()):
        if not entry.is_file():
            continue
        stat = entry.stat()
        out[entry.name] = (hashlib.sha256(entry.read_bytes()).hexdigest(), stat.st_mtime_ns, stat.st_size)
    return out
