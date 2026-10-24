# Roadmap

What's open, roughly in priority order. What has shipped is in the
[CHANGELOG](../CHANGELOG.md); why things are built the way they are is in
[DECISIONS.md](DECISIONS.md).

## Where things stand (2.7)

- Standalone stack (NestJS bridge + Postgres + React PWA) in daily use since October 2026;
  the original WordPress plugin is retired.
- Calibrated ABV model (bubble volume learned from gravity readings), brew log, batch
  events, a downloadable report, installable app with light/dark theme.
- Push notifications: fermentation started, airlock offline/back online, no start,
  temperature out of range, peak passed, looks finished, possibly stalled, airlock
  restarted; each with a switch and thresholds.
- Airlocks are discovered from their readings and named in Settings; batches pick one from
  a list.

## Alerts

- [ ] Tune the defaults on more real batches. Peak passed and looks finished were set from
      one batch's curve shape; airlock leaks and very slow ferments haven't been seen with
      alerts on yet.
- [ ] Maybe: per-yeast-strain temperature bands (now: app-wide + per batch).
- [ ] Maybe: an outside uptime check for the server itself (e.g. UptimeRobot on
      `/api/version`), since the server can't report its own outage.
- [ ] Maybe: a "possible leak" hint when a batch's bubble count runs far below what its OG
      and the learned bubble volume predict, so a bad seal is caught before the ABV
      estimate is trusted.

## ABV calibration model

Design, sources and settings: [DECISIONS.md](DECISIONS.md) "Calibrated bubble-volume ABV
model".

- [ ] **More calibration data.** One refractometer reading mid-fermentation and one near the
      end per batch is ideal; measure the OG every time (it's the biggest uncertainty).
      The first point (Oct 2026, 5 °Bx at 1.49 M bubbles) gave 0.280 mL/bubble against the
      0.3 mL default. Sensitivity on that batch: OG ±0.5 °Bx ≈ ±0.33% ABV; reading ±0.2 °Bx
      ≈ ±0.1%; WCF 1.00 vs 1.04 ≈ +0.2%.
- [ ] **Keep an odd batch's calibration to itself.** A batch whose readings fit is
      calibrated from its own readings (right for that batch), but its fit also joins the
      learned volume every other batch starts from. The second batch (Oct 2026) fitted
      2.1 mL/bubble against the first batch's 0.28 (a likely lid leak, or a different
      airlock fill), which would make the next batch read ~7× high until its first
      reading. Add a per-batch "don't share this calibration" switch (or drop outliers
      from the learned mean), separate from "Exclude from calibration", which would make
      the leaky batch itself fall back to the learned value.
- [ ] Calibrate the wort correction factor itself: a refractometer and a hydrometer reading
      of the same unfermented wort gives the WCF directly.
- [ ] Once the learned bubble volume is stable across a few batches, **simplify the UI**:
      hide most settings, keep OG and the occasional gravity reading.
- [ ] Maybe: estimate the OG from the recipe (extract kg × PPG + sugar) when it wasn't
      measured.
- [ ] Maybe: on a counter reset, count the new counter value as bubbles since the reboot
      instead of skipping it (`ReadingsService` and `buildGasSeries`). Negligible for ABV
      (~0.06% on the one reboot seen so far).

## Tests

- [ ] `BlynkService` (TCP framing, auth, ping timing) has no unit tests; it has been
      validated against the real device and `mock-device.js`.
- [ ] `fratoo-web` has no automated tests; screens are checked with headless-browser
      screenshots against a throwaway stack.
- Covered today: delta engine and stats (`readings`), window resolution and cascading
  delete (`batches`), the ABV model, the report, alert rules and the alert service.

## Nice to have

- [ ] An access layer in front of the public dashboard (e.g. Cloudflare Access) as a second
      login.
- [ ] Multi-user accounts, if more than one person ever needs to sign in (single admin by
      design today; see DECISIONS.md).
- [ ] Linux/macOS deploy script equivalent to `ProdRelease.bat`.
