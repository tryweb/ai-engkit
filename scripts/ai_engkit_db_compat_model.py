#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
# How to run:
#   Imported by scripts/ai-engkit-db-compat.py; not executed directly.
"""Pinned vocabulary for the OpenCode v1 database compatibility preflight.

Holds the v1 identity constants pinned from the disposable 1.19.2 fixture, the
stable status set, operator guidance, and the typed results shared by the gate.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Final, TypedDict

BASELINE_SCHEMA: Final = 1
MIGRATION_TABLE: Final = "migration"
LEGACY_JOURNAL_TABLE: Final = "__drizzle_migrations"
SIDECAR_SUFFIXES: Final = ("-wal", "-shm", "-journal")

REQUIRED_CORE_TABLES: Final = (
    "session",
    "message",
    "part",
    "session_context_epoch",
    "session_input",
    "session_message",
    "data_migration",
    "workspace",
)
V1_ONLY_TABLES: Final = ("session_context_epoch", "session_input", "data_migration")
V2_MARKER_TABLES: Final = ("session_v2",)
V2_MARKER_MIGRATIONS: Final = (
    "20260730195856_optional_session_title",
    "20260804233008_loose_psylocke",
)

type JsonValue = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
type SqlValue = str | int | float | bytes | None


class Status(StrEnum):
    """Stable machine-readable gate outcome."""

    ALLOW_ABSENT = "allow_absent"
    ALLOW_FRESH = "allow_fresh"
    ALLOW_V1 = "allow_v1"
    REFUSE_BASELINE = "refuse_baseline"
    REFUSE_ORPHAN_SIDECARS = "refuse_orphan_sidecars"
    REFUSE_LOCKED = "refuse_locked"
    REFUSE_UNSTABLE = "refuse_unstable"
    REFUSE_SPACE = "refuse_space"
    REFUSE_TEMP = "refuse_temp"
    REFUSE_CORRUPT = "refuse_corrupt"
    REFUSE_V2 = "refuse_v2"
    REFUSE_UNKNOWN = "refuse_unknown"


_ALLOWED: Final[frozenset[Status]] = frozenset(
    {Status.ALLOW_ABSENT, Status.ALLOW_FRESH, Status.ALLOW_V1}
)

GUIDANCE: Final[dict[Status, str]] = {
    Status.REFUSE_BASELINE: "Restore the baked v1 baseline manifest from the image; do not proceed without it.",
    Status.REFUSE_ORPHAN_SIDECARS: "Remove or reconcile the orphan SQLite sidecars before retrying; this is not a clean first boot.",
    Status.REFUSE_LOCKED: "Stop the process holding the database and retry after it exits cleanly.",
    Status.REFUSE_UNSTABLE: "Quiesce writers and retry; the database changed during inspection.",
    Status.REFUSE_SPACE: "Free space on the temporary filesystem, or point TMPDIR at a filesystem with room.",
    Status.REFUSE_TEMP: "Provide a writable temporary directory outside the session data path and retry.",
    Status.REFUSE_CORRUPT: "Restore the database from a known-good backup offline; do not start the v1 binary.",
    Status.REFUSE_V2: "This database was upgraded by OpenCode v2 and cannot be used by the v1 core.",
    Status.REFUSE_UNKNOWN: "Back up the data and consult the operator recovery guide; do not auto-migrate.",
}


class BaselineError(RuntimeError):
    """The pinned baseline manifest is missing or malformed."""


class GateReport(TypedDict):
    """Machine-readable gate report emitted by ``--json``."""

    status: str
    allowed: bool
    reason: str
    guidance: str
    db_path: str
    copied: list[str]
    extras: list[str]


@dataclass(frozen=True, slots=True)
class Baseline:
    """Pinned v1 identity loaded from the baseline manifest."""

    schema: int
    source: str
    tables: frozenset[str]
    required_tables: frozenset[str]
    migration_ids: frozenset[str]
    v2_tables: frozenset[str]
    v2_migration_ids: frozenset[str]


@dataclass(frozen=True, slots=True)
class SchemaFacts:
    """Schema facts read read-only from the inspection copy."""

    tables: tuple[str, ...]
    migration_ids: tuple[str, ...]
    has_migration_table: bool
    has_drizzle_table: bool


@dataclass(frozen=True, slots=True)
class Verdict:
    """A schema classification with a stable reason and supporting extras."""

    status: Status
    reason: str
    extras: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class LegacyResolution:
    """Outcome of mapping a legacy ``__drizzle_migrations`` journal to v1 ids."""

    ok: bool
    ids: tuple[str, ...]
    problem: str


@dataclass(frozen=True, slots=True)
class GateResult:
    """Final gate outcome."""

    status: Status
    reason: str
    guidance: str
    db_path: str
    copied: tuple[str, ...] = ()
    extras: tuple[str, ...] = ()

    @property
    def allowed(self) -> bool:
        return self.status in _ALLOWED

    def to_report(self) -> GateReport:
        return GateReport(
            status=self.status.value,
            allowed=self.allowed,
            reason=self.reason,
            guidance=self.guidance,
            db_path=self.db_path,
            copied=list(self.copied),
            extras=list(self.extras),
        )
