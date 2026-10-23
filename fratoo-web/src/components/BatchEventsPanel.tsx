import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { EVENT_LABELS, toDatetimeLocalValue } from '../lib/format';
import { dayNumber, formatShortDateTime } from '../lib/status';
import type { BatchEvent, BatchEventKind } from '../types';
import { TrashIcon } from './Icons';

interface Props {
  batchId: number;
  batchStartedAt: string;
  events: BatchEvent[];
  onChanged: () => Promise<void>;
}

const KINDS = Object.keys(EVENT_LABELS) as BatchEventKind[];

// Things done to (or noticed about) the batch at a point in time: dry hop,
// moving the fermenter, bottling. Drawn on the chart and listed in the
// report, so a bump or a step in the bubble rate has an explanation. They
// never change the ABV estimate.
export function BatchEventsPanel({ batchId, batchStartedAt, events, onChanged }: Props) {
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  // Captured when the form opens, so a new event defaults to "now" without calling Date during render.
  const [openedAt, setOpenedAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sorted = events.slice().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const editing = typeof editingId === 'number' ? events.find((e) => e.id === editingId) : undefined;

  function open(id: number | 'new') {
    setOpenedAt(new Date().toISOString());
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
      occurredAt: new Date(String(form.get('occurredAt'))).toISOString(),
      kind: String(form.get('kind')) as BatchEventKind,
    };
    const ok = await run(() =>
      editing
        ? api.patch(`/batches/${batchId}/events/${editing.id}`, { ...dto, notes: notes || null })
        : api.post(`/batches/${batchId}/events`, notes ? { ...dto, notes } : dto),
    );
    if (ok) setEditingId(null);
  }

  function handleDelete(ev: BatchEvent) {
    if (!window.confirm(`Delete the ${EVENT_LABELS[ev.kind].toLowerCase()} event from ${formatShortDateTime(ev.occurredAt)}?`)) {
      return;
    }
    void run(() => api.delete(`/batches/${batchId}/events/${ev.id}`));
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="card-title">Events</h2>
          <p className="card-sub">
            Dry hops, additions, moving the fermenter, bottling. They show on the chart and in the report, so a bump in
            the bubble rate has an explanation.
          </p>
        </div>
        <button type="button" onClick={() => (editingId === null ? open('new') : setEditingId(null))} disabled={busy}>
          {editingId === null ? '+ Log event' : 'Close'}
        </button>
      </div>

      {editingId !== null && (
        <form key={editingId} className="form-grid inset" onSubmit={(e) => void handleSubmit(e)}>
          <label className="field">
            When
            <input
              name="occurredAt"
              type="datetime-local"
              required
              defaultValue={toDatetimeLocalValue(editing?.occurredAt ?? openedAt)}
            />
          </label>
          <label className="field">
            What
            <select name="kind" defaultValue={editing?.kind ?? 'dry_hop'}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {EVENT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="field span-all">
            Notes
            <input name="notes" defaultValue={editing?.notes ?? ''} placeholder="e.g. Cascade 50 g, moved to the cellar" />
          </label>
          <div className="form-actions">
            <button type="submit" disabled={busy}>
              {editing ? 'Save event' : 'Log event'}
            </button>
            <button type="button" className="secondary" onClick={() => setEditingId(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <p className="error-text">{error}</p>}

      {sorted.length === 0 ? (
        <p className="empty-state">No events logged.</p>
      ) : (
        sorted.map((ev) => (
          <article key={ev.id} className="reading">
            <div className="reading-main">
              <span className="reading-when">
                {formatShortDateTime(ev.occurredAt)} · day {dayNumber(batchStartedAt, ev.occurredAt)}
              </span>
              <span className="pill event">{EVENT_LABELS[ev.kind]}</span>
              {ev.notes && <span className="reading-note">{ev.notes}</span>}
            </div>
            <div className="reading-actions">
              <button type="button" className="secondary small" onClick={() => open(ev.id)} disabled={busy}>
                Edit
              </button>
              <button
                type="button"
                className="danger icon-btn small"
                aria-label="Delete event"
                onClick={() => handleDelete(ev)}
                disabled={busy}
              >
                <TrashIcon />
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
