# Deployment & Operations

How to install, deploy, update and look after a Fratoo server. Component-level setup (env
vars, firewall rules, running without Docker) is in
[`fratoo-bridge/README.md`](../fratoo-bridge/README.md); this doc is the runbook around it.

## What runs where

- **Docker Compose**, three services in the repo-root `docker-compose.yml`:
  `postgres`, `api` (fratoo-bridge) and `web` (fratoo-web, served by nginx, which also
  reverse-proxies `/api` to `api`). Restart policy `unless-stopped` on all three.
- **Ports:** `1234` (Blynk TCP, the airlock talks to this) and `8086` (dashboard HTTP).
  Postgres isn't published to the host; it's only reachable container-to-container as
  `postgres:5432`.
- **State:** everything lives in the `fratoo_pgdata` volume (batches, readings, gravity
  readings, settings, push subscriptions and the VAPID keys) plus the repo-root `.env`.
  Back up both.
- **Device networking:** the airlock is configured with the server's LAN IP and port 1234
  (see [USER-MANUAL.md — device provisioning](USER-MANUAL.md#reconnecting-the-plaato-airlock-to-wi-fi-device-provisioning)).
  Keep the server on a fixed LAN IP. The device doesn't buffer readings while the server is
  down, but its bubble counter keeps running, so totals catch up on the next reading.

## First-time setup

The scripts and examples are Windows/PowerShell (that's what the reference server runs);
the stack itself is plain Docker and runs anywhere Docker does.

1. **Clone and fill in the repo-root `.env`:**
   ```powershell
   git clone https://github.com/FarzadDerafshi/fratoo.git
   cd fratoo
   Copy-Item .env.example .env
   notepad .env   # DB_USERNAME / DB_PASSWORD / DB_NAME
   ```
2. **Create the admin account.** Interactive: prompts for a username and password, hashes
   it with bcrypt, and writes `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` into the `.env`, plus a
   random `JWT_SECRET` if there isn't one yet:
   ```powershell
   cd fratoo-bridge
   npm ci               # gets bcryptjs for the script
   npm run create-admin
   cd ..
   ```
   Re-running it asks before overwriting an existing account. `npm run hash-password --
   "your-password"` prints just a hash, if you'd rather paste it yourself; the
   `create-admin.js` header comment explains why the interactive script is the safer route
   (see also [DECISIONS.md](DECISIONS.md)).
3. **Bring up the stack:**
   ```powershell
   docker compose up -d --build
   docker compose logs -f
   ```
   `db/init/*.sql` runs automatically the first time Postgres starts on an empty volume.
4. **Open the firewall** for TCP 1234 (and 8086 if the dashboard should be reachable from
   other machines): see the bridge README.
5. **Point the airlock at the server** (user manual, device provisioning), wait one wake
   cycle (~5 min), and look for `Auth from … token: …` and `Pin V100 = …` lines in
   `docker compose logs -f api`.
6. Open `http://<server>:8086` and sign in. The airlock shows up in **Settings → Airlocks**
   after its first reading; give it a name, then create a batch and pick it from the list.
   (Its token is the `blynk=` value from its config URL; the bridge log shows the first 8
   characters on each connect.)

## HTTPS and remote access

The dashboard works over plain HTTP on the LAN, but **installing it as an app and push
notifications need HTTPS**. The simplest route is a tunnel such as Cloudflare Tunnel
(`cloudflared` on the server → `http://localhost:8086`), which needs no open inbound port.
Only expose the dashboard: port 1234 should stay LAN-only. The dashboard's own login is the
only protection, so use a strong password; an access layer in front (e.g. Cloudflare
Access) adds a second one.

`fratoo-web/nginx.conf` sends `no-cache` for `index.html`, `sw.js` and the manifest and a
one-year `immutable` for hashed assets, so a CDN in front behaves.

## Routine deploys: `ProdRelease.bat`

Run **`ProdRelease.bat`** from the repo root on the server for every update (it can also be
run unattended, e.g. by a scheduler or a chat-ops bot). It:

1. backs up the database (`pg_dump` into `DB_Backup\`) and the `.env` files,
2. updates the code to exactly `origin/main` (`git fetch` + forced checkout, so local edits
   to tracked files are overwritten and gitignored files are left alone),
3. applies database migrations (below),
4. rebuilds and restarts the stack (`docker compose up -d --build`), passing the git commit
   into both images,
5. checks port 1234 and asks `http://localhost:8086/api/version` which build is running,
   e.g. `Running: v2.6.1 (ab12cd3)`; the dashboard footer shows the same.

The server is down for a few minutes during a deploy. The batch page then shows an amber
"No reading for …" until the next reading arrives; no bubbles are lost.

**When an update changes `ProdRelease.bat` itself**, the script stops with
"[STOP] … run ProdRelease.bat again" before rebuilding anything; just run it again. cmd
reads a running `.bat` line by line from disk, so the script runs from a temporary copy and
compares it with the updated file rather than executing a half-replaced script.

**DB credentials:** the backup and migration steps use `-U fratoo -d fratoo` (the
`.env.example` defaults). Change those lines if your `.env` uses other values.

**Running npm on the server:** use `npm ci`, never `npm install`, for anything run directly
on the host. `npm install` can rewrite `package-lock.json`; the next deploy would
silently overwrite it again. The Docker builds use `npm ci` already.

## Database migrations

Postgres only runs `fratoo-bridge/db/init/*.sql` by itself on a brand-new volume. On an
existing one, `ProdRelease.bat` applies every file except `001_init_fratoo.sql` *before* the
new `api` image starts. So every migration from 002 on must be **idempotent**
(`IF NOT EXISTS` everywhere): re-applying the ones already in is a no-op. A failing
migration prints `[ERROR] Migration … failed!` and stops the deploy before any container is
touched; the backup from step 1 is in `DB_Backup\`.

To apply one by hand:

```powershell
Get-Content fratoo-bridge\db\init\005_alerts.sql -Raw | docker exec -i fratoo-postgres psql -U fratoo -d fratoo -v ON_ERROR_STOP=1
```

To check one went in (example for `005_alerts.sql`, expect 4 rows):

```powershell
docker exec fratoo-postgres psql -U fratoo -d fratoo -c "SELECT table_name, column_name FROM information_schema.columns WHERE (table_name = 'batch_notifications' AND column_name IN ('active','cleared_at')) OR (table_name = 'batches' AND column_name IN ('alert_temp_min_c','alert_temp_max_c')) ORDER BY 1, 2;"
docker exec fratoo-postgres psql -U fratoo -d fratoo -c "\dt"            # all tables
docker exec fratoo-postgres psql -U fratoo -d fratoo -c "\d batches"     # one table's columns
docker logs fratoo-bridge --since 30m 2>&1 | Select-String "ERROR|failed"  # API errors (a missing column shows here)
```

## Releasing a version

Convention: [CHANGELOG.md "Versioning"](../CHANGELOG.md#versioning). Entries go under
**[Unreleased]** as work lands. To cut a release, on a clean `main`:

```powershell
.\scripts\release.ps1 minor "UI Facelift"     # or major / patch; -DryRun to preview
git push origin main --follow-tags
```

then deploy as usual. The script bumps both `package.json` files (+ lockfiles), turns
[Unreleased] into `## [X.Y.Z] — date — **Title**`, commits `release: vX.Y.Z - Title` and
creates the annotated tag. Deploying unreleased commits in between is fine; the footer then
shows the last version plus the actual commit.

## Push notifications

Nothing to configure: the VAPID keys are generated on first start and stored in Postgres
(`app_settings.push_vapid`). Keep them; deleting that row means every device has to turn
notifications on again. Optional `PUSH_SUBJECT` in `.env` is the contact (`mailto:` or
`https:`) sent to the push services; it defaults to this repo's URL. Needs the HTTPS address,
and on iPhone the installed home-screen app.

## Day-to-day operations

- **Logs:** `docker compose logs -f` for everything, or `docker compose logs -f api` /
  `web` / `postgres`.
- **After a code or `.env` change:** `docker compose up -d --build` at the repo root (or
  just `ProdRelease.bat`). The frontend is baked into the nginx image, so a plain
  `docker compose restart web` does **not** pick up source changes.
- **Device went quiet:** usually a stuck connection on the server side, not the device:
  `docker compose restart api`, then wait one wake cycle (~5 min). Re-provision the device
  only if that doesn't help.
- **Resetting the database** (local dev, or a fresh start): `docker compose down -v`
  removes the `fratoo_pgdata` volume, and the next `up` re-runs `db/init`. Never on a real
  installation without a fresh `pg_dump` first.
- **Restoring a backup:** `Get-Content DB_Backup\fratoo_<timestamp>.sql | docker exec -i
  fratoo-postgres psql -U fratoo -d fratoo` into an empty database (after `down -v` + `up -d
  postgres`).

## History

Fratoo started as a WordPress plugin (MySQL tables, WP REST API, an admin page), with the
bridge forwarding readings over HTTP. In October 2026 storage, API and dashboard moved into
the bridge + Postgres + React stack described here, ran in parallel with WordPress for about
three weeks, and the WordPress side was retired in 2.5.0 (see [DECISIONS.md](DECISIONS.md)
and the [CHANGELOG](../CHANGELOG.md)). Before that, in the same month, the bridge moved from
PM2 to Docker.
