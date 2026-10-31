# User Manual — Fratoo Dashboard

> **Where to log in:** your server's HTTPS address (if you've set one up, see
> [DEPLOYMENT.md — HTTPS](DEPLOYMENT.md#https-and-remote-access)), or `http://<server>:8086`
> on the local network, with the single admin account created by `npm run create-admin`
> (see [DEPLOYMENT.md](DEPLOYMENT.md#first-time-setup)).

## Installing the dashboard as an app (phone, tablet, desktop)

*(From 2.2.0.)* The dashboard can be added to a home screen and then opens in its own
window with the Fratoo icon, like an app. It needs an **https://** address; the plain
`http://<server>:8086` address only gives a bookmark.

- **Android (Chrome):** open the dashboard, then ⋮ menu → **Install app** (or **Add to Home
  screen**).
- **iPhone / iPad (Safari):** Share button → **Add to Home Screen**.
- **Desktop (Chrome / Edge):** the install icon at the right end of the address bar.

The app always shows live data: readings, stats and logins never come from a cache. Only the
app itself (layout, fonts, icons) is stored, so it opens without a connection and then shows
"Failed to load" until it's back online. After a deploy it updates itself the next time it's
opened; the footer shows which version is running.

**Light / dark:** the theme button in the top bar has three settings. **Automatic**
(half-filled circle, the default) follows the phone's or computer's own light/dark setting,
and changes along with it (e.g. when the phone switches to dark at sunset). Tap it to force
the other look, tap again to force the device's look (sun = light, moon = dark), and tap a
third time to go back to Automatic. The choice is remembered per browser or installed app.

## Notifications

*(From 2.5.0; more alerts in 2.6.0.)* Fratoo sends push notifications about active
batches to your phone or computer. Tapping one opens the batch. Each alert, and its
thresholds, can be switched on or off in **Settings → Notifications → Alerts** (they apply to
every subscribed device):

| Alert | When | Default |
|---|---|---|
| **Fermentation started** | Steady bubbling begins (the end of the lag phase), once per batch. Not sent for a start more than an hour old. | on |
| **Airlock offline / back online** | No reading for 30 min while a batch is active; "back online" with how long it was gone when readings return. Not in the first 30 min after a deploy. | on |
| **No start** | No steady bubbling 24 h after pitching (or after the batch start). | on |
| **Temperature out of range** | Two readings in a row outside 16–24 °C at the airlock, then "back in range" once 0.5 °C inside again. A batch can have its own limits: **Edit → Temperature alerts**. | on |
| **Peak passed** | The hourly rate has stayed under half the peak for 3 h: time for a refractometer reading or a dry hop. Once per batch. | on |
| **Looks finished** | Under 2 bpm for 24 h with the estimated ABV near the expected mark: take the final gravity reading. Once per batch. | on |
| **Possibly stalled** | Under 2 bpm for 12 h while the estimated ABV is below 70% of the expected mark (needs the OG). Once per batch. | on |
| **Airlock restarted** | The bubble counter reset (power cut or reboot); nothing is lost. | off |

The time-based alerts are checked every 5 minutes, so they can arrive up to 5 minutes after
the condition is met. The temperature is the airlock's, not the beer's: at peak the beer is
2–4 °C warmer, which is why the default high limit is 24 °C.

**Turning it on** (once on each device that should get notifications):

1. **iPhone / iPad:** notifications only work in the **installed app** (iOS 16.4 or newer).
   Add Fratoo to the home screen first (see above) and open it from there.
2. Open **Settings** (top bar) → **Notifications** → **Turn on notifications**, then allow
   them when the phone or browser asks.
3. Tap **Send a test**. A "Test notification" should arrive within a few seconds.

**Turn off** on the same card stops them on that device. If you've blocked notifications
for Fratoo, re-allow them in the phone's Settings → Notifications → Fratoo (iPhone) or the
browser's site settings, then turn them on again here. If the app is removed from the home
screen, its subscription is dropped automatically the next time something is sent.

## Reconnecting the Plaato Airlock to Wi-Fi (device provisioning)

**Read this section before anything else if the device goes dark after a move, a Wi-Fi
password change, or a factory-reset-like event.** This is the part that's easy to forget
because it's needed rarely, but it's the one piece of info that can't be reconstructed from
the code — only from here.

### How the device is configured

The reference Airlock is configured with the bridge's host and port directly, through a
local HTTP endpoint it exposes while broadcasting its own setup Wi-Fi; it never contacts
`blynk-cloud.com`, so no DNS redirect is needed (see
[ARCHITECTURE.md](ARCHITECTURE.md#device-provisioning-not-dns-redirect)). A unit that only
talks to `blynk-cloud.com` can use the DNS-redirect fallback in the bridge README instead.

### Provisioning / re-provisioning steps

1. Get the device broadcasting its own setup Wi-Fi access point (consult the physical
   device if it isn't already in that state — it drops into its own AP when it can't join a
   known network).
2. Connect your phone or laptop to that AP.
3. Visit the device's config URL with the target network and bridge details as query
   parameters:
   ```
   http://192.168.4.1/config?ssid=<WIFI_SSID>&pass=<WIFI_PASSWORD>&blynk=<DEVICE_TOKEN>&host=<BRIDGE_LAN_IP>&port=1234
   ```
4. The device applies the config and reconnects to the real network, then to the bridge at
   `host:port`.

### Keep your working config

Once a config works, save the full URL (Wi-Fi name and password, token, host) somewhere
safe, such as a password manager or the git-ignored `ProjectDocs/private/` folder, so you
can reuse it as-is instead of re-deriving the token or retyping the password from memory.
**Never commit it.**

- `+` in the URL is a literal space in the SSID; URL-encode other special characters.
- The `blynk` token is the device's identity (what the bridge calls `device_id`, and what
  each batch is tied to). Pick any 32-character hex string for a new device and keep it.
- Only re-point `host` if the bridge moves to a different machine or gets a new LAN IP.

### If the device doesn't come back after a power-cycle

The network path (device → bridge) is otherwise stable. If you manually unplug/replug the
physical Airlock mid-run and it doesn't reappear in the logs right away, don't re-run the
provisioning steps above or second-guess the config — it almost never needs reprovisioning.
Just clear out a stuck connection on the bridge side:

```powershell
# in the repo root on the server
docker compose restart api
docker compose logs -f api
```

If the container isn't running at all (`docker compose ps` shows nothing), bring it up
fresh instead: `docker compose up -d` then tail the logs the same way. Give it up to one
full wake cycle (~4m47s) before concluding something's actually wrong — see
[DEPLOYMENT.md](DEPLOYMENT.md) for deeper troubleshooting if it still doesn't reconnect.

## Batches

A **batch** represents one brew/fermentation run tied to a device (`device_id`) and a time
window (`started_at` → `ended_at`, or "still running" if `ended_at` is empty).

### Batch list

- One card per batch: status and day, a small bubble-activity graph, estimated (or final)
  ABV, gravity, the current or peak bubble rate, and when the last reading arrived.
- Filter with **All / Active / Completed**; **+ New batch** (or the dashed card) starts one.
- Click a card to open the batch. Deleting is on the batch page (⋯ menu).

### Starting a batch

Create a new batch entry with its **airlock** (picked from a list, see below), brew type,
volume, and optional notes — and,
if you know them, the yeast strain, its attenuation (from the yeast pack), when you pitched
and the wort temperature at that moment (all can be filled in later too). From
that point on, any readings coming in from that device are considered part of this batch
until it's completed (or another batch starts on the same device).

The **Airlock** list shows every known airlock with its name, whether it's online and which
batch is using it. The airlock of your most recent batch is preselected, so with one
airlock there's nothing to choose. If it still has an active batch, the form says so: the
old batch's readings stop where the new one starts, so end it first if it's finished.
**Enter a token…** at the bottom takes a raw token for an airlock that isn't listed.

### Airlocks (Settings → Airlocks)

Every airlock that has sent a reading appears here by itself (existing ones were added from
past readings when 2.7 was installed). For each: its name and short token, online / last
seen, and the batch using it.

- **Name it / Edit** — give it a name ("Airlock 1", "Big fermenter"); batch pages and
  reports then show the name. The edit view also shows the full token.
- **Copy token** — the full 32-character token, e.g. for re-provisioning the airlock.
- **+ Add an airlock by token** — list one before it has ever connected.
- **Remove…** (in Edit) — takes it off the list only; readings and batches are kept. One
  that's still sending comes back by itself, unnamed, with its next reading.

### Completing a batch

On the batch detail page, **Complete Fermentation** sets `ended_at` to now, closing the
batch's reading window.

### Editing a batch

Open the **⋯** menu on the batch detail page → **Edit batch & ABV inputs** to change batch code, airlock, brew type, started
date, volume, added sugar, notes, the **Yeast & pitch** details, hops, the **Bottling**
details (priming sugar, bottled volume, number of bottles) and tasting notes. Clearing a
field removes that value
entirely rather than leaving it unchanged. Backdating **Started** is useful when the batch
record was created after the yeast went in, so its window reaches back to when fermentation
actually began — but it doesn't check for overlap with an
earlier batch on the same device, so double-check there isn't one before saving. This form
doesn't touch end date/status — use **Complete Fermentation** / **Reopen Batch** for those.

### Notes (formatted)

The notes field takes any length of text. Light formatting is understood, so a pasted review
reads well: lines starting with `- ` or `* ` become bullets, `1. ` a numbered list, `# ` a
heading; a short line ending in `:` becomes a bold label; `**text**` is bold. Short notes sit
under the batch title; longer ones (over ~280 characters or 4 lines) get their own **Notes**
card, on the page and in the report.

### Events

The **Events** panel on the batch page logs things that happened at a moment: dry hop,
addition, temperature change, disturbance (moving the fermenter, opening the lid), bottling,
or a plain note. Each shows as a solid amber line on the chart and in the report, so a bump
in the bubble rate has an explanation. Events never change the ABV estimate.

### Reopening a completed batch

If you completed a batch by mistake, or want to resume logging against it, use **⋯ → Reopen
batch** (only shown on completed batches). This clears the end date and sets it back to
active — new telemetry counts toward it again. Just flipping the status without clearing the
end date would leave new readings outside the batch's window and they'd silently not show
up, which is why this is a dedicated action rather than part of the edit form.

### Deleting a batch

**This is destructive and cannot be undone.** Deleting a batch also deletes every telemetry
reading that falls inside its resolved time window (device_id + started_at..ended_at) —
not just the batch record itself.

- Available from the **⋯** menu on the batch detail page (**Delete batch…**).
- The detail-page confirmation shows the exact number of readings that will be deleted
  before you confirm — read that number before clicking through.
- If the batch is still "running" (no `ended_at`) and a later batch has since started on
  the same device, deletion is automatically clamped to stop at that later batch's start
  time, so it won't eat another batch's data.

## Batch detail page

### Live status

The line under the batch details says whether the airlock is reporting:

- **Live** (green): a reading in the last 15 minutes, with the latest rate and temperature.
- **No reading for …** (amber): 15–60 minutes of silence; the airlock reports about every
  5 minutes, so it may just be reconnecting.
- **No data for …** (red): over an hour. Check the device and the server. Bubbles are still
  counted by the device and catch up once it reconnects.

A deploy (`ProdRelease.bat`) takes the server down for a few minutes, so an amber
**No reading for …** shortly after one is expected; it turns back to **Live** with the next
reading, and the chart shows that stretch as a shaded gap.

### Fermentation summary

- **Estimated ABV** is the big figure, with a badge saying how it's calibrated. The bar runs
  from 0 to the most this OG could produce ("OG ceiling"); the black mark is the expected ABV, the amber mark your target (if set).
  The expected mark uses the yeast's attenuation (or the default in ABV settings) and counts
  added sugar as fully fermentable; the text next to it says what it assumed. Below it: estimated gravity,
  apparent attenuation, CO₂ released and the bubble volume in use.
- **Activity / Temperature / Time** on the right: bubble rate now and at peak, total bubbles,
  temperature now and on average, and how long the batch has been running.
- Any warnings from the ABV model (no OG, no volume, capped) are listed under these.

### ABV estimate and calibration

The ABV is worked out from the bubble count, so the fermenter never needs opening. Each
bubble's gas volume is the unknown, and it's learned from the occasional gravity reading.

1. **Set the OG** via **Edit** → *ABV model*: the value, its unit (Brix from a
   refractometer, or SG from a hydrometer), and whether it was measured after the added
   sugar was dissolved. Enter a refractometer reading exactly as read; the wort correction
   factor is applied for you. *Target ABV* is just your own expectation, for comparison.
2. **Add gravity readings** in the *Gravity Readings* panel on the batch page. Refractometer
   readings taken mid-fermentation are corrected for alcohol automatically (Terrill). One
   mid-fermentation and one near the end are the most useful. Each row shows the corrected
   SG, the ABV it implies, the bubble volume it implies, and what the model now predicts
   for that moment. A reading that looks wrong can be **Excluded** without deleting it.
3. **The Bubble Volume tile** says where its value comes from: *this batch's readings*,
   *learned from other batches* (once any batch has readings), *default (uncalibrated)*,
   or *manual override* (the *Bubble volume override* field in **Edit**, which beats
   everything; leave it blank to let calibration work).
4. **Share this batch's calibration** (in **Edit** → *ABV model*, on by default) decides
   whether new batches learn from this one. Turn it off when the batch isn't typical, for
   example the airlock was filled to a different level or the lid leaked. The batch keeps
   using its own readings either way; *Exclude* is for a single reading that's wrong.

**ABV settings** (in the top bar) holds every assumption the model makes: default
bubble volume, refractometer correction factor, ABV formula, pressure, temperature source,
dissolved CO₂ and so on, each with its default shown. Saving recalibrates every batch.

The estimate is the alcohol in the fermenter. Enter the priming sugar (and bottled volume)
under **Edit → Bottling** to see the bottled ABV, the carbonation in volumes of CO₂ and the
calories per 330 mL; without it, the card reminds you priming adds roughly 0.3–0.4%.

The temperature comes from the airlock's sensor, which sits above the beer. During peak
fermentation the wort itself typically runs 2–4 °C warmer than what's shown.

### Analytics chart

- **Left axis / blue line:** bubble rate (bubbles per minute), derived from the V100
  cumulative counter.
- **Right axis / orange line:** temperature (°C), PCB-corrected from the raw sensor reading.
- **ABV** (dashed, off by default): the estimate over time, from the same model as the big
  figure.
- **Shaded stretches:** no readings arrived (device or server offline). The bubbles from
  that time are still counted; only the rate curve is missing there.
- **Dashed vertical lines:** gravity readings, labelled with the value and its ABV.
- **Solid amber lines:** logged events (dry hop, bottling …), labelled at the bottom.

The chips switch each line on and off; **24h / 3d / 7d / All** pick the time range.

### Download Batch Report

Click **Download report** to generate a self-contained, print-ready HTML file covering the
whole batch, with the same look and the same numbers as the batch page.

- **Header** — the Fratoo logo, batch code and status, start/end, volume, added sugar, OG
  (as entered and as SG), target ABV, device, and the batch notes.
- **Estimated ABV** — the big figure with its calibration badge, the bar against the OG
  ceiling (expected / target marks), estimated gravity, attenuation, CO₂ released and the
  bubble volume used. Any model warnings follow.
- **Activity / Temperature / Time** — bubble rate now and at peak, total bubbles,
  temperature now, average and range, elapsed time and the last reading.
- **Brew log / Bottling** — yeast, pitch time and temperature, lag phase, hops and the
  events; priming sugar, bottles, bottled ABV, carbonation, calories and tasting notes
  (only what's been filled in).
- **Notes** — long notes, formatted, in their own card.
- **Trend chart** — bubble rate, temperature and the ABV line (with its own % axis); shaded
  stretches with no readings; dashed lines at each gravity reading, solid amber lines at
  events.
- **Gravity readings** — each reading with its SG, measured ABV, the model's ABV at that
  moment, the bubble count so far, the bubble volume it implies, and whether it was used for
  calibration (or why not).
- **Daily 9:00 PM snapshots** — one row per day of the batch (cumulative bubbles, corrected
  temperature, estimated ABV), picked from whichever reading's clock time is closest to
  21:00 that day.
- **Key Highlights:**
  - *Peak Fermentation Velocity* — the single highest bubble rate recorded, with timestamp.
  - *Thermal Range* — min/max corrected temperature across the batch.
  - *Lag Phase* — how long fermentation took to visibly start (from the pitch time, or
    `started_at` if none is set, to the
    first reading that clears a small activity floor and stays active, filtering out
    single-spike noise).
The downloaded file opens as a normal HTML page in any browser. To get a PDF: open it, then
**Ctrl+P → Save as PDF** (the report has print-specific styling so it lays out cleanly on
A4). All times in the report are UTC. The chart and fonts load from the internet; offline
the numbers and tables still show.

## Troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| Bubble rate looks wildly wrong (near-zero or absurdly high) | Pin mapping regression | [ARCHITECTURE.md — pin mapping](ARCHITECTURE.md#real-device-pin-mapping-confirmed) |
| Chart shows no data for a known-active batch | Device not connected / bridge down | [DEPLOYMENT.md](DEPLOYMENT.md) — check `docker compose logs -f` on the server |
| New readings aren't appearing at all | Device not reaching the bridge, or wrong device_id on the batch | Check `docker logs fratoo-bridge` for `Pin V100 = …` lines; confirm the batch's `device_id` matches the Airlock's auth token |
| Device went dark after a move / power outage / Wi-Fi change | Needs re-provisioning, or just a stuck connection | [Reconnecting the Plaato Airlock to Wi-Fi](#reconnecting-the-plaato-airlock-to-wi-fi-device-provisioning) above — try the power-cycle fix before re-provisioning |
