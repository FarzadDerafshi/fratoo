import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, LessThan, LessThanOrEqual, Repository } from 'typeorm';
import { DATA_SOURCE } from '../database/database.module';
import { AppSettingEntity } from '../database/entities/app-setting.entity';
import { BatchEntity } from '../database/entities/batch.entity';
import { ReadingEntity } from '../database/entities/reading.entity';
import { ReadingsService } from '../readings/readings.service';
import { BatchesService } from '../batches/batches.service';
import { FermentationService } from '../fermentation/fermentation.service';
import { correctTemperature, sustainedStartIndex } from '../common/fermentation-math';
import {
  RatePoint,
  TempPoint,
  formatDuration,
  peakPassed,
  slowFor,
  smoothedPeak,
  temperatureChange,
} from './alert-rules';
import { DEFAULT_NOTIFICATION_SETTINGS, NotificationSettings } from './notification-settings';
import { PushPayload, PushService } from './push.service';

export const FERMENTATION_STARTED = 'fermentation_started';

const SETTINGS_KEY = 'notifications';
/** How often the time-based rules (offline, no start, temperature, peak, finished, stalled) run. */
const CHECK_INTERVAL_MS = 5 * 60_000;
/** A start older than this when first seen (e.g. a deploy mid-batch) is recorded without a notification. */
const STALE_START_MS = 60 * 60_000;
const HOUR_MS = 3_600_000;

/**
 * Push alerts for active batches. Two paths:
 *
 * - On each stored reading (ReadingsService.onInserted): fermentation
 *   started, back online, device rebooted — things a reading itself reveals.
 * - Every CHECK_INTERVAL_MS over every active batch: device offline, no
 *   start, temperature, peak passed, looks finished, stalled.
 *
 * Each alert is claimed in batch_notifications before it's sent, so it can't
 * go out twice: one-off kinds once per batch, on/off kinds (device_offline,
 * temp_high, temp_low) once per "problem → resolved" cycle.
 */
@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertsService.name);
  private readonly batchRepo: Repository<BatchEntity>;
  private readonly readingRepo: Repository<ReadingEntity>;
  private readonly settingsRepo: Repository<AppSettingEntity>;
  private readonly bootedAt = Date.now();
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly readings: ReadingsService,
    private readonly batches: BatchesService,
    private readonly fermentation: FermentationService,
    private readonly push: PushService,
  ) {
    this.batchRepo = this.dataSource.getRepository(BatchEntity);
    this.readingRepo = this.dataSource.getRepository(ReadingEntity);
    this.settingsRepo = this.dataSource.getRepository(AppSettingEntity);
  }

  onModuleInit(): void {
    this.unsubscribe = this.readings.onInserted((reading, counterReset) => {
      void this.onReading(reading, counterReset).catch((err: unknown) => this.logError('Reading alert check', err));
    });
    this.timer = setInterval(() => void this.runChecks(), CHECK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
  }

  // --- Settings ------------------------------------------------------------

  async getSettings(): Promise<NotificationSettings> {
    const row = await this.settingsRepo.findOne({ where: { key: SETTINGS_KEY } });
    return { ...DEFAULT_NOTIFICATION_SETTINGS, ...((row?.value ?? {}) as Partial<NotificationSettings>) };
  }

  async updateSettings(changes: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    const merged = { ...(await this.getSettings()), ...defined };
    await this.settingsRepo.save({ key: SETTINGS_KEY, value: { ...merged } });
    return merged;
  }

  // --- On each reading -----------------------------------------------------

  async onReading(reading: ReadingEntity, counterReset: boolean, now = new Date()): Promise<void> {
    const batch = await this.batchRepo.findOne({
      where: { deviceId: reading.deviceId, status: 'active', startedAt: LessThanOrEqual(reading.recordedAt) },
      order: { startedAt: 'DESC' },
    });
    if (!batch) return;
    const s = await this.getSettings();

    if (s.notifyDeviceOffline && (await this.clearState(batch.id, 'device_offline', now))) {
      const prev = await this.readingRepo.findOne({
        where: { deviceId: reading.deviceId, recordedAt: LessThan(reading.recordedAt) },
        order: { recordedAt: 'DESC' },
      });
      const gap = prev ? ` after ${formatDuration(reading.recordedAt.getTime() - prev.recordedAt.getTime())} without data` : '';
      await this.send(batch, 'device', 'Airlock back online', `readings resumed${gap}.`);
    }

    if (reading.pin !== 'V100') return;
    if (counterReset && s.notifyDeviceRebooted) {
      await this.send(batch, 'reboot', 'Airlock restarted', 'the bubble counter reset (power cut or reboot). Counting carries on; nothing is lost.');
    }
    if (s.notifyFermentationStarted) await this.checkFermentationStarted(batch, now);
  }

  async checkFermentationStarted(batch: BatchEntity, now = new Date()): Promise<void> {
    if (await this.wasSent(batch.id, FERMENTATION_STARTED)) return;

    const from = batch.pitchedAt ?? batch.startedAt;
    const v100 = (await this.batches.getReadings(batch.id)).filter(
      (r) => r.pin === 'V100' && r.recordedAt.getTime() >= from.getTime(),
    );
    const i = sustainedStartIndex(v100.map((r) => r.bubbleRate), true);
    if (i < 0) return;
    if (!(await this.claimOnce(batch.id, FERMENTATION_STARTED, now))) return;

    if (now.getTime() - v100[i + 2].recordedAt.getTime() > STALE_START_MS) {
      this.logger.log(`Batch ${batch.id}: fermentation started earlier — recorded without a notification`);
      return;
    }
    const lag = formatDuration(v100[i].recordedAt.getTime() - from.getTime());
    const latest = v100[v100.length - 1];
    await this.send(
      batch,
      'started',
      'Fermentation started',
      `bubbling at ${latest.bubbleRate.toFixed(1)} bpm, ${lag} after ${batch.pitchedAt ? 'pitching' : 'the batch started'}.`,
    );
  }

  // --- Periodic checks -----------------------------------------------------

  async runChecks(now = new Date()): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const s = await this.getSettings();
      const active = await this.batchRepo.find({ where: { status: 'active' } });
      for (const batch of active) {
        if (!batch.deviceId) continue;
        await this.checkBatch(batch, s, now).catch((err: unknown) => this.logError(`Alert checks for batch ${batch.id}`, err));
      }
    } catch (err) {
      this.logError('Alert checks', err);
    } finally {
      this.checking = false;
    }
  }

  async checkBatch(batch: BatchEntity, s: NotificationSettings, now = new Date()): Promise<void> {
    const readings = await this.batches.getReadings(batch.id);
    const t = now.getTime();

    // Offline: nothing from the device for offlineMinutes. Not right after
    // this process starts — a server outage would otherwise look like one.
    const lastAt = readings.length ? readings[readings.length - 1].recordedAt.getTime() : batch.startedAt.getTime();
    const offlineMs = s.offlineMinutes * 60_000;
    if (t - lastAt > offlineMs) {
      if (s.notifyDeviceOffline && t - this.bootedAt > offlineMs && (await this.claimState(batch.id, 'device_offline', now))) {
        await this.send(
          batch,
          'device',
          'Airlock offline',
          `no reading for ${formatDuration(t - lastAt)}. Check the battery and Wi-Fi; if the device looks fine, restart the bridge.`,
        );
      }
      return; // the other rules need fresh readings
    }

    const from = (batch.pitchedAt ?? batch.startedAt).getTime();
    const rates: RatePoint[] = readings
      .filter((r) => r.pin === 'V100' && r.recordedAt.getTime() >= from)
      .map((r) => ({ t: r.recordedAt.getTime(), rate: r.bubbleRate }));
    const temps: TempPoint[] = readings
      .filter((r) => r.pin === 'V101')
      .slice(-3)
      .map((r) => ({ t: r.recordedAt.getTime(), c: correctTemperature(r.value) }));
    const started = sustainedStartIndex(rates.map((p) => p.rate)) >= 0;

    if (s.notifyTemperature) await this.checkTemperature(batch, temps, s, now);

    if (!started) {
      if (s.notifyNoStart && t - from >= s.noStartHours * HOUR_MS && (await this.claimOnce(batch.id, 'no_start', now))) {
        await this.send(
          batch,
          'no-start',
          'No fermentation yet',
          `${formatDuration(t - from)} since ${batch.pitchedAt ? 'pitching' : 'the batch started'} and no steady bubbling. Check the yeast, the temperature and the lid seal.`,
        );
      }
      return;
    }

    if (s.notifyPeakPassed) {
      const passed = peakPassed(rates, t, s.peakDropPct, s.peakDropHours);
      if (passed && (await this.claimOnce(batch.id, 'peak_passed', now))) {
        await this.send(
          batch,
          'peak',
          'Peak passed',
          `${passed.recent.toFixed(0)} bpm, down from a ${passed.peak.rate.toFixed(0)} bpm peak ${formatDuration(t - passed.peak.t)} ago. A good time for a refractometer reading or a dry hop.`,
        );
      }
    }

    if ((s.notifyStalled || s.notifyLooksFinished) && smoothedPeak(rates)) {
      const slowLong = slowFor(rates, t, s.finishedHours, s.finishedBpm);
      const slowShort = slowFor(rates, t, s.stallHours, s.finishedBpm);
      if (!slowLong && !slowShort) return;

      const estimate = await this.fermentation.estimate(batch, readings);
      const abv = estimate.abv;
      const expected = estimate.expectedAbv;
      const behind = abv !== null && expected !== null && abv < expected * (s.stallPctOfExpected / 100);

      if (behind && slowShort && s.notifyStalled && (await this.claimOnce(batch.id, 'stalled', now))) {
        await this.send(
          batch,
          'slow',
          'Fermentation may be stalled',
          `under ${s.finishedBpm} bpm for ${s.stallHours} h, but only ~${abv!.toFixed(1)}% of the expected ${expected!.toFixed(1)}% ABV. Check the temperature, gently swirl to rouse the yeast, or take a gravity reading to confirm.`,
        );
      } else if (!behind && slowLong && s.notifyLooksFinished && (await this.claimOnce(batch.id, 'looks_finished', now))) {
        await this.send(
          batch,
          'slow',
          'Looks finished',
          `under ${s.finishedBpm} bpm for ${s.finishedHours} h${abv !== null ? `, est. ${abv.toFixed(1)}% ABV` : ''}. Take a gravity reading; if it's unchanged 2 days later, it's ready to bottle.`,
        );
      }
    }
  }

  private async checkTemperature(batch: BatchEntity, temps: TempPoint[], s: NotificationSettings, now: Date): Promise<void> {
    if (temps.length === 0) return;
    const current = temps[temps.length - 1].c.toFixed(1);
    const max = batch.alertTempMaxC ?? s.tempMaxC;
    const min = batch.alertTempMinC ?? s.tempMinC;

    const high = temperatureChange(temps, max, 'high');
    if (high === 'enter' && (await this.claimState(batch.id, 'temp_high', now))) {
      await this.send(
        batch,
        'temp',
        'Temperature high',
        `${current} °C at the airlock (limit ${max} °C). The beer runs 2–4 °C warmer at peak, so cool it if you can.`,
      );
    } else if (high === 'exit' && (await this.clearState(batch.id, 'temp_high', now))) {
      await this.send(batch, 'temp', 'Temperature back in range', `${current} °C at the airlock.`);
    }

    const low = temperatureChange(temps, min, 'low');
    if (low === 'enter' && (await this.claimState(batch.id, 'temp_low', now))) {
      await this.send(
        batch,
        'temp',
        'Temperature low',
        `${current} °C at the airlock (limit ${min} °C). The yeast may slow down or stop; move it somewhere warmer.`,
      );
    } else if (low === 'exit' && (await this.clearState(batch.id, 'temp_low', now))) {
      await this.send(batch, 'temp', 'Temperature back in range', `${current} °C at the airlock.`);
    }
  }

  // --- Sending and alert state ---------------------------------------------

  /** `group` becomes the notification tag: a later one of the same group (back online, back in range) replaces the earlier. */
  private async send(batch: BatchEntity, group: string, title: string, body: string): Promise<void> {
    const payload: PushPayload = { title, body: `${batch.batchCode}: ${body}`, url: `/batches/${batch.id}`, tag: `${group}-${batch.id}` };
    await this.push.sendToAll(payload);
  }

  private async wasSent(batchId: number, kind: string): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query('SELECT 1 FROM batch_notifications WHERE batch_id = $1 AND kind = $2', [
      batchId,
      kind,
    ]);
    return rows.length > 0;
  }

  /** One-off alert: true the first time for this batch, false ever after. */
  private async claimOnce(batchId: number, kind: string, now: Date): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(
      'INSERT INTO batch_notifications (batch_id, kind, sent_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING batch_id',
      [batchId, kind, now],
    );
    return rows.length > 0;
  }

  /** On/off alert going on: true when it wasn't already on. */
  private async claimState(batchId: number, kind: string, now: Date): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(
      `INSERT INTO batch_notifications (batch_id, kind, sent_at, active) VALUES ($1, $2, $3, true)
       ON CONFLICT (batch_id, kind) DO UPDATE SET active = true, sent_at = EXCLUDED.sent_at, cleared_at = NULL
       WHERE batch_notifications.active = false
       RETURNING batch_id`,
      [batchId, kind, now],
    );
    return rows.length > 0;
  }

  /** On/off alert going off: true when it was on. */
  private async clearState(batchId: number, kind: string, now: Date): Promise<boolean> {
    // TypeORM returns [rows, affectedCount] for an UPDATE on Postgres.
    const [rows] = (await this.dataSource.query(
      'UPDATE batch_notifications SET active = false, cleared_at = $3 WHERE batch_id = $1 AND kind = $2 AND active RETURNING batch_id',
      [batchId, kind, now],
    )) as [unknown[], number];
    return rows.length > 0;
  }

  private logError(what: string, err: unknown): void {
    this.logger.error(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
