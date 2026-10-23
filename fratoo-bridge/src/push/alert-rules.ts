// Pure rules behind the push alerts (AlertsService decides when to send).
// Times are epoch milliseconds; rates are V100 bubble rates in bpm, which
// are noisy reading to reading (±5–10%), so the rules look at hourly means
// rather than single readings.

export interface RatePoint {
  t: number;
  rate: number;
}

export interface TempPoint {
  t: number;
  c: number;
}

const HOUR_MS = 3_600_000;

/** A peak below this isn't a real fermentation peak (lag-phase noise, a tiny batch) — peak/finished/stalled stay quiet. */
export const MIN_PEAK_BPM = 10;

/** Hysteresis: a temperature alert clears only once the reading is this far back inside the limit. */
export const TEMP_HYSTERESIS_C = 0.5;

/** Share of the hours in a window that must have readings for a "for N hours" rule to count. */
const MIN_HOUR_COVERAGE = 0.8;

/** Mean over the preceding `windowMs` (the point itself included, the window start excluded) at each point. */
export function rollingMean(points: RatePoint[], windowMs = HOUR_MS): RatePoint[] {
  const out: RatePoint[] = [];
  let sum = 0;
  let j = 0;
  for (let i = 0; i < points.length; i++) {
    sum += points[i].rate;
    while (points[j].t <= points[i].t - windowMs) {
      sum -= points[j].rate;
      j++;
    }
    out.push({ t: points[i].t, rate: sum / (i - j + 1) });
  }
  return out;
}

/** Highest 1-hour mean rate, or null when it never reached MIN_PEAK_BPM. */
export function smoothedPeak(points: RatePoint[]): RatePoint | null {
  let peak: RatePoint | null = null;
  for (const p of rollingMean(points)) if (!peak || p.rate > peak.rate) peak = p;
  return peak && peak.rate >= MIN_PEAK_BPM ? peak : null;
}

/** Hourly mean rates for the last `hours` hours before `now` (newest last); null for an hour without readings. */
function hourlyMeans(points: RatePoint[], now: number, hours: number): (number | null)[] {
  const sums = new Array<number>(hours).fill(0);
  const counts = new Array<number>(hours).fill(0);
  const from = now - hours * HOUR_MS;
  for (const p of points) {
    if (p.t <= from || p.t > now) continue;
    const bucket = Math.min(hours - 1, Math.floor((p.t - from) / HOUR_MS));
    sums[bucket] += p.rate;
    counts[bucket]++;
  }
  return sums.map((s, i) => (counts[i] ? s / counts[i] : null));
}

function covered(means: (number | null)[]): boolean {
  return means.filter((m) => m !== null).length >= Math.ceil(means.length * MIN_HOUR_COVERAGE);
}

/** Every hour of the last `hours` (allowing a few without data) averaged below `bpm`. */
export function slowFor(points: RatePoint[], now: number, hours: number, bpm: number): boolean {
  const means = hourlyMeans(points, now, hours);
  return covered(means) && means.every((m) => m === null || m < bpm);
}

/** Mean rate over the last `hours`, or null when too few hours have readings. */
export function meanOver(points: RatePoint[], now: number, hours: number): number | null {
  const means = hourlyMeans(points, now, hours);
  if (!covered(means)) return null;
  const present = means.filter((m): m is number => m !== null);
  return present.reduce((a, b) => a + b, 0) / present.length;
}

export interface PeakPassed {
  peak: RatePoint;
  recent: number;
}

/**
 * The 1-hour peak is at least `hours` old and the mean of the last `hours`
 * is below (100 − dropPct)% of it.
 */
export function peakPassed(points: RatePoint[], now: number, dropPct: number, hours: number): PeakPassed | null {
  const peak = smoothedPeak(points);
  if (!peak || peak.t > now - hours * HOUR_MS) return null;
  const recent = meanOver(points, now, hours);
  if (recent === null || recent >= peak.rate * (1 - dropPct / 100)) return null;
  return { peak, recent };
}

export type TempChange = 'enter' | 'exit' | null;

/**
 * Temperature limit crossing from the latest readings: 'enter' once the last
 * two readings are past the limit, 'exit' once the latest is back inside it
 * by TEMP_HYSTERESIS_C (so it doesn't flap around the line).
 */
export function temperatureChange(temps: TempPoint[], limit: number, side: 'high' | 'low'): TempChange {
  if (temps.length === 0) return null;
  const past = (c: number) => (side === 'high' ? c > limit : c < limit);
  const last = temps[temps.length - 1].c;
  if (temps.length >= 2 && past(last) && past(temps[temps.length - 2].c)) return 'enter';
  const inside = side === 'high' ? last <= limit - TEMP_HYSTERESIS_C : last >= limit + TEMP_HYSTERESIS_C;
  return inside ? 'exit' : null;
}

/** "1h 5m", "35m", "2d 3h". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
