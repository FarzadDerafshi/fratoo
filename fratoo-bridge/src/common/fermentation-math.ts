// Shared fermentation math — ported from the WordPress plugin, where these
// constants and formulas were duplicated across assets/js/fratoo-chart.js
// (client-side stats) and includes/class-fratoo-report.php (report
// generation), with an explicit warning to keep them in sync manually.
// Here there is exactly one copy, used by both ReadingsService (live stats)
// and ReportsService (downloadable report) — see ProjectDocs/DECISIONS.md.
//
// The old fixed-1.7 mL-per-bubble ABV estimate that used to live here was
// replaced by the calibrated model in src/fermentation/abv-model.ts.

// PLAATO PCB self-heating correction (from PlaatoStructure.java) — see
// ProjectDocs/ARCHITECTURE.md "Real device pin mapping".
export const TEMP_CORRECTION_SLOPE = 0.9133;
export const TEMP_CORRECTION_INTERCEPT = 1.145;

export function correctTemperature(raw: number): number {
  return TEMP_CORRECTION_SLOPE * raw - TEMP_CORRECTION_INTERCEPT;
}

/** Sums only positive deltas across chronologically-sorted V100 values — a negative delta means a hardware reboot reset the counter, and must never produce a negative jump in the running total. Same rule as the per-row delta engine in ReadingsService.insertReading(). */
export function sumPositiveDeltas(valuesAsc: number[]): number {
  let total = 0;
  for (let i = 1; i < valuesAsc.length; i++) {
    const delta = valuesAsc[i] - valuesAsc[i - 1];
    if (delta > 0) total += delta;
  }
  return total;
}

/** Noise floor for "the yeast has started": a lone reading above it isn't enough, see sustainedStartIndex(). */
export const SUSTAINED_BPM = 1;

/**
 * Index of the first bubble rate that starts sustained bubbling: at least
 * SUSTAINED_BPM, with the next two readings still bubbling (rate > 0). A lone
 * spike — the headspace breathing with temperature — doesn't count. Judgment
 * call, not from the spec — see ProjectDocs/ROADMAP.md.
 *
 * At the end of the series fewer than two follow-up readings are accepted
 * (the report and ABV model show the latest state), unless `confirmed` is set
 * — then both must exist, so an alert never fires on a single reading.
 * Returns -1 when bubbling hasn't started.
 */
export function sustainedStartIndex(rates: number[], confirmed = false): number {
  for (let i = 0; i < rates.length; i++) {
    if (rates[i] < SUSTAINED_BPM) continue;
    if (confirmed && i + 2 >= rates.length) return -1;
    if (rates.slice(i + 1, i + 3).every((next) => next > 0)) return i;
  }
  return -1;
}
