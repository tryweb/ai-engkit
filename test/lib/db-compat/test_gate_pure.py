#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
# How to run: python3 test/lib/db-compat/test_gate_pure.py -v
from __future__ import annotations

import unittest

from gate_common import BASELINE, MIGRATION_IDS, MODEL, SCHEMA, TABLES, _timestamp_ms


class GatePureTests(unittest.TestCase):
    def test_parse_baseline_rejects_missing_keys(self) -> None:
        with self.assertRaises(MODEL.BaselineError):
            SCHEMA.parse_baseline({"schema": 1, "tables": ["a"]})

    def test_parse_baseline_rejects_required_not_subset(self) -> None:
        with self.assertRaises(MODEL.BaselineError):
            SCHEMA.parse_baseline(
                {"schema": 1, "tables": ["a"], "required_tables": ["b"], "migration_ids": ["x_1"]}
            )

    def test_classify_fresh(self) -> None:
        facts = MODEL.SchemaFacts((), (), False, False)
        self.assertEqual(SCHEMA.classify_schema(BASELINE, facts).status, MODEL.Status.ALLOW_FRESH)

    def test_classify_recognized_v1(self) -> None:
        facts = MODEL.SchemaFacts(tuple(TABLES), tuple(MIGRATION_IDS), True, False)
        self.assertEqual(SCHEMA.classify_schema(BASELINE, facts).status, MODEL.Status.ALLOW_V1)

    def test_classify_empty_migration_journal_refused(self) -> None:
        facts = MODEL.SchemaFacts(tuple(TABLES), (), True, False)
        self.assertEqual(SCHEMA.classify_schema(BASELINE, facts).status, MODEL.Status.REFUSE_UNKNOWN)

    def test_classify_empty_legacy_journal_refused(self) -> None:
        tables = tuple(table for table in TABLES if table != "migration") + ("__drizzle_migrations",)
        facts = MODEL.SchemaFacts(tables, (), False, True)
        self.assertEqual(SCHEMA.classify_schema(BASELINE, facts).status, MODEL.Status.REFUSE_UNKNOWN)

    def test_classify_v2_table(self) -> None:
        tables = tuple(table for table in TABLES if table != "session") + ("session_v2",)
        facts = MODEL.SchemaFacts(tables, tuple(MIGRATION_IDS), True, False)
        self.assertEqual(SCHEMA.classify_schema(BASELINE, facts).status, MODEL.Status.REFUSE_V2)

    def test_classify_v2_migration_id(self) -> None:
        ids = tuple(MIGRATION_IDS) + ("20260804233008_loose_psylocke",)
        facts = MODEL.SchemaFacts(tuple(TABLES), ids, True, False)
        self.assertEqual(SCHEMA.classify_schema(BASELINE, facts).status, MODEL.Status.REFUSE_V2)

    def test_classify_unknown_migration_id(self) -> None:
        facts = MODEL.SchemaFacts(tuple(TABLES), ("20990101000000_future_thing",), True, False)
        self.assertEqual(SCHEMA.classify_schema(BASELINE, facts).status, MODEL.Status.REFUSE_UNKNOWN)

    def test_classify_unexpected_table(self) -> None:
        facts = MODEL.SchemaFacts(tuple(TABLES) + ("surprise",), tuple(MIGRATION_IDS), True, False)
        self.assertEqual(SCHEMA.classify_schema(BASELINE, facts).status, MODEL.Status.REFUSE_UNKNOWN)

    def test_classify_missing_required(self) -> None:
        tables = tuple(table for table in TABLES if table != "workspace")
        facts = MODEL.SchemaFacts(tables, tuple(MIGRATION_IDS), True, False)
        self.assertEqual(SCHEMA.classify_schema(BASELINE, facts).status, MODEL.Status.REFUSE_UNKNOWN)

    def test_classify_legacy_drizzle_allowed(self) -> None:
        tables = tuple(table for table in TABLES if table != "migration") + ("__drizzle_migrations",)
        facts = MODEL.SchemaFacts(tables, tuple(MIGRATION_IDS), False, True)
        self.assertEqual(SCHEMA.classify_schema(BASELINE, facts).status, MODEL.Status.ALLOW_V1)

    def test_resolve_drizzle_by_name(self) -> None:
        rows = tuple((index, "h", migration_id) for index, migration_id in enumerate(MIGRATION_IDS))
        result = SCHEMA.resolve_drizzle(BASELINE, ("id", "hash", "name"), rows)
        self.assertTrue(result.ok)
        self.assertEqual(set(result.ids), set(MIGRATION_IDS))

    def test_resolve_drizzle_by_created_at(self) -> None:
        rows = tuple(
            (index, "h", _timestamp_ms(migration_id))
            for index, migration_id in enumerate(MIGRATION_IDS)
        )
        result = SCHEMA.resolve_drizzle(BASELINE, ("id", "hash", "created_at"), rows)
        self.assertTrue(result.ok)
        self.assertEqual(set(result.ids), set(MIGRATION_IDS))

    def test_resolve_drizzle_unknown_name_fails(self) -> None:
        result = SCHEMA.resolve_drizzle(
            BASELINE, ("id", "hash", "name"), ((1, "h", "20990101000000_future_thing"),)
        )
        self.assertFalse(result.ok)

    def test_resolve_drizzle_unknown_timestamp_fails(self) -> None:
        result = SCHEMA.resolve_drizzle(
            BASELINE, ("id", "hash", "created_at"), ((1, "h", 4102444800000),)
        )
        self.assertFalse(result.ok)

    def test_resolve_drizzle_unsupported_shape_fails(self) -> None:
        result = SCHEMA.resolve_drizzle(BASELINE, ("id", "hash"), ())
        self.assertFalse(result.ok)


if __name__ == "__main__":
    unittest.main(verbosity=2)
