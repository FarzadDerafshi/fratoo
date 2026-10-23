import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, downloadReport } from '../api/client';
import { BatchEventsPanel } from '../components/BatchEventsPanel';
import { FermentationChart, type ChartMarker } from '../components/FermentationChart';
import { GravityReadingsPanel } from '../components/GravityReadingsPanel';
import { CheckIcon, MoreIcon, WarningIcon } from '../components/Icons';
import {
  BUBBLE_SOURCE_LABELS,
  EVENT_LABELS,
  formatGravity,
  formatPercent,
  formatSg,
  optionalDateTime,
  optionalNumber,
  toDatetimeLocalValue,
} from '../lib/format';
import { isLongNote, renderNotesHtml } from '../lib/notes';
import { ago, dayNumber, formatDateTime, formatShortDateTime, liveKind, span } from '../lib/status';
import type {
  AbvPoint,
  Batch,
  BatchEvent,
  FermentationEstimate,
  FermentationStats,
  GravityReading,
  GravityUnit,
  Reading,
} from '../types';

/** Elapsed time from `startedAt` to `endedAt`, or to now if still active, as e.g. "4d 6h" or "3h 45m". */
function formatDuration(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const totalMinutes = Math.max(0, Math.floor((end - start) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Badge above the ABV figure: how much to trust it. */
function calibrationBadge(estimate: FermentationEstimate): { text: string; tone: 'good' | 'warn' | '' } {
  const n = estimate.calibration.usablePoints;
  switch (estimate.bubbleVolumeSource) {
    case 'batch-calibration':
      return { text: `Calibrated from ${n} gravity reading${n === 1 ? '' : 's'}`, tone: 'good' };
    case 'learned':
      return { text: 'Calibrated from earlier batches', tone: 'good' };
    case 'batch-override':
      return { text: 'Manual bubble volume', tone: '' };
    default:
      return { text: 'Uncalibrated — add a gravity reading', tone: 'warn' };
  }
}

function StatusLine({ batch, stats }: { batch: Batch; stats: FermentationStats }) {
  const kind = liveKind(batch.status, stats.lastReadingAt);
  const now =
    [
      stats.currentRate !== null && `${stats.currentRate.toFixed(1)} bubbles/min`,
      stats.currentTemp !== null && `${stats.currentTemp.toFixed(1)} °C`,
    ]
      .filter(Boolean)
      .join(' · ') || null;

  let title: string;
  let detail: string;
  if (kind === 'done') {
    title = 'Completed';
    detail = batch.endedAt ? `Ended ${formatDateTime(batch.endedAt)}` : '';
  } else if (kind === 'none') {
    title = 'Waiting for the first reading';
    detail = 'The airlock reports about every 5 minutes once it is connected.';
  } else if (kind === 'live') {
    title = 'Live';
    detail = [`Last reading ${ago(stats.lastReadingAt!)}`, now].filter(Boolean).join(' · ');
  } else if (kind === 'stale') {
    title = `No reading for ${span(stats.lastReadingAt!)}`;
    detail = 'The airlock reports about every 5 min. It may be reconnecting.';
  } else {
    title = `No data for ${span(stats.lastReadingAt!)}`;
    detail = 'Check the device and the server. Bubbles are still counted and will catch up.';
  }

  return (
    <div className={`status-line ${kind}`} role="status">
      <span className="status-dot" aria-hidden="true" />
      <span className="status-title">{title}</span>
      {detail && <span className="status-detail">{detail}</span>}
    </div>
  );
}

/** What the expected-ABV mark assumes, e.g. "89% attenuation: default 75%, 57% of the OG from sugar". */
function describeExpected(batch: Batch, estimate: FermentationEstimate): string | null {
  if (estimate.expectedAttenuation === null) return null;
  const base =
    batch.yeastAttenuation !== null
      ? `yeast ${batch.yeastAttenuation}%`
      : `default ${Math.round(estimate.settings.expectedAttenuation * 100)}%`;
  const sugar = estimate.sugarShare >= 0.005 ? `, ${Math.round(estimate.sugarShare * 100)}% of the OG from sugar` : '';
  return `${Math.round(estimate.expectedAttenuation * 100)}% attenuation: ${base}${sugar}`;
}

/** Shown under every temperature summary: the sensor sits in the airlock, not the beer. */
/** A reading-to-reading wobble is ±5–10%, so only a bigger drop below the peak is called out as one. */
const MIN_SHOWN_DROP_PCT = 15;
const TEMP_CAVEAT = 'Measured at the airlock, not in the beer. At peak fermentation the wort runs 2–4 °C warmer.';

function AbvCard({ batch, estimate }: { batch: Batch; estimate: FermentationEstimate }) {
  const badge = calibrationBadge(estimate);
  const expectedDetail = describeExpected(batch, estimate);
  const scale = estimate.maxAbv && estimate.maxAbv > 0 ? estimate.maxAbv : null;
  // No bubbles counted yet: "0.00%" would read as a measurement.
  const abv = estimate.co2Liters > 0 ? estimate.abv : null;
  const pos = (v: number) => `${Math.min(100, Math.max(0, (v / scale!) * 100)).toFixed(1)}%`;

  return (
    <section className="card abv-card">
      <div className="card-head">
        <span className="eyebrow">Estimated ABV</span>
        <span className={`pill ${badge.tone}`}>
          {badge.tone === 'good' && <CheckIcon />}
          {badge.text}
        </span>
      </div>
      <div className="abv-figure">
        <span className="abv-value">{formatPercent(abv)}</span>
        <span className="status-detail">
          alcohol in the fermenter
          {estimate.abvCapped && <span className="flag">capped</span>}
        </span>
      </div>
      {scale !== null && abv !== null && (
        <div className="abv-bar">
          <div className="abv-track">
            <div className="abv-fill" style={{ width: pos(abv) }} />
            {estimate.expectedAbv !== null && <div className="abv-marker" style={{ left: pos(estimate.expectedAbv) }} />}
            {estimate.targetAbv !== null && (
              <div className="abv-marker" style={{ left: pos(estimate.targetAbv), background: 'var(--accent)' }} />
            )}
          </div>
          <div className="abv-scale">
            <span style={{ left: 0 }}>0%</span>
            <span style={{ right: 0 }}>OG ceiling {formatPercent(scale, 1)}</span>
          </div>
          {(estimate.expectedAbv !== null || estimate.targetAbv !== null) && (
            <p className="hint abv-legend">
              {estimate.expectedAbv !== null && (
                <span>
                  <span className="abv-key" /> expected {formatPercent(estimate.expectedAbv, 1)}
                  {expectedDetail && <span className="legend-detail"> ({expectedDetail})</span>}
                </span>
              )}
              {estimate.targetAbv !== null && (
                <span>
                  <span className="abv-key target" /> your target {formatPercent(estimate.targetAbv, 1)}
                </span>
              )}
            </p>
          )}
        </div>
      )}
      <div className="mini-stats">
        <div className="mini-stat">
          <div className="mini-label">Est. gravity</div>
          <div className="mini-value">{formatSg(estimate.estimatedSg)}</div>
          <div className="mini-sub">{estimate.og !== null ? `from OG ${formatSg(estimate.og)}` : 'set an OG'}</div>
        </div>
        <div className="mini-stat">
          <div className="mini-label">Attenuation</div>
          <div className="mini-value">
            {estimate.apparentAttenuation !== null ? `${Math.round(estimate.apparentAttenuation * 100)}%` : '—'}
          </div>
          <div className="mini-sub">apparent</div>
        </div>
        <div className="mini-stat">
          <div className="mini-label">CO₂ released</div>
          <div className="mini-value">{estimate.co2Liters > 0 ? `${estimate.co2Liters.toFixed(1)} L` : '—'}</div>
          <div className="mini-sub">through the airlock</div>
        </div>
        <div className="mini-stat">
          <div className="mini-label">Bubble volume</div>
          <div className="mini-value">{estimate.bubbleVolumeMl.toFixed(3)} mL</div>
          <div className="mini-sub">{BUBBLE_SOURCE_LABELS[estimate.bubbleVolumeSource]}</div>
        </div>
      </div>
      <p className="hint">
        {estimate.bottling ? (
          <>
            With {batch.primingSugarG} g priming sugar: <strong>{formatPercent(estimate.bottling.bottledAbv, 1)}</strong> in
            the bottle.
          </>
        ) : (
          "Bottle priming adds roughly another 0.3–0.4% ABV, which isn't counted here. Enter the priming sugar to include it."
        )}
      </p>
    </section>
  );
}

function SideCard({ batch, stats }: { batch: Batch; stats: FermentationStats }) {
  const active = batch.status !== 'completed';
  const drop =
    stats.currentRate !== null && stats.peakRate ? Math.round((1 - stats.currentRate / stats.peakRate) * 100) : null;

  return (
    <section className="card side-card">
      <div className="side-group">
        <span className="eyebrow">Activity</span>
        {active && (
          <div className="big-line">
            <span className="big-value">
              {stats.currentRate !== null ? stats.currentRate.toFixed(1) : '—'} <span className="big-unit">bpm now</span>
            </span>
            {drop !== null && drop >= MIN_SHOWN_DROP_PCT && <span className="hint">↓ {drop}% from peak</span>}
          </div>
        )}
        <div className="kv">
          <span>Peak rate</span>
          <strong>{stats.peakRate !== null ? `${stats.peakRate.toFixed(1)} bpm` : '—'}</strong>
        </div>
        <div className="kv">
          <span>Total bubbles</span>
          <strong>{stats.totalBubbles > 0 ? stats.totalBubbles.toLocaleString() : '—'}</strong>
        </div>
      </div>
      <div className="divider" />
      <div className="side-group">
        <span className="eyebrow">Temperature</span>
        {active && (
          <span className="big-value">
            {stats.currentTemp !== null ? stats.currentTemp.toFixed(1) : '—'} <span className="big-unit">°C now</span>
          </span>
        )}
        <div className="kv">
          <span>Average</span>
          <strong>{stats.avgTemp !== null ? `${stats.avgTemp.toFixed(1)} °C` : '—'}</strong>
        </div>
        <p className="hint">{TEMP_CAVEAT}</p>
      </div>
      <div className="divider" />
      <div className="side-group">
        <span className="eyebrow">Time</span>
        <span className="big-value">{formatDuration(batch.startedAt, batch.endedAt)}</span>
        <div className="kv">
          <span>Started</span>
          <strong>{formatShortDateTime(batch.startedAt)}</strong>
        </div>
        {batch.endedAt && (
          <div className="kv">
            <span>Ended</span>
            <strong>{formatShortDateTime(batch.endedAt)}</strong>
          </div>
        )}
      </div>
    </section>
  );
}

/** Batch notes with light formatting — renderNotesHtml() escapes the text before adding any tags. */
function RichNotes({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={className ? `${className} rich` : 'rich'}
      dangerouslySetInnerHTML={{ __html: renderNotesHtml(text) }}
    />
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** Yeast, pitch, hops, bottling and tasting — only what has been filled in. */
function BrewLogCard({ batch, estimate }: { batch: Batch; estimate: FermentationEstimate }) {
  const pitch =
    batch.pitchedAt !== null
      ? `${formatShortDateTime(batch.pitchedAt)}${batch.pitchTempC !== null ? ` at ${batch.pitchTempC} °C` : ''}`
      : batch.pitchTempC !== null
        ? `${batch.pitchTempC} °C`
        : null;
  const brew = [
    batch.yeastStrain && <Fact key="y" label="Yeast" value={batch.yeastStrain} />,
    batch.yeastAttenuation !== null && <Fact key="a" label="Strain attenuation" value={`${batch.yeastAttenuation}%`} />,
    pitch && <Fact key="p" label="Pitched" value={pitch} />,
  ].filter(Boolean);
  const b = estimate.bottling;
  const bottling = [
    batch.primingSugarG !== null && <Fact key="s" label="Priming sugar" value={`${batch.primingSugarG} g`} />,
    batch.bottledVolumeL !== null && <Fact key="v" label="Bottled volume" value={`${batch.bottledVolumeL} L`} />,
    batch.bottleCount !== null && <Fact key="n" label="Bottles" value={String(batch.bottleCount)} />,
    b && (
      <Fact
        key="abv"
        label="Bottled ABV"
        value={`${formatPercent(b.bottledAbv)} (+${formatPercent(b.primingAbv)} priming)`}
      />
    ),
    b && <Fact key="co2" label="Carbonation" value={`${b.co2Volumes.toFixed(1)} volumes CO₂`} />,
    estimate.caloriesPer330ml !== null && (
      <Fact key="kcal" label="Calories" value={`≈ ${Math.round(estimate.caloriesPer330ml)} kcal per 330 mL`} />
    ),
  ].filter(Boolean);

  if (brew.length === 0 && !batch.hops && bottling.length === 0 && !batch.tastingNotes) return null;

  return (
    <section className="card brew-log">
      <div className="side-group">
        <span className="eyebrow">Brew log</span>
        {brew}
        {batch.hops && (
          <div className="text-block">
            <span className="mini-label">Hops</span>
            <span>{batch.hops}</span>
          </div>
        )}
        {brew.length === 0 && !batch.hops && <p className="hint">Add the yeast, pitch and hops under Edit batch.</p>}
      </div>
      <div className="side-group">
        <span className="eyebrow">{batch.primingSugarG !== null || batch.bottleCount !== null ? 'Bottling' : 'In the glass'}</span>
        {bottling}
        {batch.tastingNotes && (
          <div className="text-block">
            <span className="mini-label">Tasting notes</span>
            <span>{batch.tastingNotes}</span>
          </div>
        )}
      </div>
    </section>
  );
}

export function BatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [readings, setReadings] = useState<Reading[] | null>(null);
  const [stats, setStats] = useState<FermentationStats | null>(null);
  const [estimate, setEstimate] = useState<FermentationEstimate | null>(null);
  const [gravity, setGravity] = useState<GravityReading[] | null>(null);
  const [abvSeries, setAbvSeries] = useState<AbvPoint[]>([]);
  const [events, setEvents] = useState<BatchEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const [b, r, ev] = await Promise.all([
          api.get<Batch>(`/batches/${id}`),
          api.get<Reading[]>(`/batches/${id}/readings`),
          api.get<BatchEvent[]>(`/batches/${id}/events`),
          reloadModel(),
        ]);
        setBatch(b);
        setReadings(r);
        setEvents(ev);
      } catch {
        setError('Failed to load batch.');
      }
    })();
    // reloadModel only depends on `id`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Close the ⋯ menu on a click outside it or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  /** Re-fetches everything the ABV model derives — after any edit to the batch or its gravity readings. */
  async function reloadModel() {
    const [s, e, g, a] = await Promise.all([
      api.get<FermentationStats>(`/batches/${id}/stats`),
      api.get<FermentationEstimate>(`/batches/${id}/fermentation`),
      api.get<GravityReading[]>(`/batches/${id}/gravity-readings`),
      api.get<AbvPoint[]>(`/batches/${id}/abv-series`),
    ]);
    setStats(s);
    setEstimate(e);
    setGravity(g);
    setAbvSeries(a);
  }

  async function handleComplete() {
    if (!batch) return;
    setBusy(true);
    try {
      setBatch(await api.post<Batch>(`/batches/${batch.id}/complete`));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!batch) return;
    setMenuOpen(false);
    const { count } = await api.get<{ count: number }>(`/batches/${batch.id}/reading-count`);
    const confirmed = window.confirm(
      `Delete batch "${batch.batchCode}"? This permanently deletes it and ${count} telemetry reading(s). This cannot be undone.`,
    );
    if (!confirmed) return;

    await api.delete(`/batches/${batch.id}`);
    navigate('/batches');
  }

  async function handleDownloadReport() {
    if (!batch) return;
    setBusy(true);
    try {
      await downloadReport(batch.id, `fratoo-report-${batch.batchCode}.html`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!batch) return;
    const form = new FormData(e.currentTarget);
    const ogValue = optionalNumber(form.get('ogValue'));

    setBusy(true);
    try {
      const startedAtRaw = String(form.get('startedAt') ?? '');
      const updated = await api.patch<Batch>(`/batches/${batch.id}`, {
        batchCode: String(form.get('batchCode') ?? '').trim() || batch.batchCode,
        deviceId: String(form.get('deviceId') ?? ''),
        brewType: String(form.get('brewType') ?? ''),
        startedAt: startedAtRaw ? new Date(startedAtRaw).toISOString() : batch.startedAt,
        volumeLiters: optionalNumber(form.get('volumeLiters')),
        addedSugarG: optionalNumber(form.get('addedSugarG')),
        notes: String(form.get('notes') ?? ''),
        // OG value and unit are set/cleared together (the API rejects one without the other).
        ogValue,
        ogUnit: ogValue === null ? null : (String(form.get('ogUnit')) as GravityUnit),
        ogIncludesSugar: form.get('ogIncludesSugar') === 'on',
        targetAbv: optionalNumber(form.get('targetAbv')),
        bubbleVolumeMl: optionalNumber(form.get('bubbleVolumeMl')),
        yeastStrain: String(form.get('yeastStrain') ?? '').trim() || null,
        yeastAttenuation: optionalNumber(form.get('yeastAttenuation')),
        pitchedAt: optionalDateTime(form.get('pitchedAt')),
        pitchTempC: optionalNumber(form.get('pitchTempC')),
        alertTempMinC: optionalNumber(form.get('alertTempMinC')),
        alertTempMaxC: optionalNumber(form.get('alertTempMaxC')),
        hops: String(form.get('hops') ?? '').trim() || null,
        primingSugarG: optionalNumber(form.get('primingSugarG')),
        bottledVolumeL: optionalNumber(form.get('bottledVolumeL')),
        bottleCount: optionalNumber(form.get('bottleCount')),
        tastingNotes: String(form.get('tastingNotes') ?? '').trim() || null,
      });
      setBatch(updated);
      setEditing(false);
      await reloadModel();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to save changes.');
    } finally {
      setBusy(false);
    }
  }

  async function handleReopen() {
    if (!batch) return;
    setMenuOpen(false);
    const confirmed = window.confirm(
      'Reopen this batch? This clears its end date and sets it back to active, so new telemetry will count toward it again.',
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      setBatch(await api.patch<Batch>(`/batches/${batch.id}`, { status: 'active', endedAt: null }));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="error-text">{error}</p>;
  if (!batch || !readings || !stats || !estimate || !gravity || !events) return <p className="empty-state">Loading…</p>;

  const active = batch.status !== 'completed';
  const markers: ChartMarker[] = [
    ...gravity
      .filter((g) => !g.excludeFromCalibration)
      .map((g) => {
        const p = estimate.calibration.points.find((x) => x.id === g.id);
        return {
          t: g.measuredAt,
          label: `${formatGravity(g.value, g.unit)}${p?.measuredAbv != null ? ` · ${formatPercent(p.measuredAbv)}` : ''}`,
          kind: 'gravity' as const,
        };
      }),
    ...events.map((e) => ({ t: e.occurredAt, label: EVENT_LABELS[e.kind], kind: 'event' as const })),
  ];
  // "Uncalibrated" is already said by the ABV badge; the rest still matter.
  const warnings = estimate.warnings.filter((w) => !w.startsWith('Using the default bubble volume'));

  return (
    <>
      <section className="detail-head">
        <Link to="/batches" className="back-link">
          ← All batches
        </Link>
        <div className="detail-title-row">
          <div className="detail-title">
            <h1 className="page-title">{batch.batchCode}</h1>
            <span className={active ? 'pill active' : 'pill'}>
              {active
                ? `Active · day ${dayNumber(batch.startedAt, null)}`
                : `Completed · ${dayNumber(batch.startedAt, batch.endedAt)} days`}
            </span>
          </div>
          <div className="detail-actions">
            <button type="button" className="secondary" onClick={() => void handleDownloadReport()} disabled={busy}>
              Download report
            </button>
            {active && (
              <button type="button" onClick={() => void handleComplete()} disabled={busy}>
                Complete fermentation
              </button>
            )}
            <div className="menu-wrap" ref={menuRef}>
              <button
                type="button"
                className="icon-btn"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <MoreIcon />
              </button>
              {menuOpen && (
                <div className="menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setEditing(true);
                      setMenuOpen(false);
                    }}
                  >
                    Edit batch &amp; ABV inputs
                  </button>
                  {!active && (
                    <button type="button" role="menuitem" onClick={() => void handleReopen()}>
                      Reopen batch
                    </button>
                  )}
                  <div className="divider" />
                  <button type="button" role="menuitem" className="danger" onClick={() => void handleDelete()}>
                    Delete batch…
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {!editing && (
          <>
            <div className="meta-row">
              <span>
                Started <strong>{formatDateTime(batch.startedAt)}</strong>
              </span>
              {batch.volumeLiters !== null && (
                <span>
                  <strong>{batch.volumeLiters} L</strong> · {batch.brewType}
                </span>
              )}
              {batch.addedSugarG !== null && (
                <span>
                  <strong>{batch.addedSugarG.toLocaleString()} g</strong> added sugar
                </span>
              )}
              {batch.ogValue !== null && batch.ogUnit !== null && (
                <span>
                  OG{' '}
                  <strong>
                    {formatGravity(batch.ogValue, batch.ogUnit)}
                    {estimate.og !== null && (batch.ogUnit === 'brix' || !batch.ogIncludesSugar) && ` → ${formatSg(estimate.og)}`}
                  </strong>
                  {!batch.ogIncludesSugar && ' incl. sugar'}
                </span>
              )}
              {batch.targetAbv !== null && (
                <span>
                  Target <strong>{batch.targetAbv}%</strong>
                </span>
              )}
              {batch.yeastStrain && (
                <span>
                  Yeast <strong>{batch.yeastStrain}</strong>
                </span>
              )}
            </div>
            {batch.notes && !isLongNote(batch.notes) && <RichNotes className="notes" text={batch.notes} />}
          </>
        )}
      </section>

      {editing && (
        <form className="card" onSubmit={(e) => void handleSaveEdit(e)}>
          <h2 className="card-title">Edit batch</h2>
          <div className="form-grid">
            <label className="field">
              Batch code
              <input name="batchCode" defaultValue={batch.batchCode} required />
            </label>
            <label className="field">
              Device ID
              <input name="deviceId" defaultValue={batch.deviceId} />
            </label>
            <label className="field">
              Brew type
              <select name="brewType" defaultValue={batch.brewType}>
                <option value="beer">Beer</option>
                <option value="cider">Cider</option>
                <option value="mead">Mead</option>
                <option value="wine">Wine</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="field">
              Started
              <input name="startedAt" type="datetime-local" defaultValue={toDatetimeLocalValue(batch.startedAt)} />
            </label>
            <label className="field">
              Volume (L)
              <input name="volumeLiters" type="number" step="0.1" min="0" defaultValue={batch.volumeLiters ?? ''} />
            </label>
            <label className="field">
              Added sugar (g)
              <input name="addedSugarG" type="number" step="0.1" min="0" defaultValue={batch.addedSugarG ?? ''} />
            </label>
            <fieldset className="form-group">
              <legend>ABV model</legend>
              <label className="field">
                Original gravity
                <input name="ogValue" type="number" step="any" min="0" defaultValue={batch.ogValue ?? ''} />
              </label>
              <label className="field">
                OG unit
                <select name="ogUnit" defaultValue={batch.ogUnit ?? 'brix'}>
                  <option value="brix">Brix (refractometer)</option>
                  <option value="sg">SG (hydrometer)</option>
                </select>
              </label>
              <label className="field">
                Target ABV (%)
                <input name="targetAbv" type="number" step="0.1" min="0" max="100" defaultValue={batch.targetAbv ?? ''} />
              </label>
              <label className="field">
                Bubble volume override (mL)
                <input
                  name="bubbleVolumeMl"
                  type="number"
                  step="any"
                  min="0.01"
                  placeholder="blank = calibrate"
                  defaultValue={batch.bubbleVolumeMl ?? ''}
                />
              </label>
              <label className="check span-all">
                <input name="ogIncludesSugar" type="checkbox" defaultChecked={batch.ogIncludesSugar} />
                OG measured after the added sugar was dissolved
              </label>
              <p className="hint span-all">
                Enter a refractometer OG as read (raw °Bx). Untick the sugar box if you measured the wort before adding
                sugar: the added sugar is then converted to gravity points and added on top. Target ABV is for
                comparison only. Leave the bubble volume override blank so gravity readings can calibrate it.
              </p>
            </fieldset>
            <fieldset className="form-group">
              <legend>Yeast &amp; pitch</legend>
              <label className="field">
                Yeast strain
                <input name="yeastStrain" maxLength={128} placeholder="e.g. SafAle US-05" defaultValue={batch.yeastStrain ?? ''} />
              </label>
              <label className="field">
                Strain attenuation (%)
                <input
                  name="yeastAttenuation"
                  type="number"
                  step="any"
                  min="1"
                  max="100"
                  placeholder={`blank = ${Math.round(estimate.settings.expectedAttenuation * 100)}`}
                  defaultValue={batch.yeastAttenuation ?? ''}
                />
              </label>
              <label className="field">
                Pitched at
                <input
                  name="pitchedAt"
                  type="datetime-local"
                  defaultValue={batch.pitchedAt ? toDatetimeLocalValue(batch.pitchedAt) : ''}
                />
              </label>
              <label className="field">
                Wort temperature at pitch (°C)
                <input name="pitchTempC" type="number" step="0.1" min="-10" max="60" defaultValue={batch.pitchTempC ?? ''} />
              </label>
              <p className="hint span-all">
                Strain attenuation is the yeast maker's figure for malt wort; added sugar is counted as fully fermentable
                on top of it for the "expected" mark. Extract kits usually land 5–10 points below the quoted figure.
                The lag phase is measured from the pitch time when it's set.
              </p>
            </fieldset>
            <label className="field span-all">
              Hops
              <textarea name="hops" defaultValue={batch.hops ?? ''} rows={2} placeholder="e.g. Cascade 30 g @ 10 min, Citra 50 g dry hop day 7" />
            </label>
            <fieldset className="form-group">
              <legend>Temperature alerts</legend>
              <label className="field">
                Low limit (°C)
                <input
                  name="alertTempMinC"
                  type="number"
                  step="0.5"
                  min="-10"
                  max="60"
                  placeholder="blank = Settings"
                  defaultValue={batch.alertTempMinC ?? ''}
                />
              </label>
              <label className="field">
                High limit (°C)
                <input
                  name="alertTempMaxC"
                  type="number"
                  step="0.5"
                  min="-10"
                  max="60"
                  placeholder="blank = Settings"
                  defaultValue={batch.alertTempMaxC ?? ''}
                />
              </label>
              <p className="hint span-all">
                Measured at the airlock, like the temperature on this page. Leave blank to use the limits in Settings →
                Notifications (16–24 °C unless changed); set them for a lager or a warm-fermenting yeast.
              </p>
            </fieldset>
            <fieldset className="form-group">
              <legend>Bottling</legend>
              <label className="field">
                Priming sugar (g)
                <input name="primingSugarG" type="number" step="1" min="0" defaultValue={batch.primingSugarG ?? ''} />
              </label>
              <label className="field">
                Bottled volume (L)
                <input
                  name="bottledVolumeL"
                  type="number"
                  step="0.1"
                  min="0"
                  placeholder={batch.volumeLiters !== null ? `blank = ${batch.volumeLiters}` : ''}
                  defaultValue={batch.bottledVolumeL ?? ''}
                />
              </label>
              <label className="field">
                Bottles
                <input name="bottleCount" type="number" step="1" min="0" defaultValue={batch.bottleCount ?? ''} />
              </label>
              <p className="hint span-all">
                Priming sugar is table sugar (sucrose) dissolved into the bottled volume. It's used for the bottled ABV
                and the carbonation level.
              </p>
            </fieldset>
            <label className="field span-all">
              Notes
              <textarea name="notes" defaultValue={batch.notes ?? ''} rows={10} className="notes-editor" />
              <span className="hint">
                Long notes are fine: they get their own card on the page and in the report. Formatting: lines starting
                with "- " or "* " become bullets, "1. " a numbered list, "# " a heading; a short line ending in ":" is a
                bold label; **text** is bold.
              </span>
            </label>
            <label className="field span-all">
              Tasting notes
              <textarea name="tastingNotes" defaultValue={batch.tastingNotes ?? ''} rows={3} />
            </label>
            <p className="hint span-all">
              Backdating "Started" pulls in readings from before this batch was created, which is useful after a
              historical-data import. It doesn't check for overlap with an earlier batch on the same device, so
              double-check there isn't one before saving.
            </p>
            <div className="form-actions">
              <button type="submit" disabled={busy}>
                Save changes
              </button>
              <button type="button" className="secondary" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        </form>
      )}

      <StatusLine batch={batch} stats={stats} />

      <div className="hero">
        <AbvCard batch={batch} estimate={estimate} />
        <SideCard batch={batch} stats={stats} />
      </div>

      {warnings.length > 0 && (
        <ul className="warning-box">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <BrewLogCard batch={batch} estimate={estimate} />

      {batch.notes && isLongNote(batch.notes) && (
        <section className="card">
          <h2 className="card-title">Notes</h2>
          <RichNotes text={batch.notes} />
        </section>
      )}

      {readings.length === 0 ? (
        <section className="card">
          <p className="empty-state">
            <WarningIcon /> No telemetry recorded for this batch yet.
          </p>
        </section>
      ) : (
        <FermentationChart readings={readings} abvSeries={abvSeries} markers={markers} />
      )}

      <GravityReadingsPanel
        batchId={batch.id}
        batchStartedAt={batch.startedAt}
        readings={gravity}
        estimate={estimate}
        defaultUnit={batch.ogUnit ?? 'brix'}
        onChanged={async () => {
          // Recalibration also updates the batch's cached fit.
          const [b] = await Promise.all([api.get<Batch>(`/batches/${batch.id}`), reloadModel()]);
          setBatch(b);
        }}
      />

      <BatchEventsPanel
        batchId={batch.id}
        batchStartedAt={batch.startedAt}
        events={events}
        onChanged={async () => setEvents(await api.get<BatchEvent[]>(`/batches/${batch.id}/events`))}
      />
    </>
  );
}
