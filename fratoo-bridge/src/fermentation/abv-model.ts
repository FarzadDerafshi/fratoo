// Calibrated bubble-volume ABV model. Pure functions only — no DB, no Nest —
// so every step is unit-testable in isolation (abv-model.spec.ts).
//
// Chain: airlock bubbles → CO₂ that left through the airlock (moles, via the
// ideal gas law at the measured temperature) → + CO₂ still dissolved in the
// beer → ethanol (Balling mass ratio) → ABV → estimated current gravity.
//
// The one unknown — how much gas one bubble carries — is learned from
// occasional hydrometer/refractometer readings: each reading pins down the
// true ABV at a moment in time, and with it the bubble volume that would
// have produced it. Formula sources and the reasoning behind each step:
// ProjectDocs/DECISIONS.md "Calibrated bubble-volume ABV model".
//
// The bubble volume depends on the airlock's water level, so an "airlock
// changed" event splits a batch into segments, each with its own volume
// (DECISIONS.md "Airlock segments"). Without such events a batch is one
// segment and everything below reduces to a single volume.

import { correctTemperature, sustainedStartIndex } from '../common/fermentation-math';
import { AbvFormula, FermentationSettings } from './fermentation-settings';

export const CO2_MOLAR_MASS = 44.01; // g/mol
export const ETHANOL_DENSITY = 0.789; // g/mL
export const CO2_DENSITY_STP = 1.977; // g/L — "volumes of CO₂" are defined at 0 °C, 1 atm
const GAS_CONSTANT = 8.314462618; // J/(mol·K)

export type GravityUnit = 'sg' | 'brix';

export interface TelemetryRow {
  pin: string;
  value: number;
  recordedAt: Date;
}

export interface GravityInput {
  id?: number;
  measuredAt: Date;
  value: number;
  unit: GravityUnit;
  excludeFromCalibration?: boolean;
}

export interface BatchModelInputs {
  volumeLiters: number | null;
  ogValue: number | null;
  ogUnit: GravityUnit | null;
  ogIncludesSugar: boolean;
  addedSugarG: number | null;
  /** Manual per-batch bubble volume — wins over everything when set. */
  bubbleVolumeMl: number | null;
  targetAbv: number | null;
  /** The strain's typical apparent attenuation on malt wort, percent — overrides settings.expectedAttenuation. */
  yeastAttenuation: number | null;
  /** Priming sugar (g, sucrose) and the volume it went into (falls back to volumeLiters). */
  primingSugarG: number | null;
  bottledVolumeL: number | null;
}

// ---------------------------------------------------------------------------
// Gravity conversions
// ---------------------------------------------------------------------------

/** Brix → SG, the BYO equation as used by Brewer's Friend. Pass Brix already divided by the wort correction factor. */
export function brixToSg(brix: number): number {
  return 1 + brix / (258.6 - (brix / 258.2) * 227.1);
}

/** SG → Brix, the exact inverse of brixToSg() (numerically, so the two can never drift apart). */
export function sgToBrix(sg: number): number {
  return bisect((b) => brixToSg(b) - sg, -10, 60);
}

/**
 * Sean Terrill's cubic: true FG from a refractometer reading taken after
 * fermentation started (alcohol skews the refraction). Both inputs are Brix
 * already divided by the wort correction factor.
 */
export function terrillCubicFg(originalBrix: number, finalBrix: number): number {
  const ob = originalBrix;
  const fb = finalBrix;
  return (
    1 -
    0.0044993 * ob +
    0.011774 * fb +
    0.00027581 * ob ** 2 -
    0.0012717 * fb ** 2 -
    0.00000728 * ob ** 3 +
    0.000063293 * fb ** 3
  );
}

export function abvFromGravity(og: number, fg: number, formula: AbvFormula): number {
  if (formula === 'alternate') {
    // Michael L. Hall, "Brew by the Numbers".
    return ((76.08 * (og - fg)) / (1.775 - og)) * (fg / 0.794);
  }
  return (og - fg) * 131.25;
}

/** Inverse of abvFromGravity(): the gravity that ABV implies for this OG. */
export function fgFromAbv(og: number, abv: number, formula: AbvFormula): number {
  return bisect((fg) => abvFromGravity(og, fg, formula) - abv, 0.9, og);
}

/**
 * The batch's OG as SG, or null when none was entered. A Brix OG is read
 * before any alcohol exists, so it needs only the wort correction factor,
 * not Terrill. When the OG was measured before the sugar went in, the
 * sugar's gravity points are added on top.
 */
export function effectiveOg(batch: BatchModelInputs, settings: FermentationSettings): number | null {
  if (batch.ogValue === null || batch.ogUnit === null) return null;

  let og = batch.ogUnit === 'brix' ? brixToSg(batch.ogValue / settings.wortCorrectionFactor) : batch.ogValue;

  if (!batch.ogIncludesSugar && batch.addedSugarG && batch.volumeLiters && batch.volumeLiters > 0) {
    const points = ((batch.addedSugarG / 1000) * settings.sugarPointsPerKgPerLiter) / batch.volumeLiters;
    og += points / 1000;
  }
  return og;
}

/**
 * A gravity reading as true SG. Hydrometer (SG) readings are taken as-is;
 * refractometer (Brix) readings need the OG for Terrill's alcohol
 * correction, so they return null without one.
 */
export function gravityReadingToSg(reading: GravityInput, og: number | null, settings: FermentationSettings): number | null {
  if (reading.unit === 'sg') return reading.value;
  if (og === null) return null;
  const finalBrix = reading.value / settings.wortCorrectionFactor;
  return terrillCubicFg(sgToBrix(og), finalBrix);
}

// ---------------------------------------------------------------------------
// Gas physics
// ---------------------------------------------------------------------------

/** Litres per mole of an ideal gas — 22.4 at 0 °C / 1 atm, ~24.2 at 22 °C. */
export function gasMolarVolumeL(tempC: number, pressureKpa: number): number {
  return (GAS_CONSTANT * (tempC + 273.15)) / (pressureKpa * 1000) * 1000;
}

/**
 * CO₂ that stays dissolved in fermented beer at a given temperature (g/L).
 * Residual-CO₂ fit used by priming calculators (input in °F, output in
 * volumes), converted to grams via the density of CO₂ at STP.
 */
export function dissolvedCo2GramsPerLiter(tempC: number): number {
  const f = (tempC * 9) / 5 + 32;
  const volumes = 3.0378 - 0.050062 * f + 0.00026555 * f ** 2;
  return Math.max(volumes, 0) * CO2_DENSITY_STP;
}

// ---------------------------------------------------------------------------
// Expected attenuation, bottling, calories
// ---------------------------------------------------------------------------

/** Grams of CO₂ per gram of sucrose fully fermented: C₁₂H₂₂O₁₁ + H₂O → 4 C₂H₅OH + 4 CO₂ (176 / 342). */
const CO2_PER_SUCROSE = 0.5146;

/**
 * Apparent attenuation to expect from this batch. Yeast strains quote
 * attenuation on malt wort, which always keeps some unfermentable sugars —
 * table sugar ferments out completely. So the share of the OG's gravity
 * points that came from added sugar is counted at 100%, the rest at the
 * strain's figure (or the app-wide default).
 */
export function expectedAttenuationFor(
  batch: BatchModelInputs,
  og: number | null,
  settings: FermentationSettings,
): { attenuation: number; sugarShare: number } {
  const base = batch.yeastAttenuation !== null ? batch.yeastAttenuation / 100 : settings.expectedAttenuation;
  const ogPoints = og !== null ? (og - 1) * 1000 : 0;
  const sugarPoints =
    batch.addedSugarG && batch.volumeLiters && batch.volumeLiters > 0
      ? ((batch.addedSugarG / 1000) * settings.sugarPointsPerKgPerLiter) / batch.volumeLiters
      : 0;
  const sugarShare = ogPoints > 0 ? Math.min(1, sugarPoints / ogPoints) : 0;
  return { attenuation: base * (1 - sugarShare) + sugarShare, sugarShare };
}

export interface BottlingEstimate {
  /** Alcohol the priming sugar adds once it ferments out in the bottle. */
  primingAbv: number;
  bottledAbv: number;
  /** Carbonation in volumes of CO₂: what stayed dissolved at `tempC` plus what the priming sugar makes. */
  co2Volumes: number;
}

/** Null until priming sugar and a volume are known. */
export function bottlingEstimate(
  batch: BatchModelInputs,
  abv: number | null,
  tempC: number,
  settings: FermentationSettings,
): BottlingEstimate | null {
  const volume = batch.bottledVolumeL ?? batch.volumeLiters;
  if (abv === null || !batch.primingSugarG || !volume || volume <= 0) return null;
  const gramsPerLiter = batch.primingSugarG / volume;
  const points = (gramsPerLiter / 1000) * settings.sugarPointsPerKgPerLiter;
  const primingAbv = (points / 1000) * 131.25;
  const co2Volumes = (dissolvedCo2GramsPerLiter(tempC) + gramsPerLiter * CO2_PER_SUCROSE) / CO2_DENSITY_STP;
  return { primingAbv, bottledAbv: abv + primingAbv, co2Volumes };
}

/** SG → degrees Plato (the usual brewing approximation). */
function sgToPlato(sg: number): number {
  return 259 - 259 / sg;
}

/**
 * kcal in a 330 mL serving, from the standard homebrew formula (ASBC):
 * kcal per 12 fl oz = (6.9 × ABW + 4.0 × (RE − 0.1)) × FG × 3.55, where
 * RE (real extract, °P) = 0.1808 × OE + 0.8192 × AE.
 */
export function caloriesPer330ml(og: number, fg: number, abv: number): number {
  const realExtract = 0.1808 * sgToPlato(og) + 0.8192 * sgToPlato(fg);
  const abw = (0.79 * abv) / fg;
  const per12oz = (6.9 * abw + 4.0 * (realExtract - 0.1)) * fg * 3.55;
  return (per12oz * 330) / 354.88;
}

// ---------------------------------------------------------------------------
// Bubble series
// ---------------------------------------------------------------------------

export interface GasPoint {
  time: Date;
  cumulativeBubbles: number;
  /** Σ Δbubbles / molar volume at that interval's temperature — multiply by bubble volume (mL) to get moles of CO₂ out. */
  molesPerMl: number;
  /** The airlock segment this point falls in (0 before the first airlock change). */
  segment: number;
  /** molesPerMl and cumulativeBubbles split by segment — index k pairs with segment k's bubble volume. */
  segmentMolesPerMl: number[];
  segmentBubbles: number[];
  tempC: number;
  /**
   * Sustained bubbling has started (sustainedStartIndex(), the same rule as
   * the report's lag phase) — only from then on is the beer taken as
   * saturated with CO₂. A stray bubble before that is the headspace
   * breathing with temperature, not the yeast.
   */
  saturated: boolean;
}

/** Index of the airlock segment a moment falls in, given the sorted times each later segment starts. */
export function segmentAt(segmentStarts: Date[], t: Date): number {
  let k = 0;
  while (k < segmentStarts.length && segmentStarts[k].getTime() <= t.getTime()) k++;
  return k;
}

/**
 * Walks V100/V101 chronologically, accumulating bubbles (positive deltas
 * only — a negative delta is a counter reset after a reboot, same rule as
 * ReadingsService) and converting each interval's bubbles to gas at the
 * temperature measured at the time, not a single fixed 22.4 L/mol.
 * `segmentStarts` (sorted) are the airlock changes: an interval's bubbles
 * count toward the segment its closing reading falls in.
 */
export function buildGasSeries(rows: TelemetryRow[], settings: FermentationSettings, segmentStarts: Date[] = []): GasPoint[] {
  const sorted = rows.slice().sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  const segmentMolesPerMl = new Array<number>(segmentStarts.length + 1).fill(0);
  const segmentBubbles = new Array<number>(segmentStarts.length + 1).fill(0);

  const firstTemp = sorted.find((r) => r.pin === 'V101');
  let tempC =
    settings.temperatureSource === 'fixed' || !firstTemp ? settings.fixedTemperatureC : correctTemperature(firstTemp.value);

  const points: GasPoint[] = [];
  const rates: number[] = [];
  let prevCounter: number | null = null;
  let prevTime: number | null = null;
  let cumulativeBubbles = 0;
  let molesPerMl = 0;

  for (const row of sorted) {
    if (row.pin === 'V101') {
      if (settings.temperatureSource === 'measured' && isFinite(row.value)) tempC = correctTemperature(row.value);
      continue;
    }
    if (row.pin !== 'V100') continue;

    const segment = segmentAt(segmentStarts, row.recordedAt);
    let rate = 0;
    if (prevCounter !== null && prevTime !== null) {
      const delta = row.value - prevCounter;
      if (delta > 0) {
        const moles = delta / 1000 / gasMolarVolumeL(tempC, settings.pressureKpa);
        cumulativeBubbles += delta;
        molesPerMl += moles;
        segmentBubbles[segment] += delta;
        segmentMolesPerMl[segment] += moles;
        const minutes = (row.recordedAt.getTime() - prevTime) / 60_000;
        rate = minutes > 0 ? delta / minutes : 0;
      }
    }
    prevCounter = row.value;
    prevTime = row.recordedAt.getTime();
    rates.push(rate);
    points.push({
      time: row.recordedAt,
      cumulativeBubbles,
      molesPerMl,
      segment,
      segmentMolesPerMl: segmentMolesPerMl.slice(),
      segmentBubbles: segmentBubbles.slice(),
      tempC,
      saturated: false,
    });
  }

  const start = sustainedStartIndex(rates);
  if (start >= 0) for (let i = start; i < points.length; i++) points[i].saturated = true;
  return points;
}

/** The series state at time t (last point at or before it). Before the first point: zero gas, first known temperature. */
export function gasAt(series: GasPoint[], t: Date, settings: FermentationSettings): GasPoint {
  let found: GasPoint | null = null;
  for (const p of series) {
    if (p.time.getTime() > t.getTime()) break;
    found = p;
  }
  if (found) return found;
  return {
    time: t,
    cumulativeBubbles: 0,
    molesPerMl: 0,
    segment: 0,
    segmentMolesPerMl: [],
    segmentBubbles: [],
    tempC: series[0]?.tempC ?? settings.fixedTemperatureC,
    saturated: false,
  };
}

/** One bubble volume per segment; a single number (or a list shorter than the segments) repeats its last value. */
export type BubbleVolumes = number | number[];

function volumeOf(volumes: BubbleVolumes, segment: number): number {
  if (typeof volumes === 'number') return volumes;
  return volumes[Math.min(segment, volumes.length - 1)];
}

/** Moles of CO₂ that left through the airlock up to this point, each segment's bubbles at its own volume. */
export function gasMolesOut(gas: GasPoint, volumes: BubbleVolumes): number {
  if (typeof volumes === 'number') return gas.molesPerMl * volumes;
  return gas.segmentMolesPerMl.reduce((sum, m, k) => sum + m * volumeOf(volumes, k), 0);
}

function co2LitersOut(gas: GasPoint, volumes: BubbleVolumes): number {
  if (typeof volumes === 'number') return (gas.cumulativeBubbles * volumes) / 1000;
  return gas.segmentBubbles.reduce((sum, b, k) => sum + b * volumeOf(volumes, k), 0) / 1000;
}

// ---------------------------------------------------------------------------
// CO₂ ↔ ABV
// ---------------------------------------------------------------------------

function dissolvedMoles(tempC: number, volumeLiters: number, settings: FermentationSettings): number {
  if (!settings.dissolvedCo2Enabled) return 0;
  return (dissolvedCo2GramsPerLiter(tempC) * volumeLiters) / CO2_MOLAR_MASS;
}

/**
 * ABV from the moles of CO₂ that left through the airlock. Dissolved CO₂ is
 * only added once the beer is `saturated` — sustained bubbling means it
 * already holds all it can (a stray bubble before that doesn't). Using the *current* temperature's saturation makes
 * temperature-driven outgassing cancel out: warming releases bubbles, but
 * lowers the dissolved term by the same amount.
 */
export function abvFromCo2Out(
  outMoles: number,
  tempC: number,
  volumeLiters: number,
  settings: FermentationSettings,
  saturated = true,
): number {
  if (outMoles <= 0) return 0;
  const producedMoles = outMoles + (saturated ? dissolvedMoles(tempC, volumeLiters, settings) : 0);
  const ethanolGrams = (producedMoles * CO2_MOLAR_MASS) / settings.co2PerEthanolMass;
  return (ethanolGrams / ETHANOL_DENSITY / (volumeLiters * 1000)) * 100;
}

/** Inverse of abvFromCo2Out(): CO₂ that must have left through the airlock for this ABV (can be ≤ 0 early on). */
export function co2OutFromAbv(abv: number, tempC: number, volumeLiters: number, settings: FermentationSettings): number {
  const ethanolGrams = (abv / 100) * volumeLiters * 1000 * ETHANOL_DENSITY;
  const producedMoles = (ethanolGrams * settings.co2PerEthanolMass) / CO2_MOLAR_MASS;
  return producedMoles - dissolvedMoles(tempC, volumeLiters, settings);
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export interface CalibrationPoint {
  id?: number;
  measuredAt: Date;
  value: number;
  unit: GravityUnit;
  sg: number | null;
  measuredAbv: number | null;
  cumulativeBubbles: number;
  /** Airlock segment the reading was taken in. */
  segment: number;
  /** Bubble volume of the reading's own segment that would explain it, given the volumes of earlier segments. */
  impliedBubbleVolumeMl: number | null;
  usable: boolean;
  /** Why the point can't calibrate, when it can't. */
  reason: string | null;
  /** Filled in by estimateBatch() with the final bubble volumes. */
  predictedSg: number | null;
  predictedAbv: number | null;
}

export interface SegmentFit {
  /** When the segment began: null for the first, else the airlock change that started it. */
  startsAt: Date | null;
  /** Fitted from the readings taken in this segment, or null when it has none. */
  fittedBubbleVolumeMl: number | null;
  usablePoints: number;
}

export interface CalibrationFit {
  points: CalibrationPoint[];
  /**
   * The latest segment's fit that exists: what the batch caches and shares
   * with other batches (the airlock as it was left). For a batch without
   * airlock changes this is simply the batch's fit.
   */
  fittedBubbleVolumeMl: number | null;
  /** Usable readings across the batch. */
  usablePoints: number;
  /** One per airlock segment; absent means a single segment matching the fields above. */
  segments?: SegmentFit[];
  /** Usable readings behind fittedBubbleVolumeMl: its weight in the learned volume. */
  fittedPoints?: number;
}

/**
 * Each gravity reading pins down the CO₂ that must have left by then.
 * With one segment that is a least-squares fit through the origin, which
 * naturally weights later (larger-signal) readings more than early ones.
 * With airlock changes, the gas is a sum over segments (moles-per-mL of each
 * segment × its volume), solved jointly for every segment that has a
 * reading of its own; a segment without one takes `fallbackBubbleVolumeMl`
 * (learned from other batches, or the default).
 */
export function calibrate(
  batch: BatchModelInputs,
  readings: GravityInput[],
  series: GasPoint[],
  settings: FermentationSettings,
  fallbackBubbleVolumeMl = settings.defaultBubbleVolumeMl,
  segmentStarts: Date[] = [],
): CalibrationFit {
  const og = effectiveOg(batch, settings);
  const volume = batch.volumeLiters && batch.volumeLiters > 0 ? batch.volumeLiters : null;
  const segmentCount = segmentStarts.length + 1;

  const rows: CalibrationRow[] = [];
  const points = readings
    .slice()
    .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime())
    .map((r): CalibrationPoint => {
      const gas = gasAt(series, r.measuredAt, settings);
      const sg = gravityReadingToSg(r, og, settings);
      const measuredAbv = og !== null && sg !== null ? abvFromGravity(og, sg, settings.abvFormula) : null;

      const point: CalibrationPoint = {
        id: r.id,
        measuredAt: r.measuredAt,
        value: r.value,
        unit: r.unit,
        sg,
        measuredAbv,
        cumulativeBubbles: gas.cumulativeBubbles,
        segment: segmentAt(segmentStarts, r.measuredAt),
        impliedBubbleVolumeMl: null,
        usable: false,
        reason: null,
        predictedSg: null,
        predictedAbv: null,
      };

      if (og === null) return { ...point, reason: 'Batch has no OG' };
      if (volume === null) return { ...point, reason: 'Batch has no volume' };
      if (sg === null || measuredAbv === null) return { ...point, reason: 'Gravity could not be converted' };

      const outMoles = co2OutFromAbv(measuredAbv, gas.tempC, volume, settings);

      if (r.excludeFromCalibration) point.reason = 'Excluded by user';
      else if (gas.cumulativeBubbles < settings.minCalibrationBubbles) point.reason = 'Too few bubbles counted yet';
      else if (outMoles <= 0) point.reason = 'Gravity drop too small to measure past dissolved CO₂';
      else if (!((gas.segmentMolesPerMl[point.segment] ?? 0) > 0)) point.reason = 'No bubbles counted since the airlock change';
      else point.usable = true;

      // The implied volume needs the fitted volumes of earlier segments, so it's filled in below.
      rows.push({ point, gas, outMoles });
      return point;
    });

  const usable = rows.filter((r) => r.point.usable);
  const volumes = solveSegmentVolumes(usable, segmentCount, fallbackBubbleVolumeMl);

  for (const { point, gas, outMoles } of rows) {
    const own = gas.segmentMolesPerMl[point.segment] ?? 0;
    if (own <= 0 || outMoles <= 0) continue;
    const earlier = gas.segmentMolesPerMl.reduce((sum, m, k) => (k === point.segment ? sum : sum + m * volumes.all[k]), 0);
    const implied = (outMoles - earlier) / own;
    if (implied > 0) point.impliedBubbleVolumeMl = implied;
  }

  const segments: SegmentFit[] = Array.from({ length: segmentCount }, (_, k) => ({
    startsAt: k === 0 ? null : segmentStarts[k - 1],
    fittedBubbleVolumeMl: volumes.fitted[k],
    usablePoints: usable.filter((r) => r.point.segment === k).length,
  }));
  const latest = [...segments].reverse().find((seg) => seg.fittedBubbleVolumeMl !== null) ?? null;

  return {
    points,
    fittedBubbleVolumeMl: latest?.fittedBubbleVolumeMl ?? null,
    usablePoints: usable.length,
    segments,
    fittedPoints: latest?.usablePoints ?? 0,
  };
}

interface CalibrationRow {
  point: CalibrationPoint;
  gas: GasPoint;
  outMoles: number;
}

/**
 * Least squares for the volumes of segments that have a reading of their
 * own; the rest are fixed at the fallback and moved to the known side. A
 * fit that comes out non-physical (≤ 0, from noisy readings) drops that
 * segment to the fallback and solves again.
 */
function solveSegmentVolumes(
  rows: CalibrationRow[],
  segmentCount: number,
  fallback: number,
): { fitted: (number | null)[]; all: number[] } {
  const fitted = new Array<number | null>(segmentCount).fill(null);
  let free = [...new Set(rows.map((r) => r.point.segment))].sort((a, b) => a - b);

  while (free.length > 0) {
    const n = free.length;
    const ata = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const atb = new Array<number>(n).fill(0);
    for (const { gas, outMoles } of rows) {
      const x = free.map((k) => gas.segmentMolesPerMl[k] ?? 0);
      const known = gas.segmentMolesPerMl.reduce((sum, m, k) => (free.includes(k) ? sum : sum + m * fallback), 0);
      for (let i = 0; i < n; i++) {
        atb[i] += x[i] * (outMoles - known);
        for (let j = 0; j < n; j++) ata[i][j] += x[i] * x[j];
      }
    }
    const solution = solveLinear(ata, atb);
    if (solution !== null && solution.every((v) => v > 0)) {
      free.forEach((k, i) => (fitted[k] = solution[i]));
      break;
    }
    // Drop the latest offending segment: it has the least data behind it.
    const bad = solution === null ? free : free.filter((_, i) => !(solution[i] > 0));
    free = free.filter((k) => k !== bad[bad.length - 1]);
  }

  return { fitted, all: fitted.map((v) => v ?? fallback) };
}

/** Gaussian elimination with partial pivoting; null when singular. The systems here are tiny (one row per segment). */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-30) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

export type BubbleVolumeSource = 'batch-override' | 'batch-calibration' | 'learned' | 'default';

export interface ResolvedBubbleVolume {
  /** The current (latest) segment's volume and where it came from: the dashboard's Bubble Volume tile. */
  bubbleVolumeMl: number;
  source: BubbleVolumeSource;
  /** One per airlock segment, in order. */
  volumes: number[];
  sources: BubbleVolumeSource[];
}

/** Per segment: batch override → the segment's own fit → learned from other batches → default (auto mode); override → default otherwise. */
export function resolveBubbleVolume(
  batch: BatchModelInputs,
  fit: CalibrationFit,
  learnedBubbleVolumeMl: number | null,
  settings: FermentationSettings,
): ResolvedBubbleVolume {
  const segments = fit.segments ?? [{ startsAt: null, fittedBubbleVolumeMl: fit.fittedBubbleVolumeMl, usablePoints: fit.usablePoints }];
  const resolved = segments.map((seg): { ml: number; source: BubbleVolumeSource } => {
    if (batch.bubbleVolumeMl !== null && batch.bubbleVolumeMl > 0) return { ml: batch.bubbleVolumeMl, source: 'batch-override' };
    if (settings.calibrationMode === 'auto') {
      if (seg.fittedBubbleVolumeMl !== null) return { ml: seg.fittedBubbleVolumeMl, source: 'batch-calibration' };
      if (learnedBubbleVolumeMl !== null) return { ml: learnedBubbleVolumeMl, source: 'learned' };
    }
    return { ml: settings.defaultBubbleVolumeMl, source: 'default' };
  });
  const current = resolved[resolved.length - 1];
  return {
    bubbleVolumeMl: current.ml,
    source: current.source,
    volumes: resolved.map((r) => r.ml),
    sources: resolved.map((r) => r.source),
  };
}

/** What a segment without readings of its own falls back to: the same order resolveBubbleVolume() uses. */
export function fallbackBubbleVolume(learnedBubbleVolumeMl: number | null, settings: FermentationSettings): number {
  return settings.calibrationMode === 'auto' && learnedBubbleVolumeMl !== null ? learnedBubbleVolumeMl : settings.defaultBubbleVolumeMl;
}

/**
 * Factor that puts a bubble rate from any segment into bubbles of the
 * current segment's size (1 without airlock changes), so peaks, "now" and
 * alert thresholds compare like with like across a water-level change.
 */
export function rateScaleAt(volumes: number[], segmentStarts: Date[], t: Date): number {
  const current = volumes[volumes.length - 1];
  const own = volumes[Math.min(segmentAt(segmentStarts, t), volumes.length - 1)];
  return current > 0 ? own / current : 1;
}

/** Weighted mean of other batches' fits, weighted by their usable point count. */
export function learnBubbleVolume(fits: { bubbleVolumeMl: number; points: number }[]): number | null {
  const valid = fits.filter((f) => f.bubbleVolumeMl > 0 && f.points > 0);
  const weight = valid.reduce((s, f) => s + f.points, 0);
  return weight > 0 ? valid.reduce((s, f) => s + f.bubbleVolumeMl * f.points, 0) / weight : null;
}

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

export interface AbvEstimate {
  abv: number | null;
  /** True when the raw estimate exceeded what the OG can physically produce. */
  abvCapped: boolean;
  estimatedSg: number | null;
  apparentAttenuation: number | null;
  /** Gas that passed through the airlock, at the temperatures it was measured at. */
  co2Liters: number;
}

export interface BatchEstimate extends AbvEstimate {
  /** The current airlock segment's volume (the only one without airlock changes). */
  bubbleVolumeMl: number;
  bubbleVolumeSource: BubbleVolumeSource;
  /** One entry per airlock segment, first to current. */
  airlockSegments: { startsAt: Date | null; bubbleVolumeMl: number; source: BubbleVolumeSource; usablePoints: number }[];
  og: number | null;
  /** ABV the OG would give at expectedAttenuation. */
  expectedAbv: number | null;
  /** Yeast (or default) attenuation blended with the added sugar's share — see expectedAttenuationFor(). */
  expectedAttenuation: number | null;
  /** Share of the OG's gravity points that came from added sugar (0..1). */
  sugarShare: number;
  bottling: BottlingEstimate | null;
  /** In the fermenter, before priming. */
  caloriesPer330ml: number | null;
  /** Most ABV the OG could produce (fermented down to minPossibleFg) — the scale of the dashboard's ABV bar. */
  maxAbv: number | null;
  targetAbv: number | null;
  calibration: CalibrationFit & { learnedBubbleVolumeMl: number | null };
  warnings: string[];
}

/** ABV / gravity at one point of the series, for a given bubble volume (or one per airlock segment). */
export function estimateAt(
  gas: GasPoint,
  bubbleVolumeMl: BubbleVolumes,
  batch: BatchModelInputs,
  settings: FermentationSettings,
): AbvEstimate {
  const og = effectiveOg(batch, settings);
  const co2Liters = co2LitersOut(gas, bubbleVolumeMl);
  const volume = batch.volumeLiters;
  if (!volume || volume <= 0) return { abv: null, abvCapped: false, estimatedSg: null, apparentAttenuation: null, co2Liters };

  let abv = abvFromCo2Out(gasMolesOut(gas, bubbleVolumeMl), gas.tempC, volume, settings, gas.saturated);
  let abvCapped = false;

  if (og !== null && settings.capAbvToOg) {
    const maxAbv = abvFromGravity(og, settings.minPossibleFg, settings.abvFormula);
    if (abv > maxAbv) {
      abv = maxAbv;
      abvCapped = true;
    }
  }

  const estimatedSg = og !== null ? fgFromAbv(og, abv, settings.abvFormula) : null;
  const apparentAttenuation = og !== null && estimatedSg !== null && og > 1 ? (og - estimatedSg) / (og - 1) : null;

  return { abv, abvCapped, estimatedSg, apparentAttenuation, co2Liters };
}

export function estimateBatch(
  batch: BatchModelInputs,
  rows: TelemetryRow[],
  readings: GravityInput[],
  learnedBubbleVolumeMl: number | null,
  settings: FermentationSettings,
  segmentStarts: Date[] = [],
): BatchEstimate {
  const series = buildGasSeries(rows, settings, segmentStarts);
  const fit = calibrate(batch, readings, series, settings, fallbackBubbleVolume(learnedBubbleVolumeMl, settings), segmentStarts);
  const resolved = resolveBubbleVolume(batch, fit, learnedBubbleVolumeMl, settings);
  const og = effectiveOg(batch, settings);

  const last = series.length ? series[series.length - 1] : gasAt(series, new Date(), settings);
  const current = estimateAt(last, resolved.volumes, batch, settings);

  for (const p of fit.points) {
    const predicted = estimateAt(gasAt(series, p.measuredAt, settings), resolved.volumes, batch, settings);
    p.predictedAbv = predicted.abv;
    p.predictedSg = predicted.estimatedSg;
  }

  const expected = expectedAttenuationFor(batch, og, settings);
  const fermenting = current.co2Liters > 0;
  const expectedAbv =
    og !== null && og > 1 ? abvFromGravity(og, og - expected.attenuation * (og - 1), settings.abvFormula) : null;
  const maxAbv = og !== null && og > settings.minPossibleFg ? abvFromGravity(og, settings.minPossibleFg, settings.abvFormula) : null;

  const warnings: string[] = [];
  if (!batch.volumeLiters) warnings.push('No batch volume set — ABV cannot be estimated.');
  if (og === null) warnings.push('No OG set — estimated gravity and attenuation are unavailable, and refractometer readings cannot calibrate.');
  if (resolved.source === 'default') warnings.push('Using the default bubble volume — not yet calibrated by any gravity reading.');
  if (segmentStarts.length > 0 && resolved.source !== 'batch-calibration' && resolved.source !== 'batch-override') {
    warnings.push('No gravity reading since the last airlock change — take one so the new bubble size can be calibrated.');
  }
  if (current.abvCapped) warnings.push('Bubble count implies more alcohol than the OG allows — ABV capped; bubble volume is probably too large.');

  return {
    ...current,
    bubbleVolumeMl: resolved.bubbleVolumeMl,
    bubbleVolumeSource: resolved.source,
    airlockSegments: (fit.segments ?? []).map((seg, k) => ({
      startsAt: seg.startsAt,
      bubbleVolumeMl: resolved.volumes[k],
      source: resolved.sources[k],
      usablePoints: seg.usablePoints,
    })),
    og,
    expectedAbv,
    expectedAttenuation: og !== null && og > 1 ? expected.attenuation : null,
    sugarShare: expected.sugarShare,
    // Nothing counted yet means no ABV to build on (the dashboard shows "—", not 0%).
    bottling: fermenting ? bottlingEstimate(batch, current.abv, last.tempC, settings) : null,
    caloriesPer330ml:
      fermenting && og !== null && current.estimatedSg !== null && current.abv !== null
        ? caloriesPer330ml(og, current.estimatedSg, current.abv)
        : null,
    maxAbv,
    targetAbv: batch.targetAbv,
    calibration: { ...fit, learnedBubbleVolumeMl },
    warnings,
  };
}

// ---------------------------------------------------------------------------

/** Root of a monotonic function on [lo, hi] — robust and precise enough for gravity math. */
function bisect(f: (x: number) => number, lo: number, hi: number): number {
  let fLo = f(lo);
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const fMid = f(mid);
    if (Math.abs(fMid) < 1e-12) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}
