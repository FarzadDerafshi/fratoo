import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { formatPercent, formatSg, optionalDateTime, optionalNumber } from '../lib/format';
import { ago, dayNumber, liveKind } from '../lib/status';
import type { Batch, FermentationStats } from '../types';

type Filter = 'All' | 'Active' | 'Completed';

/** Bubble-rate outline for a batch card, scaled to its own peak. */
function Sparkline({ points }: { points: FermentationStats['sparkline'] }) {
  if (points.length < 2) return <div className="spark-empty">No activity recorded yet</div>;
  const t0 = new Date(points[0].t).getTime();
  const span = new Date(points[points.length - 1].t).getTime() - t0 || 1;
  const max = Math.max(...points.map((p) => p.rate), 1);
  const line = points
    .map((p, i) => {
      const x = ((new Date(p.t).getTime() - t0) / span) * 300;
      const y = 60 - (p.rate / max) * 56;
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="spark" viewBox="0 0 300 64" preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line} L300 60 L0 60 Z`} style={{ fill: 'var(--chart-rate-fill)' }} />
      <path d={line} style={{ fill: 'none', stroke: 'var(--chart-rate)', strokeWidth: 2, vectorEffect: 'non-scaling-stroke' }} />
    </svg>
  );
}

function BatchCard({ batch, stats }: { batch: Batch; stats: FermentationStats | undefined }) {
  const kind = liveKind(batch.status, stats?.lastReadingAt ?? null);
  const active = batch.status !== 'completed';
  const day = dayNumber(batch.startedAt, batch.endedAt);

  return (
    <Link to={`/batches/${batch.id}`} className="batch-card">
      <div className="batch-card-head">
        <span className="batch-card-title">{batch.batchCode}</span>
        <span className={active ? 'pill active' : 'pill'}>{active ? `Active · day ${day}` : `Completed · ${day} days`}</span>
      </div>
      {stats ? <Sparkline points={stats.sparkline} /> : <div className="spark-empty">Loading…</div>}
      <div className="trio">
        <div>
          <div className="trio-label">{active ? 'Est. ABV' : 'Final ABV'}</div>
          <div className="trio-value">{stats && stats.totalBubbles > 0 ? formatPercent(stats.abv) : '—'}</div>
        </div>
        <div>
          <div className="trio-label">Gravity</div>
          <div className="trio-value">{stats ? formatSg(stats.estimatedSg) : '—'}</div>
        </div>
        <div>
          <div className="trio-label">{active ? 'Now' : 'Peak'}</div>
          <div className="trio-value">
            {stats ? ((active ? stats.currentRate : stats.peakRate)?.toFixed(1) ?? '—') : '—'}{' '}
            <span className="trio-unit">bpm</span>
          </div>
        </div>
      </div>
      <div className="batch-card-foot">
        {kind !== 'done' && kind !== 'none' && <span className={`status-line-dot ${kind}`} aria-hidden="true" />}
        <span>
          {kind === 'live' && 'Live · '}
          {kind === 'stale' && 'No recent reading · '}
          {kind === 'offline' && 'Offline · '}
          {stats?.lastReadingAt ? `last reading ${ago(stats.lastReadingAt)}` : 'no readings yet'}
          {batch.volumeLiters !== null && ` · ${batch.volumeLiters} L ${batch.brewType}`}
        </span>
      </div>
    </Link>
  );
}

export function BatchListPage() {
  const navigate = useNavigate();
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [stats, setStats] = useState<Record<number, FermentationStats>>({});
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState<Filter>('All');

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<Batch[]>('/batches');
        setBatches(list);
        // Cards fill in as each batch's stats arrive.
        for (const b of list) {
          api
            .get<FermentationStats>(`/batches/${b.id}/stats`)
            .then((s) => setStats((prev) => ({ ...prev, [b.id]: s })))
            .catch(() => undefined);
        }
      } catch {
        setError('Failed to load batches.');
      }
    })();
  }, []);

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const ogValue = optionalNumber(form.get('ogValue'));
    const dto = {
      batchCode: String(form.get('batchCode')),
      deviceId: String(form.get('deviceId') || ''),
      brewType: String(form.get('brewType') || 'beer'),
      volumeLiters: optionalNumber(form.get('volumeLiters')) ?? undefined,
      addedSugarG: optionalNumber(form.get('addedSugarG')) ?? undefined,
      ogValue: ogValue ?? undefined,
      ogUnit: ogValue !== null ? String(form.get('ogUnit')) : undefined,
      targetAbv: optionalNumber(form.get('targetAbv')) ?? undefined,
      yeastStrain: String(form.get('yeastStrain') || '').trim() || undefined,
      yeastAttenuation: optionalNumber(form.get('yeastAttenuation')) ?? undefined,
      pitchedAt: optionalDateTime(form.get('pitchedAt')) ?? undefined,
      pitchTempC: optionalNumber(form.get('pitchTempC')) ?? undefined,
      notes: String(form.get('notes') || ''),
    };
    try {
      const created = await api.post<Batch>('/batches', dto);
      navigate(`/batches/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create the batch.');
    }
  }

  const shown = (batches ?? []).filter(
    (b) => filter === 'All' || (filter === 'Completed') === (b.status === 'completed'),
  );

  return (
    <>
      <div className="list-head">
        <h1 className="page-title">Batches</h1>
        <div className="list-actions">
          <div className="segmented" role="group" aria-label="Show batches">
            {(['All', 'Active', 'Completed'] as Filter[]).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? 'Cancel' : '+ New batch'}
          </button>
        </div>
      </div>

      {showCreate && (
        <form className="card" onSubmit={(e) => void handleCreate(e)}>
          <h2 className="card-title">New batch</h2>
          <div className="form-grid">
            <label className="field">
              Batch code
              <input name="batchCode" placeholder="e.g. IPA 2026.11" required />
            </label>
            <label className="field">
              Device ID
              <input name="deviceId" placeholder="Blynk token" />
            </label>
            <label className="field">
              Brew type
              <select name="brewType" defaultValue="beer">
                <option value="beer">Beer</option>
                <option value="cider">Cider</option>
                <option value="mead">Mead</option>
                <option value="wine">Wine</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="field">
              Volume (L)
              <input name="volumeLiters" type="number" step="0.1" min="0" />
            </label>
            <label className="field">
              Added sugar (g)
              <input name="addedSugarG" type="number" step="1" min="0" />
            </label>
            <label className="field">
              Original gravity (after sugar)
              <input name="ogValue" type="number" step="any" min="0" />
            </label>
            <label className="field">
              OG unit
              <select name="ogUnit" defaultValue="brix">
                <option value="brix">Brix (refractometer)</option>
                <option value="sg">SG (hydrometer)</option>
              </select>
            </label>
            <label className="field">
              Target ABV (%)
              <input name="targetAbv" type="number" step="0.1" min="0" max="100" />
            </label>
            <label className="field">
              Yeast strain
              <input name="yeastStrain" maxLength={128} placeholder="e.g. SafAle US-05" />
            </label>
            <label className="field">
              Strain attenuation (%)
              <input name="yeastAttenuation" type="number" step="any" min="1" max="100" placeholder="from the yeast pack" />
            </label>
            <label className="field">
              Pitched at
              <input name="pitchedAt" type="datetime-local" />
            </label>
            <label className="field">
              Wort temperature at pitch (°C)
              <input name="pitchTempC" type="number" step="0.1" min="-10" max="60" />
            </label>
            <label className="field span-all">
              Notes
              <input name="notes" />
            </label>
            <div className="form-actions">
              <button type="submit">Start batch</button>
              <button type="button" className="secondary" onClick={() => setShowCreate(false)}>
                Cancel
              </button>
            </div>
          </div>
        </form>
      )}

      {error && <p className="error-text">{error}</p>}

      {batches === null ? (
        !error && <p className="empty-state">Loading…</p>
      ) : (
        <div className="batch-grid">
          {shown.map((b) => (
            <BatchCard key={b.id} batch={b} stats={stats[b.id]} />
          ))}
          {filter !== 'Completed' && !showCreate && (
            <button type="button" className="new-batch-card" onClick={() => setShowCreate(true)}>
              <span className="new-batch-plus" aria-hidden="true">
                +
              </span>
              Start a new batch
            </button>
          )}
          {shown.length === 0 && filter === 'Completed' && <p className="empty-state">No completed batches yet.</p>}
        </div>
      )}
    </>
  );
}
