import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { DATA_SOURCE } from '../database/database.module';
import { AppSettingEntity } from '../database/entities/app-setting.entity';
import { BatchEntity } from '../database/entities/batch.entity';
import { GravityReadingEntity } from '../database/entities/gravity-reading.entity';
import { ReadingEntity } from '../database/entities/reading.entity';
import { BatchesService } from '../batches/batches.service';
import {
  BatchEstimate,
  BatchModelInputs,
  buildGasSeries,
  calibrate,
  estimateAt,
  estimateBatch,
  fallbackBubbleVolume,
  gasAt,
  learnBubbleVolume,
  rateScaleAt,
  resolveBubbleVolume,
} from './abv-model';
import { DEFAULT_FERMENTATION_SETTINGS, FermentationSettings } from './fermentation-settings';
import { CreateGravityReadingDto, UpdateFermentationSettingsDto, UpdateGravityReadingDto } from './dto/fermentation.dto';

const SETTINGS_KEY = 'fermentation';

/**
 * DB-facing side of the ABV model (the math itself is pure, in
 * abv-model.ts): settings, gravity readings, and the per-batch calibration
 * cache that lets every batch learn from the others.
 *
 * Cache invariant: batches.calibrated_bubble_volume_ml / calibration_points
 * always reflect the batch's current gravity readings, batch fields and
 * settings — so every write to any of those calls recalibrate() (or
 * recalibrateAll() for settings). New telemetry never invalidates it: a
 * calibration point only looks at bubbles counted up to its own timestamp.
 * Airlock-changed events split the fit into segments, so adding, moving or
 * removing one recalibrates too (BatchesController).
 */
@Injectable()
export class FermentationService {
  private readonly settingsRepo: Repository<AppSettingEntity>;
  private readonly gravityRepo: Repository<GravityReadingEntity>;
  private readonly batchRepo: Repository<BatchEntity>;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly batches: BatchesService,
  ) {
    this.settingsRepo = this.dataSource.getRepository(AppSettingEntity);
    this.gravityRepo = this.dataSource.getRepository(GravityReadingEntity);
    this.batchRepo = this.dataSource.getRepository(BatchEntity);
  }

  // --- Settings ------------------------------------------------------------

  /** Stored values over defaults — a key added in a later release picks up its default automatically. */
  async getSettings(): Promise<FermentationSettings> {
    const row = await this.settingsRepo.findOne({ where: { key: SETTINGS_KEY } });
    return { ...DEFAULT_FERMENTATION_SETTINGS, ...((row?.value ?? {}) as Partial<FermentationSettings>) };
  }

  async updateSettings(dto: UpdateFermentationSettingsDto): Promise<FermentationSettings> {
    const merged = { ...(await this.getSettings()), ...stripUndefined(dto) };
    await this.settingsRepo.save({ key: SETTINGS_KEY, value: { ...merged } });
    await this.recalibrateAll();
    return merged;
  }

  async resetSettings(): Promise<FermentationSettings> {
    await this.settingsRepo.delete({ key: SETTINGS_KEY });
    await this.recalibrateAll();
    return this.getSettings();
  }

  // --- Gravity readings ----------------------------------------------------

  async listGravityReadings(batchId: number): Promise<GravityReadingEntity[]> {
    await this.batches.findOneOrThrow(batchId);
    return this.gravityRepo.find({ where: { batchId }, order: { measuredAt: 'ASC' } });
  }

  async addGravityReading(batchId: number, dto: CreateGravityReadingDto): Promise<GravityReadingEntity> {
    await this.batches.findOneOrThrow(batchId);
    const saved = await this.gravityRepo.save(
      this.gravityRepo.create({
        batchId,
        measuredAt: new Date(dto.measuredAt),
        value: dto.value,
        unit: dto.unit,
        excludeFromCalibration: dto.excludeFromCalibration ?? false,
        notes: dto.notes ?? null,
      }),
    );
    await this.recalibrate(batchId);
    return saved;
  }

  async updateGravityReading(batchId: number, id: number, dto: UpdateGravityReadingDto): Promise<GravityReadingEntity> {
    const reading = await this.findGravityOrThrow(batchId, id);
    if (dto.measuredAt !== undefined) reading.measuredAt = new Date(dto.measuredAt);
    if (dto.value !== undefined) reading.value = dto.value;
    if (dto.unit !== undefined) reading.unit = dto.unit;
    if (dto.excludeFromCalibration !== undefined) reading.excludeFromCalibration = dto.excludeFromCalibration;
    if (dto.notes !== undefined) reading.notes = dto.notes;
    const saved = await this.gravityRepo.save(reading);
    await this.recalibrate(batchId);
    return saved;
  }

  async removeGravityReading(batchId: number, id: number): Promise<void> {
    const reading = await this.findGravityOrThrow(batchId, id);
    await this.gravityRepo.delete({ id: reading.id });
    await this.recalibrate(batchId);
  }

  private async findGravityOrThrow(batchId: number, id: number): Promise<GravityReadingEntity> {
    const reading = await this.gravityRepo.findOne({ where: { id, batchId } });
    if (!reading) throw new NotFoundException(`Gravity reading ${id} not found on batch ${batchId}`);
    return reading;
  }

  // --- Calibration cache ---------------------------------------------------

  /** Refits one batch's bubble volume from its own gravity readings and caches the result on the batch row. */
  async recalibrate(batchId: number, settings?: FermentationSettings): Promise<void> {
    const batch = await this.batches.findOneOrThrow(batchId);
    const gravity = await this.gravityRepo.find({ where: { batchId } });
    const s = settings ?? (await this.getSettings());

    let fitted: number | null = null;
    let points = 0;
    if (gravity.length > 0) {
      const readings = await this.batches.getReadings(batchId);
      const starts = await this.airlockChanges(batchId);
      // Only a segment without readings of its own needs the learned value.
      const fallback = fallbackBubbleVolume(starts.length ? await this.learnedBubbleVolume(batchId) : null, s);
      const fit = calibrate(toModelInputs(batch), gravity, buildGasSeries(readings, s, starts), s, fallback, starts);
      // The airlock as it was left, weighted by its own readings: what other batches learn from.
      fitted = fit.fittedBubbleVolumeMl;
      points = fit.fittedPoints ?? fit.usablePoints;
    }

    await this.batchRepo.update({ id: batchId }, { calibratedBubbleVolumeMl: fitted, calibrationPoints: points });
  }

  /** Settings changes can move every fit (wort correction factor, ABV formula, temperature model, …). */
  async recalibrateAll(): Promise<void> {
    const settings = await this.getSettings();
    const withReadings = await this.gravityRepo
      .createQueryBuilder('g')
      .select('DISTINCT g.batch_id', 'batchId')
      .getRawMany<{ batchId: number }>();
    const stale = await this.batchRepo.find({ where: { calibratedBubbleVolumeMl: Not(IsNull()) }, select: { id: true } });

    const ids = new Set([...withReadings.map((r) => Number(r.batchId)), ...stale.map((b) => b.id)]);
    for (const id of ids) await this.recalibrate(id, settings);
  }

  /** What every other calibrated batch agrees one bubble carries — batches with sharing turned off keep their fit to themselves. */
  async learnedBubbleVolume(excludeBatchId: number): Promise<number | null> {
    const others = await this.batchRepo.find({
      where: { id: Not(excludeBatchId), calibratedBubbleVolumeMl: Not(IsNull()), shareCalibration: true },
      select: { id: true, calibratedBubbleVolumeMl: true, calibrationPoints: true },
    });
    return learnBubbleVolume(others.map((b) => ({ bubbleVolumeMl: b.calibratedBubbleVolumeMl!, points: b.calibrationPoints })));
  }

  /** When the airlock was refilled or swapped, oldest first: where each new bubble-volume segment starts. */
  async airlockChanges(batchId: number): Promise<Date[]> {
    const events = await this.batches.listEvents(batchId);
    return events.filter((e) => e.kind === 'airlock').map((e) => e.occurredAt);
  }

  // --- Estimates -----------------------------------------------------------

  async estimate(batch: BatchEntity, readings: ReadingEntity[]): Promise<BatchEstimate & { settings: FermentationSettings }> {
    const settings = await this.getSettings();
    const gravity = await this.gravityRepo.find({ where: { batchId: batch.id } });
    const learned = await this.learnedBubbleVolume(batch.id);
    const starts = await this.airlockChanges(batch.id);
    return { ...estimateBatch(toModelInputs(batch), readings, gravity, learned, settings, starts), settings };
  }

  /**
   * The readings with every V100 bubble rate expressed in bubbles of the
   * current airlock segment's size, so peak, "now", the chart and the alerts
   * compare like with like across a water-level change. Unchanged for a
   * batch without airlock changes. Counter values, and so the ABV model, are
   * untouched. Pass `estimate` when it's already at hand.
   */
  async withComparableRates(batch: BatchEntity, readings: ReadingEntity[], estimate?: BatchEstimate): Promise<ReadingEntity[]> {
    const starts = await this.airlockChanges(batch.id);
    if (starts.length === 0) return readings;
    const { airlockSegments } = estimate ?? (await this.estimate(batch, readings));
    const volumes = airlockSegments.map((seg) => seg.bubbleVolumeMl);
    return readings.map((r) =>
      r.pin === 'V100' ? { ...r, bubbleRate: r.bubbleRate * rateScaleAt(volumes, starts, r.recordedAt) } : r,
    );
  }

  /** ABV at any moment of the batch, with the same bubble volume the live estimate uses — for the report's daily snapshots. */
  async abvTimeline(batch: BatchEntity, readings: ReadingEntity[]): Promise<(t: Date) => number | null> {
    const settings = await this.getSettings();
    const gravity = await this.gravityRepo.find({ where: { batchId: batch.id } });
    const learned = await this.learnedBubbleVolume(batch.id);
    const inputs = toModelInputs(batch);
    const starts = await this.airlockChanges(batch.id);
    const series = buildGasSeries(readings, settings, starts);
    const fit = calibrate(inputs, gravity, series, settings, fallbackBubbleVolume(learned, settings), starts);
    const { volumes } = resolveBubbleVolume(inputs, fit, learned, settings);
    return (t: Date) => estimateAt(gasAt(series, t, settings), volumes, inputs, settings).abv;
  }

  /**
   * ABV over the batch for the chart: hourly from the first to the last
   * reading (coarser for very long batches), same bubble volume as the
   * live estimate. Empty without telemetry; null ABVs (no volume) are kept
   * so the caller can tell "no estimate" from 0%.
   */
  async abvSeries(batch: BatchEntity, readings: ReadingEntity[]): Promise<{ t: Date; abv: number | null }[]> {
    if (readings.length === 0) return [];
    const times = readings.map((r) => r.recordedAt.getTime());
    const first = Math.min(...times);
    const last = Math.max(...times);
    const step = Math.max(3_600_000, (last - first) / (ABV_SERIES_MAX_POINTS - 1));
    const abvAt = await this.abvTimeline(batch, readings);
    const out: { t: Date; abv: number | null }[] = [];
    for (let t = first; t < last; t += step) out.push({ t: new Date(t), abv: abvAt(new Date(t)) });
    out.push({ t: new Date(last), abv: abvAt(new Date(last)) });
    return out;
  }
}

/** At most this many points in an ABV series (one an hour is plenty for a chart). */
export const ABV_SERIES_MAX_POINTS = 500;

export function toModelInputs(batch: BatchEntity): BatchModelInputs {
  return {
    volumeLiters: batch.volumeLiters,
    ogValue: batch.ogValue,
    ogUnit: batch.ogUnit,
    ogIncludesSugar: batch.ogIncludesSugar,
    addedSugarG: batch.addedSugarG,
    bubbleVolumeMl: batch.bubbleVolumeMl,
    targetAbv: batch.targetAbv,
    yeastAttenuation: batch.yeastAttenuation,
    primingSugarG: batch.primingSugarG,
    bottledVolumeL: batch.bottledVolumeL,
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
