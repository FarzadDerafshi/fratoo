import { DataSource } from 'typeorm';
import { AppSettingEntity } from '../database/entities/app-setting.entity';
import { BatchEntity } from '../database/entities/batch.entity';
import { ReadingEntity } from '../database/entities/reading.entity';
import { BatchesService } from '../batches/batches.service';
import { FermentationService } from '../fermentation/fermentation.service';
import { ReadingsService } from '../readings/readings.service';
import { AlertsService } from './alerts.service';
import { DEFAULT_NOTIFICATION_SETTINGS, NotificationSettings } from './notification-settings';
import { PushPayload, PushService } from './push.service';

const PITCH = new Date('2026-10-21T14:50:00Z').getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

function makeBatch(overrides: Partial<BatchEntity> = {}): BatchEntity {
  return Object.assign(new BatchEntity(), {
    id: 7,
    batchCode: 'IPA 2026.10',
    deviceId: 'airlock-1',
    status: 'active',
    startedAt: new Date(PITCH - 13 * MIN),
    pitchedAt: new Date(PITCH),
    alertTempMinC: null,
    alertTempMaxC: null,
    ...overrides,
  });
}

function row(pin: string, t: number, value: number, bubbleRate = 0): ReadingEntity {
  return Object.assign(new ReadingEntity(), { deviceId: 'airlock-1', pin, value, bubbleRate, recordedAt: new Date(t) });
}

/** V100 + V101 every 5 min from the pitch until `hours`, rate/temperature as functions of hours since pitch. */
function telemetry(hours: number, rateAt: (h: number) => number, tempAt: (h: number) => number = () => 21): ReadingEntity[] {
  const rows: ReadingEntity[] = [];
  for (let t = PITCH + 5 * MIN; t <= PITCH + hours * HOUR; t += 5 * MIN) {
    const h = (t - PITCH) / HOUR;
    rows.push(row('V100', t, 0, rateAt(h)));
    // The PCB-raw value whose corrected temperature is tempAt(h).
    rows.push(row('V101', t + 1000, (tempAt(h) + 1.145) / 0.9133));
  }
  return rows;
}

/** Fake Postgres for batch_notifications, keyed "batchId:kind". */
function fakeDataSource(batch: BatchEntity, settings: Partial<NotificationSettings>, prevReading: ReadingEntity | null = null) {
  const state = new Map<string, { active: boolean }>();
  const dataSource = {
    getRepository: (entity: unknown) => {
      if (entity === BatchEntity) return { findOne: jest.fn().mockResolvedValue(batch), find: jest.fn().mockResolvedValue([batch]) };
      if (entity === AppSettingEntity) return { findOne: jest.fn().mockResolvedValue({ key: 'notifications', value: settings }) };
      return { findOne: jest.fn().mockResolvedValue(prevReading) };
    },
    query: jest.fn((sql: string, [batchId, kind]: [number, string]) => {
      const key = `${batchId}:${kind}`;
      const current = state.get(key);
      if (sql.startsWith('SELECT')) return Promise.resolve(current ? [{}] : []);
      if (sql.includes('DO NOTHING')) {
        if (current) return Promise.resolve([]);
        state.set(key, { active: false });
        return Promise.resolve([{}]);
      }
      if (sql.includes('DO UPDATE')) {
        if (current?.active) return Promise.resolve([]);
        state.set(key, { active: true });
        return Promise.resolve([{}]);
      }
      // UPDATE … SET active = false (TypeORM: [rows, count])
      if (current?.active) {
        current.active = false;
        return Promise.resolve([[{}], 1]);
      }
      return Promise.resolve([[], 0]);
    }),
  } as unknown as DataSource;
  return { dataSource, state };
}

function setup(opts: {
  readings: ReadingEntity[];
  batch?: BatchEntity;
  settings?: Partial<NotificationSettings>;
  estimate?: { abv: number | null; expectedAbv: number | null };
  prevReading?: ReadingEntity;
}) {
  const batch = opts.batch ?? makeBatch();
  const { dataSource, state } = fakeDataSource(batch, opts.settings ?? {}, opts.prevReading ?? null);
  const sent: PushPayload[] = [];
  const push = { sendToAll: jest.fn((p: PushPayload) => (sent.push(p), Promise.resolve({ sent: 1, removed: 0, failed: 0 }))) };
  const batches = { getReadings: jest.fn().mockResolvedValue(opts.readings) };
  const fermentation = {
    estimate: jest.fn().mockResolvedValue(opts.estimate ?? { abv: 4.6, expectedAbv: 4.9 }),
    // No airlock changes in these batches: rates pass through unchanged.
    withComparableRates: jest.fn((_batch: unknown, readings: unknown) => Promise.resolve(readings)),
  };
  const service = new AlertsService(
    dataSource,
    {} as ReadingsService,
    batches as unknown as BatchesService,
    fermentation as unknown as FermentationService,
    push as unknown as PushService,
  );
  (service as unknown as { bootedAt: number }).bootedAt = 0;
  const settings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...opts.settings };
  const last = opts.readings[opts.readings.length - 1];
  const justAfter = new Date((last?.recordedAt.getTime() ?? PITCH) + 1000);
  return { service, sent, state, batch, settings, last, justAfter, fermentation };
}

const titles = (sent: PushPayload[]) => sent.map((p) => p.title);

describe('AlertsService — fermentation started', () => {
  const v100 = (rates: number[]) => rates.map((r, i) => row('V100', PITCH + (i + 1) * 5 * MIN, 0, r));

  it('notifies once bubbling is confirmed by two more readings', async () => {
    const { service, sent, batch, justAfter } = setup({ readings: v100([0, 0.2, 0, 1.4, 2.1, 3.0]) });
    await service.checkFermentationStarted(batch, justAfter);
    expect(sent).toEqual([
      expect.objectContaining({
        title: 'Fermentation started',
        body: 'IPA 2026.10: bubbling at 3.0 bpm, 20m after pitching.',
        url: '/batches/7',
      }),
    ]);
  });

  it('waits while the start is not yet confirmed, and ignores a lone spike', async () => {
    const a = setup({ readings: v100([0, 0.2, 0, 1.4, 2.1]) });
    await a.service.checkFermentationStarted(a.batch, a.justAfter);
    const b = setup({ readings: v100([0, 3, 0, 0, 0.5, 0]) });
    await b.service.checkFermentationStarted(b.batch, b.justAfter);
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(0);
  });

  it('notifies only once per batch', async () => {
    const { service, sent, batch, justAfter } = setup({ readings: v100([0, 1.4, 2.1, 3.0]) });
    await service.checkFermentationStarted(batch, justAfter);
    await service.checkFermentationStarted(batch, justAfter);
    expect(sent).toHaveLength(1);
  });

  it('records a start that happened long ago without notifying (deploy mid-batch)', async () => {
    const { service, sent, state, batch, justAfter } = setup({ readings: v100([0, 1.4, 2.1, 3.0, ...Array<number>(20).fill(50)]) });
    await service.checkFermentationStarted(batch, justAfter);
    expect(sent).toHaveLength(0);
    expect(state.has('7:fermentation_started')).toBe(true);
  });
});

describe('AlertsService — periodic checks', () => {
  it('device offline: once, not during the grace period after start-up, then back online on the next reading', async () => {
    const readings = telemetry(10, () => 30);
    const { service, sent, settings, batch, last } = setup({ readings, prevReading: readings[readings.length - 1] });
    const later = new Date(last.recordedAt.getTime() + 40 * MIN);

    (service as unknown as { bootedAt: number }).bootedAt = later.getTime() - 10 * MIN;
    await service.checkBatch(batch, settings, later);
    expect(sent).toHaveLength(0);

    (service as unknown as { bootedAt: number }).bootedAt = 0;
    await service.checkBatch(batch, settings, later);
    await service.checkBatch(batch, settings, later);
    expect(titles(sent)).toEqual(['Airlock offline']);
    expect(sent[0].body).toBe('IPA 2026.10: no reading for 40m. Check the battery and Wi-Fi; if the device looks fine, restart the bridge.');

    const back = row('V101', later.getTime() + 5 * MIN, 30);
    await service.onReading(back, false, back.recordedAt);
    await service.onReading(back, false, back.recordedAt);
    expect(titles(sent)).toEqual(['Airlock offline', 'Airlock back online']);
    expect(sent[1].body).toBe('IPA 2026.10: readings resumed after 45m without data.');
    expect(sent[1].tag).toBe(sent[0].tag);
  });

  it('no start: after noStartHours without sustained bubbling', async () => {
    const early = setup({ readings: telemetry(20, () => 0) });
    await early.service.checkBatch(early.batch, early.settings, early.justAfter);
    const late = setup({ readings: telemetry(25, () => 0) });
    await late.service.checkBatch(late.batch, late.settings, late.justAfter);
    await late.service.checkBatch(late.batch, late.settings, late.justAfter);
    expect(early.sent).toHaveLength(0);
    expect(titles(late.sent)).toEqual(['No fermentation yet']);
  });

  it('temperature: high after two readings over the limit, back in range with hysteresis; batch limits win', async () => {
    const warm = setup({ readings: telemetry(3, () => 20, (h) => (h > 2.9 ? 24.6 : 23)) });
    await warm.service.checkBatch(warm.batch, warm.settings, warm.justAfter);
    expect(titles(warm.sent)).toEqual(['Temperature high']);
    expect(warm.sent[0].body).toContain('24.6 °C at the airlock (limit 24 °C)');

    const ownLimit = setup({
      readings: telemetry(3, () => 20, (h) => (h > 2.9 ? 24.6 : 23)),
      batch: makeBatch({ alertTempMaxC: 26 }),
    });
    await ownLimit.service.checkBatch(ownLimit.batch, ownLimit.settings, ownLimit.justAfter);
    expect(ownLimit.sent).toHaveLength(0);

    const cooled = setup({ readings: telemetry(3, () => 20, () => 23.2) });
    cooled.state.set('7:temp_high', { active: true });
    await cooled.service.checkBatch(cooled.batch, cooled.settings, cooled.justAfter);
    expect(titles(cooled.sent)).toEqual(['Temperature back in range']);
  });

  it('peak passed: once the hourly rate is below half the peak for 3 h', async () => {
    const rate = (h: number) => 60 * Math.exp(-((h - 20) ** 2) / 50);
    const before = setup({ readings: telemetry(22, rate) });
    await before.service.checkBatch(before.batch, before.settings, before.justAfter);
    const after = setup({ readings: telemetry(32, rate) });
    await after.service.checkBatch(after.batch, after.settings, after.justAfter);
    expect(titles(before.sent)).not.toContain('Peak passed');
    expect(titles(after.sent)).toEqual(['Peak passed']);
  });

  const fermentDone = (h: number) => (h < 2 ? 0 : h < 60 ? 60 * Math.exp(-((h - 20) ** 2) / 120) + 1 : 1);

  it('looks finished: under 2 bpm for 24 h with the ABV near the expected mark', async () => {
    const { service, sent, settings, batch, justAfter } = setup({ readings: telemetry(100, fermentDone), settings: { notifyPeakPassed: false } });
    await service.checkBatch(batch, settings, justAfter);
    expect(titles(sent)).toEqual(['Looks finished']);
    expect(sent[0].body).toContain('est. 4.6% ABV');
  });

  it('stalled: slow for 12 h while far below the expected ABV', async () => {
    const stall = (h: number) => (h < 2 ? 0 : h < 30 ? 40 : 1);
    const { service, sent, settings, batch, justAfter } = setup({
      readings: telemetry(45, stall),
      settings: { notifyPeakPassed: false },
      estimate: { abv: 2.1, expectedAbv: 4.9 },
    });
    await service.checkBatch(batch, settings, justAfter);
    expect(titles(sent)).toEqual(['Fermentation may be stalled']);
    expect(sent[0].body).toContain('only ~2.1% of the expected 4.9% ABV');
  });

  it('respects the switches', async () => {
    const { service, sent, settings, batch, justAfter } = setup({
      readings: telemetry(25, () => 0, () => 30),
      settings: { notifyNoStart: false, notifyTemperature: false },
    });
    await service.checkBatch(batch, settings, justAfter);
    expect(sent).toHaveLength(0);
  });
});

describe('AlertsService — device rebooted', () => {
  it('is off by default and sends when switched on', async () => {
    const reading = row('V100', PITCH + HOUR, 3, 0);
    const off = setup({ readings: [reading] });
    await off.service.onReading(reading, true, reading.recordedAt);
    const on = setup({ readings: [reading], settings: { notifyDeviceRebooted: true } });
    await on.service.onReading(reading, true, reading.recordedAt);
    expect(off.sent).toHaveLength(0);
    expect(titles(on.sent)).toEqual(['Airlock restarted']);
  });
});
