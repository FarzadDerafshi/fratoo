# Architecture

## Overview

Fratoo intercepts telemetry from a **Plaato Airlock** fermentation monitor. The device
speaks the legacy **Blynk** TCP protocol. The bridge decodes that protocol, computes
derived values, and stores everything for a dashboard to visualize.

Fratoo began as a WordPress plugin and moved to a standalone stack in October 2026 (see
[DECISIONS.md](DECISIONS.md#2026-10-01-replace-wordpress-with-a-standalone-backend--frontend)):

```
Plaato Airlock  --(Blynk TCP, port 1234)-->  fratoo-bridge (NestJS)
                                                    |
                                                    v  (direct writes, no HTTP round-trip)
                                                Postgres
                                                    ^
                                                    |  (REST API under /api, JWT-authed)
                                                    v
                                         fratoo-web (React + Vite SPA)
```

The WordPress plugin it replaced ran in parallel until the cutover in 2.5.0 and has since
been retired; the bridge no longer has any WordPress code.

## Repo layout

```
fratoo/
├── fratoo-bridge/          NestJS backend: Blynk TCP bridge + REST API + Postgres
│   ├── src/
│   │   ├── blynk/          TCP listener, Blynk legacy protocol parser
│   │   ├── push/           Web Push: subscriptions, VAPID keys, fermentation alerts
│   │   ├── database/       TypeORM entities + DataSource provider
│   │   ├── readings/       V100 delta engine, fermentation stats
│   │   ├── batches/        Batch CRUD, cascading delete, window resolution
│   │   ├── reports/        Download Batch Report HTML generation
│   │   ├── auth/           Single-admin JWT login
│   │   └── common/         Shared fermentation math (see DECISIONS.md)
│   ├── db/init/            SQL schema, auto-applied on a fresh Postgres volume
│   └── scripts/            hash-password.js, create-admin.js
├── fratoo-web/             React + Vite SPA — login, batch list/detail, chart, reports
├── docker-compose.yml      Postgres + api (fratoo-bridge) + web (fratoo-web/nginx)
├── scripts/                release.ps1 (cut a version), build-icons.ps1
├── mock-device.js          Standalone Plaato Airlock simulator (no build step)
├── ProjectDocs/            You are here
└── CHANGELOG.md
```

## fratoo-bridge (NestJS) — standalone backend

- **AppController** — `GET /api/version` (no auth): product version from `package.json`,
  the git commit baked in at image build (`GIT_COMMIT` build arg, `dev` outside Docker),
  and when the process started. Read by the dashboard footer and `ProdRelease.bat`.
- **BlynkModule** — raw TCP server on port 1234, implements the Blynk legacy binary
  protocol.
  - PING is ACKed **synchronously** (no `await`) — the Airlock's watchdog will reboot the
    device if the ACK is delayed.
  - `BLYNK_INTERNAL (0x11)` is ACKed with RESPONSE 200 on every login.
  - `parseHardwarePayload()` drops non-numeric firmware error payloads via
    `isFinite(parseFloat(rawValue))`.
  - `deviceId` is the full Blynk auth token (32-char hex), threaded through `BlynkReading`
    to every downstream consumer.
- **ReadingsModule** — subscribes to `BlynkService`'s `'reading'` event and writes directly
  to Postgres, computing `bubble_rate` with the V100 delta engine
  (`ReadingsService.insertReading()`: bubbles since the previous V100 value ÷ minutes since
  it; a negative delta is a device reboot and stores 0). Also exposes
  `ReadingsService.computeStats()` (total bubbles, average temperature, peak rate). CO₂ and
  ABV come from the fermentation model below.
- **PushModule** (2.5.0) — `src/push/`. `PushService` keeps the VAPID key pair (generated
  on first start, stored in `app_settings` under `push_vapid`) and the `push_subscriptions`
  table, and sends with `web-push` (subscriptions the push service reports as gone, 404/410,
  are deleted). `AlertsService` (2.6.0, replaced 2.5.0's
  `FermentationAlertsService`) has two paths: on each stored reading
  (`ReadingsService.onInserted()`, which also says whether a V100 value was a counter
  reset) it checks fermentation started, back online and device rebooted; every 5 min it
  runs the time-based rules over every active batch (offline, no start, temperature, peak
  passed, looks finished, stalled). The rules themselves are pure functions in
  `push/alert-rules.ts` (hourly means, since single bubble rates are noisy); thresholds and
  switches live in `app_settings.notifications` (`/api/settings/notifications`), per-batch
  temperature limits on `batches.alert_temp_min_c/max_c`. Each alert is claimed in
  `batch_notifications` before sending: one-off kinds once per batch, on/off kinds
  (`device_offline`, `temp_high`, `temp_low`) via its `active` flag. "Fermentation started"
  uses the report's lag-phase rule (`sustainedStartIndex()`), confirmed by two follow-up
  readings. The service worker
  (`fratoo-web/public/sw.js`) shows the notification and opens the batch on tap.
- **BatchesModule** — batch CRUD, cascading delete with the next-batch guard, and window
  resolution (`resolveWindow()`). Batches and readings have no foreign key: "this batch's
  readings" is always `device_id` + the window `started_at .. (ended_at ?? now)`, clamped to
  the next batch's start on the same device, and everything that needs it goes through
  `resolveWindow()`.
- **Fermentation (ABV model)** — `src/fermentation/`, registered inside `BatchesModule` (it
  needs `BatchesService`, and `BatchesController` needs it back, so a separate module would
  be circular). `abv-model.ts` holds the pure math: bubbles → CO₂ (ideal gas at the
  measured temperature) → + dissolved CO₂ → ethanol → ABV → estimated SG, with the
  **bubble volume learned from manual gravity readings** (`gravity_readings` table, SG or
  Brix with Terrill correction). `FermentationService` owns the settings (`app_settings`,
  key `fermentation`) and the per-batch calibration cache on `batches`. Routes:
  `GET/PATCH /api/settings/fermentation`, `POST /api/settings/fermentation/reset`,
  `GET /api/batches/:id/fermentation` (full model output incl. every calibration point and
  its residual), `GET/POST /api/batches/:id/gravity-readings`,
  `PATCH/DELETE /api/batches/:id/gravity-readings/:readingId`. `GET /api/batches/:id/stats`
  now takes its `abv`/`co2Liters` (plus `estimatedSg`, `apparentAttenuation`,
  `bubbleVolumeMl`/`bubbleVolumeSource`, …) from this model, and the report's daily
  snapshots use it too. Why and sources: [DECISIONS.md](DECISIONS.md) "Calibrated
  bubble-volume ABV model".
- **ReportsModule** — generates the self-contained "Download Batch Report" HTML document
  (daily snapshots, highlights, chart) in the dashboard design (light tokens copied from
  `fratoo-web/src/index.css`, inline logo) and with the dashboard's data:
  `BatchesController` passes it the same `computeStats`, `FermentationService.estimate()`,
  gravity readings and `abvSeries()` the batch page loads, so the two never disagree.
  Tests: `reports.service.spec.ts`.
- **AuthModule** — single-admin JWT login (`ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH`, bcrypt).
  See [DEPLOYMENT.md](DEPLOYMENT.md) for creating the account.
- **Database** — Postgres via `typeorm`, driven directly (no `@nestjs/typeorm`) — see
  `src/database/database.module.ts` for why. Schema lives in `db/init/*.sql`
  (`001_init_fratoo.sql`, `002_abv_calibration.sql`, …), auto-applied by the official
  postgres image on a fresh volume. Every file from 002 on must be **idempotent** (`IF NOT
  EXISTS`): `ProdRelease.bat` re-applies all of them to the existing production volume on
  every deploy.
- All HTTP routes are served under `/api` (`app.setGlobalPrefix('api')`) so nginx can proxy
  everything under that path straight to this container in production.
- Deployment: Dockerized (`Dockerfile`, multi-stage `node:20-alpine`), orchestrated together
  with Postgres and the frontend by the repo-root `docker-compose.yml`. See
  [DEPLOYMENT.md](DEPLOYMENT.md).

## fratoo-web (React + Vite) — standalone frontend

Single-page app: login, batch list (create/delete), batch detail (fermentation stats,
dual-axis Chart.js chart with range filter, Complete/Delete, Download Batch Report). Talks
to `fratoo-bridge` over `/api` with a JWT in `localStorage`. The chart
(`FermentationChart.tsx`, Chart.js) plots the V100 bubble rate and the corrected V101
temperature on two axes, plus the optional ABV line, gaps, gravity readings and events.

**Frame and theming.** `AppShell.tsx` (rendered by `ProtectedRoute`) is the top bar,
page and footer for every signed-in page. All colors are CSS variables in `index.css`
(light on `:root`, dark under `prefers-color-scheme` and `[data-theme='dark']`);
`lib/theme.ts` stores an explicit choice in `localStorage` (`fratoo_theme`) and
`index.html` applies it before first paint. The chart reads its colors from the same
`--chart-*` variables and redraws on theme change. Fonts are self-hosted via
`@fontsource/*` (latin subset). The mark lives in three places with the same geometry:
`components/Logo.tsx` (inline, themed), `public/favicon.svg`, and `icons/*.svg` (sources for
the PNGs, rendered by `scripts/build-icons.ps1`).

**PWA.** `public/manifest.webmanifest` + `public/sw.js` (registered in `main.tsx`,
production builds only). The service worker never touches `/api/*`; it caches Vite's hashed
`/assets/*` and `/icons/*` cache-first and falls back to the cached app shell for
navigations when offline. `nginx.conf` sends `no-cache` for `index.html`, `sw.js` and the
manifest (so Cloudflare and installed apps revalidate) and a one-year `immutable` for
`/assets/`.

The ABV model has no frontend math: the batch page reads `/stats`, `/fermentation` and
`/gravity-readings` and displays them (`GravityReadingsPanel.tsx`), and `SettingsPage.tsx`
edits `/settings/fermentation`. The only duplicate is the default-settings table in
`SettingsPage.tsx`, used just to highlight changed values.

The PCB temperature-correction formula is the one piece of fermentation math duplicated
between this frontend and the backend's `common/fermentation-math.ts` (there's no shared
package between the two runtimes) — see `fratoo-web/src/lib/temperature.ts`.

Built as a static bundle and served by nginx in production (`fratoo-web/Dockerfile`,
`fratoo-web/nginx.conf`), which also reverse-proxies `/api/` to the `api` container — see
`docker-compose.yml`.

## Real device pin mapping (confirmed)

Source: `PlaatoStructure.java` in `PLAATO-Technologies/plaato-b2c-server` on GitHub — the
manufacturer's own open-source Blynk server fork.

| Pin | Meaning | Notes |
|---|---|---|
| V99 | Firmware transmission sequence counter | +1 per wake/send cycle. No fermentation value; the official server ignores it. |
| V100 | **Cumulative bubble counter** | Monotonic; resets on device reboot. This is the real bubble odometer. |
| V101 | Raw PCB temperature °C | Needs correction: `0.9133 × raw − 1.145` (PCB self-heating offset ~3.4°C). |

Additional pins from the official spec (server-computed, not sent by hardware): V102 (BPM,
server-side), V103 (corrected temp), V104 (volume), V105 (OG), V106 (SG), V107 (ABV),
V108–V110 (unit strings/totals), V118 (BubPerGrav), V119 (CO₂ volume).

Device behavior:
- Wakes, sends, and sleeps on a **~4m47s cycle**.
- `deviceId` = Blynk auth token (32-char hex).
- Readings are stored in UTC; the chart renders in local time via `replace(/-/g, '/')`.

### Device provisioning (not DNS redirect)

The reference unit is configured with the bridge's host/port directly and never connects to
`blynk-cloud.com`, so no DNS redirect is involved. The device exposes a local `/config`
endpoint (reachable while it's broadcasting its own setup Wi-Fi AP) that takes the target
Wi-Fi credentials, its Blynk token and the bridge's `host`/`port` as query parameters. Steps
and recovery guidance:
[USER-MANUAL.md — Reconnecting the Plaato Airlock to Wi-Fi](USER-MANUAL.md#reconnecting-the-plaato-airlock-to-wi-fi-device-provisioning).
`fratoo-bridge/README.md` documents DNS redirect as a fallback for a unit that only talks to
`blynk-cloud.com`.

### ⚠️ Historical bug: V99/V100 were swapped

Before 2026-06-20, the entire pipeline had V99 and V100 roles **inverted** — V99 was
treated as the bubble counter and V100 as a meaningless "Connection Status" field. This
produced bubble rates ~300× too low and an invisible chart backdrop. Fixed in 1.2.1 (see
[CHANGELOG `[1.2.1]`](../CHANGELOG.md)) with a historical backfill migration.
If you ever see suspiciously tiny bubble rates again, check this mapping first.
