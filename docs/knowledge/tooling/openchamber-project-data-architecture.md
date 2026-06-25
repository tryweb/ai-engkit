# OpenChamber Project Data & Recovery After Rename

## Context

OpenChamber v1.13.3 stores per-project data outside the OpenCode SQLite database, keyed by the project's **filesystem path**. When a project directory is renamed (e.g., `Codeforge` → `ai-engkit`), OpenChamber treats it as a new project — scheduled tasks vanish from the UI, and sessions become invisible even though they share the same `project_id` in the OpenCode DB.

This applies to anyone running OpenChamber who renames a workspace directory.

## Problem

After renaming a project directory on disk:

1. **Scheduled tasks disappear** — OpenChamber looks for a settings file at `~/.config/openchamber/projects/path_<base64(path)>.json`. The old path's file exists, but no file for the new path exists.
2. **Sessions become invisible** — OpenChamber calls `experimental.session.list({directory: projectPath})`, filtering by the exact directory path stored in the `session.directory` column. Old sessions still have the old path.
3. **Projects list still shows the old entry** — OpenChamber's `settings.json` `projects[]` array is indexed by the base64-encoded path, so the old project remains listed separately.

The OpenCode **backend** correctly maps both paths to the same `project_id` (via `project_directory` table and `sandboxes` column). The data loss is purely in OpenChamber's UI layer.

## Solution

Recovery requires updating **three independent storage layers**:

### 1. OpenCode DB — session directory paths

```sql
UPDATE session
SET directory = '/home/devuser/workspace/<new-name>'
WHERE project_id = '<project-id>'
  AND directory = '/home/devuser/workspace/<old-name>';
```

Verify:
```sql
SELECT COUNT(*) FROM session WHERE directory LIKE '%<old-name>%';
```

### 2. OpenChamber project settings — scheduled tasks

Copy the scheduled tasks from the old project file to a new one:

```bash
# Old file (still exists as backup)
~/.config/openchamber/projects/path_<base64(old-path)>.json

# New file (create this)
~/.config/openchamber/projects/path_<base64(new-path)>.json
```

File format:
```json
{
  "version": 1,
  "scheduledTasks": [
    {
      "id": "<uuid>",
      "name": "<task-name>",
      "enabled": true,
      "schedule": { "kind": "daily", "times": ["HH:MM"], "timezone": "<IANA-tz>" },
      "execution": {
        "prompt": "<prompt-text>",
        "providerID": "opencode",
        "modelID": "<model-id>",
        "agent": "<agent-name>"
      },
      "state": {
        "createdAt": <epoch-ms>,
        "updatedAt": <epoch-ms>,
        "lastStatus": "success",
        "lastRunAt": <epoch-ms>,
        "lastDurationMs": <ms>,
        "nextRunAt": <epoch-ms>,
        "lastSessionId": "<session-id>"
      }
    }
  ]
}
```

### 3. OpenChamber session UI organization

Update `~/.config/openchamber/sessions-directories.json`: move the session IDs from the old project's folder entry to a folder under the new project's `__archived__:<new-path>` key, then remove the old folder entry.

This file is organized as:
```json
{
  "version": 1,
  "foldersMap": {
    "__archived__:<parent-path>": [
      { "name": "<project-name>", "sessionIds": ["ses_...", ...] }
    ],
    "__archived__:<new-project-path>": [
      { "name": "<folder-name>", "sessionIds": ["ses_...", ...] }
    ]
  }
}
```

The `__archived__` prefix is a namespace convention, not a deletion marker — all project-level folders use it.

## Why It Works

- **OpenCode DB** uses a stable `project_id` (SHA1 of worktree path on creation) that survives directory renames. The `project_directory` table links multiple directory entries to the same project, and `sandboxes` tracks active paths. Updating `session.directory` to the new path makes the backend `session.list({directory: ...})` filter match again.
- **OpenChamber's project settings** are flat files keyed by base64(path). Creating a new file at the new path makes scheduled tasks appear. The old file becomes orphaned but remains as backup.
- **sessions-directories.json** is a UI organizational cache. Moving session IDs under the new path's key makes OpenChamber's folder tree show them.

## Side Effects / Tradeoffs

- **Direct DB mutation** — updating `session.directory` in the OpenCode DB bypasses the application layer. There is no event-sourced rollback. Take a backup first: `cp ~/.local/share/opencode/opencode.db ~/.local/share/opencode/opencode.db.bak`.
- **The old `settings.json` project entry** (in `~/.config/openchamber/settings.json`) remains with the old path. It becomes a stale entry. OpenChamber may show the old project in the sidebar as inaccessible until manually removed.
- **Sessions created under a git worktree** (`~/.local/share/opencode/worktree/.../<slug>`) use worktree paths, not the project root. These are unaffected and should not be migrated.
- The `sessions-directories.json` folder `id` field, if hand-written as a non-UUID string, should not cause issues — OpenChamber likely ignores folder IDs for display. But to be safe, generate a proper UUID.

## Evidence

- Observed: Codeforge project (240 sessions) vanished from OpenChamber UI after directory rename
- Verified: `project_directory` table correctly linked both `Codeforge` and `ai-engkit` paths to the same `project_id`
- Verified: `session.list({directory: '/home/devuser/workspace/Codeforge'})` returned 240 sessions before migration, 0 after update
- Verified: scheduled tasks persisted in the old project JSON file after rename
- Database: 6.5 GB SQLite at `~/.local/share/opencode/opencode.db`
- Source: OpenChamber bundled JS at `~/.bun/install/global/node_modules/@openchamber/web/dist/assets/`

## Related Files

- `~/.local/share/opencode/opencode.db` — OpenCode SQLite DB (session, project, project_directory tables)
- `~/.config/openchamber/settings.json` — OpenChamber settings (projects[], pinned directories)
- `~/.config/openchamber/sessions-directories.json` — Session UI folder organization
- `~/.config/openchamber/projects/path_<base64(path)>.json` — Per-project settings (scheduled tasks, icons)
- `~/.config/openchamber/managed-opencode/*.json` — OpenCode process registry (not project-scoped)

## Tags

- openchamber
- opencode
- project-rename
- data-recovery
- session-migration
- scheduled-tasks
- storage-architecture
