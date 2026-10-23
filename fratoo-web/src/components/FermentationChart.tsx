import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Chart,
  type ChartDataset,
  type Plugin,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Filler,
} from 'chart.js';
import 'chartjs-adapter-date-fns';
import type { AbvPoint, Reading } from '../types';
import { correctTemperature } from '../lib/temperature';
import { cssVar, useThemeVersion } from '../lib/theme';

Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Filler);

interface Point {
  x: number;
  y: number | null;
}

export interface ChartMarker {
  t: string;
  label: string;
  /** Gravity readings: dashed, label on top. Events (dry hop, bottling …): solid accent, label at the bottom. */
  kind?: 'gravity' | 'event';
}

const RANGES = [
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
  { label: 'All', hours: null },
] as const;

/** A silence longer than this between readings is drawn as a gap (the airlock reports about every 5 min). */
const GAP_MS = 20 * 60_000;

/** Breaks the line (null point) wherever consecutive points are further apart than GAP_MS. */
function withGaps(points: Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i].x - points[i - 1].x > GAP_MS) out.push({ x: points[i - 1].x + 1, y: null });
    out.push(points[i]);
  }
  return out;
}

/** Linear interpolation of the ABV series at time t. */
function abvAt(series: { t: number; abv: number }[], t: number): number | null {
  if (series.length === 0 || t < series[0].t) return null;
  for (let i = 1; i < series.length; i++) {
    if (t <= series[i].t) {
      const a = series[i - 1];
      const b = series[i];
      return a.abv + ((b.abv - a.abv) * (t - a.t)) / (b.t - a.t || 1);
    }
  }
  return series[series.length - 1].abv;
}

interface OverlayOptions {
  gaps: [number, number][];
  markers: { x: number; label: string; event: boolean }[];
  gapColor: string;
  inkColor: string;
  eventColor: string;
  bgColor: string;
}

// Draws shaded no-data gaps behind the lines, and gravity-reading (dashed)
// and event (solid) markers on top, clipped to the plot area.
const overlays: Plugin<'line'> = {
  id: 'fratooOverlays',
  beforeDatasetsDraw(chart) {
    const o = (chart.options.plugins as unknown as { fratooOverlays: OverlayOptions }).fratooOverlays;
    const { ctx, chartArea: a, scales } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.rect(a.left, a.top, a.width, a.height);
    ctx.clip();
    ctx.fillStyle = o.gapColor;
    for (const [t0, t1] of o.gaps) {
      const x0 = scales.x.getPixelForValue(t0);
      const x1 = scales.x.getPixelForValue(t1);
      ctx.fillRect(x0, a.top, x1 - x0, a.height);
    }
    ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const o = (chart.options.plugins as unknown as { fratooOverlays: OverlayOptions }).fratooOverlays;
    const { ctx, chartArea: a, scales } = chart;
    ctx.save();
    ctx.font = '600 11px "IBM Plex Sans", system-ui, sans-serif';
    for (const m of o.markers) {
      const x = scales.x.getPixelForValue(m.x);
      if (x < a.left || x > a.right) continue;
      const color = m.event ? o.eventColor : o.inkColor;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(m.event ? [] : [4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, a.top);
      ctx.lineTo(x, a.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      const w = ctx.measureText(m.label).width + 14;
      const left = Math.min(Math.max(x - w / 2, a.left), a.right - w);
      const top = m.event ? a.bottom - 26 : a.top + 6;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(left, top, w, 20, 6);
      ctx.fill();
      ctx.fillStyle = m.event ? '#ffffff' : o.bgColor;
      ctx.fillText(m.label, left + 7, top + 14);
    }
    ctx.restore();
  },
};

interface Props {
  readings: Reading[];
  abvSeries: AbvPoint[];
  markers: ChartMarker[];
}

export function FermentationChart({ readings, abvSeries, markers }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rangeHours, setRangeHours] = useState<number | null>(null);
  const [show, setShow] = useState({ rate: true, temp: true, abv: false });
  const themeVersion = useThemeVersion();

  const data = useMemo(() => {
    const v100: Point[] = [];
    const v101: Point[] = [];
    for (const r of readings) {
      const x = new Date(r.recordedAt).getTime();
      if (isNaN(x)) continue;
      if (r.pin === 'V100') v100.push({ x, y: r.bubbleRate });
      if (r.pin === 'V101') v101.push({ x, y: correctTemperature(r.value) });
    }
    v100.sort((a, b) => a.x - b.x);
    v101.sort((a, b) => a.x - b.x);

    const gaps: [number, number][] = [];
    for (let i = 1; i < v100.length; i++) {
      if (v100[i].x - v100[i - 1].x > GAP_MS) gaps.push([v100[i - 1].x, v100[i].x]);
    }

    // ABV sampled at the bubble readings' times, so the tooltip lines up across all three series.
    const abvPts = abvSeries
      .filter((p) => p.abv !== null)
      .map((p) => ({ t: new Date(p.t).getTime(), abv: p.abv as number }));
    const abv: Point[] = v100.map((p) => ({ x: p.x, y: abvAt(abvPts, p.x) }));

    const latest = Math.max(v100.at(-1)?.x ?? 0, v101.at(-1)?.x ?? 0);
    return { v100: withGaps(v100), v101: withGaps(v101), abv: withGaps(abv), gaps, latest, hasAbv: abvPts.length > 0 };
  }, [readings, abvSeries]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const rate = cssVar('--chart-rate');
    const temp = cssVar('--chart-temp');
    const abvColor = cssVar('--chart-abv');
    const grid = cssVar('--chart-grid');
    const muted = cssVar('--muted');
    const min = rangeHours === null ? undefined : data.latest - rangeHours * 3_600_000;

    const datasets: ChartDataset<'line', Point[]>[] = [];
    if (show.rate) {
      datasets.push({
        label: 'Bubble rate',
        data: data.v100,
        yAxisID: 'y',
        borderColor: rate,
        backgroundColor: cssVar('--chart-rate-fill'),
        borderWidth: 2,
        tension: 0.2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
        spanGaps: false,
      });
    }
    if (show.temp) {
      datasets.push({
        label: 'Temperature',
        data: data.v101,
        yAxisID: 'y1',
        borderColor: temp,
        borderWidth: 2,
        tension: 0.2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: false,
        spanGaps: false,
      });
    }
    if (show.abv && data.hasAbv) {
      datasets.push({
        label: 'ABV',
        data: data.abv,
        yAxisID: 'y2',
        borderColor: abvColor,
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: false,
        spanGaps: true,
      });
    }

    const overlayOptions: OverlayOptions = {
      gaps: data.gaps,
      markers: markers.map((m) => ({ x: new Date(m.t).getTime(), label: m.label, event: m.kind === 'event' })),
      gapColor: cssVar('--chart-gap'),
      inkColor: cssVar('--ink'),
      eventColor: '#b07a06',
      bgColor: cssVar('--surface'),
    };
    const tick = { color: muted, font: { family: '"IBM Plex Mono", monospace', size: 11 } };

    const chart = new Chart<'line', Point[]>(canvasRef.current, {
      type: 'line',
      data: { datasets },
      plugins: [overlays],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(ctx) {
                const v = ctx.parsed.y as number;
                if (ctx.dataset.yAxisID === 'y') return ` Bubble rate: ${v.toFixed(1)} bpm`;
                if (ctx.dataset.yAxisID === 'y1') return ` Temperature: ${v.toFixed(2)} °C`;
                return ` ABV: ${v.toFixed(2)}%`;
              },
            },
          },
          ...({ fratooOverlays: overlayOptions } as object),
        },
        scales: {
          x: {
            type: 'time',
            min,
            time: {
              tooltipFormat: 'MMM d, HH:mm',
              displayFormats: { minute: 'HH:mm', hour: 'MMM d HH:mm', day: 'MMM d' },
            },
            ticks: { ...tick, maxTicksLimit: 8, maxRotation: 0 },
            grid: { color: grid },
            border: { display: false },
          },
          y: {
            type: 'linear',
            position: 'left',
            display: show.rate,
            suggestedMin: 0,
            ticks: { ...tick, color: rate },
            grid: { color: grid },
            border: { display: false },
          },
          y1: {
            type: 'linear',
            position: 'right',
            display: show.temp,
            ticks: { ...tick, color: temp },
            grid: { drawOnChartArea: false },
            border: { display: false },
          },
          y2: {
            type: 'linear',
            position: 'right',
            display: show.abv && data.hasAbv,
            min: 0,
            ticks: { ...tick, color: abvColor, callback: (v) => `${v}%` },
            grid: { drawOnChartArea: false },
            border: { display: false },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [data, markers, rangeHours, show, themeVersion]);

  const series = [
    { key: 'rate' as const, label: 'Bubble rate', color: 'var(--chart-rate)' },
    { key: 'temp' as const, label: 'Temperature', color: 'var(--chart-temp)' },
    ...(data.hasAbv ? [{ key: 'abv' as const, label: 'ABV', color: 'var(--chart-abv)' }] : []),
  ];

  return (
    <section className="card">
      <div className="chart-toolbar">
        <h2 className="card-title">Fermentation activity</h2>
        <div className="series-chips">
          {series.map((s) => (
            <button
              key={s.key}
              type="button"
              className="series-chip"
              aria-pressed={show[s.key]}
              onClick={() => setShow((v) => ({ ...v, [s.key]: !v[s.key] }))}
            >
              <span
                className={s.key === 'abv' ? 'series-swatch dashed' : 'series-swatch'}
                style={{ background: s.color, color: s.color }}
              />
              {s.label}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.label} type="button" aria-pressed={rangeHours === r.hours} onClick={() => setRangeHours(r.hours)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-canvas-wrap">
        <canvas ref={canvasRef} role="img" aria-label="Bubble rate and temperature over the batch" />
      </div>
      <div className="chart-legend">
        <span>Left axis: bubbles per minute</span>
        <span>Right axis: °C{show.abv && data.hasAbv ? ' and ABV %' : ''}</span>
        {data.gaps.length > 0 && <span>Shaded: no readings received (bubbles were still counted)</span>}
        {markers.some((m) => m.kind !== 'event') && <span>Dashed line: gravity reading</span>}
        {markers.some((m) => m.kind === 'event') && <span>Solid line: logged event</span>}
      </div>
    </section>
  );
}
