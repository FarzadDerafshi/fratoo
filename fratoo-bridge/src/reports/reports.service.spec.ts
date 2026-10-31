import { writeFileSync } from 'fs';
import { BatchEntity } from '../database/entities/batch.entity';
import { BatchEventEntity } from '../database/entities/batch-event.entity';
import { GravityReadingEntity } from '../database/entities/gravity-reading.entity';
import { ReadingEntity } from '../database/entities/reading.entity';
import {
  buildGasSeries,
  calibrate,
  estimateAt,
  estimateBatch,
  gasAt,
  resolveBubbleVolume,
} from '../fermentation/abv-model';
import { toModelInputs } from '../fermentation/fermentation.service';
import { DEFAULT_FERMENTATION_SETTINGS } from '../fermentation/fermentation-settings';
import { ReadingsService } from '../readings/readings.service';
import { ReportInput, ReportsService } from './reports.service';

const settings = { ...DEFAULT_FERMENTATION_SETTINGS };
const START = new Date('2026-10-01T19:08:00Z');
const MIN = 60_000;

function makeBatch(overrides: Partial<BatchEntity> = {}): BatchEntity {
  return Object.assign(new BatchEntity(), {
    id: 1,
    batchCode: 'American <2026.10>',
    deviceId: 'airlock-1',
    brewType: 'beer',
    status: 'active',
    volumeLiters: 24,
    addedSugarG: 1500,
    notes: 'AMERICAN PALE ALE.\nYeast at 27C.',
    ogValue: 11,
    ogUnit: 'brix',
    ogIncludesSugar: true,
    targetAbv: null,
    bubbleVolumeMl: null,
    calibratedBubbleVolumeMl: null,
    calibrationPoints: 0,
    shareCalibration: true,
    yeastStrain: null,
    yeastAttenuation: null,
    pitchedAt: null,
    pitchTempC: null,
    hops: null,
    primingSugarG: null,
    bottledVolumeL: null,
    bottleCount: null,
    tastingNotes: null,
    alertTempMinC: null,
    alertTempMaxC: null,
    startedAt: START,
    endedAt: null,
    createdAt: START,
    ...overrides,
  });
}

/** ~16 days of 5-minute V100/V101 readings, with an 18-hour hole on day 12 (server down). */
function makeReadings(): ReadingEntity[] {
  const rows: ReadingEntity[] = [];
  let counter = 0;
  let id = 1;
  const gapFrom = START.getTime() + 12 * 1440 * MIN;
  const gapTo = gapFrom + 18 * 60 * MIN;
  for (
    let t = START.getTime() + 30 * MIN;
    t < START.getTime() + 15.8 * 1440 * MIN;
    t += 5 * MIN
  ) {
    const day = (t - START.getTime()) / (1440 * MIN);
    const rate =
      day < 0.4
        ? 0
        : 75 * Math.exp(-((day - 3) ** 2) / 8) +
          20 * Math.exp(-((day - 11.5) ** 2) / 0.6) +
          4;
    counter += rate * 5;
    if (t > gapFrom && t < gapTo) continue;
    const at = new Date(t);
    const temp = 22 + Math.sin(day) * 0.8;
    rows.push(
      Object.assign(new ReadingEntity(), {
        id: id++,
        deviceId: 'airlock-1',
        pin: 'V101',
        value: (temp + 1.145) / 0.9133,
        bubbleRate: 0,
        recordedAt: at,
      }),
    );
    rows.push(
      Object.assign(new ReadingEntity(), {
        id: id++,
        deviceId: 'airlock-1',
        pin: 'V100',
        value: Math.round(counter),
        bubbleRate: rate,
        recordedAt: new Date(t + 1000),
      }),
    );
  }
  return rows;
}

function makeInput(
  batch = makeBatch(),
  withGravity = true,
  events: BatchEventEntity[] = [],
): ReportInput {
  const readings = makeReadings();
  const gravity: GravityReadingEntity[] = withGravity
    ? [
        Object.assign(new GravityReadingEntity(), {
          id: 7,
          batchId: 1,
          measuredAt: new Date(START.getTime() + 14.8 * 1440 * MIN),
          value: 5,
          unit: 'brix',
          excludeFromCalibration: false,
          notes: 'Refractometer <first>',
          createdAt: START,
        }),
      ]
    : [];
  const inputs = toModelInputs(batch);
  const series = buildGasSeries(readings, settings);
  const { bubbleVolumeMl } = resolveBubbleVolume(
    inputs,
    calibrate(inputs, gravity, series, settings),
    null,
    settings,
  );
  const abvAt = (t: Date) =>
    estimateAt(gasAt(series, t, settings), bubbleVolumeMl, inputs, settings)
      .abv;
  const first = readings[0].recordedAt.getTime();
  const last = readings[readings.length - 1].recordedAt.getTime();
  const abvSeries: { t: Date; abv: number | null }[] = [];
  for (let t = first; t <= last; t += 3_600_000)
    abvSeries.push({ t: new Date(t), abv: abvAt(new Date(t)) });

  return {
    batch,
    readings,
    stats: ReadingsService.computeStats(readings),
    estimate: {
      ...estimateBatch(inputs, readings, gravity, null, settings),
      settings,
    },
    gravity,
    events,
    abvSeries,
    abvAt,
    version: 'v2.2.1 (test)',
  };
}

describe('ReportsService', () => {
  const service = new ReportsService();

  it('renders the ABV estimate, calibration badge and gravity readings', () => {
    const html = service.generateReportHtml(makeInput());
    expect(html).toContain('Estimated ABV');
    expect(html).toContain('Calibrated from 1 gravity reading');
    expect(html).toContain('OG ceiling');
    expect(html).toContain('5.0 °Bx');
    expect(html).toContain('Implied volume');
    expect(html).toContain('Active · day');
    expect(html).toContain('v2.2.1 (test)');
    if (process.env.REPORT_SAMPLE)
      writeFileSync(process.env.REPORT_SAMPLE, html);
  });

  it('escapes user text', () => {
    const html = service.generateReportHtml(makeInput());
    expect(html).toContain('American &lt;2026.10&gt;');
    expect(html).toContain('Refractometer &lt;first&gt;');
    expect(html).not.toContain('<2026.10>');
  });

  it('marks gaps in the chart data and breaks the lines there', () => {
    const html = service.generateReportHtml(makeInput());
    const data = JSON.parse(/var data = (\{.*\});/.exec(html)![1]) as {
      gaps: unknown[];
      rate: { y: number | null }[];
    };
    expect(data.gaps).toHaveLength(1);
    expect(data.rate.some((p) => p.y === null)).toBe(true);
  });

  it('says uncalibrated and shows no gravity table without readings', () => {
    const html = service.generateReportHtml(
      makeInput(
        makeBatch({
          status: 'completed',
          endedAt: new Date(START.getTime() + 16 * 1440 * MIN),
        }),
        false,
      ),
    );
    expect(html).toContain('Uncalibrated');
    expect(html).toContain('No gravity readings recorded');
    expect(html).toContain('Completed · 17 days');
  });

  it('shows the brew log, bottling and events', () => {
    const batch = makeBatch({
      status: 'completed',
      endedAt: new Date(START.getTime() + 15.7 * 1440 * MIN),
      yeastStrain: 'US-05 <dry>',
      yeastAttenuation: 78,
      pitchedAt: new Date(START.getTime() + 5 * 60 * MIN),
      pitchTempC: 19,
      hops: 'Cascade 30 g @ 10 min',
      primingSugarG: 140,
      bottledVolumeL: 22,
      bottleCount: 44,
      tastingNotes: 'Crisp, dry.',
    });
    const dryHop = Object.assign(new BatchEventEntity(), {
      id: 1,
      batchId: 1,
      occurredAt: new Date(START.getTime() + 11.4 * 1440 * MIN),
      kind: 'dry_hop',
      notes: 'Cascade 50 g',
      createdAt: START,
    });
    const input = makeInput(batch, true, [dryHop]);
    const html = service.generateReportHtml(input);

    expect(html).toContain('Brew log');
    expect(html).toContain('US-05 &lt;dry&gt;');
    expect(html).toContain('at 19.0 °C');
    expect(html).toContain('from pitch');
    expect(html).toContain('Pitch → sustained bubbling');
    expect(html).toContain('Cascade 30 g @ 10 min');
    expect(html).toContain('Dry hop');
    expect(html).toContain('Bottled ABV');
    expect(html).toContain('volumes CO₂');
    expect(html).toContain('kcal per 330 mL');
    expect(html).toContain('Crisp, dry.');
    expect(html).toContain('in the bottle');
    expect(html).toMatch(
      /\d+% attenuation: yeast 78%, \d+% of the OG from sugar/,
    );
    expect(html).not.toContain('roughly another');

    const data = JSON.parse(/var data = (\{.*\});/.exec(html)![1]) as {
      markers: { kind: string; label: string }[];
    };
    expect(data.markers).toContainEqual(
      expect.objectContaining({ kind: 'event', label: 'Dry hop' }),
    );
    if (process.env.REPORT_SAMPLE_FULL)
      writeFileSync(process.env.REPORT_SAMPLE_FULL, html);
  });

  it('formats notes: short under the title, long in their own card', () => {
    const short = service.generateReportHtml(makeInput());
    expect(short).toContain(
      '<div class="notes rich"><p>AMERICAN PALE ALE.<br>Yeast at 27C.</p></div>',
    );
    expect(short).not.toContain('<h2>Notes</h2>');

    const long = service.generateReportHtml(
      makeInput(
        makeBatch({
          notes:
            'How the fermentation went\nGood:\n\n* It finished.\n* Strong start.\n\nProcess tweaks:\n\n1. Pitch at 18–19 °C.\n2. Swap sugar for DME.',
        }),
      ),
    );
    expect(long).toContain('<h2>Notes</h2>');
    expect(long).toContain(
      '<ul><li>It finished.</li><li>Strong start.</li></ul>',
    );
    expect(long).toContain(
      '<ol><li>Pitch at 18–19 °C.</li><li>Swap sugar for DME.</li></ol>',
    );
    expect(long).not.toContain('class="notes rich"');
  });

  it('labels a last day that ends before 9 PM as the latest reading', () => {
    expect(service.generateReportHtml(makeInput())).toContain(
      'Latest reading, before 9 PM',
    );
    const done = service.generateReportHtml(
      makeInput(
        makeBatch({
          status: 'completed',
          endedAt: new Date(START.getTime() + 15.8 * 1440 * MIN),
        }),
      ),
    );
    expect(done).toContain('<div class="sub">Last reading</div>');
  });

  it('shortens the device ID and explains the sugar in the expected mark', () => {
    const html = service.generateReportHtml(
      makeInput(makeBatch({ deviceId: '0123456789abcdef0123456789abcdef' })),
    );
    expect(html).toContain('01234567…cdef');
    expect(html).toMatch(/default 75%, \d+% of the OG from sugar/);
    expect(html).toContain('Measured at the airlock');
  });

  it("puts the device's name in front of the short ID when it has one", () => {
    const html = service.generateReportHtml({
      ...makeInput(makeBatch({ deviceId: '0123456789abcdef0123456789abcdef' })),
      deviceName: 'Airlock <1>',
    });
    expect(html).toContain('Airlock &lt;1&gt; (01234567…cdef)');
  });
});
