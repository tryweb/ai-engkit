# DESIGN.md — AI-EngKit Admin Dashboard

Design contract for the admin dashboard. Server-rendered Hono JSX (no client
framework); styling lives in `src/admin/static/style.css` as plain CSS classes.

## 1. Design contract

- Dark zinc theme: background `#18181b`, surface `#27272a`, border `#3f3f46`.
- Text `#f4f4f5`, muted `#a1a1aa`; green accent `#10b981` (hover `#34d399`).
- Semantic colors: success `#10b981`, danger `#ef4444`, warning `#f59e0b`.
- Radius `8px`; 4px spacing grid (8 / 12 / 16 / 20 / 24).
- Typography: Inter (sans) for UI, JetBrains Mono (mono) for code/versions.
- Layout: fixed 240px sidebar + `.main-content` (max-width 1200px); topbar
  drawer replaces the sidebar at ≤768px.

## 2. Tokens

All tokens are CSS custom properties on `:root` in `style.css`:

| Token | Value | Use |
|---|---|---|
| `--bg` | `#18181b` | page background |
| `--surface` | `#27272a` | cards, sidebar, inputs |
| `--border` | `#3f3f46` | borders, dividers |
| `--text` | `#f4f4f5` | primary text |
| `--text-muted` | `#a1a1aa` | secondary text, labels |
| `--accent` / `--accent-hover` | `#10b981` / `#34d399` | primary actions, focus, active nav |
| `--danger` | `#ef4444` | errors, destructive actions, stopped state |
| `--success` | `#10b981` | healthy state |
| `--warning` | `#f59e0b` | degraded state, update available |
| `--radius` | `8px` | card/input radius |
| `--font-sans` / `--font-mono` | Inter / JetBrains Mono | UI / code |
| `--text-xs` … `--text-4xl` | 0.75rem … 2.25rem | type scale |
| `--text-code` | 0.8125rem | inline code |

Semantic tones map to tokens: `success` → `var(--success)` + `.status-pill--success`/`.badge-success`; `warning` → `var(--warning)` + `.status-pill--warning`/`.badge-warning`; `danger` → `var(--danger)` + `.status-pill--danger`/`.badge-danger`; `neutral` → `var(--text-muted)` + `.status-pill--neutral` neutral surface. Color is never the sole indicator — each tone carries visible text.

## 3. Primitives

Named classes, defined in `style.css`; JSX primitives live in
`src/admin/views/dashboard.tsx`.

### StatusPill — `.status-pill` + `.status-pill--{tone}`
Compact rounded status indicator. Tones: `success`, `danger`, `warning`,
`neutral`. Used for container status, auth state, version mismatch, Center state, Runtime Profile fields, AI Runtime rows. Accepts an
optional `ariaLabel` for glyph-only labels (e.g. `✓` / `✗`).

### MetricCard — `.metric-card` (+ `.metric-card--accent`)
Overview metric surface. Rendered as `<dl>` with `<dt>` title, `<dd>` value,
optional `<dd>` sub and foot (foot separated by a top border). Accent tone adds
a green-tinted gradient border for the headline metric. Value uses
`font-variant-numeric: tabular-nums` for stable scanning. Numbers format with `en-US` grouping.

### SiteSummary band — `.site-summary` + `__item` / `__label` / `__value`
Compact status strip directly under the page heading. Flex-wrap row of
label/value pairs and pills: container status + uptime, project count, GitHub /
GitLab auth, git user, Center state (linked to `/agent`), admin version mismatch, update availability. Center item uses exact copy `Connected`/`Standalone`/`Disconnected`/`Unavailable` with tones `success`/`neutral`/`warning`/`danger` and links to `/agent`. When `admin_version` is `dev`, the `✓ Latest` badge is suppressed in both the Site Summary and the Component Versions `AI-EngKit` row; actionable states (`▲ Upgrade`, `● Pinned`, `? unavailable`) remain visible.

### Runtime Profile — `.runtime-profile` + `__header` / `__fields` / `__field` / `__label` / `__value` / `__action`
Compact read-only LeanCTX Runtime Profile card directly below the KPI row. Fixed field order: Apply state, `Compression`, `Tools`, `Security`, `Archive`, plus `Open configuration` link to `/leanctx`. Apply states: `Applied` (success), `Pending apply` (warning), `Saved config only` (neutral), `Runtime profile unavailable` (danger). Compression values: `Off`/`Lite`/`Standard`/`Max`/`Unknown`; Tools: `Minimal`/`Standard`/`Power`/`Unknown`; Archive: `On · {hours}h`/`Off`/`Unknown`; Security: `Protected` (success)/`Review` (warning)/`At risk` (danger)/`Unknown` (neutral) with focus-accessible detail listing `Secret detection`, `Secret redaction`, `Cross-project search`, `Permission inheritance` as `On`/`Off`/`Unknown`. All values carry semantic tone tokens; unknown uses neutral. The card action CTA links to `/leanctx` with min 44px target.

### AI Runtime card — `.ai-runtime` + `__row` / `__label` / `__value`
Compact AI execution dependency card. Fixed rows: `Providers` then `Subagents`. Providers row links to `/providers`; Subagents row links to `/agent-models`. No header action; rows provide navigation. Card container is not clickable (no nested interactive elements). Each row has min 44px target.

### Dashboard operational row — `.dashboard__ops-row` + `.card--link`
Container Status, Projects, and AI Runtime share one three-column row on desktop and stack below 1025px. The site-summary Projects item and Projects card link to `/projects`; GitHub, GitLab, and Git items link to `/auth/github`, `/auth/gitlab`, and `/git-config`; the AI-EngKit version links to `/versions`.

### LeanCTX Insights — `.insights` + `__subsection` / `__title` / `__table`
One container replacing the former separate full-width value panels. Fixed subsection order: `Savings Economics`, `Decision Quality`, `Evidence`, `Top Saving Tools`. Each subsection owns unique facts and renders `Data unavailable` locally without hiding siblings. Savings Economics shows gross tokens/USD, overhead USD/bounce tokens, ledger verification without repeating KPI headlines. Top Saving Tools shows at most five tools in descending token order with proportional share bars (`.share-bar` + `__fill`). All numbers use `en-US` formatting: integers/tokens grouped no decimals, percentages one decimal + `%`, USD `$` + two decimals, CPAO grouped + `μs`, ETPAO grouped + ` tokens`. Component Versions (`#versions-card`) shares heading/table rhythm with Insights per polish option 1 — `h3` 12px bottom margin and `th`/`td` 10px×12px with 4px top table offset — no content or breakpoint changes.

### Existing primitives (unchanged contract)
- `.card` — surface container with 20px padding, 16px bottom margin.
- `.badge` + `.badge-success` / `.badge-danger` / `.badge-warning` — small
  rounded status labels (detail views).
- `.btn` / `.btn-outline` / `.btn-danger` — actions; 44px min-height on mobile.
- `table` — bordered detail rows (auth, versions).
- `.progress-bar` / `.fill` — upgrade progress.
- `.log-viewer` / `.log-entry` — upgrade event log.

### Projects capability badges — `.cap-badges` + `.cap-badge`
Project-row capability cluster (Knowledge, Maintenance, OpenSpec, SuperPower, CodeGraph, LeanCTX Knowledge); each badge is a focusable button that opens the project drawer. CodeGraph keeps its existing copy and tones: `CG` indexed/stale/not-indexed, `CG?` unknown. LeanCTX Knowledge states carry visible text: available shows `LK {activeFacts}`, empty shows `no knowledge`, a failed probe shows `LK unknown`; every badge names its capability and state in `aria-label` and `title`, so meaning is never color-only. The cluster wraps at narrow widths.

### Project drawer — `.drawer` + `__section` / `.drawer-cap`
Right-side project detail drawer (`min(420px, 100vw)`; capped to `min(360px, calc(100vw - var(--sidebar)))` at 768–1024px so it never covers the sidebar). Section order: Git remote, Capabilities, CodeGraph (with Reindex), LeanCTX Knowledge, project actions. The LeanCTX Knowledge section is a read-only summary of active/archived facts, patterns, history, and last update time, labeled project-scoped; it exposes no fact mutation, import, restore, removal, consolidation, or configuration controls.

### Provider key registry row — `.key-row` + `__select` / `__value` / `__note` / `__actions`
Registry key entry on the Providers page. Flex-wrap row that fits 320px
without horizontal overflow: radio select, masked value (ellipsis-truncated),
note input, and a right-aligned action cluster (Save / Show / Delete). Key
inputs truncate at `--text-mono`; buttons keep ≥44px min-height on mobile.

### Key add row — `.key-add-row`
Wrap row of "New API key" / "Note" inputs plus Add / Import actions; inputs
flex-grow on wide screens, stack at 320px.

### ChatGPT OAuth panel — `.oauth-panel` (+ `.oauth-flow`, `.oauth-code-display`, `.oauth-code`)
OpenAI Pro/Plus connection surface. Success-tinted border when
`data-connected="true"`. The flow block shows the device code in large mono
(`--font-mono`, letter-spaced), the verification link, live poll status, and
Cancel / Finish actions; its buttons are ≥44px.

### Share bar — `.share-bar` + `__fill`
Proportional token-share bar in Top Saving Tools. Track is `--border` surface, fill uses `var(--accent)` or tone color; width is `(tokens / totalTokensSaved) * 100%`.

## 4. Dashboard page structure

Order is fixed and does not reorder on status change:

1. `h2` page heading.
2. `.site-summary` band — scannable site status including Center.
3. `.metric-row` — three `.metric-card`s: **Token Savings** (net tokens saved,
   net USD saved, compression %), **leanCTX Memory** (total memory facts,
   projects with facts, health coverage), **leanCTX Activity** (active projects
   in 24h, savings ledger integrity).
4. `.runtime-profile` — LeanCTX Runtime Profile (Apply, Compression, Tools, Security, Archive, CTA to `/leanctx`).
5. `.dashboard__ops-row` — Container Status (restart + admin mismatch), Projects (count only, linked to `/projects`), and AI Runtime (Providers/Subagents) in one operational row.
7. `.insights` — LeanCTX Insights (Savings Economics, Decision Quality, Evidence, Top Saving Tools) in fixed order.
8. Existing lower-priority administrative sections: Auth Status, Component Versions.

The overview row is the summary layer; the cards below keep the full detail.
Null probes render `—` / "unavailable" / `Data unavailable` in the owning section and keep the layout
stable. No duplicate headline values across sections.

## 5. Responsive rules

| Breakpoint | Behavior |
|---|---|
| ≥1280px (desktop) | `.runtime-profile__fields` single compact row; `.metric-row` 3 columns; `.dashboard__ops-row` 3 columns; sidebar visible; `.ai-runtime__row` horizontal |
| 1025–1279px (desktop) | `.dashboard__ops-row` 3 columns; `.metric-row` 3 columns; sidebar visible |
| 768–1024px (tablet) | `.metric-row` 2 columns, third card spans full width; `.dashboard__ops-row` stacks; `.runtime-profile` heading/action row + wrapping field row; `.ai-runtime__row` horizontal |
| ≤768px (and `.mobile` class) | `.metric-row` 1 column; sidebar → topbar drawer; `.grid-2`/`.grid-3` stack; `.runtime-profile__fields` as two-column `dl` definition list; `.ai-runtime__row` stacks label/value/actions; 44px touch targets; `document.documentElement.scrollWidth === window.innerWidth` (no horizontal scroll); cards stack |
| 375px (mobile) | Same as ≤768px; Runtime Profile fields and AI Runtime rows stacked; definition-list layout without clipping |
| 320px floor | `.site-summary` wraps; metric values fit at `--text-3xl`; `.key-row` and `.key-add-row` wrap so registry keys fit without horizontal overflow; all new rows fit without clipping |

Same DOM content is restyled rather than duplicated, preserving accessible names and avoiding divergent copy.

## 6. Accessibility constraints

- `:focus-visible` outline: 2px `--accent`, 2px offset, on links, buttons,
  inputs, and tabbable elements. Runtime Profile security details and AI Runtime rows expose focus-visible state; security details available on focus as well as hover.
- Semantic structure: `<section aria-label>` for metric row, runtime profile, AI Runtime, and Insights; `<dl>/<dt>/<dd>` for metric cards, Runtime Profile fields, and key-value pairs; `<table>` with `<th>` for tool breakdown; `aria-label` on the site summary band and on glyph-only pills. Accessible names include both field label and visible state.
- `prefers-reduced-motion`: all transitions/animations collapse to ~0 duration.
- Touch targets ≥44px on mobile and at all breakpoints for buttons, CTAs, row links, nav links.
- Muted text (`#a1a1aa`) on surface (`#27272a`) keeps ≥4.5:1 contrast.
- Links are non-nested: card container not clickable; rows are distinct interactive targets. Details use focusable disclosure (`<details>`/keyboard-accessible tooltip) rather than hover-only content.

## 7. Accepted debt

- Pre-existing inline `style=` attributes across views; migrate to named
  classes incrementally (this change adds classes for new primitives only).
- Emoji glyphs as icons in nav/buttons (pre-existing).
- `UpdateBadge` is a `<span>` with `onclick` (not keyboard-focusable) —
  pre-existing; the Component Versions table remains the canonical upgrade
  trigger.
- Per-view inline `<script>` blocks (no client framework); the dashboard
  upgrade/restart script stays in `dashboard.tsx` (SIZE_OK — splitting it into
  `app.js` is out of scope). The Providers page exceeds 250 pure LOC when the
  script is inlined, so its client logic lives in `/static/providers-page.js`
  (boot data injected via `window.providersBoot`); projects.tsx follows the
  same pattern with `/static/projects-page.js`.
- KPIs and Insights intentionally partition values: net savings/compression owned by KPI row; gross/overhead/verification owned by Savings Economics subsection.
