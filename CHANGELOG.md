# Changelog

All notable changes to Fratoo are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

See [`ProjectDocs/`](ProjectDocs/README.md) for architecture, decisions, deployment
runbooks, the user manual, and the roadmap.

---

## Versioning

From 2.0.0 on, one **product version** covers `fratoo-bridge` and `fratoo-web` together:
they're always deployed together by `ProdRelease.bat`, so both `package.json` files carry
the same number. (The retired WordPress plugin had its own version, `FRATOO_VERSION`, last
1.8.0.) Numbering follows [Semantic Versioning](https://semver.org/):

- **MAJOR** — needs something beyond running `ProdRelease.bat`, or breaks compatibility
  (device protocol, data that has to be migrated by hand, removed features).
- **MINOR** — new features. Database changes that `ProdRelease.bat` applies by itself
  (idempotent `db/init/NNN_*.sql`) are fine in a minor.
- **PATCH** — fixes only.

Commit prefixes map onto this: `feat:` → minor, `fix:` → patch, `docs:`/`chore:` → no
release on their own. Entries collect under **[Unreleased]** as work lands; cutting a
release is `.\scripts\release.ps1 <major|minor|patch> "<Title>"`, which bumps both
packages, dates the changelog section, commits and tags `vX.Y.Z` (it doesn't push or
deploy). The running build is visible in the dashboard footer and at `GET /api/version`
(version + git commit), and `ProdRelease.bat` logs both.

Versions up to 1.4.0 are the earlier WordPress-plugin era. The public repository starts at
2.6.1 with a fresh history, so tags for earlier versions aren't in it; their entries below
are kept as the project's record.

---

## [Unreleased]

### Added

- **Share calibration** switch per batch (**Edit** → *ABV model*, on by default). Turn it
  off for an odd batch (a different airlock fill, a leaky lid): the batch still uses its own
  gravity readings, but its bubble volume no longer joins the learned value new batches
  start from. Until now the only choice was excluding the readings, which also took them
  away from the batch itself.
- Migration `007_calibration_sharing.sql` (applied by `ProdRelease.bat`).

---

## [2.7.0] — 2026-10-24 — **Airlocks**

### Added

- **Airlocks** (Settings → Airlocks): every airlock that sends a reading is listed by
  itself, with online / last seen and the batch using it. Name it, copy its full token, add
  one by token before it has connected, or remove it from the list (readings and batches
  are kept). Existing airlocks are added from past readings on the first deploy.
- The new-batch and edit forms pick the airlock from a dropdown instead of a pasted token,
  preselecting the airlock of the most recent batch; **Enter a token…** still takes a raw
  token. The form warns when the chosen airlock still has an active batch.
- Batch page and report show the airlock's name.
- Migration `006_devices.sql` (applied by `ProdRelease.bat`).

### Changed

- `ProdRelease.bat` gets the code with `git fetch` + a forced checkout of `origin/main`
  instead of `git pull`, so a deploy keeps working even if the GitHub history is ever
  replaced. Gitignored files (`.env`, backups, logs) are untouched as before.

---

## [2.6.1] — 2026-10-23 — **Open Source**

First public release: the repository is now open source under the MIT license. It starts
from a fresh history; the entries below cover everything before it.

### Added
- **`LICENSE`** (MIT), a project **`README.md`** with screenshots (generated demo data),
  and a real `fratoo-web/README.md` in place of the Vite template.

### Changed
- **Docs rewritten for a public audience:** `DEPLOYMENT.md` is now a general install /
  deploy / operations runbook (HTTPS via a tunnel, backups, migrations, restore) instead of
  one server's history; `ROADMAP.md` lists only open work; `DECISIONS.md` is in date order.
  Real Wi-Fi credentials, device tokens, hostnames and IPs are no longer in the repo (keep
  your own in the git-ignored `ProjectDocs/private/`).
- Both packages declare `"license": "MIT"`.
- `ProdRelease.bat`: dropped the obsolete WordPress-plugin reminder.

### Removed
- **`fratoo-plugin/` (the WordPress plugin)**, `scripts/build-plugin.ps1`, and
  `fratoo-bridge/scripts/migrate-from-wordpress.js` with its `mysql2` dependency. The
  WordPress side was retired in 2.5.0.

---

## [2.6.0] — 2026-10-23 — **Alerts**

### fratoo-bridge

#### Added
- **Seven more push alerts** (`db/init/005_alerts.sql`, applied by `ProdRelease.bat`):
  airlock offline (no reading for 30 min) and back online; no start (no steady bubbling 24 h
  after pitching); temperature out of range at the airlock (16–24 °C, two readings in a row,
  0.5 °C hysteresis, then "back in range"); peak passed (hourly rate under half the peak for
  3 h); looks finished (under 2 bpm for 24 h with the ABV near the expected mark); possibly
  stalled (under 2 bpm for 12 h with the ABV below 70% of the expected mark); airlock
  restarted (counter reset, off by default). Offline/no-start/temperature/peak/finished/
  stalled are checked every 5 minutes; no offline alert in the first 30 min after start-up.
- **Notification settings** `GET/PATCH /api/settings/notifications`: a switch per alert
  and every threshold.
- **Per-batch temperature alert limits** (`alertTempMinC`, `alertTempMaxC` on a batch).

#### Changed
- `FermentationAlertsService` became `AlertsService`; `ReadingsService.onInserted()`
  listeners also learn whether a V100 value was a counter reset.

### fratoo-web

#### Added
- **Settings → Notifications → Alerts**: switch each alert on or off and set its
  thresholds.
- **Edit batch → Temperature alerts**: low/high limits for this batch (blank = Settings).

---

## [2.5.0] — 2026-10-23 — **Push Notifications**

### fratoo-bridge

#### Added
- **Push notifications** (`db/init/004_push.sql`, applied by `ProdRelease.bat`): Web Push
  with VAPID keys generated on first start and kept in Postgres (no `.env` change needed;
  optional `PUSH_SUBJECT`). `GET /api/push`, `POST /api/push/subscriptions`,
  `POST /api/push/subscriptions/remove`, `POST /api/push/test`. Subscriptions the push
  service reports as gone are removed.
- **"Fermentation started" alert**, once per batch: sustained bubbling (the report's
  lag-phase rule, now shared as `sustainedStartIndex()`), confirmed by two follow-up
  readings, e.g. "IPA 2026.10: bubbling at 3.0 bpm, 6h 10m after pitching." A start older
  than an hour when first seen (like a batch already fermenting at deploy) is recorded
  without a notification.

#### Removed
- **WordPress dual-write (the cutover).** `WordpressModule`, its queue and the
  `axios`/`axios-retry` dependencies are gone; readings go to Postgres only. `WP_*` settings
  in `.env` are ignored and can be deleted; deactivate `fratoo-plugin` in WP Admin.

### fratoo-web

#### Added
- **Settings → Notifications**: turn push notifications on or off for this device and send
  a test. On iPhone/iPad it explains that the home-screen app is needed (iOS 16.4+). The
  service worker shows notifications and opens the batch when one is tapped.

#### Changed
- The top-bar link and page are now just **Settings** (notifications + ABV model).

### Tools

#### Fixed
- `mock-device.js` sends the real Airlock pins (V99 sequence, V100 bubble counter, V101 raw
  temperature) instead of the old V1/V4 stand-ins; `BUBBLES_PER_SEND` (default 5, 0 = lag
  phase).

---

## [2.4.2] — 2026-10-23 — **Report polish**

### fratoo-bridge

#### Fixed
- **No ABV jump from a stray bubble before fermentation starts.** The dissolved-CO₂ head
  start (about 0.2% ABV — the CO₂ the beer soaks up before any gas leaves) was added at the
  very first bubble, so a batch showed ~0.2% while still in its lag phase (IPA 2026.10's
  day 1: 9 bubbles → 0.21%). It now kicks in only once bubbling is sustained — ≥ 1 bpm with
  the next two readings still bubbling, the same rule as the report's lag phase.
- **Report: the last day's row says when it isn't a 9 PM snapshot.** On a batch that's still
  running (or ended before 21:00 UTC), the final row of "Daily 9:00 PM snapshots" is the
  latest reading; it's now labelled "Latest reading, before 9 PM" (or "Last reading").

### fratoo-bridge + fratoo-web

#### Fixed
- **"↓ x% from peak" only shows for a real drop.** It used to show for any reading below the
  peak, e.g. "↓ 7%" five minutes after the peak while the rate was still climbing.
  Reading-to-reading noise is ±5–10%, so it now needs a drop of 15% or more (report and
  dashboard).

---

## [2.4.1] — 2026-10-22 — **Automatic theme**

### fratoo-web

#### Fixed
- **The theme can go back to following the device.** Once the sun/moon button had been
  pressed, the choice stuck for good and the app stopped following the phone's light/dark
  setting. The button now cycles Automatic (follows the device, live) → the opposite look →
  the device's look → Automatic, with a half-filled-circle icon for Automatic and a tooltip
  saying which setting is active.

---

## [2.4.0] — 2026-10-21 — **Brew Log**

### fratoo-bridge

#### Added
- **Brew log fields on a batch** (`db/init/003_brew_log.sql`, applied by `ProdRelease.bat`):
  yeast strain and its attenuation, pitch time and wort temperature at pitch, hops, priming
  sugar, bottled volume, bottle count and tasting notes. All editable through
  `PATCH /batches/:id`; the start-of-batch ones also on `POST /batches`.
- **Batch events** — `GET/POST /batches/:id/events`, `PATCH/DELETE /batches/:id/events/:eventId`
  (dry hop, addition, temperature change, disturbance, bottling, other). Annotations only —
  they never change the ABV estimate.
- **Bottled ABV, carbonation and calories** in the estimate (`bottling`, `caloriesPer330ml`):
  priming sugar is converted to ABV and to volumes of CO₂ on top of what stayed dissolved;
  calories per 330 mL from the standard ASBC formula. Empty until bubbles are counted.
- **Formatted notes** (`common/notes-format.ts`): `- `/`* ` bullets, `1. ` lists, `# `
  headings, short "Label:" lines and `**bold**`, HTML-escaped first.

#### Changed
- **Smarter "expected ABV" mark.** Uses the batch's yeast attenuation when set (the app-wide
  setting otherwise), and counts the share of the OG that came from added sugar as fully
  fermentable — table sugar has no unfermentable part. New `expectedAttenuation` and
  `sugarShare` in the estimate say what it assumed.
- **Report:** new *Brew log* card (yeast, pitch, lag, hops, events) and *Bottling* card
  (priming sugar, bottles, bottled ABV, carbonation, calories, tasting notes); long notes
  get their own formatted *Notes* card, short ones stay under the title; events drawn on the
  chart (solid amber) and named in the daily snapshot of their day; the ABV line has its own
  axis; the expected mark says what it assumes; temperature summaries say they're measured at
  the airlock; the lag phase is measured from the pitch time when known; the device ID is
  shortened.

#### Fixed
- **Report chart legend printed without its colour swatches** (and the expected/target keys
  under the ABV bar): they're backgrounds, which browsers drop when printing unless told
  otherwise. Now `print-color-adjust: exact`.

### fratoo-web

#### Added
- **Edit batch:** *Yeast & pitch* and *Bottling* sections, hops and tasting notes, and a
  bigger notes box with formatting hints. **New batch** also asks for yeast and pitch.
- **Brew log card** on the batch page (yeast, pitch, hops, bottling figures, tasting notes)
  and an **Events panel** to log dry hops, additions, disturbances and bottling.
- **Notes** render formatted; long notes move into their own card.

#### Changed
- **Chart:** logged events show as solid amber lines labelled at the bottom; the ABV line
  gets its own % axis when switched on.
- **ABV card:** the expected mark explains its attenuation and sugar share; with priming
  sugar entered, the bottled ABV replaces the generic "+0.4%" note.
- Temperature card says the sensor is at the airlock, not in the beer.

### Deployment

#### Fixed
- **`ProdRelease.bat` never noticed a failed database backup.** Step 1 checked
  `pg_dump`'s result with `%errorlevel%` inside the same `(...)` block that ran it, and
  cmd reads such a variable when the block is parsed, before `pg_dump` has run. A
  failed dump therefore printed "Backup saved" and the release carried on. The check
  now uses `if errorlevel 1` outside the block. (Found while preparing to run this script
  unattended.)

---

## [2.3.0] — 2026-10-17 — **Batch Report Redesign**

### fratoo-bridge

#### Changed
- **Download report redesigned** to match the 2.2 dashboard (logo, navy + amber, IBM Plex /
  Outfit fonts, cards) and to carry the batch page's information: estimated ABV with
  calibration badge and OG-ceiling bar, estimated gravity, attenuation, CO₂, bubble volume
  and model warnings; activity / temperature / time; the chart with the ABV line, shaded
  no-data gaps and gravity-reading markers; a gravity readings table (SG, measured vs. model
  ABV, implied bubble volume, used or why not); added sugar, OG, target ABV in the header;
  version and model assumptions in the footnote. Daily snapshots and highlights stay.
  Prints cleanly on A4; times are labelled UTC.

#### Added
- `reports.service.spec.ts` — the report had no tests before.

---

## [2.2.1] — 2026-10-17 — **Phone menu fix**

### fratoo-web

#### Fixed
- **⋯ menu off screen on phones.** On narrow screens the batch actions wrapped and the ⋯
  button landed on the left of the second row, so its right-anchored menu opened past the
  left edge. On phones the actions are now laid out as Complete fermentation (full width),
  then Download report + ⋯, with ⋯ always at the right edge.

---

## [2.2.0] — 2026-10-17 — **UI Facelift & Installable App**

### Deployment

#### Added
- `GET /api/version` (unauthenticated) and a dashboard footer showing the running version
  and git commit, with a warning if the dashboard and API builds differ.
- `ProdRelease.bat` passes the commit into both image builds, and confirms the running
  version at the end (logged).
- `scripts/release.ps1` — cuts a release (see "Versioning" above).

#### Changed
- `ProdRelease.bat` now runs from a temporary copy of itself and stops (before rebuilding
  anything) if `git pull` changed the script, asking for a re-run. Removes the old
  "pull by hand first when the script changes" rule.
- `fratoo-bridge` and `fratoo-web` versions set to 2.1.0 (were 0.0.1 / 0.0.0).

### fratoo-web

#### Added
- **New look** built from the Fratoo logo: navy + amber palette, self-hosted IBM Plex Sans /
  Mono and Outfit (wordmark) fonts, light and dark themes (follows the device; the top-bar
  toggle pins a choice), and an app frame with top bar and version footer. Works at phone
  width.
- **Installable app (PWA):** web app manifest, app icons (192/512, maskable, Apple touch
  icon, favicon) redrawn as vector from the supplied logo, and a small service worker that
  caches only the app shell — `/api` is never cached. Needs HTTPS, which the Cloudflare
  Tunnel provides.
- **Batch detail:** live device status line (live / no reading for … / no data for …), ABV
  hero with calibration badge and a bar against the OG ceiling (expected and target marks),
  grouped Activity / Temperature / Time panel, actions in a ⋯ menu.
- **Chart:** series toggles, optional ABV-over-time line, shaded no-data gaps, gravity
  readings marked on the timeline, theme-aware colors.
- **Batch list:** cards with a bubble-activity sparkline, ABV, gravity, current rate and
  last-reading time; All / Active / Completed filter.
- **Gravity readings** shown as cards, with a Brix/SG switch in the form.

#### Changed
- Delete (and Reopen) moved from the batch list rows / header buttons into the batch page's ⋯
  menu. The Vite template favicon and unused `icons.svg` replaced/removed.

### fratoo-bridge

#### Added
- `GET /api/batches/:id/stats` also returns `currentRate`, `currentTemp`, `lastReadingAt` and
  a 48-slice bubble-rate `sparkline`.
- `GET /api/batches/:id/abv-series` — ABV over time (hourly, at most 500 points).
- `maxAbv` in the ABV estimate: the most the OG could produce, the scale of the ABV bar.

### Repo-wide

#### Added
- `scripts/build-icons.ps1` — renders `fratoo-web/icons/*.svg` to the PNG icons with
  headless Edge (no npm packages); the PNGs are committed.
- nginx cache headers: hashed `/assets/` cached for a year; `index.html`, `sw.js` and the
  manifest always revalidated, so Cloudflare and installed apps pick up deploys.

---

## [2.1.0] — 2026-10-14 — **Calibrated ABV Model**

### Deployment

#### Changed
- `ProdRelease.bat` now applies database migrations (`fratoo-bridge/db/init/*.sql` after
  001, all idempotent) to the running Postgres before rebuilding the stack, instead of
  leaving it as a manual reminder.

### fratoo-bridge

#### Added
- **Calibrated ABV model** (2026-10-14), replacing the fixed 1.7 mL-per-bubble estimate
  that read 25.5% on the first production batch. Bubbles → CO₂ at the measured
  temperature → + dissolved CO₂ → ethanol → ABV → estimated SG, with the bubble volume
  learned from occasional hydrometer/refractometer readings (Terrill-corrected Brix) and
  shared across batches. Every assumption is configurable via
  `GET/PATCH /api/settings/fermentation`. New: `gravity_readings` and `app_settings`
  tables, OG/target-ABV/bubble-volume-override columns on `batches`
  (`db/init/002_abv_calibration.sql`), `GET /api/batches/:id/fermentation`,
  `/api/batches/:id/gravity-readings` CRUD. `/stats` and the downloadable report now use
  the model. See `ProjectDocs/DECISIONS.md`.

### fratoo-web

#### Added
- **ABV model UI** (2026-10-14), for the calibrated ABV model in fratoo-bridge:
  - OG (Brix/SG, "measured after sugar" flag), target ABV and a bubble-volume override
    in the batch edit form; OG, sugar and target ABV on the create form too.
  - New stat tiles: estimated gravity, apparent attenuation, bubble volume and its
    source; the ABV tile flags a capped estimate and shows expected/target ABV. Model
    warnings listed under the tiles.
  - *Gravity Readings* panel (`GravityReadingsPanel.tsx`): add/edit/exclude/delete, with
    each reading's corrected SG, implied ABV and bubble volume, and the model's
    prediction at that moment.
  - *ABV Settings* page (`/settings`) for every fermentation-model setting, highlighting
    the ones changed from default, with reset.
  - Shared formatting helpers moved to `src/lib/format.ts`.
- **Duration** stat tile on the batch detail page — elapsed time from
  `startedAt` to `endedAt` (or to now, for an active batch), computed
  client-side (`formatDuration()` in `BatchDetailPage.tsx`) since both
  timestamps are already on the `Batch` object. No backend change.
  Committed 2026-10-05, first deployed with this release.

---

## [2.0.0] — 2026-10-02 — **Standalone Backend & Dashboard**

Fratoo stops depending on WordPress: Postgres + NestJS API + React dashboard, deployed
with Docker Compose. Major because it's a new runtime, datastore and login (the
WordPress plugin keeps working in parallel while `WP_API_URL` is set). Historical data
backfilled 2026-10-03.

### fratoo-bridge

#### Added
- **Standalone backend**: Postgres-backed REST API under `/api`, replacing
  the WordPress plugin as the primary datastore/API (WordPress support kept,
  now optional via `WP_API_URL`, for parallel-run migration validation —
  see `ProjectDocs/DECISIONS.md` and `ProjectDocs/DEPLOYMENT.md`).
  - `ReadingsModule` — direct-to-Postgres V100 delta engine
    (`ReadingsService.insertReading()`), ported from
    `Fratoo_DB::insert_reading()`, with unit tests
    (`readings.service.spec.ts`). Also computes server-side fermentation
    summary stats (`computeStats()`), ported from `fratoo-chart.js`.
  - `BatchesModule` — batch CRUD, cascading delete with the next-batch
    guard, and window resolution, ported from `class-fratoo-db.php`'s
    batch methods.
  - `ReportsModule` — "Download Batch Report" HTML generation, ported from
    `class-fratoo-report.php` (same daily-snapshot/highlights/chart logic
    and HTML/CSS template).
  - `AuthModule` — single-admin JWT login (`ADMIN_USERNAME` +
    `ADMIN_PASSWORD_HASH`, bcrypt), replacing WordPress's user system.
  - `common/fermentation-math.ts` — the fermentation constants/formulas
    that used to be duplicated between PHP and JS now live in one place,
    shared by `ReadingsService` and `ReportsService`.
  - `db/init/001_init_fratoo.sql` — Postgres schema, auto-applied on a
    fresh volume.
  - `scripts/migrate-from-wordpress.js` — one-time data migration from the
    WordPress MySQL tables into the new Postgres schema. Batches are
    merged by `batch_code` (never truncated) rather than replaced
    wholesale — an earlier version would have deleted a batch created
    through the new dashboard, since those never get written back to
    WordPress; see `ProjectDocs/DECISIONS.md`.
  - `scripts/create-admin.js` (`npm run create-admin`) — interactive setup:
    prompts for username/password, writes `ADMIN_USERNAME` /
    `ADMIN_PASSWORD_HASH` / `JWT_SECRET` straight into `.env`. Built on a
    small queued stdin prompter instead of `readline.question()`, which
    turned out to silently drop input when multiple lines arrive in one
    chunk (piped input, or a password-manager paste); also filters ANSI
    escape sequences (an arrow-keypress corrupted a real production
    username before this), escapes `$` for Docker Compose's `env_file`
    interpolation (which otherwise silently truncates a bcrypt hash), and
    verifies its own output by re-reading the file and confirming the
    password actually validates before declaring success — see
    `ProjectDocs/DECISIONS.md` for all three bugs this caught.
  - `scripts/hash-password.js` — lower-level one-off: prints a bcrypt hash
    for a password passed as an argument, no `.env` writing.
- Multi-stage `Dockerfile` (`node:20-alpine`) — now orchestrated, together
  with Postgres and the new frontend, by a repo-root `docker-compose.yml`
  (moved from `fratoo-bridge/docker-compose.yml`).

### fratoo-web (NEW)

#### Added
- Standalone React + Vite SPA — login, batch list (create/delete), batch
  detail (fermentation stats, dual-axis Chart.js trend chart with range
  filter, Complete/Delete, Download Batch Report). Talks to fratoo-bridge
  over `/api` with a JWT. `FermentationChart.tsx` ports
  `assets/js/fratoo-chart.js`'s chart/filter logic directly.
- `Dockerfile` + `nginx.conf` — builds to a static bundle, served by nginx,
  which also reverse-proxies `/api` to the backend container in production.
- **Edit** form on the batch detail page (batch code, device ID, brew type, volume, added
  sugar, notes; clearing volume/sugar removes the value) and a **Reopen Batch** action for
  completed batches, which clears the end date rather than just flipping the status.
- Editing a batch's **Started** date, to backdate its window after the historical import.

### Repo-wide

#### Added
- `ProdRelease.bat` updated: backs up the Postgres database (`pg_dump`,
  skipped gracefully on a brand-new deployment) in addition to `.env`
  file(s), and deploys the full `postgres` + `api` + `web` stack from the
  repo-root `docker-compose.yml`.
- `fratoo-bridge` containerized (`Dockerfile`), and `ProdRelease.bat` introduced as the
  one-step deploy script.

---

## [1.4.0] — 2026-07-10 — **Download Batch Report**

### fratoo-plugin (v1.8.0)

#### Added
- **"Download Batch Report"** button on the batch detail page — streams a
  self-contained, print-ready HTML document (no external assets other than
  the Chart.js CDN) that opens standalone or via `Ctrl+P → Save as PDF`.
- `Fratoo_DB::get_batch_readings( int $id )` — fetches every reading inside
  a batch's device/time window in chronological order, reusing the same
  `resolve_batch_window()` (now `public`) that `delete_batch()` and
  `count_batch_readings()` already rely on, so the report's dataset always
  agrees with what "this batch" means everywhere else in the plugin.
- `Fratoo_Report` (`includes/class-fratoo-report.php`) — the report
  generation engine:
  - **Daily 9:00 PM snapshots** — a single chronological pass over V100
    builds a running cumulative-bubble total (summing only positive deltas,
    matching the reboot-safe rule in `insert_reading()`), bucketed by
    calendar day, keeping whichever row's clock time is closest to 21:00.
    Each row is paired with the nearest V101 reading (by timestamp) for a
    PCB-corrected temperature column, and a per-day estimated cumulative ABV
    computed from the running bubble total.
  - **Key Highlights** — Peak Fermentation Velocity (max `bubble_rate` +
    timestamp), Thermal Range (min/max corrected V101), and Lag Phase (time
    from `started_at` to the first V100 reading that clears a 1 bpm floor
    *and* stays active for the next two readings, filtering out single-spike
    noise).
  - **Trend chart** — dual-axis Chart.js line chart spanning the full batch
    timeline (bubble rate / teal gradient fill on the left axis, corrected
    temperature / crimson line on the right), decimated to 800 points per
    series (endpoints always preserved) so multi-thousand-row batches still
    render and print instantly; `tension: 0.4`, no heavy gridlines, fixed
    aspect-ratio canvas for consistent page-width printing.
  - Print-optimized CSS (`@media print`, `@page` A4 margins, `break-inside:
    avoid` on sections/rows) and a **Recipe & Brewer Notes** block pulling
    the batch's `notes` column.
- Routed through a new `download-report` branch in
  `Fratoo_Admin::handle_admin_actions()` (admin_init, nonce
  `fratoo_download_report_{$id}`, `manage_options`-gated) — same GET-link
  pattern as "stop batch" / "delete batch", since the handler needs to send
  its own `Content-Disposition` headers before any admin page HTML starts.

---

## [1.3.0] — 2026-07-08 — **Cascading Batch Deletion**

### fratoo-plugin (v1.7.0)

#### Added
- **Permanent batch deletion** from the WordPress admin — purges a batch
  definition row and every telemetry reading that falls inside its
  device/time window in one atomic operation.
- `Fratoo_DB::delete_batch( int $id )` — wraps the purge in a MySQL
  transaction (`START TRANSACTION` / `COMMIT` / `ROLLBACK`):
  - Locks the target batch row with `SELECT ... FOR UPDATE` to prevent a
    race with a concurrent "Complete Fermentation" click.
  - Resolves the batch's telemetry window the same way
    `Fratoo_REST::get_readings()` already does for `batch_id` reads:
    `device_id` + `recorded_at BETWEEN started_at AND (ended_at ?? NOW())`.
  - **Next-batch guard**: clamps the window's upper bound to the start of
    the next batch on the same `device_id`, if any, so an open-ended
    (still-active) window can never delete a later batch's readings.
  - Deletes matching rows from `wp_fratoo_readings` (indexed range scan via
    `idx_device_time`), then deletes the batch row, then commits. Any
    failure rolls back both operations — no orphaned batch or readings.
- `Fratoo_DB::count_batch_readings( int $id )` — read-only variant of the
  same windowed query, used to show the exact reading count before
  deletion.
- Admin: red "Delete" row action on the batches list table (generic
  confirm), and a "Delete Batch" button on the batch detail page whose
  confirm dialog shows the exact reading count via
  `count_batch_readings()`.
- `Fratoo_Admin::process_delete_batch()` — nonce-guarded
  (`fratoo_delete_batch_{$id}`), `manage_options`-gated, routed through the
  existing `handle_admin_actions()` GET-link pattern (no AJAX, consistent
  with "stop batch" / "toggle logging"). Redirects with
  `deleted=1&count=N` and renders a success notice reporting the number of
  readings wiped.

---

## [1.2.1] — 2026-06-20 — **Virtual Pin Correction (V99 ↔ V100 Swap)**

### fratoo-plugin (v1.6.0)

#### Fixed
- **Virtual pin mapping corrected** — confirmed via PLAATO's own open-source
  server (`PlaatoStructure.java` in `PLAATO-Technologies/plaato-b2c-server`):
  - **V100** is the cumulative bubble counter (was incorrectly treated as
    "Connection Status" with a 0–20 stepped backdrop).
  - **V99** is a firmware transmission sequence counter with no fermentation
    value (was incorrectly treated as the bubble counter driving the delta
    engine, summary stats, and chart).
  - **V101** is the raw PCB temperature — PLAATO applies a self-heating
    correction (`0.9133 × raw − 1.145`) that we were missing.
- `Fratoo_DB::insert_reading()` — delta engine now targets **V100** instead
  of V99; computes `bubble_rate = ΔBubbles / ΔMinutes` from consecutive V100
  rows per device.  All non-V100 pins store `bubble_rate = 0.0`.
- One-time **historical backfill migration** (`maybe_backfill_v100_bubble_rate`)
  runs automatically on next page load: zeroes out stale V99-based rates,
  then recomputes correct `bubble_rate` for every V100 row from consecutive
  deltas.  Guarded by `fratoo_v100_backfill_done` option so it runs exactly
  once.

#### Changed
- `fratoo-chart.js` — simplified from 3-dataset to clean **dual-axis layout**:
  - **Dataset 0**: Bubble Rate (bpm) — V100 `bubble_rate` on left Y-axis.
  - **Dataset 1**: Temperature °C — V101 with PCB heat correction applied at
    display time (`0.9133 × raw − 1.145`).
  - Removed: V99 dataset, hidden `y2` axis, stepped backdrop fill, and
    V100 status-code tooltip decoder (`16 → Active`, `1 → Boot`).
- `computeFermentationStats()` — Total Bubbles, CO₂, ABV, and Peak Rate now
  derived from **V100** positive deltas.  Avg Temperature applies the PCB
  correction.
- `applyFilter()` — updated index contract for 2-dataset layout:
  `datasets[0] = V100 bubble rate`, `datasets[1] = V101 temperature`.
- Admin empty-state message updated: "No V100 or V101 readings found…"
- `mock-device.js` — pin comments corrected to match confirmed firmware layout.

---

## [1.2.0] — 2026-06-13 — **Fermentation Summary Stats**

### fratoo-plugin (v1.6.0)

#### Added
- Batch detail page: new "Duration" meta card (`Xd Yh`, computed from
  `started_at`/`ended_at`, falls back to "now" while active).
- New "Fermentation Summary" card row, populated client-side from telemetry
  in `fratoo-chart.js`:
  - **Total Bubbles** — sum of positive deltas in the V99 cumulative counter
    (mirrors the server-side bubble_rate delta engine's reboot handling).
  - **CO₂ Produced (L)** — `totalBubbles × 1.7 mL` (homebrew bubble-counter
    estimate), converted to liters.
  - **Estimated ABV** — via fermentation stoichiometry
    (C6H12O6 → 2 C2H5OH + 2 CO2, 1:1 molar ratio): moles CO2 (22.4 L/mol at
    STP) → grams ethanol (46.07 g/mol) → liters ethanol (0.789 g/mL density)
    → % of batch volume. Requires batch `volume_liters` to be set; shows "—"
    otherwise.
  - **Avg Temperature (°C)** — mean of all V101 readings.
  - **Peak Bubble Rate (bpm)** — max `bubble_rate` across V99 readings.
- `enqueue_assets()` now passes `volumeLiters` to `fratooChart` JS context.

---

## [1.1.2] — 2026-06-13 — **Batch Completion Fix**

### fratoo-plugin (v1.5.2)

#### Fixed
- `Fratoo_DB::update_batch()` — fixed `ended_at` never being persisted when
  completing a batch. The method unconditionally `unset()` the `ended_at`
  field before building the update query and never included it in
  `$scalar_fields`, so "Mark as Completed" set `status = 'completed'` but
  left `ended_at` (and therefore the Duration column) empty. `ended_at` is
  now written normally when a non-null value is provided, while the existing
  "clear to NULL" path is preserved for explicit nulls.

---

## [1.1.1] — 2026-06-02 — **Range Filter Hotfix**

### fratoo-plugin (v1.5.1)

#### Fixed
- `applyFilter()` — added explicit `datasets[0].pointRadius = 0` so the V100
  backdrop dataset's point radius is locked on every filter update, matching
  the three-index layout introduced in v1.5.0:
  `[0] = V100 backdrop`, `[1] = V99 bubble rate`, `[2] = V101 temperature`.

---

## [1.1.0] — 2026-06-02 — **Bubble Rate Engine**

### fratoo-plugin (v1.5.0)

#### Added
- `wp_fratoo_readings` — new `bubble_rate FLOAT NOT NULL DEFAULT 0.0` column.
  `dbDelta` adds the column on all existing installs automatically when the plugin
  version advances from 1.4.0 → 1.5.0.
- `Fratoo_DB::insert_reading()` — server-side delta engine for V99:
  - Queries the latest prior V99 row for the same `device_id` before every insert.
  - Computes `bubble_rate = ΔBubbles / ΔMinutes` using `DateTimeImmutable`
    timestamps (millisecond-precision `DATETIME(3)` safe).
  - Negative delta (hardware reboot / counter reset) stores `0.0` instead of
    a broken negative spike.
  - Zero or negative elapsed time stores `0.0` (division-by-zero guard).
  - All non-V99 pins store `0.0` (column default).
- `fratoo-chart.js` — Connection Status (V100) backdrop dataset:
  - Third dataset rendered as a stepped, filled area (`stepped: 'before'`,
    `fill: 'origin'`, `order: 10` to sit behind all other lines).
  - Mapped to a hidden `y2` axis (range 0–20, `display: false`) so its shape
    does not affect the V99 or V101 scale.
  - Tooltip shows decoded status: `16 → Active`, `1 → Boot`.

#### Changed
- `Fratoo_DB::insert_reading()` is now the single write path for readings;
  `Fratoo_REST::create_readings()` delegates to it instead of calling
  `$wpdb->insert()` directly.
- `fratoo-chart.js` — V99 dataset now graphs `bubble_rate` (bubbles per minute)
  instead of the raw cumulative counter; the line turns from a monotonic ramp
  into a fermentation velocity curve.
- Left Y-axis label updated from `'Bubble Count (V99)'` to `'Bubble Rate (bpm)'`.
- Tooltip suffix for `y` axis changed from blank to `' bpm'`.

---

## [1.0.0] — 2026-05-30 — **Stable Release**

### fratoo-plugin (v1.4.0)

#### Fixed
- `applyFilter()` — fully NaN-hardened timestamp mapping: `recorded_at` is
  null-checked and trimmed before parsing; the `validTimes` array filters out
  any `null` or `NaN` entries before `Math.max()` is called; each row in the
  final filter also guards against `NaN` before comparison. Eliminates the
  silent propagation bug that froze range buttons when mixed device tokens
  (e.g. `airlock_1` vs. hex token) produced unparseable date strings.
- `chartInstance.update('none')` confirmed clean on every `applyFilter()` call

#### Changed
- `fratoo-chart.js` — production cleanup: removed stale inline comments,
  consolidated diagnostic console logs; code is now release-quality
- `class-fratoo-rest.php` — tightened verbose batch-resolution comments to
  concise single-line form; all non-obvious logic retains its explanation

---

## [0.8.7] — 2026-05-30

### fratoo-plugin (v1.3.7)

#### Fixed
- `fetchAllReadings()` — added immediate `break` after the first page push;
  since `batch_id` triggers `no_limit` on the server the full dataset arrives
  on page 1, preventing 9 duplicate re-requests of identical data
- `applyFilter()` — confirmed cutoff is anchored to `Math.max(...timestamps)`
  (newest record in dataset) rather than `Date.now()`; no changes needed

#### Added
- Diagnostic logging toggle on the Batches list page: "Diagnostic Logging: ON/OFF"
  status badge + Enable/Disable button; persisted via WordPress option
  `fratoo_enable_logging` (default: false)
- `process_toggle_logging()` — nonce-verified GET action; flips the option
  and calls `wp_delete_file()` on `fratoo-debug.log` when turning off
- `class-fratoo-rest.php` — `file_put_contents()` now gated on
  `get_option('fratoo_enable_logging', false)`; no disk writes when disabled

---

## [0.8.6] — 2026-05-30

### fratoo-plugin (v1.3.6)

#### Fixed
- `Fratoo_DB::get_readings()` — added `no_limit` flag: when set, the query
  runs without `LIMIT`/`OFFSET` so the full batch time window is returned in
  one trip, eliminating offset-skipping across page boundaries
- `Fratoo_REST::get_readings()` — sets `$args['no_limit'] = true` whenever
  `batch_id` is resolved, so chart fetches bypass pagination entirely
- `applyFilter()` — cutoff now anchored to `Math.max(...timestamps)` (the
  newest record in the dataset) instead of `Date.now()`, making the rolling
  window independent of any timezone offset between server and browser

---

## [0.8.5] — 2026-05-30

### fratoo-plugin (v1.3.5)

#### Fixed
- `applyFilter()` — replaced `replace(' ','T') + 'Z'` UTC coercion with
  `replace(/-/g, '/')` so MySQL datetime strings are parsed as local time,
  matching how Chart.js renders timestamps on the x-axis; eliminates the
  timezone offset error that locked the range filter buttons

---

## [0.8.4] — 2026-05-30

### fratoo-plugin (v1.3.4)

#### Fixed
- **Root cause of 33-row cap**: `get_args()` declares `device_id` with
  `'default' => 'airlock_1'`, so `get_param('device_id')` always returns a
  truthy value even when the JS only sends `?batch_id=X`. The old condition
  `empty( $args['device_id'] )` was therefore always `false`, preventing the
  batch's real auth token from ever being substituted.
  Fix: check `array_key_exists( 'device_id', $request->get_query_params() )`
  to detect whether the caller explicitly sent a `device_id`; if not, the
  batch's stored token takes precedence.
- `process_update_batch()` — added `mb_substr(..., 0, 64)` server-side
  enforcement of the `VARCHAR(64)` column limit on `device_id`, ensuring a
  bypassed HTML `maxlength` can never silently truncate the auth token.

---

## [0.8.3] — 2026-05-30

### fratoo-plugin (v1.3.3)

#### Added
- PHP diagnostic logging in `Fratoo_REST::get_readings()` — appends one line
  per request to `fratoo-plugin/fratoo-debug.log`:
  `[timestamp] batch_id | Page | Limit | from | to | device_id | Rows Found`
  Reveals the exact filter window and row count the DB query sees on each page.
- JS console checkpoints in `fetchAllReadings()`:
  - `-> Fetching data page N via URL: …` before each fetch
  - `<- Page N received. Data Type: Array | Array Length: N` after parse
  - `!! Loop stopped at page N because …` on every break path (empty array / maxPages cap)

---

## [0.8.2] — 2026-05-29

### fratoo-plugin (v1.3.2)

#### Fixed
- `fetchAllReadings()` — removed premature `data.length < perPage` break; loop
  now advances pages until the server returns `[]`, so all readings are collected
  regardless of whether the final page is a partial batch

#### Added
- Timeline range selector toolbar above the analytics chart canvas: "Show All"
  (default), "Last 24h", "Last 3 Days", "Last 7 Days"
- `applyFilter(rangeHours)` in `fratoo-chart.js` — filters the in-memory
  `allReadings` array by a rolling UTC cutoff and calls `chartInstance.update('none')`
  in-place; no repeated server requests on each button press
- Point-radius is recomputed on each filter change so dots collapse/restore
  correctly as the visible dataset size changes

---

## [0.8.1] — 2026-05-29

### fratoo-plugin (v1.3.1)

#### Fixed
- `Fratoo_DB::get_readings()` — changed `ORDER BY recorded_at DESC` to `ASC`
  so pages stream in chronological order; fixes truncated / missing recent
  readings on the analytics chart when data spans multiple pages
- `assets/js/fratoo-chart.js` — removed the client-side `Array.sort()` that
  reversed DESC payloads into ASC; server now guarantees the correct order

---

## [0.8] — 2026-05-29

### fratoo-plugin (v1.3.0)

#### Added
- Batch edit form — `?page=fratoo-batches&action=edit&id=ID` routed inside the
  existing page callback (no extra submenu entry):
  - Editable fields: Batch Code, Volume (L), Added Sugar (g), Notes
  - Device ID: editable on active/paused batches; read-only plain text on
    completed batches (preserves telemetry linkage)
  - Read-only display: Brew Type, Started At (both locked at creation)
  - Nonce: `fratoo_update_batch` / `fratoo_update_batch_nonce`
  - Validation: Batch Code required; empty volume/sugar fields clear the DB
    column to NULL via direct query (same null-safety pattern as `ended_at`)
  - On success redirects to the all-batches list with `?saved=1`
  - "Back ←" link returns to the batch detail (analytics) view
- `?saved=1` flash notice "Batch settings updated successfully." in batch list
- "Edit" action link added to every batch row in the list table

#### Changed
- `Fratoo_DB::update_batch()` — `batch_code` and `device_id` added to
  `$scalar_fields`; null `volume_liters` / `added_sugar_g` now cleared via
  direct prepared query (consistent with the existing `ended_at = NULL` pattern)
- Plugin version bumped to 1.3.0

---

## [0.7] — 2026-05-28

### fratoo-plugin (v1.2.0)

#### Added
- `assets/js/fratoo-chart.js` — time-series analytics engine:
  - Paginates through up to 10 pages (5 000 readings) via
    `GET /readings?batch_id=ID` with `X-WP-Nonce` auth header
  - Sorts readings ascending after collection; separates V99 and V101 into
    `{x, y}` point arrays for Chart.js
  - Dual Y-axis line chart: Bubble Count (V99) on the left / Temperature °C
    (V101) on the right; `tension: 0.2` smooth curves; `mode: index` tooltips
  - Point radius auto-collapses to 0 for datasets > 200 points to avoid clutter
  - Loading spinner, inline error notice, and empty-state message
- Batch detail view — `?page=fratoo-batches&view_batch=ID` routed inside
  the existing page callback (no extra submenu entry):
  - Meta summary cards: brew type, started, elapsed/ended, volume, sugar, device
  - `<canvas id="fratoo-analytics-chart">` inside a sized wrapper div
  - "Complete Fermentation" action button shown only for active batches
  - Notes block with `nl2br` formatting
- `enqueue_assets(string $hook)` — registers and enqueues Chart.js v4.4.3 and
  `chartjs-adapter-date-fns` v3.0.0 (both via jsDelivr CDN) plus
  `fratoo-chart.js` only on Fratoo admin pages and only when `view_batch` is
  present; passes `restUrl`, `nonce`, `batchId` via `wp_localize_script`
- `FRATOO_PLUGIN_URL` constant in `fratoo.php` for asset URL resolution
- Batch code column in list table now links directly to the batch detail view
- "Analytics" action link added to every batch row in the list table

#### Changed
- Plugin version bumped to 1.2.0; `admin_enqueue_scripts` hook registered

---

## [0.6] — 2026-05-28

### fratoo-plugin

#### Added
- `wp_fratoo_batches` database table — captures batch metadata: `batch_code`,
  `device_id`, `brew_type` (beer/wine/champagne/olive_oil/cider/custom),
  `status` (active/completed/paused), `volume_liters`, `added_sugar_g`,
  `notes`, `started_at` (locked at creation), `ended_at` (set on completion),
  `created_at`; composite indexes on status, device, and start time
- `class-fratoo-batch-rest.php` — REST endpoints under `fratoo/v1`:
  - `GET  /wp-json/fratoo/v1/batches` — paginated list with optional
    `status` and `device_id` filters
  - `POST /wp-json/fratoo/v1/batches` — create batch; start time locked to
    server time on insert; full arg schema with enum validation
  - `GET  /wp-json/fratoo/v1/batches/{id}` — single batch record
  - `PATCH /wp-json/fratoo/v1/batches/{id}` — update status/notes/volume/sugar;
    completing or pausing auto-sets `ended_at`; re-activating clears it
- `class-fratoo-admin.php` — WordPress admin interface:
  - Top-level "Fratoo" menu (dashicon chart-bar) with "All Batches" and
    "New Batch" submenus
  - Batch list table: status badges (colour-coded), elapsed duration for active
    batches, truncated device token with full token on hover, row-level
    "Complete Fermentation" action with confirmation dialog
  - New Batch form: all schema fields, inline unit labels, old-input restore
    on validation failure, start-time note
  - Form processing and stop action handled in `admin_init` (before headers)
    so `wp_safe_redirect` works cleanly; nonce-protected throughout
- `batch_id` query parameter on `GET /wp-json/fratoo/v1/readings` — resolves
  a batch's `started_at`/`ended_at`/`device_id` automatically, so callers can
  fetch all telemetry within a batch window without passing from/to manually;
  caller-supplied filters always take precedence

#### Changed
- Plugin version bumped to 1.1.0; `fratoo_db_version` check will trigger
  `install_batches()` on all existing installs via `plugins_loaded`
- `Fratoo_DB::install()` split into `install_readings()` + `install_batches()`
  (both called from `install()`; readings table schema is unchanged)

---

## [0.5] — 2026-05-28

### fratoo-bridge

#### Added
- `README.md` — full Windows Server deployment guide replacing NestJS boilerplate:
  prerequisites, build, `.env` configuration, PM2 start/stop, auto-start on boot
  via `pm2-installer`, firewall rule, and DNS redirect instructions (hosts file,
  Pi-hole, dnsmasq)
- `.env.example` — documents all required environment variables with descriptions

### fratoo-plugin

#### Added
- `scripts/build-plugin.ps1` — PowerShell script that zips `fratoo-plugin/` into
  `fratoo-plugin.zip` for upload via WP Admin; idempotent (removes stale zip first)

### Repo

#### Fixed
- `.gitignore` — `fratoo-plugin.zip` added to root ignore list (build artifact
  was previously untracked)

---

## [0.4] — 2026-05-27

### fratoo-bridge

#### Added
- `BLYNK_INTERNAL (0x11)` constant — ACKed with RESPONSE 200 on every device
  connection; eliminates the `Unhandled frame 0x11` debug noise seen on all
  real Plaato Airlock sessions
- `deviceId` field on `BlynkReading` interface — auth token captured as a
  closure variable in `handleConnection` and threaded through `dispatchFrame`
  → `parseHardwarePayload` → WordPress payload
- `ecosystem.config.js` — PM2 production config: fork mode (single instance,
  avoids EADDRINUSE), 256 MB restart ceiling, 10-restart backoff, structured
  log timestamps
- `mock-device.js` (repo root) — standalone Node.js script simulating a Plaato
  Airlock; performs full Blynk handshake (LOGIN → HW_SYNC) and streams
  HARDWARE frames and PING keepalives without any build step

#### Changed
- LOGIN handling moved from `dispatchFrame` into the `handleConnection` data
  loop so the token is available as a closure for all subsequent frames on
  the same socket
- `dispatchFrame` signature extended with `deviceId: string` parameter

### fratoo-plugin

#### Changed
- `class-fratoo-rest.php` — `device_id` insert now accepts camelCase
  `deviceId` (NestJS serialisation) with `device_id` snake_case and
  `'airlock_1'` as fallbacks, consistent with the existing
  `receivedAt` / `recorded_at` dual-key pattern

---

## [0.3] — 2026-05-14

### fratoo-bridge

#### Added
- `BlynkFrameParser` unit test suite (`blynk-frame.parser.spec.ts`) — 17 Jest
  cases: single frame, field decoding (big-endian msgId), multi-frame bursts,
  TCP fragmentation (byte-by-byte and mid-payload splits), empty / incomplete
  inputs, payload buffer isolation, `reset()`

---

## [0.2] — 2026-05-14

### fratoo-bridge

#### Added
- `WordpressModule` — `ReadingQueue` bounded ring buffer (1 000 cap) with
  `requeue()` for retry ordering; `WordpressService` drains queue to WP REST
  API on a configurable interval (default 5 s) using axios + axios-retry
  (3× exponential backoff, retries network errors and 5xx)
- `ConfigModule` wired globally via `@nestjs/config`; `.env` variables:
  `WP_API_URL`, `WP_USERNAME`, `WP_APP_PASSWORD`, `WP_DRAIN_INTERVAL_MS`
- Arrow-function EventEmitter listener in `WordpressService` for correct
  `off()` cleanup on module destroy

### fratoo-plugin

#### Added
- `fratoo.php` — plugin bootstrap with `register_activation_hook` and
  `plugins_loaded` version-check for upgrade-safe installs
- `class-fratoo-db.php` — `dbDelta` creates `wp_fratoo_readings`
  (`DATETIME(3)` for millisecond precision); composite index on
  `(device_id, recorded_at)`
- `class-fratoo-rest.php` — REST routes under `fratoo/v1`:
  - `POST /wp-json/fratoo/v1/readings` — batch insert, accepts `receivedAt`
    (NestJS camelCase) or `recorded_at`
  - `GET /wp-json/fratoo/v1/readings` — paginated query with filters:
    `device_id`, `pin`, `from`, `to`, `per_page`, `page`
  - Auth: WP Application Password → `current_user_can('edit_posts')`

---

## [0.1] — 2026-05-14

### fratoo-bridge

#### Added
- NestJS monorepo scaffold (`fratoo-bridge/`)
- `BlynkModule` — raw TCP server on port 1234 implementing Blynk legacy
  binary protocol
- `BlynkFrameParser` — stateful push-based parser handling TCP fragmentation;
  yields complete `BlynkFrame` objects across chunk boundaries
- `BlynkService` — `net.createServer` in `OnModuleInit`; handles LOGIN,
  PING (synchronous ACK to avoid watchdog reboot), HW_SYNC, HARDWARE frames;
  emits `'reading'` events via Node `EventEmitter`
- Protocol constants: `RESPONSE (0x00)`, `LOGIN (0x02)`, `PING (0x06)`,
  `HW_SYNC (0x10)`, `HARDWARE (0x14)`

### fratoo-plugin

#### Added
- WordPress plugin scaffold (`fratoo-plugin/`)
