# fratoo-bridge

NestJS backend: a TCP bridge that intercepts telemetry from a Plaato Airlock (Blynk legacy
protocol), a Postgres-backed REST API (batches, readings, reports), and a single-admin JWT
login. See [`../ProjectDocs/`](../ProjectDocs/README.md) for the full architecture — this
README covers only this component's setup.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Docker Desktop (Windows) | `winget install Docker.DockerDesktop` |
| Node.js (only for running the one-off setup scripts below, not required to run the app) | `winget install OpenJS.NodeJS.LTS` |

---

## Configure

The real `.env` lives at the **repo root** (sibling to `docker-compose.yml`), not in this
folder — see [`../.env.example`](../.env.example):

```powershell
cd ..
Copy-Item .env.example .env
notepad .env           # DB_USERNAME / DB_PASSWORD / DB_NAME
```

Then create the admin account (writes `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH`/`JWT_SECRET`
straight into that same `.env` — interactive, never put a plaintext password in the file by
hand):

```powershell
cd fratoo-bridge
npm install          # first time only, to get bcryptjs for the script
npm run create-admin
cd ..
```

(This file's own `.env.example`, inside `fratoo-bridge/`, is only for running the bridge
directly with `npm run start:dev`, outside Docker — most setups don't need it.)

---

## Run with Docker (recommended)

Run from the **repo root**, not this folder — `docker-compose.yml` orchestrates Postgres,
this backend, and the `fratoo-web` frontend together:

```powershell
cd ..   # repo root, if you're not already there

# Build the images and start all three containers (detached)
docker compose up -d --build

# Check status and recent logs
docker compose ps
docker compose logs -f api        # or: postgres / web / (omit a name for all three)

# Stop / restart
docker compose stop
docker compose restart

# Stop and remove the containers (add -v to also wipe the Postgres volume)
docker compose down
```

The bridge listens on **TCP port 1234**, published to the host. The Plaato Airlock must be
able to reach this host — see [Device provisioning](#device-provisioning) below (this device
is configured with the host's LAN IP directly, no DNS redirect needed).

Docker Desktop is set to start on login by default, and each container's
`restart: unless-stopped` policy brings it back up automatically after a host reboot or
Docker restart — no separate "install as a service" step needed. `docker compose down`
removes the containers outright; `docker compose stop` leaves them stopped until the next
`docker compose start` or host reboot.

After changing `.env` or the source code, rebuild with `docker compose up -d --build` (repo
root) to pick up the changes — or just run `ProdRelease.bat` at the repo root, which wraps
this plus a pre-deploy Postgres backup.

---

## Alternative: run directly with PM2 (legacy)

Docker is the recommended path above. If you'd rather run the compiled app directly on Windows instead:

```powershell
npm install
npm run build          # compiles TypeScript → dist/

npm install -g pm2
pm2 start ecosystem.config.js --env production

pm2 status
pm2 logs fratoo-bridge --lines 50
pm2 stop fratoo-bridge
pm2 restart fratoo-bridge
```

`pm2 startup` does not work on Windows — use `pm2-installer` (`npm install -g pm2-installer && pm2-installer install`, then `pm2 save`) to register PM2 as a Windows Service so saved apps survive a reboot.

---

## Firewall

Open TCP port 1234 inbound so the Airlock can reach the bridge:

```powershell
# Run as Administrator
New-NetFirewallRule `
  -DisplayName "Fratoo Bridge (Blynk TCP)" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 1234 `
  -Action Allow
```

If the `fratoo-web` dashboard (port `8086`) needs to be reachable from outside this host too
(not just `localhost`), open that as well:

```powershell
New-NetFirewallRule `
  -DisplayName "Fratoo Web Dashboard" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 8086 `
  -Action Allow
```

---

## Device provisioning

> **Preferred: direct provisioning.** The reference Airlock is configured with the
> bridge's host/port directly via its own setup Wi-Fi AP — see
> [`ProjectDocs/USER-MANUAL.md`](../ProjectDocs/USER-MANUAL.md#reconnecting-the-plaato-airlock-to-wi-fi-device-provisioning)
> for the steps and
> [`ProjectDocs/ARCHITECTURE.md`](../ProjectDocs/ARCHITECTURE.md#device-provisioning-not-dns-redirect)
> for background. The DNS redirect below is a fallback for a unit that only talks to
> `blynk-cloud.com`.

### DNS redirect (fallback)

The stock Plaato Airlock firmware connects to `blynk-cloud.com`. Redirect that hostname to your server's local IP so the bridge intercepts the traffic instead.

### Option A — Windows hosts file (single machine, for testing)

```
# C:\Windows\System32\drivers\etc\hosts
192.168.1.XX    blynk-cloud.com
```

### Option B — Pi-hole (recommended for the whole network)

1. Pi-hole Admin → **Local DNS → DNS Records**
2. Add: Domain `blynk-cloud.com` → IP `<server LAN IP>`

### Option C — dnsmasq

```
# /etc/dnsmasq.d/fratoo.conf
address=/blynk-cloud.com/192.168.1.XX
```

Restart dnsmasq: `sudo systemctl restart dnsmasq`

The Airlock will start connecting to your bridge automatically — no firmware changes needed.

---

## Logs

With Docker, the NestJS logger writes to stdout/stderr, which Docker captures directly:

```powershell
docker compose logs -f           # real-time tail
docker compose logs --tail 50    # last 50 lines
```

Running with PM2 instead? Logs land in `%USERPROFILE%\.pm2\logs\` (`fratoo-bridge-out.log` / `fratoo-bridge-error.log`); tail with `pm2 logs fratoo-bridge`.
