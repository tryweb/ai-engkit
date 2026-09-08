# OpenChamber Session Retention Fields: Schema-Only, No Server-Side Executor

## Context

ai-engkit's opencode.db (SQLite, `~/.local/share/opencode/opencode.db`) grew to ~13.8G. An earlier research report recommended enabling OpenChamber's built-in auto-cleanup (Strategy A: `autoDeleteEnabled` / `autoDeleteAfterDays` / `sessionRetentionAction`) assuming it runs "每日最多跑一次、走官方 API" server-side. Verifying that claim against the **installed** `@openchamber/web` v1.22.2 (`/home/devuser/.bun/install/global/node_modules/@openchamber/web/server/`) revealed the assumption was wrong.

## Problem

The retention settings fields exist and pass validation, but **no server-side component consumes them**. Relying on them for automated space reclamation silently fails in a headless container.

## Solution

Confirmed facts from installed source (`@openchamber/web` v1.22.2):

- **Schema (settings-helpers.js)** — `sanitizeSettingsUpdate` whitelists and normalizes:
  - `autoDeleteEnabled` (boolean)
  - `autoDeleteAfterDays` (number, clamped `1..365`, rounded)
  - `sessionRetentionAction` (`'archive' | 'delete'`)
  - Tests (`settings-helpers.test.js:679-710`) only cover **persistence round-trip**, not execution.
- **Storage path** — `settings-runtime.js` reads/writes `SETTINGS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'settings.json')`, where `OPENCHAMBER_DATA_DIR = env OPENCHAMBER_DATA_DIR ?? $HOME/.config/openchamber`. With no env override, this is **exactly** `/home/devuser/.config/openchamber/settings.json` — the same file the admin dashboard already reads/writes (`src/admin/routes/openchamber.ts`).
- **Execution model — frontend-orchestrated only.** `autoDeleteEnabled`, `autoDeleteAfterDays`, `autoDeleteLastRunAt`, `setAutoDeleteLastRunAt` appear in the **frontend bundle** (`dist/assets/useAppFontEffects-Bb1Zihd2.js` etc.), not in any server runtime. The UI:
  - computes eligible sessions = `activeSessions` older than `cutoffDays`, excluding `currentSessionId`
  - tracks "once per day" via `autoDeleteLastRunAt` in client state
  - runs via `POST /api/openchamber/sessions/archive` (archive action) or the opencode SDK session delete (delete action); manual "Run cleanup now" is `POST /api/openchamber/sessions/archive`
- `grep -rI "autoDelete"` across the whole server (`server/lib`, `server/index.js`) hits **only** `settings-helpers.js` (sanitizer) — zero behavioral consumers.

## Why It Works

The settings file is validated and persisted correctly, so writing the three fields via admin works "on paper". But the retention job only executes while an OpenChamber **browser tab is open** (`activeSessions` populated). Headless operation (`openchamber serve` as entrypoint, no UI tab) means the daily run never fires — a silent no-op.

## Side Effects / Tradeoffs

- Enabling retention via admin UI in this container would store settings but not reclaim space reliably.
- For real automation, prefer a maintenance-window SQL batch (`DELETE FROM session WHERE time_updated < cutoff` + FK cascade + `VACUUM`) or a cron wrapper over `opencode session delete` — not reliance on OpenChamber's frontend-driven retention.
- The manual archive endpoint exists (`POST /api/openchamber/sessions/archive`, max 500 ids/batch) but requires explicit session ids; it is not a by-age sweep.
- Consistent with `docs/knowledge/troubleshooting/opencode-session-auto-archive.md`: opencode binary itself has no built-in retention; the old 30-day auto-archive came from a now-dead opencode runtime behavior.

## Evidence

- `server/lib/opencode/settings-helpers.js:400-408` — retention field sanitization.
- `server/lib/opencode/settings-runtime.js:59,475-508` — reads/writes `SETTINGS_FILE_PATH`.
- `server/index.js:308-311` — `OPENCHAMBER_DATA_DIR = env ?? $HOME/.config/openchamber`; `SETTINGS_FILE_PATH = .../settings.json`.
- `server/lib/openchamber-sessions/routes.js:631-671,939-945` — archive endpoint; service exposes only `create/archive/send/fork` (no delete, no scheduler).
- `dist/assets/useAppFontEffects-Bb1Zihd2.js` — frontend retention state (`autoDeleteEnabled`, `autoDeleteAfterDays`, `autoDeleteLastRunAt`) and `POST /api/openchamber/sessions/archive` call.
- `server/lib/opencode/settings-helpers.test.js:679-710` — persistence-only tests.
- Environment: `OPENCHAMBER_DATA_DIR` unset (verified via `env` in container).

## Related Files

- `/home/devuser/.bun/install/global/node_modules/@openchamber/web/server/lib/opencode/settings-helpers.js`
- `/home/devuser/.bun/install/global/node_modules/@openchamber/web/server/lib/opencode/settings-runtime.js`
- `/home/devuser/.bun/install/global/node_modules/@openchamber/web/server/index.js`
- `/home/devuser/.bun/install/global/node_modules/@openchamber/web/server/lib/openchamber-sessions/routes.js`
- `/home/devuser/.bun/install/global/node_modules/@openchamber/web/dist/assets/useAppFontEffects-Bb1Zihd2.js`
- `/home/devuser/workspace/ai-engkit/src/admin/routes/openchamber.ts`
- `docs/knowledge/troubleshooting/opencode-session-auto-archive.md`

## Tags

- openchamber
- opencode
- session-retention
- settings
- sqlite
- disk-space