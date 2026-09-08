# Admin DB Maintenance

## Purpose

Lets operators configure, trigger, and monitor periodic space reclamation for the production opencode database from the admin dashboard, replacing SSH-only manual maintenance with a guarded, auditable workflow.

## Requirements

### Requirement: Retention policy configuration

The system SHALL allow an authenticated admin operator to configure a retention policy consisting of an enabled flag, an inactivity cutoff in days (1-365), and a required daily run time `dailyRunAt` in 24h `HH:MM` (zero-padded, `00:00`–`23:59`, default `03:00` for stored policies missing the field), for hard deletion, and SHALL persist it server-side. There is deliberately no archive action: archiving reclaims zero bytes (verified), so offering it would report success without freeing space. Invalid values MUST be rejected with a field-level error naming the offending field and no partial write.

#### Scenario: Save valid policy

- **WHEN** an operator saves enabled=true, cutoff=30 days, dailyRunAt=03:00
- **THEN** the system stores the policy and returns the stored values on subsequent reads

#### Scenario: Reject invalid cutoff

- **WHEN** an operator saves a cutoff of 0 or 400 days
- **THEN** the system rejects the request with an error and the previous policy remains unchanged

#### Scenario: Reject invalid dailyRunAt and apply default for missing stored field

- **WHEN** an operator saves a dailyRunAt of 24:00 or 3:00 or ab:cd
- **THEN** the system rejects the request with a field-level error naming `dailyRunAt` and the previous policy remains unchanged
- **WHEN** a stored policy file missing `dailyRunAt` (pre-off-peak) is read
- **THEN** the system resolves it to `03:00` without migrating the file on disk and the scheduler uses the wall-clock time

### Requirement: Manual maintenance run with explicit confirmation

The system SHALL require an explicit confirmation step before any destructive maintenance run, SHALL create a restorable backup before deleting anything, and SHALL stream progress events (backup, delete, reclaim, verify) until the run reaches a terminal state (success or failure). A second run MUST be rejected while one is in progress.

#### Scenario: Confirmed run completes

- **WHEN** an operator confirms a maintenance run against the stored policy
- **THEN** the system creates a backup first, deletes only sessions older than the cutoff plus their FK-cascaded dependents (including event sequences and their events), reclaims file space, verifies integrity, and reports per-phase outcomes

#### Scenario: Concurrent run rejected

- **WHEN** an operator triggers a run while another run is in progress
- **THEN** the system rejects the second request with a conflict error

### Requirement: Fail-closed disk and writer guards

The system SHALL refuse to start a maintenance run when free disk space is below the required headroom for backup plus reclaim temp space, and SHALL abort the run if free space drops under a critical floor mid-run, leaving the original database file intact. The system SHALL perform deletes and reclaim only while no database writer is active.

#### Scenario: Insufficient space refuses to start

- **WHEN** free disk space is below the required headroom at trigger time
- **THEN** the system refuses the run with an explanatory error and changes nothing

#### Scenario: Mid-run space exhaustion aborts safely

- **WHEN** free space breaches the critical floor during reclaim
- **THEN** the system aborts, discards temp artifacts, preserves the original database, and reports failure with the guard that tripped

#### Scenario: Busy sessions defer the run

- **WHEN** one or more opencode sessions are still running at trigger time
- **THEN** the system waits for completion up to a deadline, and refuses to stop the runtime without deleting anything if sessions stay busy or session status is unavailable

### Requirement: Read-only database health status

The system SHALL expose read-only database health: database file size, freelist count, session/event/message/part row counts, and host free disk space. Status collection MUST NOT write to the database or require stopping any service.

#### Scenario: Health read without side effects

- **WHEN** an operator views database health while the system is serving traffic
- **THEN** the system returns current size, freelist, row counts, and free space with no writes and no service interruption

### Requirement: Guarded scheduled execution

The system SHALL evaluate the stored policy on a daily cadence and execute a maintenance run only when the policy is enabled, all disk and writer guards pass, and at least one prior manual run has succeeded. Any guard failure MUST skip the run and record the skip reason; a scheduled run MUST NEVER delete data the manual path would refuse to delete.

#### Scenario: Scheduled run skipped on guard failure

- **WHEN** the daily evaluation finds insufficient free space
- **THEN** no deletion occurs and the skip reason is recorded and visible to the operator

#### Scenario: Schedule inactive without successful manual run

- **WHEN** the policy is enabled but no manual run has ever succeeded
- **THEN** the scheduler takes no destructive action
