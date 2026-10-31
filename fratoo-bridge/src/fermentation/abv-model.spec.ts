import {
  BatchModelInputs,
  GravityInput,
  TelemetryRow,
  abvFromCo2Out,
  abvFromGravity,
  bottlingEstimate,
  brixToSg,
  caloriesPer330ml,
  buildGasSeries,
  calibrate,
  co2OutFromAbv,
  dissolvedCo2GramsPerLiter,
  effectiveOg,
  estimateAt,
  estimateBatch,
  expectedAttenuationFor,
  fgFromAbv,
  gasAt,
  gasMolarVolumeL,
  gravityReadingToSg,
  learnBubbleVolume,
  rateScaleAt,
  resolveBubbleVolume,
  segmentAt,
  sgToBrix,
  terrillCubicFg,
} from './abv-model';
import { DEFAULT_FERMENTATION_SETTINGS, FermentationSettings } from './fermentation-settings';

const settings: FermentationSettings = { ...DEFAULT_FERMENTATION_SETTINGS };

function batch(overrides: Partial<BatchModelInputs> = {}): BatchModelInputs {
  return {
    volumeLiters: 24,
    ogValue: 1.045,
    ogUnit: 'sg',
    ogIncludesSugar: true,
    addedSugarG: null,
    bubbleVolumeMl: null,
    targetAbv: null,
    yeastAttenuation: null,
    primingSugarG: null,
    bottledVolumeL: null,
    ...overrides,
  };
}

/** Raw V101 value whose PCB-corrected temperature is `tempC` (inverse of correctTemperature). */
function rawTemp(tempC: number): number {
  return (tempC + 1.145) / 0.9133;
}

const T0 = new Date('2026-10-01T00:00:00Z').getTime();
const hour = (h: number) => new Date(T0 + h * 3_600_000);

/** Hourly V100/V101 telemetry: `bubblesPerHour` each hour, at `tempAt(h)` °C. */
function telemetry(hours: number, bubblesPerHour: (h: number) => number, tempAt: (h: number) => number = () => 20): TelemetryRow[] {
  const rows: TelemetryRow[] = [];
  let counter = 0;
  for (let h = 0; h <= hours; h++) {
    if (h > 0) counter += bubblesPerHour(h);
    rows.push({ pin: 'V101', value: rawTemp(tempAt(h)), recordedAt: hour(h) });
    rows.push({ pin: 'V100', value: counter, recordedAt: new Date(hour(h).getTime() + 1000) });
  }
  return rows;
}

describe('gravity conversions', () => {
  it('converts 20 °Bx to ~1.083 SG (the BYO/Brewer’s Friend reference value)', () => {
    expect(brixToSg(20)).toBeCloseTo(1.083, 3);
  });

  it('sgToBrix is the exact inverse of brixToSg', () => {
    for (const b of [0, 5, 10.58, 11, 20, 30]) expect(sgToBrix(brixToSg(b))).toBeCloseTo(b, 6);
  });

  it('11 °Bx with the default 1.04 WCF is ~1.042 SG', () => {
    expect(effectiveOg(batch({ ogValue: 11, ogUnit: 'brix' }), settings)).toBeCloseTo(1.0424, 3);
  });

  it('applies the published Terrill cubic coefficients', () => {
    // Hand-expanded: 1 − 0.0044993·10 + 0.011774·5 + 0.00027581·100 − 0.0012717·25 − 0.00000728·1000 + 0.000063293·125
    expect(terrillCubicFg(10, 5)).toBeCloseTo(1.0102971, 6);
  });

  it('Terrill gives a lower FG for a lower final Brix (more fermented)', () => {
    expect(terrillCubicFg(10.6, 4)).toBeLessThan(terrillCubicFg(10.6, 6));
  });

  it('refractometer readings need an OG; hydrometer readings do not', () => {
    const brix: GravityInput = { measuredAt: hour(1), value: 5.5, unit: 'brix' };
    expect(gravityReadingToSg(brix, null, settings)).toBeNull();
    expect(gravityReadingToSg(brix, 1.045, settings)).toBeCloseTo(terrillCubicFg(sgToBrix(1.045), 5.5 / 1.04), 9);
    expect(gravityReadingToSg({ measuredAt: hour(1), value: 1.012, unit: 'sg' }, null, settings)).toBe(1.012);
  });

  it('adds added-sugar gravity points only when the OG was measured before the sugar', () => {
    // 1.5 kg sucrose in 24 L at 383.9 pts·L/kg = 23.99 points.
    const sugar = { addedSugarG: 1500, ogValue: 1.02, ogUnit: 'sg' as const };
    expect(effectiveOg(batch({ ...sugar, ogIncludesSugar: true }), settings)).toBeCloseTo(1.02, 9);
    expect(effectiveOg(batch({ ...sugar, ogIncludesSugar: false }), settings)).toBeCloseTo(1.04399, 5);
  });
});

describe('ABV formulas', () => {
  it('standard: (OG − FG) × 131.25', () => {
    expect(abvFromGravity(1.05, 1.01, 'standard')).toBeCloseTo(5.25, 9);
  });

  it('alternate (Hall) agrees with standard at normal gravity and reads higher at high gravity', () => {
    expect(Math.abs(abvFromGravity(1.05, 1.01, 'alternate') - 5.25)).toBeLessThan(0.15);
    expect(abvFromGravity(1.1, 1.0, 'alternate')).toBeGreaterThan(abvFromGravity(1.1, 1.0, 'standard'));
  });

  it('fgFromAbv inverts both formulas', () => {
    for (const f of ['standard', 'alternate'] as const) {
      expect(fgFromAbv(1.045, abvFromGravity(1.045, 1.008, f), f)).toBeCloseTo(1.008, 6);
    }
  });
});

describe('gas physics', () => {
  it('molar volume is 22.414 L at 0 °C / 1 atm and ~24.2 L at 22 °C', () => {
    expect(gasMolarVolumeL(0, 101.325)).toBeCloseTo(22.414, 2);
    expect(gasMolarVolumeL(22, 101.325)).toBeCloseTo(24.22, 1);
  });

  it('residual CO₂ at 68 °F is ~0.862 volumes ≈ 1.70 g/L', () => {
    expect(dissolvedCo2GramsPerLiter(20) / 1.977).toBeCloseTo(0.862, 2);
  });

  it('warmer beer holds less CO₂', () => {
    expect(dissolvedCo2GramsPerLiter(24)).toBeLessThan(dissolvedCo2GramsPerLiter(18));
  });

  it('abvFromCo2Out and co2OutFromAbv are inverses', () => {
    const out = co2OutFromAbv(5, 21, 24, settings);
    expect(abvFromCo2Out(out, 21, 24, settings)).toBeCloseTo(5, 9);
  });

  it('dissolved CO₂ makes the same gas imply more alcohol', () => {
    const off = { ...settings, dissolvedCo2Enabled: false };
    expect(abvFromCo2Out(10, 20, 24, settings)).toBeGreaterThan(abvFromCo2Out(10, 20, 24, off));
  });
});

describe('buildGasSeries', () => {
  it('ignores the negative delta from a counter reset (reboot)', () => {
    const rows: TelemetryRow[] = [
      { pin: 'V100', value: 100, recordedAt: hour(0) },
      { pin: 'V100', value: 300, recordedAt: hour(1) }, // +200
      { pin: 'V100', value: 10, recordedAt: hour(2) }, // reboot
      { pin: 'V100', value: 60, recordedAt: hour(3) }, // +50
    ];
    expect(buildGasSeries(rows, settings).at(-1)!.cumulativeBubbles).toBe(250);
  });

  it('converts each interval at the temperature measured then', () => {
    const rows = telemetry(2, () => 1000, (h) => (h < 2 ? 10 : 30));
    const series = buildGasSeries(rows, settings);
    const expected = 1 / gasMolarVolumeL(10, 101.325) + 1 / gasMolarVolumeL(30, 101.325); // 1000 bubbles × 1 mL = 1 L each
    expect(series.at(-1)!.molesPerMl).toBeCloseTo(expected, 9);
  });

  it('uses the fixed temperature when configured', () => {
    const rows = telemetry(1, () => 1000, () => 35);
    const fixed = { ...settings, temperatureSource: 'fixed' as const, fixedTemperatureC: 20 };
    expect(buildGasSeries(rows, fixed).at(-1)!.molesPerMl).toBeCloseTo(1 / gasMolarVolumeL(20, 101.325), 9);
  });

  it('only counts the beer as saturated once bubbling is sustained', () => {
    // A stray bubble at hour 1, then ≥ 1 bpm from hour 4 on.
    const rows = telemetry(6, (h) => (h === 1 ? 3 : h >= 4 ? 600 : 0));
    const series = buildGasSeries(rows, settings);
    expect(series.map((p) => p.saturated)).toEqual([false, false, false, false, true, true, true]);
    expect(gasAt(series, new Date(T0 - 1), settings).saturated).toBe(false);
  });

  it('adds no dissolved-CO₂ head start for stray bubbles before fermentation', () => {
    const rows = telemetry(6, (h) => (h === 1 ? 9 : h >= 4 ? 600 : 0));
    const series = buildGasSeries(rows, settings);
    const stray = estimateAt(gasAt(series, hour(2), settings), 0.3, batch(), settings).abv!;
    const going = estimateAt(gasAt(series, hour(4.5), settings), 0.3, batch(), settings).abv!;
    expect(stray).toBeLessThan(0.001);
    expect(going).toBeGreaterThan(0.15); // the saturation head start kicks in
  });

  it('gasAt returns zero gas before the first point', () => {
    const series = buildGasSeries(telemetry(3, () => 500), settings);
    expect(gasAt(series, new Date(T0 - 1), settings).cumulativeBubbles).toBe(0);
    expect(gasAt(series, hour(2.5), settings).cumulativeBubbles).toBe(1000);
  });
});

describe('calibration', () => {
  // A synthetic batch fermented with a KNOWN bubble volume: gravity readings
  // are generated from the forward model, so calibrate() must recover it.
  const TRUE_ML = 0.35;
  const rows = telemetry(240, (h) => (h < 12 ? 0 : 6000 * Math.exp(-(h - 12) / 80)), (h) => 19 + (h % 24) / 12);
  const series = buildGasSeries(rows, settings);

  function readingAt(h: number, unit: 'sg' | 'brix' = 'sg'): GravityInput {
    const sg = estimateAt(gasAt(series, hour(h), settings), TRUE_ML, batch(), settings).estimatedSg!;
    if (unit === 'sg') return { id: h, measuredAt: hour(h), value: sg, unit };
    // Find the Brix reading that Terrill maps back to this SG.
    let lo = 0;
    let hi = 20;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (gravityReadingToSg({ measuredAt: hour(h), value: mid, unit: 'brix' }, 1.045, settings)! > sg) hi = mid;
      else lo = mid;
    }
    return { id: h, measuredAt: hour(h), value: (lo + hi) / 2, unit };
  }

  it('recovers the true bubble volume from a single hydrometer reading', () => {
    const fit = calibrate(batch(), [readingAt(120)], series, settings);
    expect(fit.usablePoints).toBe(1);
    expect(fit.fittedBubbleVolumeMl).toBeCloseTo(TRUE_ML, 6);
  });

  it('recovers it from refractometer (Brix) readings through the Terrill correction', () => {
    const fit = calibrate(batch(), [readingAt(60, 'brix'), readingAt(200, 'brix')], series, settings);
    expect(fit.fittedBubbleVolumeMl).toBeCloseTo(TRUE_ML, 4);
  });

  it('every usable point reports its implied volume', () => {
    const fit = calibrate(batch(), [readingAt(60), readingAt(200)], series, settings);
    for (const p of fit.points) expect(p.impliedBubbleVolumeMl).toBeCloseTo(TRUE_ML, 6);
  });

  it('skips excluded readings and early readings with too few bubbles, with a reason', () => {
    const early = readingAt(11.5); // before fermentation starts — 0 bubbles
    const excluded = { ...readingAt(100), excludeFromCalibration: true };
    const fit = calibrate(batch(), [early, excluded], series, settings);
    expect(fit.usablePoints).toBe(0);
    expect(fit.fittedBubbleVolumeMl).toBeNull();
    expect(fit.points.map((p) => p.reason)).toEqual(['Too few bubbles counted yet', 'Excluded by user']);
  });

  it('cannot calibrate without an OG', () => {
    const fit = calibrate(batch({ ogValue: null, ogUnit: null }), [readingAt(120)], series, settings);
    expect(fit.usablePoints).toBe(0);
    expect(fit.points[0].reason).toBe('Batch has no OG');
  });
});

describe('airlock segments', () => {
  // The same synthetic batch, but the airlock water was lowered at hour 60:
  // big bubbles before, small ones after. Readings come from the forward
  // model with both volumes, so calibrate() must recover each of them.
  const BEFORE_ML = 2.1;
  const AFTER_ML = 0.13;
  const change = [hour(60)];
  const rows = telemetry(240, (h) =>
    h < 12 ? 0 : (h <= 60 ? 300 : 4800) * Math.exp(-(h - 12) / 80),
  );
  const series = buildGasSeries(rows, settings, change);
  const truth = [BEFORE_ML, AFTER_ML];
  const readingAt = (h: number): GravityInput => ({
    id: h,
    measuredAt: hour(h),
    value: estimateAt(
      gasAt(series, hour(h), settings),
      truth,
      batch(),
      settings,
    ).estimatedSg!,
    unit: 'sg',
  });

  it('splits the gas by segment and still totals it', () => {
    const last = series.at(-1)!;
    expect(last.segment).toBe(1);
    expect(last.segmentBubbles[0] + last.segmentBubbles[1]).toBe(
      last.cumulativeBubbles,
    );
    expect(last.segmentMolesPerMl[0] + last.segmentMolesPerMl[1]).toBeCloseTo(
      last.molesPerMl,
      12,
    );
    expect(segmentAt(change, hour(59))).toBe(0);
    expect(segmentAt(change, hour(60))).toBe(1);
  });

  it('recovers both bubble volumes from one reading in each segment', () => {
    const fit = calibrate(
      batch(),
      [readingAt(48), readingAt(200)],
      series,
      settings,
      0.3,
      change,
    );
    expect(fit.segments!.map((seg) => seg.fittedBubbleVolumeMl)).toEqual([
      expect.closeTo(BEFORE_ML, 6),
      expect.closeTo(AFTER_ML, 6),
    ]);
    expect(fit.points.map((p) => p.impliedBubbleVolumeMl)).toEqual([
      expect.closeTo(BEFORE_ML, 6),
      expect.closeTo(AFTER_ML, 6),
    ]);
    // The airlock as it was left is what the batch shares.
    expect(fit.fittedBubbleVolumeMl).toBeCloseTo(AFTER_ML, 6);
    expect(fit.fittedPoints).toBe(1);
  });

  it('a single volume across the change misfits the early reading badly', () => {
    const one = calibrate(
      batch(),
      [readingAt(48), readingAt(200)],
      series,
      settings,
    );
    const [early] = estimateBatch(
      batch(),
      rows,
      [readingAt(48), readingAt(200)],
      null,
      settings,
    ).calibration.points;
    expect(one.fittedBubbleVolumeMl).not.toBeCloseTo(AFTER_ML, 2);
    // Least squares follows the late, larger-signal reading, so the early one under-reads by a third or more (as on the real batch).
    expect(early.predictedAbv! / early.measuredAbv!).toBeLessThan(0.7);
  });

  it('with segments, the estimate matches every reading', () => {
    const est = estimateBatch(
      batch(),
      rows,
      [readingAt(48), readingAt(200)],
      null,
      settings,
      change,
    );
    for (const p of est.calibration.points)
      expect(p.predictedAbv).toBeCloseTo(p.measuredAbv!, 6);
    expect(est.bubbleVolumeMl).toBeCloseTo(AFTER_ML, 6);
    expect(est.airlockSegments.map((seg) => seg.source)).toEqual([
      'batch-calibration',
      'batch-calibration',
    ]);
    expect(est.warnings.join(' ')).not.toMatch(/airlock change/);
  });

  it('a segment without a reading of its own uses the learned volume, and warns', () => {
    const est = estimateBatch(
      batch(),
      rows,
      [readingAt(48)],
      0.28,
      settings,
      change,
    );
    expect(
      est.airlockSegments.map((seg) => [seg.bubbleVolumeMl, seg.source]),
    ).toEqual([
      [expect.closeTo(BEFORE_ML, 6), 'batch-calibration'],
      [0.28, 'learned'],
    ]);
    expect(est.calibration.fittedBubbleVolumeMl).toBeCloseTo(BEFORE_ML, 6);
    expect(est.warnings.join(' ')).toMatch(/since the last airlock change/);
  });

  it('a reading taken right at the change, before any new bubbles, cannot calibrate the new segment', () => {
    const fit = calibrate(
      batch(),
      [{ ...readingAt(48), measuredAt: hour(60) }],
      series,
      settings,
      0.3,
      change,
    );
    expect(fit.points[0].reason).toBe(
      'No bubbles counted since the airlock change',
    );
  });

  it('puts every rate into bubbles of the current size', () => {
    expect(rateScaleAt(truth, change, hour(10))).toBeCloseTo(
      BEFORE_ML / AFTER_ML,
      9,
    );
    expect(rateScaleAt(truth, change, hour(100))).toBe(1);
    expect(rateScaleAt([0.3], [], hour(10))).toBe(1);
  });
});

describe('bubble volume resolution', () => {
  const fit = (ml: number | null) => ({ points: [], fittedBubbleVolumeMl: ml, usablePoints: ml ? 1 : 0 });

  it('override → own fit → learned → default', () => {
    expect(resolveBubbleVolume(batch({ bubbleVolumeMl: 0.5 }), fit(0.4), 0.3, settings)).toMatchObject({ bubbleVolumeMl: 0.5, source: 'batch-override' });
    expect(resolveBubbleVolume(batch(), fit(0.4), 0.3, settings)).toMatchObject({ bubbleVolumeMl: 0.4, source: 'batch-calibration' });
    expect(resolveBubbleVolume(batch(), fit(null), 0.33, settings)).toMatchObject({ bubbleVolumeMl: 0.33, source: 'learned' });
    expect(resolveBubbleVolume(batch(), fit(null), null, settings)).toMatchObject({ bubbleVolumeMl: 0.3, source: 'default' });
  });

  it("'default-only' mode ignores calibration but still honours an override", () => {
    const s = { ...settings, calibrationMode: 'default-only' as const };
    expect(resolveBubbleVolume(batch(), fit(0.4), 0.33, s).source).toBe('default');
    expect(resolveBubbleVolume(batch({ bubbleVolumeMl: 0.5 }), fit(0.4), 0.33, s).source).toBe('batch-override');
  });

  it('learns a point-weighted mean across batches', () => {
    expect(learnBubbleVolume([{ bubbleVolumeMl: 0.3, points: 1 }, { bubbleVolumeMl: 0.4, points: 3 }])).toBeCloseTo(0.375, 9);
    expect(learnBubbleVolume([])).toBeNull();
  });
});

describe('estimateBatch', () => {
  // Shape of the first production batch: ~1.38M bubbles in 24 L at ~22 °C.
  const production = telemetry(284, (h) => (h < 24 ? 0 : 5300), () => 22);

  it('no longer reports ~25% ABV for the first production batch', () => {
    const est = estimateBatch(batch({ ogValue: 11, ogUnit: 'brix' }), production, [], null, settings);
    expect(est.bubbleVolumeSource).toBe('default');
    expect(est.abv!).toBeGreaterThan(3.5);
    expect(est.abv!).toBeLessThan(5.5);
    expect(est.abvCapped).toBe(false);
  });

  it('caps the ABV at what the OG allows and says so', () => {
    const est = estimateBatch(batch({ ogValue: 1.04, bubbleVolumeMl: 1.7 }), production, [], null, settings);
    expect(est.abvCapped).toBe(true);
    expect(est.abv).toBeCloseTo(abvFromGravity(1.04, settings.minPossibleFg, 'standard'), 9);
    expect(est.warnings.some((w) => w.includes('capped'))).toBe(true);
  });

  it('estimated SG and attenuation are consistent with the ABV', () => {
    const est = estimateBatch(batch(), production, [], null, settings);
    expect(abvFromGravity(1.045, est.estimatedSg!, 'standard')).toBeCloseTo(est.abv!, 6);
    expect(est.apparentAttenuation).toBeCloseTo((1.045 - est.estimatedSg!) / 0.045, 9);
  });

  it('a perfectly calibrated reading has zero residual', () => {
    const series = buildGasSeries(production, settings);
    const sg = estimateAt(gasAt(series, hour(150), settings), 0.32, batch(), settings).estimatedSg!;
    const est = estimateBatch(batch(), production, [{ measuredAt: hour(150), value: sg, unit: 'sg' }], null, settings);
    expect(est.bubbleVolumeSource).toBe('batch-calibration');
    expect(est.bubbleVolumeMl).toBeCloseTo(0.32, 6);
    expect(est.calibration.points[0].predictedSg).toBeCloseTo(sg, 6);
  });

  it('expected ABV comes from the OG and the configured attenuation', () => {
    const est = estimateBatch(batch(), production, [], null, settings);
    expect(est.expectedAbv).toBeCloseTo(0.045 * 0.75 * 131.25, 9);
  });

  it('max ABV is the OG fermented down to the lowest possible FG', () => {
    const est = estimateBatch(batch(), production, [], null, settings);
    expect(est.maxAbv).toBeCloseTo((1.045 - settings.minPossibleFg) * 131.25, 9);
    expect(estimateBatch(batch({ ogValue: null, ogUnit: null }), production, [], null, settings).maxAbv).toBeNull();
  });

  it('without a volume: no ABV, and a warning', () => {
    const est = estimateBatch(batch({ volumeLiters: null }), production, [], null, settings);
    expect(est.abv).toBeNull();
    expect(est.warnings[0]).toMatch(/volume/);
  });
});

describe('expected attenuation', () => {
  it('uses the default attenuation for an all-malt batch', () => {
    expect(expectedAttenuationFor(batch(), 1.045, settings)).toEqual({ attenuation: 0.75, sugarShare: 0 });
  });

  it("prefers the yeast strain's attenuation", () => {
    expect(expectedAttenuationFor(batch({ yeastAttenuation: 80 }), 1.045, settings).attenuation).toBeCloseTo(0.8, 9);
  });

  it('counts the added sugar share at 100%', () => {
    // 1.5 kg in 24 L ≈ 24 points of a 48-point OG → half sugar.
    const og = 1 + (2 * 1.5 * settings.sugarPointsPerKgPerLiter) / 24 / 1000;
    const { attenuation, sugarShare } = expectedAttenuationFor(batch({ addedSugarG: 1500 }), og, settings);
    expect(sugarShare).toBeCloseTo(0.5, 9);
    expect(attenuation).toBeCloseTo(0.75 * 0.5 + 0.5, 9);
  });

  it('feeds the expected ABV', () => {
    const rows = telemetry(48, () => 1000);
    const plain = estimateBatch(batch(), rows, [], null, settings);
    const sugary = estimateBatch(batch({ addedSugarG: 1000 }), rows, [], null, settings);
    expect(sugary.expectedAttenuation!).toBeGreaterThan(plain.expectedAttenuation!);
    expect(sugary.expectedAbv!).toBeGreaterThan(plain.expectedAbv!);
  });
});

describe('bottling', () => {
  it('is unknown without priming sugar', () => {
    expect(bottlingEstimate(batch(), 4.5, 20, settings)).toBeNull();
  });

  it('adds the priming sugar as alcohol and carbonation', () => {
    // 6 g/L of sucrose ≈ 2.3 points ≈ 0.30% ABV and ≈ 1.56 volumes on top of what's dissolved.
    const b = bottlingEstimate(batch({ primingSugarG: 132, bottledVolumeL: 22 }), 4.5, 20, settings)!;
    expect(b.primingAbv).toBeCloseTo(6 * 0.3839 * 0.13125, 6);
    expect(b.bottledAbv).toBeCloseTo(4.5 + b.primingAbv, 9);
    expect(b.co2Volumes).toBeCloseTo(dissolvedCo2GramsPerLiter(20) / 1.977 + (6 * 0.5146) / 1.977, 6);
  });

  it('falls back to the batch volume', () => {
    const a = bottlingEstimate(batch({ primingSugarG: 144 }), 4.5, 20, settings)!;
    const b = bottlingEstimate(batch({ primingSugarG: 144, bottledVolumeL: 24 }), 4.5, 20, settings)!;
    expect(a).toEqual(b);
  });
});

describe('bottling and calories in the estimate', () => {
  it('stay empty until bubbles are counted', () => {
    const est = estimateBatch(batch({ primingSugarG: 140 }), telemetry(2, () => 0), [], null, settings);
    expect(est.bottling).toBeNull();
    expect(est.caloriesPer330ml).toBeNull();
  });

  it('are filled in once fermenting', () => {
    const est = estimateBatch(batch({ primingSugarG: 140 }), telemetry(48, () => 5000), [], null, settings);
    expect(est.bottling!.bottledAbv).toBeGreaterThan(est.abv!);
    expect(est.caloriesPer330ml).toBeGreaterThan(0);
  });
});

describe('calories', () => {
  it('a 1.045 → 1.010 beer is about 140 kcal per 330 mL', () => {
    const kcal = caloriesPer330ml(1.045, 1.01, abvFromGravity(1.045, 1.01, 'standard'));
    expect(kcal).toBeGreaterThan(130);
    expect(kcal).toBeLessThan(150);
  });
});
