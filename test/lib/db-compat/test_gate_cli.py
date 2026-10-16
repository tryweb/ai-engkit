#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
# How to run: python3 test/lib/db-compat/test_gate_cli.py -v
from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from gate_common import (
    BASELINE,
    BASELINE_PATH,
    GATE,
    HELPER,
    MIGRATION_IDS,
    MODEL,
    TABLES,
    _create_legacy,
    _create_tables,
    _create_v1,
    _hashes,
    _run_check,
    _status,
)


class GateCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="aek-dbtest-"))
        self.data = self.work / "data" / "opencode"
        self.data.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.work, ignore_errors=True)

    def db(self) -> Path:
        return self.data / "opencode.db"

    def test_absent_allowed(self) -> None:
        completed = _run_check(self.db())
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(_status(completed), "allow_absent")

    def test_orphan_sidecar_refused(self) -> None:
        Path(f"{self.db()}-wal").write_bytes(b"orphan")
        completed = _run_check(self.db())
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(_status(completed), "refuse_orphan_sidecars")

    def test_fresh_empty_allowed(self) -> None:
        self.db().write_bytes(b"")
        completed = _run_check(self.db())
        self.assertEqual(_status(completed), "allow_fresh")

    def test_recognized_v1_allowed(self) -> None:
        _create_v1(self.db())
        completed = _run_check(self.db())
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(_status(completed), "allow_v1")

    def test_session_content_does_not_change_recognition(self) -> None:
        _create_v1(self.db())
        con = sqlite3.connect(self.db())
        try:
            con.execute('INSERT INTO "session" (id) VALUES ("s1")')
            con.commit()
        finally:
            con.close()
        self.assertEqual(_status(_run_check(self.db())), "allow_v1")

    def test_v2_session_v2_refused(self) -> None:
        con = _create_tables(self.db(), ("session", "session_v2", "message"))
        con.close()
        self.assertEqual(_status(_run_check(self.db())), "refuse_v2")

    def test_v2_migration_id_refused(self) -> None:
        _create_v1(self.db(), ids=("20260804233008_loose_psylocke",))
        self.assertEqual(_status(_run_check(self.db())), "refuse_v2")

    def test_unknown_migration_id_refused(self) -> None:
        _create_v1(self.db(), ids=("20990101000000_future_thing",))
        self.assertEqual(_status(_run_check(self.db())), "refuse_unknown")

    def test_corrupt_refused(self) -> None:
        self.db().write_bytes(b"definitely not a sqlite database" * 40)
        self.assertEqual(_status(_run_check(self.db())), "refuse_corrupt")

    def test_baseline_missing_refused(self) -> None:
        _create_v1(self.db())
        completed = _run_check(self.db(), baseline=self.work / "absent.json")
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(_status(completed), "refuse_baseline")

    def test_legacy_drizzle_name_allowed(self) -> None:
        _create_legacy(self.db(), with_name=True)
        self.assertEqual(_status(_run_check(self.db())), "allow_v1")

    def test_legacy_drizzle_created_at_allowed(self) -> None:
        _create_legacy(self.db(), with_name=False)
        self.assertEqual(_status(_run_check(self.db())), "allow_v1")

    def test_locked_refused(self) -> None:
        _create_v1(self.db())
        writer = (
            "import sqlite3,sys,time;"
            "con=sqlite3.connect(sys.argv[1]);con.execute('BEGIN IMMEDIATE');"
            "sys.stdout.write('ready\\n');sys.stdout.flush();time.sleep(60)"
        )
        proc = subprocess.Popen(
            [sys.executable, "-c", writer, str(self.db())],
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            if proc.stdout is None:
                self.fail("writer stdout was unavailable")
            self.assertIn("ready", proc.stdout.readline())
            self.assertEqual(_status(_run_check(self.db())), "refuse_locked")
        finally:
            if proc.stdout is not None:
                proc.stdout.close()
            proc.terminate()
            proc.wait(timeout=10)

    def test_wal_only_change_detected(self) -> None:
        crash = (
            "import os,sqlite3,sys;"
            "con=sqlite3.connect(sys.argv[1]);con.execute('PRAGMA journal_mode=WAL');"
            "con.execute('CREATE TABLE session_v2 (id TEXT)');con.commit();"
            "os._exit(1)"
        )
        subprocess.run([sys.executable, "-c", crash, str(self.db())], check=False)
        self.assertGreater(Path(f"{self.db()}-wal").stat().st_size, 0)
        control = self.work / "control" / "data" / "opencode"
        control.mkdir(parents=True)
        (control / "opencode.db").write_bytes(self.db().read_bytes())
        self.assertEqual(_status(_run_check(control / "opencode.db")), "allow_fresh")
        self.assertEqual(_status(_run_check(self.db())), "refuse_v2")

    def test_original_files_unchanged(self) -> None:
        _create_v1(self.db())
        con = sqlite3.connect(self.db())
        con.execute("PRAGMA journal_mode=WAL")
        con.close()
        before = _hashes(self.data)
        _run_check(self.db())
        after = _hashes(self.data)
        self.assertEqual(before, after)

    def test_unstable_copy_refused(self) -> None:
        _create_v1(self.db())
        original = GATE.copy_files

        def touching_copy(files, dest_dir):
            copied = original(files, dest_dir)
            os.utime(self.db(), None)
            return copied

        setattr(GATE, "copy_files", touching_copy)
        try:
            result = GATE.run_gate(BASELINE, self.db())
        finally:
            setattr(GATE, "copy_files", original)
        self.assertEqual(result.status, MODEL.Status.REFUSE_UNSTABLE)

    def test_helper_does_not_shell_out(self) -> None:
        sources = [
            HELPER,
            Path(__file__).resolve().parents[3] / "scripts" / "ai_engkit_db_compat_model.py",
            Path(__file__).resolve().parents[3] / "scripts" / "ai_engkit_db_compat_schema.py",
            Path(__file__).resolve().parents[3] / "scripts" / "ai_engkit_db_compat_gate.py",
        ]
        for source_path in sources:
            source = source_path.read_text(encoding="utf-8")
            self.assertNotIn("import subprocess", source, source_path.name)
            self.assertNotIn("os.system", source, source_path.name)
            self.assertNotIn("popen", source.lower(), source_path.name)
        _create_v1(self.db())
        env = dict(os.environ, PATH="/nonexistent-bin")
        completed = _run_check(self.db(), env=env)
        self.assertEqual(_status(completed), "allow_v1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
