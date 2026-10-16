#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
# How to run:
#   Imported by scripts/ai-engkit-db-compat.py; not executed directly.
"""Baseline loading, v1 schema classification, and read-only copy inspection."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from ai_engkit_db_compat_model import (
    BASELINE_SCHEMA,
    GUIDANCE,
    LEGACY_JOURNAL_TABLE,
    MIGRATION_TABLE,
    Baseline,
    BaselineError,
    GateResult,
    JsonValue,
    LegacyResolution,
    SchemaFacts,
    SqlValue,
    Status,
    Verdict,
)


def _json_object(value: JsonValue, label: str) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        raise BaselineError(f"{label} must be a JSON object")
    return value


def _str_list(value: JsonValue, label: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise BaselineError(f"{label} must be a list of strings")
    items: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise BaselineError(f"{label} must contain only strings")
        items.append(item)
    return tuple(items)


def parse_baseline(raw: JsonValue) -> Baseline:
    """Validate a decoded baseline manifest into a typed ``Baseline``."""
    obj = _json_object(raw, "baseline")
    schema = obj.get("schema")
    if schema != BASELINE_SCHEMA:
        raise BaselineError(f"unsupported baseline schema: {schema!r}")
    tables = frozenset(_str_list(obj.get("tables"), "baseline.tables"))
    required = frozenset(_str_list(obj.get("required_tables"), "baseline.required_tables"))
    migration_ids = frozenset(_str_list(obj.get("migration_ids"), "baseline.migration_ids"))
    if not tables or not required or not migration_ids:
        raise BaselineError("baseline must declare tables, required_tables and migration_ids")
    missing_required = required - tables
    if missing_required:
        raise BaselineError(
            f"baseline.required_tables not in baseline.tables: {sorted(missing_required)}"
        )
    v2_obj = _json_object(obj.get("v2", {}), "baseline.v2")
    v2_tables = frozenset(_str_list(v2_obj.get("tables", []), "baseline.v2.tables"))
    v2_migrations = frozenset(
        _str_list(v2_obj.get("migration_ids", []), "baseline.v2.migration_ids")
    )
    source_obj = obj.get("source", {})
    source = json.dumps(source_obj, sort_keys=True) if isinstance(source_obj, dict) else ""
    return Baseline(
        schema=BASELINE_SCHEMA,
        source=source,
        tables=tables,
        required_tables=required,
        migration_ids=migration_ids,
        v2_tables=v2_tables,
        v2_migration_ids=v2_migrations,
    )


def load_baseline(path: Path) -> Baseline:
    """Load and validate the pinned baseline manifest; raise on any defect."""
    if not path.is_file():
        raise BaselineError(f"missing baseline manifest: {path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BaselineError(f"unreadable baseline manifest {path}: {exc}") from exc
    return parse_baseline(raw)


def _prefix_of(migration_id: str) -> str:
    return migration_id.split("_", 1)[0]


def resolve_drizzle(
    baseline: Baseline,
    columns: tuple[str, ...],
    rows: tuple[tuple[SqlValue, ...], ...],
) -> LegacyResolution:
    """Map legacy ``__drizzle_migrations`` rows to exact v1 ids.

    Mirrors v1.19.0 ``packages/core/src/database/migration.ts``: a ``name``
    column is used directly, otherwise ``created_at`` (milliseconds) is
    formatted to a UTC ``YYYYMMDDHHMMSS`` prefix and matched against the
    migration id prefix. An unmatched row is a hard refusal.
    """
    if "name" in columns:
        index = columns.index("name")
        resolved: list[str] = []
        for row in rows:
            name = row[index] if index < len(row) else None
            if name is None:
                continue
            if not isinstance(name, str):
                return LegacyResolution(False, (), "legacy migration name is not text")
            if name not in baseline.migration_ids:
                return LegacyResolution(False, (), f"legacy migration name not recognized: {name}")
            resolved.append(name)
        return LegacyResolution(True, tuple(resolved), "")

    if "created_at" in columns:
        index = columns.index("created_at")
        by_prefix = {_prefix_of(mid): mid for mid in baseline.migration_ids}
        resolved = []
        for row in rows:
            created = row[index] if index < len(row) else None
            if created is None:
                continue
            if not isinstance(created, (int, float)):
                return LegacyResolution(False, (), "legacy created_at is not numeric")
            prefix = time.strftime("%Y%m%d%H%M%S", time.gmtime(int(created) // 1000))
            match = by_prefix.get(prefix)
            if match is None:
                return LegacyResolution(False, (), f"legacy migration timestamp not recognized: {created}")
            resolved.append(match)
        return LegacyResolution(True, tuple(resolved), "")

    return LegacyResolution(False, (), "unsupported __drizzle_migrations columns")


def classify_schema(baseline: Baseline, facts: SchemaFacts) -> Verdict:
    """Classify schema facts against the pinned v1 baseline."""
    table_set = set(facts.tables)

    v2_present = sorted(table_set & baseline.v2_tables)
    if v2_present:
        return Verdict(
            Status.REFUSE_V2,
            f"v2 marker table present: {', '.join(v2_present)}",
            tuple(v2_present),
        )

    if facts.migration_ids:
        unknown = sorted(set(facts.migration_ids) - baseline.migration_ids)
        v2_ids = sorted(set(unknown) & baseline.v2_migration_ids)
        if v2_ids:
            return Verdict(
                Status.REFUSE_V2,
                f"v2 migration id present: {', '.join(v2_ids)}",
                tuple(v2_ids),
            )
        if unknown:
            return Verdict(
                Status.REFUSE_UNKNOWN,
                f"migration id outside the pinned v1 whitelist: {', '.join(unknown)}",
                tuple(unknown),
            )

    if not table_set:
        return Verdict(Status.ALLOW_FRESH, "no application schema present")

    if facts.has_migration_table and not facts.migration_ids:
        return Verdict(Status.REFUSE_UNKNOWN, "v1 migration journal is empty")
    if facts.has_drizzle_table and not facts.migration_ids:
        return Verdict(Status.REFUSE_UNKNOWN, "legacy migration journal is empty")

    audited = table_set - {LEGACY_JOURNAL_TABLE}
    unexpected = sorted(audited - baseline.tables)
    if unexpected:
        return Verdict(
            Status.REFUSE_UNKNOWN,
            f"table outside the pinned v1 schema: {', '.join(unexpected)}",
            tuple(unexpected),
        )

    missing = sorted(baseline.required_tables - audited)
    if missing:
        return Verdict(
            Status.REFUSE_UNKNOWN,
            f"required v1 table missing: {', '.join(missing)}",
            tuple(missing),
        )

    if not facts.has_migration_table and not facts.has_drizzle_table:
        return Verdict(Status.REFUSE_UNKNOWN, "no v1 migration journal present")

    return Verdict(Status.ALLOW_V1, "recognized v1 schema")


def sqlite_uri(path: Path) -> str:
    return f"{path.resolve().as_uri()}?mode=ro"


def read_facts(con: sqlite3.Connection) -> SchemaFacts:
    table_rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    tables = tuple(str(row[0]) for row in table_rows)
    has_migration = MIGRATION_TABLE in tables
    has_drizzle = LEGACY_JOURNAL_TABLE in tables

    migration_ids: tuple[str, ...] = ()
    if has_migration:
        id_rows = con.execute(f"SELECT id FROM {MIGRATION_TABLE} ORDER BY id").fetchall()
        migration_ids = tuple(str(row[0]) for row in id_rows)
    return SchemaFacts(
        tables=tables,
        migration_ids=migration_ids,
        has_migration_table=has_migration,
        has_drizzle_table=has_drizzle,
    )


def drizzle_resolution(con: sqlite3.Connection, baseline: Baseline) -> LegacyResolution:
    info = con.execute(f"SELECT name FROM pragma_table_info('{LEGACY_JOURNAL_TABLE}')").fetchall()
    columns = tuple(str(row[0]) for row in info)
    rows = con.execute(f"SELECT * FROM {LEGACY_JOURNAL_TABLE}").fetchall()
    typed_rows = tuple(tuple(row) for row in rows)
    return resolve_drizzle(baseline, columns, typed_rows)


def is_locked_error(exc: sqlite3.Error) -> bool:
    text = str(exc).lower()
    return "locked" in text or "busy" in text


def inspect_copy(
    baseline: Baseline, copy_db: Path, db_path: Path, copied: tuple[Path, ...]
) -> GateResult:
    """Open the private copy read-only and classify it; never touches the original."""
    names = tuple(path.name for path in copied)
    try:
        con = sqlite3.connect(sqlite_uri(copy_db), uri=True, timeout=5.0)
    except sqlite3.Error as exc:
        status = Status.REFUSE_LOCKED if is_locked_error(exc) else Status.REFUSE_CORRUPT
        return GateResult(
            status, f"cannot open inspection copy: {exc}", GUIDANCE[status], str(db_path), names
        )
    try:
        with con:
            check = con.execute("PRAGMA quick_check").fetchall()
            if any(str(row[0]).lower() != "ok" for row in check):
                return GateResult(
                    Status.REFUSE_CORRUPT,
                    "quick_check reported corruption",
                    GUIDANCE[Status.REFUSE_CORRUPT],
                    str(db_path),
                    names,
                )
            facts = read_facts(con)
            if facts.has_drizzle_table and not facts.has_migration_table:
                legacy = drizzle_resolution(con, baseline)
                if not legacy.ok:
                    return GateResult(
                        Status.REFUSE_UNKNOWN,
                        legacy.problem,
                        GUIDANCE[Status.REFUSE_UNKNOWN],
                        str(db_path),
                        names,
                        legacy.ids,
                    )
                facts = SchemaFacts(
                    tables=facts.tables,
                    migration_ids=legacy.ids,
                    has_migration_table=False,
                    has_drizzle_table=True,
                )
    except sqlite3.Error as exc:
        status = Status.REFUSE_LOCKED if is_locked_error(exc) else Status.REFUSE_CORRUPT
        return GateResult(
            status, f"cannot read inspection copy: {exc}", GUIDANCE[status], str(db_path), names
        )
    finally:
        con.close()

    verdict = classify_schema(baseline, facts)
    return GateResult(
        verdict.status,
        verdict.reason,
        GUIDANCE.get(verdict.status, ""),
        str(db_path),
        names,
        verdict.extras,
    )
