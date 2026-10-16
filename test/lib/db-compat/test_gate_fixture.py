#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
# How to run: python3 test/lib/db-compat/test_gate_fixture.py -v
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from gate_common import BASELINE_PATH, FIXTURE, HELPER, _hashes, _run_check, _status


class FixtureTests(unittest.TestCase):
    def setUp(self) -> None:
        if not FIXTURE.is_file():
            self.skipTest(f"disposable v1 fixture absent: {FIXTURE}")

    def test_committed_baseline_matches_fixture_capture(self) -> None:
        temp_dir = Path(tempfile.mkdtemp(prefix="aek-capture-"))
        output = temp_dir / "baseline.json"
        try:
            completed = subprocess.run(
                [
                    sys.executable,
                    str(HELPER),
                    "capture-baseline",
                    "--db",
                    str(FIXTURE),
                    "--out",
                    str(output),
                    "--opencode-version",
                    "1.19.0",
                    "--openchamber-version",
                    "1.24.2",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(
                json.loads(output.read_text(encoding="utf-8")),
                json.loads(BASELINE_PATH.read_text(encoding="utf-8")),
            )
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_fixture_recognized_and_unmodified(self) -> None:
        before = _hashes(FIXTURE.parent)
        completed = _run_check(FIXTURE)
        after = _hashes(FIXTURE.parent)
        self.assertEqual(_status(completed), "allow_v1")
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main(verbosity=2)
