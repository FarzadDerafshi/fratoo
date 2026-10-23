import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { formatGravity, formatPercent, formatSg, toDatetimeLocalValue } from '../lib/format';
import { dayNumber, formatShortDateTime } from '../lib/status';
import type { CalibrationPoint, FermentationEstimate, GravityReading, GravityUnit } from '../types';
import { TrashIcon } from './Icons';

interface Props {
  batchId: number;
  batchStartedAt: string;
  readings: GravityReading[];
  estimate: FermentationEstimate;
  /** Unit to preselect for a new reading (the batch's OG unit, usually). */
  defaultUnit: GravityUnit;
  onChanged: () => Promise<void>;
}

// Hydrometer/refractometer readings for one batch, joined with what the ABV
// model made of each (corrected SG, implied bubble volume, what the final
// fit predicts at that moment). Deliberately detailed while calibration is
// still learning — see ROADMAP.md "ABV calibration model".
export function GravityReadingsPanel({ batchId, batchStartedAt, readings, estimate, defaultUnit, onChanged }: Props) {
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  // Captured when the form opens, so a new reading defaults to "now" without calling Date during render.
  const [openedAt, setOpenedAt] = useState('');
  const [unit, setUnit] = useState<GravityUnit>(defaultUnit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pointsById = new Map<number, CalibrationPoint>();
  for (const p of estimate.calibration.points) if (p.id !== undefined) pointsById.set(p.id, p);
  const sorted = readings.slice().sort((a, b) => b.measuredAt.localeCompare(a.measuredAt));
  const editing = typeof editingId === 'number' ? readings.find((r) => r.id === editingId) : undefined;

  function open(id: number | 'new') {
    const r = typeof id === 'number' ? readings.find((x) => x.id === id) : undefined;
    setOpenedAt(new Date().toISOString());
    setUnit(r?.unit ?? defaultUnit);
    setEditingId(id);
  }

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const notes = String(form.get('notes') ?? '').trim();
    const dto = {
      measuredAt: new Date(String(form.get('measuredAt'))).toISOString(),
      value: Number(form.get('value')),
      unit,
      excludeFromCalibration: form.get('excludeFromCalibration') === 'on',
    };
    const ok = await run(() =>
      editing
        ? api.patch(`/batches/${batchId}/gravity-readings/${editing.id}`, { ...dto, notes: notes || null })
        : api.post(`/batches/${batchId}/gravity-readings`, notes ? { ...dto, notes } : dto),
    );
    if (ok) setEditingId(null);
  }

  function handleToggleExclude(r: GravityReading) {
    void run(() =>
      api.patch(`/batches/${batchId}/gravity-readings/${r.id}`, { excludeFromCalibration: !r.excludeFromCalibration }),
    );
  }

  function handleDelete(r: GravityReading) {
    if (!window.confirm(`Delete the ${formatGravity(r.value, r.unit)} reading from ${formatShortDateTime(r.measuredAt)}?`)) {
      return;
    }
    void run(() => api.delete(`/batches/${batchId}/gravity-readings/${r.id}`));
  }

  const { fittedBubbleVolumeMl, usablePoints, learnedBubbleVolumeMl } = estimate.calibration;

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="card-title">Gravity readings</h2>
          <p className="card-sub">
            Each reading calibrates the bubble volume. Enter a refractometer value exactly as read (raw °Bx); the wort
            correction and alcohol correction are applied for you.
          </p>
        </div>
        <button type="button" onClick={() => (editingId === null ? open('new') : setEditingId(null))} disabled={busy}>
          {editingId === null ? '+ Add reading' : 'Close'}
        </button>
      </div>

      <div className="chips-row">
        <span className={fittedBubbleVolumeMl !== null ? 'chip active' : 'chip'}>
          <strong>This batch</strong>{' '}
          {fittedBubbleVolumeMl !== null
            ? `${fittedBubbleVolumeMl.toFixed(3)} mL/bubble · ${usablePoints} reading${usablePoints === 1 ? '' : 's'}`
            : 'no usable readings yet'}
        </span>
        <span className="chip">
          <strong>Other batches</strong>{' '}
          {learnedBubbleVolumeMl !== null ? `${learnedBubbleVolumeMl.toFixed(3)} mL/bubble` : 'nothing learned yet'}
        </span>
        <span className="chip">
          <strong>Default</strong> {estimate.settings.defaultBubbleVolumeMl.toFixed(3)} mL/bubble
        </span>
      </div>

      {editingId !== null && (
        <form key={editingId} className="form-grid inset" onSubmit={(e) => void handleSubmit(e)}>
          <label className="field">
            Measured at
            <input
              name="measuredAt"
              type="datetime-local"
              required
              defaultValue={toDatetimeLocalValue(editing?.measuredAt ?? openedAt)}
            />
          </label>
          <label className="field">
            Reading
            <input
              name="value"
              type="number"
              step="any"
              min="0"
              required
              placeholder={unit === 'brix' ? 'e.g. 5.2' : 'e.g. 1.010'}
              defaultValue={editing?.value ?? ''}
            />
          </label>
          <div className="field">
            <span>Instrument</span>
            <div className="segmented solid" role="group" aria-label="Instrument">
              <button type="button" aria-pressed={unit === 'brix'} onClick={() => setUnit('brix')}>
                Brix · refractometer
              </button>
              <button type="button" aria-pressed={unit === 'sg'} onClick={() => setUnit('sg')}>
                SG · hydrometer
              </button>
            </div>
          </div>
          <label className="check">
            <input
              name="excludeFromCalibration"
              type="checkbox"
              defaultChecked={editing?.excludeFromCalibration ?? false}
            />
            Exclude from calibration
          </label>
          <label className="field span-all">
            Notes
            <input name="notes" defaultValue={editing?.notes ?? ''} placeholder="e.g. ran the tap first, sample at 20 °C" />
          </label>
          <div className="form-actions">
            <button type="submit" disabled={busy}>
              {editing ? 'Save reading' : 'Add reading'}
            </button>
            <button type="button" className="secondary" onClick={() => setEditingId(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <p className="error-text">{error}</p>}

      {sorted.length === 0 ? (
        <p className="empty-state">
          No gravity readings yet. One mid-fermentation and one near the end are the most useful for calibration.
        </p>
      ) : (
        sorted.map((r) => {
          const p = pointsById.get(r.id);
          return (
            <article key={r.id} className={r.excludeFromCalibration ? 'reading excluded' : 'reading'}>
              <div className="reading-main">
                <span className="reading-when">
                  {formatShortDateTime(r.measuredAt)} · day {dayNumber(batchStartedAt, r.measuredAt)}
                </span>
                <span className="reading-value">{formatGravity(r.value, r.unit)}</span>
                {r.notes && <span className="reading-note">{r.notes}</span>}
              </div>
              <div className="reading-facts">
                <div>
                  <span className="mini-label">Corrected SG</span>
                  <strong>{formatSg(p?.sg ?? null)}</strong>
                </div>
                <div>
                  <span className="mini-label">Measured ABV</span>
                  <strong>{formatPercent(p?.measuredAbv ?? null)}</strong>
                </div>
                <div>
                  <span className="mini-label">Bubbles so far</span>
                  <strong>{p ? Math.round(p.cumulativeBubbles).toLocaleString() : '—'}</strong>
                </div>
                <div>
                  <span className="mini-label">Implies</span>
                  <strong>{p?.impliedBubbleVolumeMl != null ? `${p.impliedBubbleVolumeMl.toFixed(3)} mL/bubble` : '—'}</strong>
                </div>
                <div>
                  <span className="mini-label">Model now says</span>
                  <strong>
                    {formatSg(p?.predictedSg ?? null)} · {formatPercent(p?.predictedAbv ?? null)}
                  </strong>
                </div>
              </div>
              <div className="reading-actions">
                {p?.usable ? (
                  <span className="pill good">Used</span>
                ) : (
                  <span className="pill warn" title={p?.reason ?? undefined}>
                    {p?.reason ?? 'Not used'}
                  </span>
                )}
                <button type="button" className="secondary small" onClick={() => open(r.id)} disabled={busy}>
                  Edit
                </button>
                <button type="button" className="secondary small" onClick={() => handleToggleExclude(r)} disabled={busy}>
                  {r.excludeFromCalibration ? 'Include' : 'Exclude'}
                </button>
                <button
                  type="button"
                  className="danger icon-btn small"
                  aria-label="Delete reading"
                  onClick={() => handleDelete(r)}
                  disabled={busy}
                >
                  <TrashIcon />
                </button>
              </div>
            </article>
          );
        })
      )}
    </section>
  );
}
