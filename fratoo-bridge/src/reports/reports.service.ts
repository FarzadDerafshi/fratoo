import { Injectable } from '@nestjs/common';
import { BatchEntity } from '../database/entities/batch.entity';
import {
  BatchEventEntity,
  BatchEventKind,
} from '../database/entities/batch-event.entity';
import { GravityReadingEntity } from '../database/entities/gravity-reading.entity';
import { ReadingEntity } from '../database/entities/reading.entity';
import {
  correctTemperature,
  sustainedStartIndex,
} from '../common/fermentation-math';
import { isLongNote, renderNotesHtml } from '../common/notes-format';
import type {
  BatchEstimate,
  BubbleVolumeSource,
} from '../fermentation/abv-model';
import type { FermentationSettings } from '../fermentation/fermentation-settings';
import type { ReadingWindowStats } from '../readings/readings.service';

// Caps the number of points sent to Chart.js so a multi-week, 12k-row batch
// still renders (and prints) instantly. Endpoints are always preserved.
const CHART_MAX_POINTS = 800;

/** Same rule as the dashboard chart: readings further apart than this are a gap (device or server offline). */
const GAP_MS = 20 * 60_000;
/** A reading-to-reading wobble is ±5–10%, so only a bigger drop below the peak is called out as one. */
const MIN_SHOWN_DROP_PCT = 15;

/** Everything the report shows — gathered by BatchesController from the same services the dashboard uses. */
export interface ReportInput {
  batch: BatchEntity;
  readings: ReadingEntity[];
  stats: ReadingWindowStats;
  estimate: BatchEstimate & { settings: FermentationSettings };
  gravity: GravityReadingEntity[];
  /** Dry hop, bottling, disturbances … — chart markers and the brew log. */
  events: BatchEventEntity[];
  /** From FermentationService.abvSeries() — the dashboard's ABV-over-time line. */
  abvSeries: { t: Date; abv: number | null }[];
  /** From FermentationService.abvTimeline() — ABV at any moment, for the daily snapshots. */
  abvAt: (t: Date) => number | null;
  /** Product version + commit, printed in the footnote. */
  version: string;
  /** The device's name from Settings → Devices, if it has one. */
  deviceName?: string | null;
}

interface DailySnapshot {
  day: number;
  timestamp: string;
  cumulative: number;
  bubbleRate: number;
  tempC: number | null;
  abv: number | null;
  /** Events logged on this calendar day, e.g. "Bottling" — explains an odd rate. */
  events: string[];
  /** The last day ended before 9 PM, so its row is the latest reading rather than a 9 PM snapshot. */
  beforeNine: boolean;
}

/** A last-day row further than this before 21:00 is labelled as the latest reading, not a 9 PM snapshot. */
const SNAPSHOT_TOLERANCE_S = 30 * 60;

interface Highlights {
  peakRate: number | null;
  peakTs: string | null;
  maxTemp: number | null;
  minTemp: number | null;
  lagSeconds: number | null;
  /** True when the lag is measured from the pitch time rather than the batch start. */
  lagFromPitch: boolean;
}

type Point = { x: string; y: number | null };

interface ChartData {
  rate: Point[];
  temp: Point[];
  abv: Point[];
  gaps: [string, string][];
  markers: { x: string; label: string; kind: 'gravity' | 'event' }[];
  abvMax: number | null;
}

const EVENT_LABELS: Record<BatchEventKind, string> = {
  dry_hop: 'Dry hop',
  addition: 'Addition',
  temperature: 'Temperature change',
  disturbance: 'Disturbance',
  bottling: 'Bottling',
  other: 'Note',
};

const BUBBLE_SOURCE_LABELS: Record<BubbleVolumeSource, string> = {
  'batch-override': 'manual override',
  'batch-calibration': "this batch's readings",
  learned: 'learned from other batches',
  default: 'default (uncalibrated)',
};

/**
 * Generates the self-contained "Download Batch Report" HTML document in the
 * 2.2 dashboard design: batch header, ABV estimate (same calibrated model as
 * the dashboard), activity/temperature/time, a Chart.js trend chart with ABV
 * line, gaps and gravity markers, the gravity readings, fermentation
 * highlights, daily 21:00 snapshots and notes. Originally a port of
 * includes/class-fratoo-report.php in the WordPress plugin (see
 * ProjectDocs/ARCHITECTURE.md); the PHP one keeps the old layout. Streamed as
 * a file download by BatchesController.
 */
@Injectable()
export class ReportsService {
  reportFilename(batch: BatchEntity): string {
    const slug =
      batch.batchCode
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'batch';
    const date = new Date().toISOString().slice(0, 10);
    return `fratoo-report-${slug}-${date}.html`;
  }

  generateReportHtml(input: ReportInput): string {
    const v100 = input.readings.filter((r) => r.pin === 'V100');
    const v101 = input.readings.filter((r) => r.pin === 'V101');

    const snapshots = this.buildDailySnapshots(
      v100,
      v101,
      input.batch.startedAt,
      input.abvAt,
      input.events,
    );
    const highlights = this.computeHighlights(
      v100,
      v101,
      input.batch.pitchedAt ?? input.batch.startedAt,
    );
    highlights.lagFromPitch = input.batch.pitchedAt !== null;
    const chartData = this.buildChartData(v100, v101, input);

    return this.renderHtml(input, snapshots, highlights, chartData);
  }

  // MODULE 1 — Daily 21:00 snapshots. Single chronological pass over V100,
  // carrying a running cumulative bubble total (summing only positive
  // deltas — same reboot-safe rule as ReadingsService.insertReading()),
  // bucketed by calendar day, keeping whichever row's clock time is closest
  // to 21:00:00.
  private buildDailySnapshots(
    v100Rows: ReadingEntity[],
    v101Rows: ReadingEntity[],
    startedAt: Date,
    abvAt: (t: Date) => number | null,
    events: BatchEventEntity[],
  ): DailySnapshot[] {
    if (v100Rows.length === 0) return [];

    const targetSeconds = 21 * 3600;
    let cumulative = 0;
    let prevValue: number | null = null;

    interface DayBucket {
      dt: Date;
      distance: number;
      timestamp: string;
      cumulative: number;
      bubbleRate: number;
    }
    const byDay = new Map<string, DayBucket>();

    for (const row of v100Rows) {
      if (prevValue !== null) {
        const delta = row.value - prevValue;
        if (delta > 0) cumulative += delta;
      }
      prevValue = row.value;

      const dt = row.recordedAt;
      const dayKey = dt.toISOString().slice(0, 10);
      const seconds =
        dt.getUTCHours() * 3600 + dt.getUTCMinutes() * 60 + dt.getUTCSeconds();
      const distance = Math.abs(seconds - targetSeconds);

      const existing = byDay.get(dayKey);
      if (!existing || distance < existing.distance) {
        byDay.set(dayKey, {
          dt,
          distance,
          timestamp: formatTimestamp(dt),
          cumulative,
          bubbleRate: row.bubbleRate,
        });
      }
    }

    const dayKeys = Array.from(byDay.keys()).sort();
    const startDateKey = startedAt.toISOString().slice(0, 10);
    const startDate = new Date(`${startDateKey}T00:00:00Z`);

    return dayKeys.map((dayKey, index) => {
      const bucket = byDay.get(dayKey)!;
      const bucketSeconds =
        bucket.dt.getUTCHours() * 3600 +
        bucket.dt.getUTCMinutes() * 60 +
        bucket.dt.getUTCSeconds();
      const dayDate = new Date(`${dayKey}T00:00:00Z`);
      const dayNumber =
        Math.round((dayDate.getTime() - startDate.getTime()) / 86_400_000) + 1;

      return {
        day: dayNumber > 0 ? dayNumber : index + 1,
        timestamp: bucket.timestamp,
        cumulative: bucket.cumulative,
        bubbleRate: bucket.bubbleRate,
        tempC: this.nearestTemperature(v101Rows, bucket.dt),
        abv: abvAt(bucket.dt),
        events: events
          .filter((e) => e.occurredAt.toISOString().slice(0, 10) === dayKey)
          .map((e) => EVENT_LABELS[e.kind] ?? e.kind),
        beforeNine:
          index === dayKeys.length - 1 &&
          bucketSeconds < targetSeconds - SNAPSHOT_TOLERANCE_S,
      };
    });
  }

  // Finds the V101 reading whose timestamp is closest to `target` (the
  // device sends V99/V100/V101 in the same ~5min wake cycle, so this is
  // normally a few seconds away).
  private nearestTemperature(
    v101Rows: ReadingEntity[],
    target: Date,
  ): number | null {
    let bestDiff: number | null = null;
    let bestVal: number | null = null;

    for (const row of v101Rows) {
      const diff = Math.abs(row.recordedAt.getTime() - target.getTime());
      if (bestDiff === null || diff < bestDiff) {
        bestDiff = diff;
        bestVal = correctTemperature(row.value);
      }
    }

    return bestVal;
  }

  // MODULE 2 — Key highlights (peak velocity, thermal range, lag phase).
  // The lag is measured from `from` — the pitch time when known, since the
  // yeast often goes in hours after the batch is started.
  private computeHighlights(
    v100Rows: ReadingEntity[],
    v101Rows: ReadingEntity[],
    from: Date,
  ): Highlights {
    let peakRate: number | null = null;
    let peakTs: string | null = null;

    for (const row of v100Rows) {
      if (peakRate === null || row.bubbleRate > peakRate) {
        peakRate = row.bubbleRate;
        peakTs = formatTimestamp(row.recordedAt);
      }
    }

    let maxTemp: number | null = null;
    let minTemp: number | null = null;
    for (const row of v101Rows) {
      const t = correctTemperature(row.value);
      if (maxTemp === null || t > maxTemp) maxTemp = t;
      if (minTemp === null || t < minTemp) minTemp = t;
    }

    return {
      peakRate,
      peakTs,
      maxTemp,
      minTemp,
      lagSeconds: this.lagPhaseSeconds(v100Rows, from),
      lagFromPitch: false,
    };
  }

  // Lag = time to the first reading of sustained bubbling — the shared rule
  // in sustainedStartIndex() (common/fermentation-math.ts).
  private lagPhaseSeconds(
    v100Rows: ReadingEntity[],
    startedAt: Date,
  ): number | null {
    const i = sustainedStartIndex(v100Rows.map((r) => r.bubbleRate));
    if (i < 0) return null;
    return Math.max(
      0,
      Math.round(
        (v100Rows[i].recordedAt.getTime() - startedAt.getTime()) / 1000,
      ),
    );
  }

  // MODULE 3 — Chart series, decimated to CHART_MAX_POINTS per series with
  // first/last points always preserved. Gaps are found on the full V100
  // series (decimated points are often > GAP_MS apart anyway), then a null
  // point breaks each line wherever a gap falls between two plotted points.
  private buildChartData(
    v100Rows: ReadingEntity[],
    v101Rows: ReadingEntity[],
    input: ReportInput,
  ): ChartData {
    const gaps: [number, number][] = [];
    for (let i = 1; i < v100Rows.length; i++) {
      const a = v100Rows[i - 1].recordedAt.getTime();
      const b = v100Rows[i].recordedAt.getTime();
      if (b - a > GAP_MS) gaps.push([a, b]);
    }

    const rate = withGaps(
      this.decimate(v100Rows).map((r) => ({
        t: r.recordedAt.getTime(),
        y: r.bubbleRate,
      })),
      gaps,
    );
    const temp = withGaps(
      this.decimate(v101Rows).map((r) => ({
        t: r.recordedAt.getTime(),
        y: correctTemperature(r.value),
      })),
      gaps,
    );
    const abv = input.abvSeries
      .filter((p) => p.abv !== null)
      .map((p) => ({ x: p.t.toISOString(), y: round(p.abv!, 3) }));

    const markers: ChartData['markers'] = [
      ...input.estimate.calibration.points.map((p) => ({
        x: p.measuredAt.toISOString(),
        label: [
          formatGravityValue(p.value, p.unit),
          p.measuredAbv !== null ? formatPercent(p.measuredAbv) : null,
        ]
          .filter(Boolean)
          .join(' · '),
        kind: 'gravity' as const,
      })),
      ...input.events.map((e) => ({
        x: e.occurredAt.toISOString(),
        label: EVENT_LABELS[e.kind] ?? e.kind,
        kind: 'event' as const,
      })),
    ];

    const ceiling = Math.max(
      input.estimate.maxAbv ?? 0,
      ...abv.map((p) => p.y ?? 0),
    );

    return {
      rate,
      temp,
      abv,
      gaps: gaps.map(([a, b]) => [
        new Date(a).toISOString(),
        new Date(b).toISOString(),
      ]),
      markers,
      // Whole percent, so the ABV axis ends on a round tick.
      abvMax: ceiling > 0 ? Math.ceil(ceiling * 1.1) : null,
    };
  }

  private decimate<T>(rows: T[]): T[] {
    const count = rows.length;
    if (count <= CHART_MAX_POINTS || count === 0) return rows;

    const step = count / CHART_MAX_POINTS;
    const out: T[] = [];
    for (let i = 0; i < count; i += step) {
      out.push(rows[Math.floor(i)]);
    }

    const last = rows[count - 1];
    if (out[out.length - 1] !== last) out.push(last);

    return out;
  }

  private formatDuration(seconds: number): string {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(' ');
  }

  // MODULE 4 — HTML / CSS template, styled after the 2.2 dashboard
  // (fratoo-web/src/index.css tokens, light theme — it's a print document).
  // All dynamic text goes through escapeHtml().
  private renderHtml(
    input: ReportInput,
    snapshots: DailySnapshot[],
    highlights: Highlights,
    chartData: ChartData,
  ): string {
    const { batch, stats, estimate, gravity } = input;
    const active = batch.status !== 'completed';
    const brewType = batch.brewType.replace(/_/g, ' ');
    const generated = formatTimestamp(new Date());
    const endMs = batch.endedAt ? batch.endedAt.getTime() : Date.now();
    const days = Math.max(
      1,
      Math.floor((endMs - batch.startedAt.getTime()) / 86_400_000) + 1,
    );
    const elapsed = this.formatDuration(
      Math.max(0, Math.round((endMs - batch.startedAt.getTime()) / 1000)),
    );
    const statusPill = active
      ? `Active · day ${days}`
      : `Completed · ${days} days`;

    // --- Header meta ------------------------------------------------------
    const ogText =
      batch.ogValue !== null && batch.ogUnit
        ? `${formatGravityValue(batch.ogValue, batch.ogUnit)}${batch.ogUnit === 'brix' && estimate.og !== null ? ` → ${formatSg(estimate.og)}` : ''}`
        : null;
    const meta = [
      metaItem('Started', formatTimestamp(batch.startedAt)),
      metaItem(
        'Ended',
        batch.endedAt ? formatTimestamp(batch.endedAt) : 'In progress',
      ),
      metaItem(
        'Volume',
        batch.volumeLiters !== null
          ? `${formatNumber(batch.volumeLiters, 1)} L · ${brewType}`
          : brewType,
      ),
      batch.addedSugarG !== null
        ? metaItem(
            'Added sugar',
            `${formatNumber(batch.addedSugarG / 1000, 2)} kg`,
          )
        : '',
      ogText
        ? metaItem(batch.ogIncludesSugar ? 'OG' : 'OG (before sugar)', ogText)
        : metaItem('OG', 'not set'),
      batch.targetAbv !== null
        ? metaItem('Target ABV', formatPercent(batch.targetAbv, 1))
        : '',
      batch.deviceId ? metaItem('Device', deviceLabel(batch.deviceId, input.deviceName)) : '',
    ].join('');

    // --- ABV card ---------------------------------------------------------
    const badge = calibrationBadge(estimate);
    const abv = estimate.co2Liters > 0 ? estimate.abv : null;
    const scale =
      estimate.maxAbv && estimate.maxAbv > 0 ? estimate.maxAbv : null;
    const pos = (v: number) =>
      `${Math.min(100, Math.max(0, (v / scale!) * 100)).toFixed(1)}%`;
    const expectedDetail = describeExpected(batch, estimate);
    const abvBar =
      scale !== null && abv !== null
        ? `<div class="abv-bar">
				<div class="abv-track">
					<div class="abv-fill" style="width:${pos(abv)}"></div>
					${estimate.expectedAbv !== null ? `<div class="abv-marker" style="left:${pos(estimate.expectedAbv)}"></div>` : ''}
					${estimate.targetAbv !== null ? `<div class="abv-marker target" style="left:${pos(estimate.targetAbv)}"></div>` : ''}
				</div>
				<div class="abv-scale"><span>0%</span><span>OG ceiling ${formatPercent(scale, 1)}</span></div>
				<p class="hint abv-legend">
					${estimate.expectedAbv !== null ? `<span><span class="abv-key"></span> expected ${formatPercent(estimate.expectedAbv, 1)}${expectedDetail ? ` <span class="legend-detail">(${escapeHtml(expectedDetail)})</span>` : ''}</span>` : ''}
					${estimate.targetAbv !== null ? `<span><span class="abv-key target"></span> target ${formatPercent(estimate.targetAbv, 1)}</span>` : ''}
				</p>
			</div>`
        : '';

    const miniStats = [
      miniStat(
        'Est. gravity',
        formatSg(estimate.estimatedSg),
        estimate.og !== null ? `from OG ${formatSg(estimate.og)}` : 'no OG set',
      ),
      miniStat(
        'Attenuation',
        estimate.apparentAttenuation !== null
          ? `${Math.round(estimate.apparentAttenuation * 100)}%`
          : '—',
        'apparent',
      ),
      miniStat(
        'CO₂ released',
        estimate.co2Liters > 0
          ? `${formatNumber(estimate.co2Liters, 1)} L`
          : '—',
        'through the airlock',
      ),
      miniStat(
        'Bubble volume',
        `${formatNumber(estimate.bubbleVolumeMl, 3)} mL`,
        BUBBLE_SOURCE_LABELS[estimate.bubbleVolumeSource],
      ),
    ].join('');

    // --- Side card --------------------------------------------------------
    const drop =
      stats.currentRate !== null && stats.peakRate
        ? Math.round((1 - stats.currentRate / stats.peakRate) * 100)
        : null;
    const sideCard = `
			<div class="side-group">
				<span class="eyebrow">Activity</span>
				${
          active
            ? `<div class="big-line"><span class="big-value">${stats.currentRate !== null ? formatNumber(stats.currentRate, 1) : '—'} <span class="big-unit">bpm now</span></span>${drop !== null && drop >= MIN_SHOWN_DROP_PCT ? `<span class="hint">↓ ${drop}% from peak</span>` : ''}</div>`
            : ''
        }
				${kv('Peak rate', stats.peakRate !== null ? `${formatNumber(stats.peakRate, 1)} bpm` : '—')}
				${kv('Total bubbles', stats.totalBubbles > 0 ? formatNumber(stats.totalBubbles, 0) : '—')}
			</div>
			<div class="divider"></div>
			<div class="side-group">
				<span class="eyebrow">Temperature</span>
				${active ? `<span class="big-value">${stats.currentTemp !== null ? formatNumber(stats.currentTemp, 1) : '—'} <span class="big-unit">°C now</span></span>` : ''}
				${kv('Average', stats.avgTemp !== null ? `${formatNumber(stats.avgTemp, 1)} °C` : '—')}
				${kv('Range', highlights.minTemp !== null && highlights.maxTemp !== null ? `${formatNumber(highlights.minTemp, 1)}–${formatNumber(highlights.maxTemp, 1)} °C` : '—')}
				<p class="hint">${TEMP_CAVEAT}</p>
			</div>
			<div class="divider"></div>
			<div class="side-group">
				<span class="eyebrow">Time</span>
				<span class="big-value">${escapeHtml(elapsed)}</span>
				${kv('Last reading', stats.lastReadingAt ? formatTimestamp(stats.lastReadingAt) : '—')}
			</div>`;

    // --- Brew log & bottling ---------------------------------------------
    const lag =
      highlights.lagSeconds !== null
        ? `${this.formatDuration(highlights.lagSeconds)} from ${highlights.lagFromPitch ? 'pitch' : 'batch start'}`
        : null;
    const brewRows = [
      batch.yeastStrain ? kv('Yeast', batch.yeastStrain) : '',
      batch.yeastAttenuation !== null
        ? kv(
            'Strain attenuation',
            `${formatNumber(batch.yeastAttenuation, 0)}%`,
          )
        : '',
      batch.pitchedAt
        ? kv(
            'Pitched',
            `${formatTimestamp(batch.pitchedAt)}${batch.pitchTempC !== null ? ` at ${formatNumber(batch.pitchTempC, 1)} °C` : ''}`,
          )
        : batch.pitchTempC !== null
          ? kv('Pitch temperature', `${formatNumber(batch.pitchTempC, 1)} °C`)
          : '',
      lag ? kv('Lag phase', lag) : '',
    ].join('');
    const hops = batch.hops ? textBlock('Hops', batch.hops) : '';
    const eventRows = input.events
      .map(
        (e) => `
				<tr>
					<td>Day ${dayOf(batch.startedAt, e.occurredAt)}<div class="sub">${escapeHtml(formatTimestamp(e.occurredAt))}</div></td>
					<td><span class="pill event">${escapeHtml(EVENT_LABELS[e.kind] ?? e.kind)}</span></td>
					<td>${e.notes ? escapeHtml(e.notes) : ''}</td>
				</tr>`,
      )
      .join('');
    const events = eventRows
      ? `<div class="text-block"><span class="mini-label">Events</span><table class="report-table events-table"><tbody>${eventRows}</tbody></table></div>`
      : '';
    const brewCard =
      brewRows || hops || events
        ? `<section class="card section-card">
				<h2>Brew log</h2>
				${brewRows ? `<div class="kv-list">${brewRows}</div>` : ''}
				${hops}
				${events}
			</section>`
        : '';

    const bottled = estimate.bottling;
    const bottlingRows = [
      batch.primingSugarG !== null && batch.endedAt
        ? kv('Bottled', formatTimestamp(batch.endedAt))
        : '',
      batch.primingSugarG !== null
        ? kv('Priming sugar', `${formatNumber(batch.primingSugarG, 0)} g`)
        : '',
      batch.bottledVolumeL !== null
        ? kv('Bottled volume', `${formatNumber(batch.bottledVolumeL, 1)} L`)
        : '',
      batch.bottleCount !== null
        ? kv('Bottles', formatNumber(batch.bottleCount, 0))
        : '',
      bottled
        ? kv(
            'Bottled ABV',
            `${formatPercent(bottled.bottledAbv)} (+${formatPercent(bottled.primingAbv)} priming)`,
          )
        : '',
      bottled
        ? kv(
            'Carbonation',
            `${formatNumber(bottled.co2Volumes, 1)} volumes CO₂`,
          )
        : '',
      estimate.caloriesPer330ml !== null
        ? kv(
            'Calories',
            `≈ ${formatNumber(estimate.caloriesPer330ml, 0)} kcal per 330 mL`,
          )
        : '',
    ].join('');
    const tasting = batch.tastingNotes
      ? textBlock('Tasting notes', batch.tastingNotes)
      : '';
    const bottlingCard =
      bottlingRows || tasting
        ? `<section class="card section-card">
				<h2>${batch.primingSugarG !== null || batch.bottleCount !== null ? 'Bottling' : 'In the glass'}</h2>
				${bottlingRows ? `<div class="kv-list">${bottlingRows}</div>` : ''}
				${tasting}
			</section>`
        : '';
    const logCards =
      brewCard && bottlingCard
        ? `<div class="grid-even">${brewCard}${bottlingCard}</div>`
        : brewCard || bottlingCard;

    const warnings = estimate.warnings.length
      ? `<ul class="warnings">${estimate.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
      : '';

    // --- Gravity readings -------------------------------------------------
    const notesById = new Map(gravity.map((g) => [g.id, g.notes]));
    const gravityRows = estimate.calibration.points
      .map((p) => {
        const day = Math.max(
          1,
          Math.floor(
            (p.measuredAt.getTime() - batch.startedAt.getTime()) / 86_400_000,
          ) + 1,
        );
        const notes = p.id !== undefined ? notesById.get(p.id) : null;
        const status = p.usable
          ? '<span class="pill good">used</span>'
          : `<span class="pill muted">${escapeHtml(p.reason ?? 'not used')}</span>`;
        return `
				<tr>
					<td>Day ${day}<div class="sub">${escapeHtml(formatTimestamp(p.measuredAt))}</div></td>
					<td class="num">${escapeHtml(formatGravityValue(p.value, p.unit))}</td>
					<td class="num">${formatSg(p.sg)}</td>
					<td class="num">${p.measuredAbv !== null ? formatPercent(p.measuredAbv) : '—'}</td>
					<td class="num">${p.predictedAbv !== null ? formatPercent(p.predictedAbv) : '—'}</td>
					<td class="num">${formatNumber(p.cumulativeBubbles, 0)}</td>
					<td class="num">${p.impliedBubbleVolumeMl !== null ? `${formatNumber(p.impliedBubbleVolumeMl, 3)} mL` : '—'}</td>
					<td>${status}${notes ? `<div class="sub">${escapeHtml(notes)}</div>` : ''}</td>
				</tr>`;
      })
      .join('');
    const gravitySection = gravityRows
      ? `<div class="table-wrap"><table class="report-table">
				<thead><tr>
					<th>When</th><th class="num">Reading</th><th class="num">SG</th><th class="num">Measured ABV</th>
					<th class="num">Model ABV</th><th class="num">Bubbles so far</th><th class="num">Implied volume</th><th>Calibration</th>
				</tr></thead>
				<tbody>${gravityRows}</tbody>
			</table></div>`
      : '<p class="empty">No gravity readings recorded for this batch.</p>';

    // --- Daily snapshots --------------------------------------------------
    const snapshotRows = snapshots
      .map(
        (row) => `
				<tr>
					<td>Day ${row.day}</td>
					<td>${escapeHtml(row.timestamp)}${row.beforeNine ? `<div class="sub">${active ? 'Latest reading, before 9 PM' : 'Last reading'}</div>` : ''}${row.events.length ? `<div class="sub">${escapeHtml(row.events.join(', '))}</div>` : ''}</td>
					<td class="num">${formatNumber(row.cumulative, 0)}</td>
					<td class="num">${formatNumber(row.bubbleRate, 2)}</td>
					<td class="num">${row.tempC !== null ? formatNumber(row.tempC, 1) : '—'}</td>
					<td class="num">${row.abv !== null ? formatPercent(row.abv) : '—'}</td>
				</tr>`,
      )
      .join('');

    const s = estimate.settings;
    const chartJson = JSON.stringify(chartData).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`Fermentation Report — ${batch.batchCode}`)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;500;600;700&family=Outfit:wght@700&display=swap" rel="stylesheet">
<style>
	:root {
		--bg: #f7f5ef;
		--surface: #ffffff;
		--surface-2: #f1eee6;
		--border: #e2ddd0;
		--ink: #111d3b;
		--muted: #5a6276;
		--brand: #142a5c;
		--brand-soft: #e3e8f3;
		--accent: #d99a12;
		--good: #1a6e3f;
		--good-soft: #ddf1e5;
		--warn: #8a5300;
		--warn-soft: #fbefd6;
		--font: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
		--font-mono: 'IBM Plex Mono', ui-monospace, Consolas, monospace;
		--font-brand: 'Outfit', var(--font);
	}
	* { box-sizing: border-box; }
	body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font); font-size: 14px; line-height: 1.5; }
	.report { max-width: 1040px; margin: 0 auto; padding: 24px 16px 48px; }
	.print-bar { display: flex; justify-content: flex-end; margin-bottom: 16px; }
	.print-btn {
		font: inherit; font-weight: 600; color: #fff; background: var(--brand); border: none;
		border-radius: 10px; padding: 10px 18px; cursor: pointer;
	}
	.print-btn:hover { background: #0b1b40; }

	.brand-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
		padding-bottom: 16px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
	.logo { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); }
	.logo-word { font-family: var(--font-brand); font-weight: 700; font-size: 24px; letter-spacing: -0.02em; }
	.brand-meta { color: var(--muted); font-size: 12px; text-align: right; }
	.brand-meta strong { display: block; color: var(--ink); font-size: 13px; text-transform: uppercase; letter-spacing: .08em; }

	.title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin-bottom: 10px; }
	h1 { margin: 0; font-size: 30px; line-height: 1.15; letter-spacing: -0.02em; }
	.pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 11px; border-radius: 999px;
		font-size: 12px; font-weight: 600; background: var(--brand-soft); color: var(--brand); white-space: nowrap; }
	.pill.good { background: var(--good-soft); color: var(--good); }
	.pill.warn { background: var(--warn-soft); color: var(--warn); }
	.pill.muted { background: var(--surface-2); color: var(--muted); font-weight: 500; white-space: normal; }
	.meta-row { display: flex; flex-wrap: wrap; gap: 6px 22px; color: var(--muted); font-size: 13px; margin-bottom: 14px; }
	.meta-row strong { color: var(--ink); font-weight: 600; }
	.notes { background: var(--surface-2); border-radius: 12px; padding: 12px 16px; font-size: 13.5px; margin-bottom: 20px; }

	.card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 20px 22px; }
	.grid-2 { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 16px; margin-bottom: 16px; }
	.eyebrow { display: block; text-transform: uppercase; letter-spacing: .1em; font-size: 11.5px; font-weight: 600; color: var(--muted); }
	.card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
	.abv-value { font-size: 64px; font-weight: 700; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
	.abv-figure { display: flex; flex-direction: column; gap: 4px; margin: 10px 0 18px; }
	.status-detail { color: var(--muted); }
	.flag { margin-left: 8px; color: var(--warn); font-weight: 600; }
	.abv-track { position: relative; height: 12px; border-radius: 999px; background: var(--surface-2); }
	.abv-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #f2c94c, #d99a12);
		-webkit-print-color-adjust: exact; print-color-adjust: exact; }
	.abv-marker { position: absolute; top: -5px; width: 3px; height: 22px; margin-left: -1px; border-radius: 2px; background: var(--ink); }
	.abv-marker.target { background: var(--accent); }
	.abv-scale { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 6px; }
	.abv-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; }
	.abv-key { display: inline-block; width: 3px; height: 12px; border-radius: 2px; background: var(--ink); vertical-align: -1px; margin-right: 4px; }
	.abv-key.target { background: var(--accent); }
	.hint { color: var(--muted); font-size: 12.5px; margin: 8px 0 0; }
	.mini-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 18px; }
	.mini-stat { background: var(--surface-2); border-radius: 12px; padding: 10px 12px; }
	.mini-label { font-size: 11.5px; color: var(--muted); }
	.mini-value { font-family: var(--font-mono); font-size: 17px; font-weight: 500; margin: 2px 0; }
	.mini-sub { font-size: 11.5px; color: var(--muted); }

	.side-card { display: flex; flex-direction: column; gap: 14px; }
	.side-group { display: flex; flex-direction: column; gap: 6px; }
	.big-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
	.big-line .hint { margin: 0; }
	.big-value { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
	.big-unit { font-size: 13px; font-weight: 500; color: var(--muted); }
	.kv { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--muted); }
	.kv strong { color: var(--ink); font-weight: 600; text-align: right; }
	.divider { height: 1px; background: var(--border); }

	.warnings { margin: 0 0 16px; padding: 12px 16px 12px 34px; border-radius: 12px; border: 1px solid var(--warn);
		background: var(--warn-soft); font-size: 13px; }

	.section { margin-bottom: 16px; }
	.section h2 { font-size: 16px; margin: 0 0 12px; }
	.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--muted); margin-bottom: 8px; }
	/* Swatches are backgrounds, which browsers drop when printing unless told otherwise. */
	.legend i { display: inline-block; width: 16px; height: 3px; border-radius: 2px; vertical-align: 3px; margin-right: 5px;
		-webkit-print-color-adjust: exact; print-color-adjust: exact; }
	.legend i.rate { background: #2c55a8; }
	.legend i.temp { background: #c26a0a; }
	.legend i.dash { background: repeating-linear-gradient(90deg, #111d3b 0 5px, transparent 5px 8px); }
	.legend i.box { height: 10px; vertical-align: -1px; background: rgba(90, 98, 118, 0.18); }
	.legend i.vline { width: 2px; height: 12px; vertical-align: -1px; background: repeating-linear-gradient(180deg, #111d3b 0 3px, transparent 3px 5px); }
	.legend i.vline.event { background: #b07a06; }
	.legend-detail { color: var(--muted); }
	.rich { font-size: 13.5px; }
	.rich > :first-child { margin-top: 0; }
	.rich > :last-child { margin-bottom: 0; }
	.rich p { margin: 0 0 8px; }
	.rich p.label { margin: 14px 0 4px; }
	.rich h4 { font-size: 14.5px; margin: 16px 0 6px; }
	.rich ul, .rich ol { margin: 0 0 8px; padding-left: 22px; }
	.rich li { margin-bottom: 4px; }
	.grid-even { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
	.section-card { margin-bottom: 16px; display: flex; flex-direction: column; gap: 12px; }
	.grid-even > .section-card { margin-bottom: 0; }
	.section-card h2 { font-size: 16px; margin: 0; }
	.kv-list { display: flex; flex-direction: column; gap: 6px; }
	.text-block { font-size: 13px; display: flex; flex-direction: column; gap: 4px; }
	.events-table td { padding: 6px 8px 6px 0; }
	.pill.event { background: var(--warn-soft); color: var(--warn); }
	.chart-box { position: relative; width: 100%; height: 340px; }

	.highlights { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
	.highlight .label { font-size: 11.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; font-weight: 600; }
	.highlight .value { font-size: 20px; font-weight: 700; margin-top: 4px; }
	.highlight .sub, td .sub { font-size: 11.5px; color: var(--muted); }

	.table-wrap { overflow-x: auto; }
	table.report-table { width: 100%; border-collapse: collapse; font-size: 13px; }
	.report-table th, .report-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
	.report-table thead th { font-size: 11.5px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .06em;
		border-bottom: 2px solid var(--border); white-space: nowrap; }
	.report-table td.num, .report-table th.num { text-align: right; }
	.report-table td.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
	.report-table tbody tr:last-child td { border-bottom: none; }
	.empty { color: var(--muted); font-style: italic; margin: 0; }
	.footnote { color: var(--muted); font-size: 11.5px; margin-top: 24px; line-height: 1.6; }

	@media screen and (max-width: 760px) {
		.grid-2, .grid-even { grid-template-columns: 1fr; }
		.mini-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.highlights { grid-template-columns: 1fr; }
		.abv-value { font-size: 52px; }
		h1 { font-size: 24px; }
		.chart-box { height: 260px; }
	}
	@media print {
		body { background: #fff; font-size: 12px; }
		.print-bar { display: none; }
		.report { max-width: none; padding: 0; }
		.card { break-inside: avoid; }
		.chart-box { height: 300px; }
		.chart-box canvas { width: 100% !important; height: 100% !important; }
		.abv-value { font-size: 52px; }
		.mini-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		.table-wrap { overflow: visible; }
		table.report-table { font-size: 10.5px; }
		.report-table th, .report-table td { padding: 6px; }
		.report-table thead th { white-space: normal; font-size: 9.5px; }
		.report-table td:first-child { white-space: nowrap; }
		.section { break-inside: avoid; }
		.report-table tr { break-inside: avoid; }
		.pill, .mini-stat, .notes, .warnings, .abv-track, .abv-marker, .abv-key { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
		.section-card, .grid-even { break-inside: avoid; }
		@page { size: A4; margin: 12mm; }
	}
</style>
</head>
<body>
<div class="report">

	<div class="print-bar">
		<button type="button" class="print-btn" onclick="window.print()">Print / Save as PDF</button>
	</div>

	<div class="brand-row">
		<span class="logo">${LOGO_SVG}<span class="logo-word">Fratoo</span></span>
		<div class="brand-meta"><strong>Fermentation report</strong>Generated ${escapeHtml(generated)} UTC</div>
	</div>

	<div class="title-row">
		<h1>${escapeHtml(batch.batchCode)}</h1>
		<span class="pill">${escapeHtml(statusPill)}</span>
	</div>
	<div class="meta-row">${meta}</div>
	${batch.notes && !isLongNote(batch.notes) ? `<div class="notes rich">${renderNotesHtml(batch.notes)}</div>` : ''}

	<div class="grid-2">
		<section class="card">
			<div class="card-head">
				<span class="eyebrow">Estimated ABV</span>
				<span class="pill ${badge.tone}">${escapeHtml(badge.text)}</span>
			</div>
			<div class="abv-figure">
				<span class="abv-value">${abv !== null ? formatPercent(abv) : '—'}</span>
				<span class="status-detail">alcohol in the fermenter${estimate.abvCapped ? '<span class="flag">capped</span>' : ''}</span>
			</div>
			${abvBar}
			<div class="mini-stats">${miniStats}</div>
			<p class="hint">${
        estimate.bottling
          ? `With ${formatNumber(batch.primingSugarG!, 0)} g priming sugar: <strong>${formatPercent(estimate.bottling.bottledAbv, 1)}</strong> in the bottle.`
          : "Bottle priming adds roughly another 0.3–0.4% ABV, which isn't counted here. Enter the priming sugar to include it."
      }</p>
		</section>
		<section class="card side-card">${sideCard}</section>
	</div>

	${warnings}

	${logCards}

	${batch.notes && isLongNote(batch.notes) ? `<section class="card section-card"><h2>Notes</h2><div class="rich">${renderNotesHtml(batch.notes)}</div></section>` : ''}

	<section class="card section">
		<h2>Fermentation trend</h2>
		<div class="legend">
			<span><i class="line rate"></i>Bubble rate (bpm, left)</span>
			<span><i class="line temp"></i>Temperature (°C, right)</span>
			${chartData.abv.length ? '<span><i class="dash"></i>Estimated ABV (%, right)</span>' : ''}
			${chartData.gaps.length ? '<span><i class="box"></i>No readings</span>' : ''}
			${chartData.markers.some((m) => m.kind === 'gravity') ? '<span><i class="vline"></i>Gravity reading</span>' : ''}
			${chartData.markers.some((m) => m.kind === 'event') ? '<span><i class="vline event"></i>Event</span>' : ''}
		</div>
		<div class="chart-box"><canvas id="report-chart"></canvas></div>
	</section>

	<section class="card section">
		<h2>Gravity readings</h2>
		${gravitySection}
	</section>

	<section class="section">
		<div class="highlights">
			<div class="card highlight">
				<div class="label">Peak fermentation velocity</div>
				${
          highlights.peakRate !== null
            ? `<div class="value">${formatNumber(highlights.peakRate, 2)} bpm</div><div class="sub">${escapeHtml(highlights.peakTs ?? '')} UTC</div>`
            : '<div class="value">—</div>'
        }
			</div>
			<div class="card highlight">
				<div class="label">Thermal range</div>
				${
          highlights.maxTemp !== null && highlights.minTemp !== null
            ? `<div class="value">${formatNumber(highlights.minTemp, 1)}–${formatNumber(highlights.maxTemp, 1)} °C</div><div class="sub">Min–max at the airlock, PCB-corrected</div>`
            : '<div class="value">—</div>'
        }
			</div>
			<div class="card highlight">
				<div class="label">Lag phase</div>
				${
          highlights.lagSeconds !== null
            ? `<div class="value">${this.formatDuration(highlights.lagSeconds)}</div><div class="sub">${highlights.lagFromPitch ? 'Pitch' : 'Batch start'} → sustained bubbling</div>`
            : '<div class="value">—</div><div class="sub">No sustained activity detected</div>'
        }
			</div>
		</div>
	</section>

	<section class="card section">
		<h2>Daily 9:00 PM snapshots <span class="hint">(UTC)</span></h2>
		${
      snapshotRows
        ? `<div class="table-wrap"><table class="report-table">
				<thead><tr>
					<th>Day</th><th>Timestamp</th><th class="num">Cumulative bubbles</th>
					<th class="num">Bubble rate (bpm)</th><th class="num">Temp (°C)</th><th class="num">Est. ABV</th>
				</tr></thead>
				<tbody>${snapshotRows}</tbody>
			</table></div>`
        : '<p class="empty">No V100 telemetry recorded for this batch.</p>'
    }
	</section>

	<p class="footnote">
		Generated ${escapeHtml(generated)} UTC by Fratoo ${escapeHtml(input.version)} from ${formatNumber(input.readings.length, 0)} telemetry rows. All times UTC.
		ABV from airlock bubbles × ${formatNumber(estimate.bubbleVolumeMl, 3)} mL/bubble (${escapeHtml(BUBBLE_SOURCE_LABELS[estimate.bubbleVolumeSource])}),
		gas volume at the measured temperature and ${formatNumber(s.pressureKpa, 1)} kPa${s.dissolvedCo2Enabled ? ', plus dissolved CO₂' : ''};
		${s.abvFormula === 'alternate' ? 'alternate (Hall)' : 'standard'} ABV formula; refractometer readings corrected with WCF ${formatNumber(s.wortCorrectionFactor, 2)} (Terrill for fermenting wort).
		Temperature calibrated via PLAATO's PCB self-heating correction (0.9133 × raw − 1.145).
	</p>

</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<script>
(function () {
	'use strict';
	if (typeof Chart === 'undefined') {
		var box = document.querySelector('.chart-box');
		if (box) box.innerHTML = '<p class="empty" style="padding:20px">Chart could not load (no internet connection). Open this report online to see the trend chart.</p>';
		return;
	}

	var data = ${chartJson};
	var t = function (iso) { return new Date(iso).getTime(); };
	var xy = function (p) { return { x: t(p.x), y: p.y }; };
	var font = "'IBM Plex Sans', system-ui, sans-serif";

	// Shaded no-data gaps and dashed gravity-reading markers, as on the dashboard.
	var overlay = {
		id: 'fratooOverlay',
		beforeDatasetsDraw: function (chart) {
			var ctx = chart.ctx, area = chart.chartArea, x = chart.scales.x;
			ctx.save();
			ctx.fillStyle = 'rgba(90, 98, 118, 0.12)';
			data.gaps.forEach(function (g) {
				var a = Math.max(area.left, x.getPixelForValue(t(g[0])));
				var b = Math.min(area.right, x.getPixelForValue(t(g[1])));
				if (b > a) ctx.fillRect(a, area.top, b - a, area.bottom - area.top);
			});
			ctx.restore();
		},
		afterDatasetsDraw: function (chart) {
			var ctx = chart.ctx, area = chart.chartArea, x = chart.scales.x;
			ctx.save();
			ctx.font = '600 11px ' + font;
			// Gravity readings: dashed navy, label at the top. Events: solid amber, label at the bottom.
			data.markers.forEach(function (m) {
				var px = x.getPixelForValue(t(m.x));
				if (px < area.left || px > area.right) return;
				var event = m.kind === 'event';
				var color = event ? '#b07a06' : '#111d3b';
				ctx.strokeStyle = color;
				ctx.setLineDash(event ? [] : [4, 4]);
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.moveTo(px, area.top);
				ctx.lineTo(px, area.bottom);
				ctx.stroke();
				ctx.setLineDash([]);
				var w = ctx.measureText(m.label).width + 12;
				var lx = Math.min(Math.max(px - w / 2, area.left), area.right - w);
				var ly = event ? area.bottom - 24 : area.top + 4;
				ctx.fillStyle = color;
				ctx.fillRect(lx, ly, w, 20);
				ctx.fillStyle = '#ffffff';
				ctx.textBaseline = 'middle';
				ctx.fillText(m.label, lx + 6, ly + 10);
			});
			ctx.restore();
		},
	};

	var datasets = [
		{ label: 'Bubble rate (bpm)', data: data.rate.map(xy), yAxisID: 'y', borderColor: '#2c55a8', backgroundColor: 'rgba(44, 85, 168, 0.1)', borderWidth: 2, tension: 0.3, pointRadius: 0, fill: true, spanGaps: false },
		{ label: 'Temperature (°C)', data: data.temp.map(xy), yAxisID: 'y1', borderColor: '#c26a0a', borderWidth: 2, tension: 0.3, pointRadius: 0, fill: false, spanGaps: false },
	];
	if (data.abv.length) {
		datasets.push({ label: 'Estimated ABV (%)', data: data.abv.map(xy), yAxisID: 'y2', borderColor: '#111d3b', borderDash: [6, 4], borderWidth: 2, tension: 0.2, pointRadius: 0, fill: false });
	}

	Chart.defaults.font.family = font;
	Chart.defaults.color = '#5a6276';
	var chart = new Chart(document.getElementById('report-chart'), {
		type: 'line',
		data: { datasets: datasets },
		plugins: [overlay],
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: false,
			interaction: { mode: 'index', intersect: false },
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: function (c) {
							var v = c.parsed.y;
							if (v === null || v === undefined) return null;
							if (c.dataset.yAxisID === 'y2') return 'ABV ' + v.toFixed(2) + '%';
							if (c.dataset.yAxisID === 'y1') return v.toFixed(1) + ' °C';
							return v.toFixed(1) + ' bpm';
						},
					},
				},
			},
			scales: {
				x: { type: 'time', time: { tooltipFormat: 'MMM d, HH:mm', displayFormats: { hour: 'MMM d HH:mm', day: 'MMM d' } }, grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, font: { size: 11 } } },
				y: { type: 'linear', position: 'left', suggestedMin: 0, title: { display: true, text: 'bpm', font: { size: 11 } }, grid: { color: 'rgba(17, 29, 59, 0.07)' }, ticks: { font: { size: 11 } } },
				y1: { type: 'linear', position: 'right', title: { display: true, text: '°C', font: { size: 11 } }, grid: { display: false }, ticks: { font: { size: 11 } } },
				y2: { type: 'linear', display: data.abv.length > 0, position: 'right', min: 0, max: data.abvMax || undefined, title: { display: true, text: 'ABV %', font: { size: 11 } }, grid: { display: false }, ticks: { font: { size: 11 }, color: '#111d3b', callback: function (v) { return v + '%'; } } },
			},
		},
	});
	// Re-fit the chart to the page width when printing (and back afterwards).
	window.addEventListener('beforeprint', function () { chart.resize(); });
	window.addEventListener('afterprint', function () { chart.resize(); });
})();
</script>
</body>
</html>`;
  }
}

// The Fratoo mark — same geometry as fratoo-web/src/components/Logo.tsx, in the light-theme navy.
const LOGO_SVG = `<svg width="34" height="32" viewBox="0 0 106 100" aria-hidden="true">
<defs><linearGradient id="fratoo-beer" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFD84D"/><stop offset="1" stop-color="#C98A0B"/></linearGradient></defs>
<path d="M22 51 C28 46 34 47 40 49 C46 51 52 50 58 47 C62 45 66 46 68 50 C72 58 72 70 66 80 C62 87 56 91 50 91 H24 C15 91 10 83 14 75 Z" fill="url(#fratoo-beer)"/>
<circle cx="34" cy="63.5" r="5" fill="#FFFFFF"/><circle cx="47" cy="76.5" r="4.3" fill="#FFFFFF"/>
<g fill="none" stroke="#111d3b" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">
<path d="M29 5 H61"/><path d="M36 9 V25 L8 70 C3 79 9 92 22 92 H58"/><path d="M53 9 V25 L66 43"/><path d="M76 75 L100 42" stroke-width="5.5"/>
</g>
<circle cx="79" cy="48" r="5.5" fill="#111d3b"/><circle cx="97" cy="69.5" r="6" fill="#111d3b"/>
</svg>`;

/** Same wording as the dashboard's ABV badge (BatchDetailPage.tsx). */
function calibrationBadge(estimate: BatchEstimate): {
  text: string;
  tone: 'good' | 'warn' | '';
} {
  const n = estimate.calibration.usablePoints;
  switch (estimate.bubbleVolumeSource) {
    case 'batch-calibration':
      return {
        text: `Calibrated from ${n} gravity reading${n === 1 ? '' : 's'}`,
        tone: 'good',
      };
    case 'learned':
      return { text: 'Calibrated from earlier batches', tone: 'good' };
    case 'batch-override':
      return { text: 'Manual bubble volume', tone: '' };
    default:
      return { text: 'Uncalibrated', tone: 'warn' };
  }
}

/** Inserts a null point between two plotted points that straddle a gap, so Chart.js breaks the line there. */
function withGaps(
  points: { t: number; y: number }[],
  gaps: [number, number][],
): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const a = points[i - 1].t;
      const b = points[i].t;
      if (gaps.some(([g0, g1]) => g0 >= a && g1 <= b))
        out.push({ x: new Date(a + 1).toISOString(), y: null });
    }
    out.push({
      x: new Date(points[i].t).toISOString(),
      y: round(points[i].y, 2),
    });
  }
  return out;
}

/** Printed with every temperature summary: the sensor sits in the airlock, not the beer. */
const TEMP_CAVEAT =
  'Measured at the airlock, not in the beer. During peak fermentation the wort typically runs 2–4 °C warmer.';

/** "01234567…cdef": the full 32-character Blynk token is noise on a report. */
function shortDeviceId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** "Airlock 1 (01234567…cdef)" when the device has a name, else just the short token. */
function deviceLabel(id: string, name: string | null | undefined): string {
  return name ? `${name} (${shortDeviceId(id)})` : shortDeviceId(id);
}

function dayOf(startedAt: Date, t: Date): number {
  return Math.max(
    1,
    Math.floor((t.getTime() - startedAt.getTime()) / 86_400_000) + 1,
  );
}

/** What the expected-ABV mark assumes, e.g. "89% attenuation: default 75%, 57% of the OG from sugar". */
function describeExpected(
  batch: BatchEntity,
  estimate: ReportInput['estimate'],
): string | null {
  if (estimate.expectedAttenuation === null) return null;
  const base =
    batch.yeastAttenuation !== null
      ? `yeast ${formatNumber(batch.yeastAttenuation, 0)}%`
      : `default ${Math.round(estimate.settings.expectedAttenuation * 100)}%`;
  const sugar =
    estimate.sugarShare >= 0.005
      ? `, ${Math.round(estimate.sugarShare * 100)}% of the OG from sugar`
      : '';
  return `${Math.round(estimate.expectedAttenuation * 100)}% attenuation: ${base}${sugar}`;
}

function textBlock(label: string, text: string): string {
  return `<div class="text-block"><span class="mini-label">${escapeHtml(label)}</span><div>${escapeHtml(text).replace(/\n/g, '<br>')}</div></div>`;
}

function metaItem(label: string, value: string): string {
  return `<span>${escapeHtml(label)} <strong>${escapeHtml(value)}</strong></span>`;
}

function miniStat(label: string, value: string, sub: string): string {
  return `<div class="mini-stat"><div class="mini-label">${escapeHtml(label)}</div><div class="mini-value">${escapeHtml(value)}</div><div class="mini-sub">${escapeHtml(sub)}</div></div>`;
}

function kv(label: string, value: string): string {
  return `<div class="kv"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function formatSg(sg: number | null): string {
  return sg !== null ? sg.toFixed(3) : '—';
}

function formatGravityValue(value: number, unit: 'sg' | 'brix'): string {
  return unit === 'brix' ? `${formatNumber(value, 1)} °Bx` : value.toFixed(3);
}

function formatPercent(n: number, decimals = 2): string {
  return `${n.toFixed(decimals)}%`;
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function formatTimestamp(d: Date): string {
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/:\d\d\.\d+Z$/, '');
}

function formatNumber(n: number, decimals: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
