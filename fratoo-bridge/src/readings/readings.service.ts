import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Between, DataSource, Repository } from 'typeorm';
import { DATA_SOURCE } from '../database/database.module';
import { ReadingEntity } from '../database/entities/reading.entity';
import { BlynkReading, BlynkService } from '../blynk/blynk.service';
import { correctTemperature } from '../common/fermentation-math';

// CO₂ and ABV are no longer computed here — they come from the calibrated
// ABV model (src/fermentation/abv-model.ts), merged in by BatchesController.
export interface ReadingWindowStats {
  totalBubbles: number;
  avgTemp: number | null;
  peakRate: number | null;
  /** Latest V100 bubble rate (bpm) — "now" on the dashboard. */
  currentRate: number | null;
  /** Latest PCB-corrected V101 temperature. */
  currentTemp: number | null;
  /** Newest reading of either pin — drives the live/stale/offline status. */
  lastReadingAt: Date | null;
  /** Bubble rate averaged into up to SPARKLINE_BUCKETS equal time slices, for the batch-list graph. Empty slices are skipped. */
  sparkline: { t: Date; rate: number }[];
}

export const SPARKLINE_BUCKETS = 48;

/** Gets each stored reading; `counterReset` = this V100 value was lower than the last (device reboot). */
export type ReadingListener = (reading: ReadingEntity, counterReset: boolean) => void;

/**
 * Owns the readings table: the V100 delta engine (bubble_rate computation),
 * and window-scoped queries used by BatchesService.
 *
 * Subscribes to BlynkService's 'reading' event directly. Since 2.5.0 this
 * is the only write path — the WordPress dual-write was retired (see
 * ProjectDocs/DECISIONS.md).
 */
@Injectable()
export class ReadingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReadingsService.name);
  private readonly repo: Repository<ReadingEntity>;
  /** Called with every stored reading — e.g. AlertsService (push notifications). */
  private readonly insertedListeners = new Set<ReadingListener>();

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly blynkService: BlynkService,
  ) {
    this.repo = this.dataSource.getRepository(ReadingEntity);
  }

  onModuleInit(): void {
    this.blynkService.on('reading', this.onReading);
    this.logger.log('Postgres ingest active');
  }

  onModuleDestroy(): void {
    this.blynkService.off('reading', this.onReading);
  }

  // Arrow function preserves `this` when passed as an EventEmitter listener.
  private readonly onReading = (reading: BlynkReading): void => {
    void this.storeReading(reading).then(
      ({ saved, counterReset }) => this.notifyInserted(saved, counterReset),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to insert reading (pin ${reading.pin}): ${msg}`);
      },
    );
  };

  private notifyInserted(saved: ReadingEntity, counterReset: boolean): void {
    for (const listener of this.insertedListeners) {
      try {
        listener(saved, counterReset);
      } catch (err) {
        this.logger.error(`Reading listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Subscribe to readings once they're stored (bubble_rate computed). Returns the unsubscribe function. */
  onInserted(listener: ReadingListener): () => void {
    this.insertedListeners.add(listener);
    return () => this.insertedListeners.delete(listener);
  }

  /**
   * V100 delta engine — ported from Fratoo_DB::insert_reading() in the
   * WordPress plugin (see ProjectDocs/ARCHITECTURE.md). V100 is the
   * Plaato Airlock's cumulative bubble counter:
   *   - Looks up the latest prior V100 row for this device.
   *   - bubble_rate = ΔBubbles / ΔMinutes.
   *   - A negative delta means the device rebooted and the counter reset;
   *     bubble_rate is pinned to 0 so it never produces a negative spike.
   * All other pins store bubble_rate = 0.
   */
  async insertReading(reading: BlynkReading): Promise<ReadingEntity> {
    return (await this.storeReading(reading)).saved;
  }

  /** insertReading(), also telling whether this V100 value was a counter reset (device reboot). */
  private async storeReading(reading: BlynkReading): Promise<{ saved: ReadingEntity; counterReset: boolean }> {
    const value = parseFloat(reading.value);
    let bubbleRate = 0;
    let counterReset = false;

    if (reading.pin === 'V100') {
      const prev = await this.repo.findOne({
        where: { deviceId: reading.deviceId, pin: 'V100' },
        order: { recordedAt: 'DESC' },
      });

      if (prev) {
        const deltaBubbles = value - prev.value;
        if (deltaBubbles < 0) {
          bubbleRate = 0; // hardware reboot — counter reset
          counterReset = true;
        } else {
          const deltaMinutes = (reading.receivedAt.getTime() - prev.recordedAt.getTime()) / 60_000;
          bubbleRate = deltaMinutes > 0 ? deltaBubbles / deltaMinutes : 0;
        }
      }
    }

    const saved = await this.repo.save(
      this.repo.create({
        deviceId: reading.deviceId,
        pin: reading.pin,
        value,
        bubbleRate,
        recordedAt: reading.receivedAt,
      }),
    );
    return { saved, counterReset };
  }

  findByDeviceAndWindow(deviceId: string, from: Date, to: Date): Promise<ReadingEntity[]> {
    return this.repo.find({
      where: { deviceId, recordedAt: Between(from, to) },
      order: { recordedAt: 'ASC' },
    });
  }

  countByDeviceAndWindow(deviceId: string, from: Date, to: Date): Promise<number> {
    return this.repo.count({ where: { deviceId, recordedAt: Between(from, to) } });
  }

  /**
   * Fermentation summary stats for a window of readings — ported from
   * computeFermentationStats() in the WordPress plugin's fratoo-chart.js,
   * now computed server-side so the frontend doesn't need to fetch every
   * raw reading just to show five numbers.
   */
  static computeStats(readings: ReadingEntity[]): ReadingWindowStats {
    const v100Asc = readings
      .filter((r) => r.pin === 'V100')
      .slice()
      .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

    let totalBubbles = 0;
    for (let i = 1; i < v100Asc.length; i++) {
      const delta = v100Asc[i].value - v100Asc[i - 1].value;
      if (delta > 0) totalBubbles += delta;
    }

    const bubbleRates = v100Asc.map((r) => r.bubbleRate).filter((v) => !isNaN(v));
    const peakRate = bubbleRates.length ? Math.max(...bubbleRates) : null;

    const temps = readings
      .filter((r) => r.pin === 'V101')
      .map((r) => correctTemperature(r.value))
      .filter((v) => !isNaN(v));
    const avgTemp = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;

    const v101Asc = readings
      .filter((r) => r.pin === 'V101' && isFinite(r.value))
      .slice()
      .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
    const lastRate = v100Asc[v100Asc.length - 1];
    const lastTemp = v101Asc[v101Asc.length - 1];
    const lastTimes = [lastRate, lastTemp].filter(Boolean).map((r) => r.recordedAt.getTime());

    return {
      totalBubbles,
      avgTemp,
      peakRate,
      currentRate: lastRate && !isNaN(lastRate.bubbleRate) ? lastRate.bubbleRate : null,
      currentTemp: lastTemp ? correctTemperature(lastTemp.value) : null,
      lastReadingAt: lastTimes.length ? new Date(Math.max(...lastTimes)) : null,
      sparkline: ReadingsService.sparkline(v100Asc),
    };
  }

  /** Averages V100 bubble rate (rows already sorted ascending) into equal time slices. */
  private static sparkline(v100Asc: ReadingEntity[]): { t: Date; rate: number }[] {
    if (v100Asc.length < 2) return [];
    const start = v100Asc[0].recordedAt.getTime();
    const span = v100Asc[v100Asc.length - 1].recordedAt.getTime() - start || 1;
    const sums = new Array<number>(SPARKLINE_BUCKETS).fill(0);
    const counts = new Array<number>(SPARKLINE_BUCKETS).fill(0);
    for (const r of v100Asc) {
      if (isNaN(r.bubbleRate)) continue;
      const i = Math.min(SPARKLINE_BUCKETS - 1, Math.floor(((r.recordedAt.getTime() - start) / span) * SPARKLINE_BUCKETS));
      sums[i] += r.bubbleRate;
      counts[i]++;
    }
    const out: { t: Date; rate: number }[] = [];
    for (let i = 0; i < SPARKLINE_BUCKETS; i++) {
      if (counts[i]) out.push({ t: new Date(start + ((i + 0.5) / SPARKLINE_BUCKETS) * span), rate: sums[i] / counts[i] });
    }
    return out;
  }
}
