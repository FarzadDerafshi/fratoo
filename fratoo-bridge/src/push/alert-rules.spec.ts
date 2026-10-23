import {
  RatePoint,
  formatDuration,
  meanOver,
  peakPassed,
  rollingMean,
  slowFor,
  smoothedPeak,
  temperatureChange,
} from './alert-rules';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A reading every 5 min for `hours`, rate from `rateAt(hour)`. */
function series(hours: number, rateAt: (h: number) => number): RatePoint[] {
  const out: RatePoint[] = [];
  for (let t = 5 * MIN; t <= hours * HOUR; t += 5 * MIN) out.push({ t, rate: rateAt(t / HOUR) });
  return out;
}

describe('alert rules', () => {
  it('rollingMean averages the preceding hour', () => {
    const pts = series(2, (h) => (h <= 1 ? 0 : 12));
    expect(rollingMean(pts).at(-1)!.rate).toBeCloseTo(12, 6);
    expect(rollingMean(pts)[11].rate).toBe(0);
  });

  it('smoothedPeak ignores a single spike and tiny peaks', () => {
    const spike = series(6, (h) => (Math.abs(h - 3) < 0.01 ? 200 : 5));
    expect(smoothedPeak(spike)!.rate).toBeLessThan(25); // one 200 among eleven 5s
    expect(smoothedPeak(series(6, () => 5))).toBeNull();
  });

  it('smoothedPeak finds the hourly peak', () => {
    const pts = series(48, (h) => 60 * Math.exp(-((h - 20) ** 2) / 50));
    const peak = smoothedPeak(pts)!;
    expect(peak.rate).toBeGreaterThan(55);
    expect(Math.abs(peak.t / HOUR - 20)).toBeLessThan(1);
  });

  it('slowFor needs every hour under the threshold and enough coverage', () => {
    const now = 30 * HOUR;
    expect(slowFor(series(30, (h) => (h < 6 ? 50 : 1)), now, 24, 2)).toBe(true);
    expect(slowFor(series(30, (h) => (h < 6 ? 50 : h > 20 && h < 21 ? 3 : 1)), now, 24, 2)).toBe(false);
    // Only the last 10 hours have readings: too little coverage.
    expect(slowFor(series(30, () => 1).filter((p) => p.t > 20 * HOUR), now, 24, 2)).toBe(false);
  });

  it('meanOver is null without enough hours of data', () => {
    expect(meanOver(series(3, () => 10), 3 * HOUR, 3)).toBeCloseTo(10, 6);
    expect(meanOver([], 3 * HOUR, 3)).toBeNull();
  });

  it('peakPassed waits until the recent mean is below half the peak, and the peak is old enough', () => {
    const rate = (h: number) => 60 * Math.exp(-((h - 20) ** 2) / 50);
    const pts = series(48, rate);
    expect(peakPassed(pts.filter((p) => p.t <= 22 * HOUR), 22 * HOUR, 50, 3)).toBeNull();
    const passed = peakPassed(pts.filter((p) => p.t <= 30 * HOUR), 30 * HOUR, 50, 3)!;
    expect(passed.recent).toBeLessThan(passed.peak.rate / 2);
  });

  it('temperatureChange needs two readings past the limit and clears with hysteresis', () => {
    const at = (cs: number[]) => cs.map((c, i) => ({ t: i * 5 * MIN, c }));
    expect(temperatureChange(at([23.8, 24.3]), 24, 'high')).toBeNull(); // one reading over
    expect(temperatureChange(at([24.2, 24.3]), 24, 'high')).toBe('enter');
    expect(temperatureChange(at([24.3, 23.8]), 24, 'high')).toBeNull(); // inside, but within 0.5
    expect(temperatureChange(at([24.3, 23.4]), 24, 'high')).toBe('exit');
    expect(temperatureChange(at([15.5, 15.8]), 16, 'low')).toBe('enter');
    expect(temperatureChange(at([15.8, 16.6]), 16, 'low')).toBe('exit');
  });

  it('formats durations', () => {
    expect(formatDuration(35 * MIN)).toBe('35m');
    expect(formatDuration(65 * MIN)).toBe('1h 5m');
    expect(formatDuration(51 * HOUR)).toBe('2d 3h');
  });
});
