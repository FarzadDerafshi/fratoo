# Decisions

Lightweight decision log — why things are built the way they are, not what they do (that's
[ARCHITECTURE.md](ARCHITECTURE.md)). Newest first.

---

## 2026-10-24 — Airlocks are discovered from their readings, named in a separate table (2.7.0)

Starting a batch meant pasting the airlock's 32-character Blynk token. Now a `devices` table
holds one row per token with a name; a token is added the first time it sends a reading, and
the batch form picks from that list.

**Why discovered, not entered:** the bridge already sees every token, so there's nothing to
type even once, and an airlock re-provisioned with a new token simply shows up. It's added
on its first *stored reading* rather than on login, so a stray connection that never sends
data doesn't create an entry. **Why a table, not a JSON setting:** it keys cleanly by token,
and the first deploy can backfill it in SQL from existing readings and batches. That
backfill runs only when the migration creates the table, so a removed airlock doesn't come
back with every deploy. **Why batches keep the raw token** (no foreign key to `devices`):
the window logic (`resolveWindow()`) and every existing batch already use it, and renaming
or removing an airlock must never change which readings belong to a batch. **Preselection:**
the airlock of the newest batch, because consecutive batches almost always use the same
airlock. The form warns when that airlock still has an active batch rather than blocking,
since the next-batch guard already ends the old batch's window where the new one starts.

## 2026-10-23 — WordPress cutover by removing the dual-write code (2.5.0)

The plan was to unset `WP_API_URL` and restart `api` (reversible without a code change).
After about three weeks of parallel running with no discrepancy, `WordpressModule` (with
`axios`/`axios-retry`, used only there) was removed instead.

**Why:** the production `.env` lives on the server, out of reach of the dev workflow;
removing the module makes the cutover happen with the normal `ProdRelease.bat` deploy, with
no manual `.env` edit to forget or get wrong, and drops dead code. **Trade-off:** rolling
back means redeploying 2.4.2, not flipping an env var, and WordPress would miss the readings
in between. Acceptable now that Postgres has been the source of truth since 2026-10-02 with
a `pg_dump` backup on every deploy. The plugin and the one-off migration script were
removed afterwards, once WordPress had been cleaned up.

---

## 2026-10-23 — Push notifications via standard Web Push (2.5.0)

**Choice:** standard Web Push (VAPID, `web-push` on the server, the existing service
worker on the client) rather than a third-party service (Pushover, ntfy, Telegram bot,
Firebase). It works in the installed PWA on iPhone (iOS 16.4+, home-screen app only),
Android and desktop, needs no extra app or account, and keeps everything self-hosted.

- **VAPID keys generated on first start and stored in `app_settings`** (`push_vapid`), not
  in `.env`: no manual deploy step (keeps this a minor release under the versioning rules).
  The private key sits next to the data it protects; acceptable for a single-user tool
  whose database isn't exposed. Losing the row just means re-subscribing devices.
- **VAPID subject** (contact sent to push services, Apple requires one): `PUSH_SUBJECT`,
  defaulting to the project's GitHub URL so no personal address is sent.
- **Alerts run off `ReadingsService.onInserted()`**, not the raw Blynk event, so they see the
  stored `bubble_rate`. Each alert kind fires once per batch, claimed with
  `INSERT … ON CONFLICT DO NOTHING RETURNING` in `batch_notifications` before sending, so
  two readings arriving together can't double-send.
- **"Fermentation started" uses the report's lag-phase rule** (`sustainedStartIndex()`,
  now shared by the report, the ABV model's dissolved-CO₂ gate and the alert), but requires
  both follow-up readings to exist. A start confirmed more than an hour before it's first
  seen (deploying 2.5.0 mid-batch, or a long outage) is recorded silently instead of
  sending a stale "started" message.
- **Payload** `{ title, body, url, tag }`, TTL 24 h, urgency high; the service worker
  always shows a notification (iOS revokes push for silent pushes) and opens `url` on tap.

---

## 2026-10-23 — Push alerts: rules, thresholds and state (2.6.0)

The seven alerts proposed with 2.5.0.

- **Two triggers.** Things a reading reveals (fermentation started, back online, counter
  reset) run on `ReadingsService.onInserted()`; everything that depends on time passing
  (offline, no start, temperature, peak, finished, stalled) runs every 5 min over the active
  batches. A timer was needed anyway for "offline" (no reading arrives to trigger it), and
  running the heavier rules there keeps the per-reading path cheap (the device sends three
  pins per wake-up).
- **Hourly means, not single readings.** Bubble rates jump ±5–10% between readings, so
  peak, "slow for N hours" and the peak drop use 1-hour means (`alert-rules.ts`), and "for N
  hours" needs readings in at least 80% of those hours (so a device outage doesn't count as
  "slow"). A peak under 10 bpm isn't treated as a fermentation peak.
- **Finished vs stalled** both mean "almost no bubbling"; they're told apart by the
  estimated ABV against the expected mark (from the OG, yeast attenuation and sugar). This
  relies on the learned bubble volume being roughly right; a gravity reading confirms it,
  which both messages ask for. Without an OG only "looks finished" can fire.
- **Temperature limits are at the airlock**, matching what the app shows. Default 16–24 °C
  (an ale band; at peak the beer is 2–4 °C warmer). Per-batch override columns instead of a
  per-strain table: simpler, and covers lagers and warm yeasts.
- **No offline alert in the first `offlineMinutes` after the API starts**: after a server
  outage or a deploy, the last reading is old because the *server* was down, not the
  device; readings resume within one wake-up.
- **State in `batch_notifications`**: one-off kinds insert once (`ON CONFLICT DO NOTHING`);
  on/off kinds (`device_offline`, `temp_high`, `temp_low`) flip an `active` flag with an
  atomic upsert/update, so the "problem" and "resolved" messages alternate and never repeat.
  The resolved message reuses the problem's notification tag, so it replaces it on the
  phone.
- **Device rebooted is off by default**: it's informational and often comes with an
  offline/online pair.

---

## 2026-10-21 — Brew log fields, batch events, and sugar-aware expected attenuation

**Context:** the first real batch report raised questions the data
couldn't answer: when the yeast actually went in (5 h after the batch started, so the lag
phase was overstated), what caused the Oct 12–13 bump, what the bottled ABV would be, and
why the expected-ABV mark (4.2%) sat well below the measured 4.55%.

**Decisions:**
- **Plain columns on `batches`** for yeast, pitch, hops, bottling and tasting — one value
  each per batch, all nullable and editable later (bottling/tasting only after the fact).
  Bottling date is the batch's `ended_at`; no separate column.
- **`batch_events` table** for things that happen at a moment (dry hop, disturbance,
  bottling…), FK + `ON DELETE CASCADE` like gravity readings. Annotation only: deliberately
  *not* used to exclude or correct telemetry — the calibration already absorbs one-off
  bumps, and silently editing data based on a label would be hard to reason about.
- **Expected attenuation = yeast × (1 − sugar share) + 1.0 × sugar share.** Yeast makers
  quote attenuation on malt wort; sucrose ferments completely (its apparent attenuation is
  ~100% or more — 1.0 is the conservative choice). On that batch (OG 1.0425, 1.5 kg sugar
  in 24 L ≈ 57% of the points) this moves the mark from 4.2% to 5.0% at the 75% default — now
  *above* the measured 4.55%, which implies the malt part attenuated only ~60–65%. That is
  typical of extract kits (more unfermentable dextrins than all-grain), and the remembered
  OG may also have been low. Setting the strain attenuation per batch is the intended fix;
  the default stays 75% until real batches say otherwise.
- **Priming ABV** = priming points × 0.13125, with points from the same
  `sugarPointsPerKgPerLiter` as added sugar, over `bottled_volume_l` (falls back to the batch
  volume). **Carbonation** = residual CO₂ at the last measured temperature + 0.5146 g CO₂ per
  g sucrose, in volumes at STP. **Calories** = ASBC homebrew formula, per 330 mL, from the
  fermenter OG/estimated FG/ABV (priming excluded — a few kcal).
- **Notes formatting is a tiny custom renderer, not Markdown**, duplicated in bridge and web
  (`common/notes-format.ts`, `lib/notes.ts`). It recognises only what a phone note or a
  pasted chat answer looks like, escapes HTML before adding any tag (so the dashboard can
  inject it), and adds no dependency to either package. Notes over 280 characters or 4 lines
  get their own card so they don't push the ABV figure off page 1 of the report.

---

## 2026-10-17 — One product version for bridge + web; releases tagged after the fact

**Problem:** the changelog's numbered releases stopped at 1.4.0 (WordPress era). Everything
since sat under "Unreleased" though it was live, `package.json` said 0.0.x, there were no git
tags, and nothing showed which build production was running.

**Decision:** one SemVer version shared by `fratoo-bridge` and `fratoo-web`, because
`ProdRelease.bat` always deploys them together; separate numbers would only invite "is web
3.2 compatible with api 2.7?" questions. (The WordPress plugin, deployed separately, kept
its own version until it was retired.) The changelog lineage continues rather than
restarting: the standalone stack is **2.0.0** (major: new runtime, datastore and login) and
the ABV model **2.1.0**, both tagged on the commits that were actually deployed; 1.0.0–1.4.0
were tagged too. Releases are cut with `scripts/release.ps1` (bump both packages, date the
changelog, commit, annotated tag; no push), so it's one command rather than five easy-to-
forget steps.

**Visibility:** the git commit is a Docker build arg (`GIT_COMMIT`, set by
`ProdRelease.bat`), exposed by `GET /api/version` (unauthenticated: version info only, and
it lets the deploy script check itself) and shown in the dashboard footer. Version + commit
rather than version alone, because deploying unreleased commits between releases is normal
here.

**Also:** `ProdRelease.bat` now runs from a `%TEMP%` copy of itself and stops if the pull
changed it, replacing the manual "pull first when the script changed" rule from 2026-10-14.
Tested in real cmd: unchanged → continues, changed → stops with the re-run message, then the
re-run continues; launched from another folder and with spaces in the path.

---

## 2026-10-14 — Calibrated bubble-volume ABV model (replaces fixed 1.7 mL/bubble)

**Problem:** The first production batch (an extract-kit IPA, 24 L, ~11 °Bx OG, 1.5 kg
added sugar) showed **25.5% ABV**. The bubble count itself was fine — 1,383,196 bubbles
matches the area under the bubble-rate chart — but the old formula assumed every bubble
carries **1.7 mL** of CO₂. That constant was inherited from the WordPress plugin, never
measured. Working backwards from a plausible ~4.5–5% ABV gives roughly **0.3–0.35 mL**.
A fixed guess was always going to be fragile: bubble size depends on the airlock, its liquid
level, and headspace pressure.

**Decision:** A hybrid model: bubbles stay the primary signal, so the
fermenter never has to be opened, but the one unknown, **mL per bubble**, is *learned* from
occasional refractometer/hydrometer readings. Code: `src/fermentation/abv-model.ts` (pure,
fully unit-tested in `abv-model.spec.ts`) + `FermentationService` (DB, settings, cache).

Chain: bubbles → CO₂ out (ideal gas law at the *measured* temperature per interval) → +
CO₂ still dissolved (saturation at current temperature) → ethanol (Balling mass ratio) →
ABV → estimated current SG (inverting the ABV formula against the OG).

- **Calibration**: each gravity reading pins the true ABV at its timestamp, so it implies a
  bubble volume. Points are combined with a least-squares fit through the origin, which
  naturally weights later, larger-signal readings more. Resolution order: per-batch manual
  override → the batch's own fit → point-weighted mean of other batches' fits ("learned")
  → configured default (0.3 mL).
- **Fit cache**: `batches.calibrated_bubble_volume_ml` / `calibration_points`, so a batch
  can learn from others without re-reading their telemetry. Recomputed on every gravity
  reading write, batch edit, and settings change (`recalibrateAll()`). New telemetry never
  invalidates it: a calibration point only uses bubbles counted up to its own timestamp.
- **Known error sources**: handled directly where physics allows (gas temperature, dissolved
  CO₂, refractometer alcohol skew via Terrill, wort correction factor, reboot resets,
  physically-impossible ABV capped against the OG with a warning). The rest is absorbed by
  calibration (airlock liquid level, lid leaks, actual bubble size). Using the *current*
  temperature's dissolved-CO₂ saturation makes temperature-driven outgassing roughly cancel:
  warming releases bubbles but lowers the dissolved term by the same amount.
- **Everything is configurable** (`app_settings`, `GET/PATCH /api/settings/fermentation`)
  on purpose: while calibration is still learning, every assumption should be
  adjustable without a code change. The UI can be simplified once the model is stable.
- OG is stored **as entered** (`og_value` + `og_unit` 'sg'/'brix') and converted on read, so
  changing the wort correction factor later re-derives it instead of baking in today's value.
- `og_includes_sugar` (default true): when the OG was measured *before* the added sugar went
  in, the sugar's gravity points are added on top (sucrose 46 PPG ≈ 383.9 pts·L/kg).

**Sources** (verified 2026-10-14; Sean Terrill's own site had an expired TLS certificate, so
his coefficients were cross-checked across two independent calculators instead):
- Brix→SG: `SG = 1 + B / (258.6 − (B / 258.2) × 227.1)`, BYO equation as used by
  [Brewer's Friend](https://www.brewersfriend.com/brix-converter). 20 °Bx ≈ 1.083 is a test.
- Refractometer correction, Terrill "new cubic":
  `FG = 1 − 0.0044993·OB + 0.011774·FB + 0.00027581·OB² − 0.0012717·FB² − 0.0000072800·OB³ + 0.000063293·FB³`,
  with OB/FB already divided by the WCF (default 1.04) —
  [Lacada Brewery calculator](https://lacadabrewery.com/brew-tools/refractometer-calculator),
  [Brewfather](https://docs.brewfather.app/tools/refractometer),
  [HBA forum discussion](https://forum.homebrewersassociation.org/t/improved-refractometer-correction-calculator/24740).
  Forum reports say it's least accurate at very high attenuation, and that calibrating the
  WCF against a hydrometer matters more than the choice of formula — hence the WCF setting.
  Terrill's "old cubic" was **not** added: its coefficients couldn't be verified.
- ABV: standard `(OG − FG) × 131.25` (Papazian) and alternate
  `76.08·(OG − FG)/(1.775 − OG) · FG/0.794` (Hall, *Brew by the Numbers*) —
  [Brewer's Friend](https://www.brewersfriend.com/2011/06/16/alcohol-by-volume-calculator-updated/).
- Ethanol↔CO₂: Balling's mass balance, 2.0665 g extract → 1 g ethanol + 0.9565 g CO₂ +
  0.11 g yeast — [Brewers Journal](https://www.brewersjournal.info/science-basic-beer-alcohol-extract-determinations/).
- Dissolved CO₂: residual-CO₂ fit `3.0378 − 0.050062·T + 0.00026555·T²` (°F → volumes),
  ×1.977 g/L (CO₂ density at STP) — [Brewer's Friend priming calculator](https://www.brewersfriend.com/beer-priming-calculator).
  An empirical fit, not a law.
- Sucrose 46 PPG — [Craft Beer & Brewing](https://beerandbrewing.com/brewing-with-sugar).
- Gas molar volume: ideal gas law (`V = RT/P`): 22.414 L/mol at 0 °C, ~24.2 at 22 °C. The
  old code's fixed 22.4 assumed 0 °C.

**Sanity check against the recipe.** For a kit of liquid malt extract (~36 PPG, assumed)
plus table sugar (46 PPG) the recipe arithmetic gave OG ≈ 1.043–1.046, consistent with the
remembered ~11–12 °Bx, and a realistic in-fermenter range of **4.5–5.0%** (plus ~0.4% from
priming). The kit vendor's 4.7% looked optimistic for the fermenter alone (it likely
includes priming). The first refractometer reading (5 °Bx at 1.49 M bubbles) then implied
0.280 mL/bubble and 4.4% ABV, close to the 0.3 mL default. The remembered rather than
measured OG was the biggest uncertainty (±0.5 °Bx ≈ ±0.33% ABV), so OG is now measured on
every batch.

**Verified**: 33 new unit tests, including a round trip (a synthetic batch fermented with a
known bubble volume → its generated hydrometer *and* Brix readings recover that volume), plus
an end-to-end run against a throwaway Postgres + API container built from this code: fresh-volume
schema init, migration re-applied to an existing DB (no-op), every new route,
recalibrate-on-edit/settings, cross-batch learning, override precedence, report snapshots,
and cascade delete of gravity readings.

---

## 2026-10-02 — WP→Postgres batch migration merges by `batch_code`, never truncates `batches`

**Decision:** `migrate-from-wordpress.js` inserts a WordPress batch only if no Postgres batch
with the same `batch_code` already exists (fresh auto-generated id, not WP's original one),
and never touches a batch that's already there. `readings` is still a full
truncate-and-reimport from WordPress.

**Why:** Caught before running against real production data, not after — the first version
truncated `batches` too, "safe to re-run" by the same logic that makes truncating `readings`
safe. That logic doesn't hold for batches: a batch created through the new `fratoo-web`
dashboard only ever exists in Postgres — `fratoo-bridge` never writes batch metadata back to
WordPress, only raw telemetry (see [ARCHITECTURE.md](ARCHITECTURE.md) — `WordpressModule`
only subscribes to the `'reading'` event). The first real production batch created after
cutover (with its own notes/volume) would have been silently deleted the
moment this script ran, while its *readings* survived untouched (those are in WP too, via
dual-write) — a partial, confusing data loss that could easily go unnoticed until someone
looked for that batch's notes later.

**Verified before trusting it anywhere near production**: spun up a throwaway MariaDB
container (same `mariadb:10.11.9` image/digest as the real WordPress database) seeded with a
batch sharing a `batch_code` already present in the real local Postgres, migrated it by
running the script from inside the already-running `api` container (copied in via `docker
cp`, executed with `docker exec -e ...`) — the same mechanism production uses, since the
production WP database has no port published to the host and Docker Desktop on Windows
doesn't let the host reach container-internal bridge IPs directly either way. Confirmed: the
pre-existing batch's own data was untouched, the WP-only batch got inserted under a new id
with no collision, and running it a second time didn't duplicate anything.

---

## 2026-10-02 — nginx resolves the `api` upstream dynamically, not at startup

**Decision:** `fratoo-web/nginx.conf` uses `resolver 127.0.0.11` (Docker's embedded DNS) plus
a `set $upstream_api ...` variable in `proxy_pass`, instead of a plain
`proxy_pass http://api:3000/...`.

**Why:** Hit during the actual production deploy, not caught locally — a bare
`proxy_pass http://api:3000` resolves that hostname **once**, when nginx itself starts. If
the `api` container wasn't fully attached to the Docker network in that exact instant (a real
race with `depends_on`, which only waits for "started", not "network-ready"), nginx fails
immediately with `host not found in upstream` and refuses to start at all — and since it's a
fresh nginx process reparsing config from scratch on every `restart: unless-stopped` retry,
it can keep losing that race indefinitely depending on timing, especially since `api` itself
waits on `postgres`'s healthcheck before starting and so is reliably one of the last
containers up. Routing through a resolver + variable forces nginx to resolve `api` per
request instead, so startup order stops mattering.

**A second bug surfaced while fixing the first, verified before shipping:** the obvious fix
(`set $upstream_api http://api:3000; proxy_pass $upstream_api/api/;`) returned 404 on every
request. Per nginx's actual behavior, a `proxy_pass` value containing a variable is **not**
subject to the usual location-prefix replacement — it appends the full original request URI
as-is after the variable, so the `/api/` already in both the incoming request and my
proxy_pass suffix doubled into `/api/api/auth/login`. Fixed by dropping the trailing path
from the variable target entirely (`proxy_pass $upstream_api;`) and letting the original URI
pass through unmodified. Verified against the local test stack (login, wrong-password 401,
and a real `/api/batches` call) before pushing, rather than assuming the first fix worked.

---

## 2026-10-02 — `create-admin` stays single-admin; adds a `readline`-free interactive prompter

**Decision:** When asked for "user creation" for production, add an interactive
`npm run create-admin` setup script rather than building multi-user accounts (a users table,
registration, roles). It writes `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH`/`JWT_SECRET` straight
into `.env`, replacing the old two-step "run `hash-password.js`, hand-paste the output"
flow.

**Why:** This is still a single-operator dashboard: the
friction was in *setting up* that one account, not in needing more than one. Building real
multi-user support (a `users` table, a management UI, sessions-vs-JWT tradeoffs) would be a
meaningfully bigger change for a need that doesn't exist yet; `ProjectDocs/ROADMAP.md` is
the place to revisit this if that ever changes.

**Found and fixed a real bug while building it:** the first version used
`readline.question()` called sequentially for username → password → confirm. Piping all
three answers at once (as an automated test naturally does, but also exactly what happens if
a user pastes multiple lines from a password manager into a real terminal) silently dropped
every line after the first — `readline.question()` registers a *one-shot* `'line'` listener
per call, and if the stream delivers several lines in the same chunk, only the first has a
listener attached yet; the rest fire into the void and the next `await question()` hangs
until stdin closes, at which point Node just exits since there's nothing left to keep the
event loop alive. Rewrote with a small queued prompter: a single persistent `'data'` listener
parses characters into lines and pushes each into a queue, and `prompt()` drains the queue
first rather than registering a listener that could miss already-arrived data. Works
identically whether input arrives one keystroke at a time (a real terminal) or all at once
(piped/paste). See `fratoo-bridge/scripts/create-admin.js`'s header comment for the full
explanation — worth reading before writing another interactive CLI prompt in this repo.

**Two more real bugs found during the actual production deploy** (not caught by the testing
above, which used piped input — these only showed up with a genuine interactive terminal and
a genuine Docker Compose `env_file`):

1. **Arrow-key presses corrupted the input.** The character-by-character reader didn't
   recognize ANSI/CSI escape sequences — pressing an arrow key mid-prompt appended its raw
   bytes (`ESC '[' 'C'` for Right, etc.) straight into the buffer as if they were typed
   characters, and the corrupted username shipped to the live `.env` before anyone noticed
   (visible later as literal escape-sequence garbage when inspecting the container's actual
   env var). Fixed with a small state machine that recognizes `ESC '['` as the start of a CSI
   sequence and swallows everything through its terminator byte, plus ignoring any other
   stray control byte (`< 0x20`) outright rather than buffering it.
2. **Docker Compose corrupted the bcrypt hash.** `env_file:` values aren't passed through
   literally — Compose interpolates `$word`-shaped sequences within them the same way it does
   `${VAR}` references in `docker-compose.yml` itself, and a bcrypt hash (`$2b$12$...`) is
   exactly that shape. The unresolved "variable" silently blanked out ~22 characters of the
   hash before it ever reached the container — confirmed by comparing `docker inspect`'s
   actual env var against what was written to `.env`. Fixed by writing the hash with every
   `$` doubled (Compose's own escape convention: `$$` → literal `$` after interpolation) —
   but **only** when the target is the repo-root `.env` that Compose's `env_file:` actually
   consumes; `fratoo-bridge/.env` (the non-Docker path) is read directly by `dotenv`, which
   has no such interpolation and would see the doubled `$$` as literal, wrong, characters.
   **A third bug was hiding behind this fix**, caught only by re-reading the actual written
   file rather than trusting the escaping logic in isolation: `upsertEnvVar()`'s own
   `contents.replace(pattern, line)` call used `line` as a plain string replacement, and
   `String.replace`'s replacement-string argument treats `$$` as its own special pattern
   (meaning "insert one literal `$`") — silently collapsing the just-escaped `$$` back down to
   `$` a second time, undoing the fix before it reached disk. Both `.replace()` calls now use
   a function replacer instead, which inserts its return value literally with no special-
   pattern processing. Verified end-to-end afterward: wrote the hash, confirmed `docker
   inspect` on a real container showed the exact unescaped original hash, and successfully
   logged in through it — not just "the code looks right now."

The script also verifies its own output as of this fix: after writing, it re-reads the file,
reconstructs the hash through the same unescaping a real deploy would apply, and confirms
`bcrypt.compareSync()` against the password just entered before declaring success — so a
future bug in this area fails loudly at setup time instead of shipping a broken credential
silently, the way both of these did.

---

## 2026-10-01 — Replace WordPress with a standalone backend + frontend

**Decision:** Fold the database, REST API, batch logic, and report generation directly into
`fratoo-bridge` (NestJS + Postgres), and build a standalone React + Vite SPA (`fratoo-web`)
as the dashboard — rather than continuing to host all of that inside a WordPress plugin.

**Why:** WordPress was doing two unrelated jobs — being a CMS, and being the database/API/
admin-UI framework for a completely separate IoT system. Every reading made an unnecessary
HTTP round-trip (bridge → WP REST → MySQL), and the dashboard, batch CRUD, and report
generation all lived behind WordPress's plugin/auth/hook machinery for no benefit specific
to this project. Folding ingestion and storage into one process (the bridge already existed
and already owned the TCP listener) removes a whole network hop and a whole CMS's worth of
indirection.

**Alternatives considered:**
- *Keep WordPress, just build a better admin UI on top of its REST API* — rejected; doesn't
  address the round-trip or the dependency on a CMS the IoT system has no other use for.
- *A separate backend service instead of extending fratoo-bridge* — rejected; fratoo-bridge
  already owns the TCP ingestion and the `'reading'` EventEmitter, so a second process would
  just need its own copy of that event stream (e.g. via a message queue) for no clear gain
  over adding modules to the process that already has the data first.
- *Flutter Web for the frontend* (matching the author's other project's stack) — rejected in
  favor of React + Vite; this is a charts-and-tables admin dashboard, squarely
  JS-ecosystem territory, and nearly all of `fratoo-chart.js`'s Chart.js logic ports over
  directly to a web frontend written in JS, whereas Flutter Web would mean rebuilding the
  charting from scratch with a less mature charting ecosystem.

**Migration approach — phased, not a cutover:** `WordpressModule` stays in the bridge and
stays fully functional, now gated behind `WP_API_URL` being set — unset it and it's a no-op.
Both it and the new `ReadingsModule` subscribe to the same `BlynkService` `'reading'` event
independently, so the old plugin and the new backend can genuinely run in parallel against
live device traffic, each with their own copy of the data, before `fratoo-plugin` is
retired. A one-time script (`fratoo-bridge/scripts/migrate-from-wordpress.js`) copies
existing historical data from the WP MySQL tables into the new Postgres schema. See
[DEPLOYMENT.md](DEPLOYMENT.md) and [ROADMAP.md](ROADMAP.md) for the actual migration
checklist and current status.

**Not using `@nestjs/typeorm`:** the version that resolves against this project's
`@nestjs/*` v11 line ships ESM-only (`"type": "module"`, no CJS export condition) and its
compiled output calls `import.meta.url`, which crashes Jest's CommonJS test runner the
instant anything imports it, including transitively. Rather than fight Jest's ESM support
for one package, `database.module.ts` drives the `typeorm` package (still CJS) directly via
a plain `DataSource` provider and `@Inject(DATA_SOURCE)`, losing `@InjectRepository`'s
decorator sugar but keeping the test suite working without extra config. Revisit if
`@nestjs/typeorm` ships a working CJS build again.

**One formula still duplicated, down from many:** the WordPress-era codebase duplicated
every fermentation constant and formula between PHP (`class-fratoo-report.php`) and
client-side JS (`fratoo-chart.js`), with a comment warning to keep them in sync by hand. The
new backend has exactly one copy (`fratoo-bridge/src/common/fermentation-math.ts`), shared
by `ReadingsService` and `ReportsService`. The frontend still needs its own copy of just the
temperature-correction formula for per-point chart rendering (`fratoo-web/src/lib/temperature.ts`)
since there's no shared package between the Node backend and the browser frontend — two
copies instead of four, and only because the backend/frontend split is a real runtime
boundary rather than an avoidable one.

---

## 2026-10-01 — `volume_liters`/`added_sugar_g` are `double precision`, not `NUMERIC`

**Decision:** Use `double precision` for these two batch columns instead of the more
"correct-looking" `NUMERIC(8,2)`.

**Why:** Caught during local smoke-testing of the new backend (not by inspection) —
`node-postgres` deserializes `NUMERIC`/`DECIMAL` columns as **strings**, not numbers, to
avoid silent float-precision loss on financial-grade data. `GET /batches` was returning
`"volumeLiters": "20.00"` as a string, which the frontend's `number | null` typing and
`estimateAbv()`'s arithmetic both assume is a number. JavaScript's loose arithmetic
coercion happened to make the ABV math work anyway, but relying on that is exactly the kind
of thing that breaks later in a way that's hard to trace back to its source. These two
columns are human-entered volume/sugar values, not money — `double precision` avoids the
string-coercion trap entirely, same type `readings.value` already uses.

---

## 2026-10-01 — Corrected: device uses direct provisioning, not DNS redirect

**Decision:** Stop documenting DNS redirect (Pi-hole/dnsmasq → `blynk-cloud.com`) as the
production device's networking mechanism. Keep it in `fratoo-bridge/README.md` only as a
documented fallback for a hypothetical future stock-firmware device.

**Why:** Surfaced while writing up the device's Wi-Fi provisioning steps in the user
manual — the known-working config commands for the reference unit set `host` and
`port` directly via the device's own `/config` endpoint, with no `blynk-cloud.com` anywhere
in the picture. This device runs custom firmware, not the stock Plaato firmware the DNS
workaround assumes. The earlier docs had carried forward an assumption (stock
firmware → needs DNS trickery) that was never verified against what this unit actually
does. See [ARCHITECTURE.md](ARCHITECTURE.md#device-provisioning-not-dns-redirect) and
[USER-MANUAL.md](USER-MANUAL.md#reconnecting-the-plaato-airlock-to-wi-fi-device-provisioning).

---

## 2026-10-01 — `ProdRelease.bat` backs up `.env`, not a database

**Decision:** Model the bridge's deploy script on another project's `ProdRelease.bat`
(self-elevate, timestamped log, numbered steps, pull → rebuild → verify), but swap its
pre-deploy database backup step for a `.env` backup.

**Why:** At the time, fratoo-bridge had no local database — all telemetry landed in WordPress, a remote
system with its own backup story. The only local state that's both irreplaceable and worth
insuring against an accidental overwrite is `.env` (gitignored; `WP_APP_PASSWORD` can only
be regenerated from WP Admin, not recovered). Backing it up costs nothing and removes any
doubt, even though a normal `git pull` can't touch a gitignored file anyway.

---

## 2026-10-01 — Run fratoo-bridge in Docker instead of PM2

**Decision:** Containerize the bridge (`Dockerfile` + `docker-compose.yml`,
`restart: unless-stopped`) and retire the PM2-based deployment entirely.

**Why:** The PM2 deployment on the production Windows server had drifted into three
overlapping process entries (`fratoo-bridge`, `fratoo-bridgenpx` ×2, one crash-looping with
15 restarts) all fighting over port 1234, with no Windows Service wrapper and no scheduled
task managing it — just a long-running `pm2` daemon someone had started by hand at some
point. There was no clean single source of truth for "is the bridge actually running, and
which copy." Docker gives a single, reproducible build (multi-stage `node:20-alpine`, no
native deps) with one obvious running/not-running state and an explicit restart policy.

**Alternative considered:** `pm2-installer` to register PM2 as a proper Windows Service.
Rejected — repeated Windows/PM2 service errors had already been hit in the past, and the
goal was simple on/off control over a process whose state is visible
(`docker compose ps`) rather than trusting PM2's internal bookkeeping again.

The PM2 clean-up steps (find the port owner with `Get-NetTCPConnection`, then
`pm2 delete all` + `pm2 save --force`, since killing the worker PID just makes PM2 respawn
it) are in the project history.

---

## 2026-07-10 — Download Batch Report is a GET-link admin action, not a REST route

**Decision:** Route "Download Batch Report" through `Fratoo_Admin::handle_admin_actions()`
on `admin_init` (nonce'd GET link), the same pattern used for batch deletion/completion —
not a new REST endpoint.

**Why:** The handler needs to send its own `Content-Disposition` header before any admin
page HTML is emitted, which requires hooking before WP's page render pipeline starts. This
is the same constraint WordPress's own CSV exporters work around. A REST route would have
required a separate auth/nonce scheme just for this one download.

---

## 2026-07-10 — Batch report pulls its dataset through `resolve_batch_window()`

**Decision:** `Fratoo_DB::get_batch_readings()` reuses the same `resolve_batch_window()`
that `delete_batch()` and `count_batch_readings()` already call (promoted from `private` to
`public` for this).

**Why:** Batches and readings have no foreign key — "the readings in this batch" is always
a derived concept (device_id + time window). Without a single shared implementation, it's
easy for a new feature to accidentally define "this batch" slightly differently (off-by-one
on the end boundary, forgetting the next-batch guard, etc.) and silently disagree with
every other view of the same batch.

---

## 2026-07-10 — Cascading batch deletion includes a "next-batch guard"

**Decision:** `delete_batch()` clamps the readings window's upper bound to the next batch's
`started_at` on the same `device_id`, if one exists, before deleting.

**Why:** Without the FK relationship, deleting an open-ended/active batch (`ended_at IS
NULL`) would otherwise delete everything "after this batch started," which could swallow a
later batch's readings if one had already begun on the same device. Identified as the key
architectural risk before implementation, not discovered after the fact.

---

## 2026-06-20 — V99/V100 pin roles corrected + PCB temperature correction applied

**Decision:** Swap which pin drives the bubble-rate delta engine (V100, not V99) and apply
`0.9133 × raw − 1.145` to V101 before display.

**Why:** Confirmed against PLAATO's own open-source server implementation
(`PlaatoStructure.java`) — the codebase had the roles backwards from day one, which wasn't
obvious because both pins happily parsed as numbers and produced *a* chart, just a wrong
and nearly invisible one. See [ARCHITECTURE.md](ARCHITECTURE.md#️-historical-bug-v99v100-were-swapped).
