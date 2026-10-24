import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { deviceLiveKind, deviceName, deviceSeen, shortToken } from '../lib/devices';
import type { Device } from '../types';

/** Settings → Airlocks: name the known airlocks, copy a token, add or remove one. */
export function AirlocksCard() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () =>
    api
      .get<Device[]>('/devices')
      .then(setDevices)
      .catch(() => setError('Failed to load the airlocks.'));

  useEffect(() => {
    void load();
  }, []);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      await load();
      setMessage(done);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function rename(e: FormEvent<HTMLFormElement>, device: Device) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name') ?? '').trim();
    const ok = await run(() => api.patch(`/devices/${encodeURIComponent(device.deviceId)}`, { name }), 'Name saved.');
    if (ok) setEditing(null);
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const dto = { deviceId: String(form.get('deviceId') ?? '').trim(), name: String(form.get('name') ?? '').trim() };
    const ok = await run(() => api.post('/devices', dto), 'Airlock added.');
    if (ok) setAdding(false);
  }

  function remove(device: Device) {
    const msg = `Remove ${deviceName(device)} from the list? Its readings and batches are kept. If it's still sending, it comes back by itself (without its name) with its next reading.`;
    if (!window.confirm(msg)) return;
    void run(() => api.delete(`/devices/${encodeURIComponent(device.deviceId)}`), 'Airlock removed.');
  }

  async function copy(device: Device) {
    setError(null);
    try {
      await navigator.clipboard.writeText(device.deviceId);
      setMessage(`Token for ${deviceName(device)} copied.`);
    } catch {
      setError('Copying is blocked here. Select the token from the edit field instead.');
    }
  }

  return (
    <section className="card">
      <h2 className="card-title">Airlocks</h2>
      <p className="card-sub">
        Every airlock that has sent a reading shows up here. Give each a name; new batches then pick their airlock from
        a list instead of a pasted token.
      </p>

      <div className="airlock-list">
        {devices === null && !error && <p className="empty-state">Loading…</p>}
        {devices?.length === 0 && (
          <p className="empty-state">
            No airlock yet. One appears when it sends its first reading, or add it by its token below.
          </p>
        )}
        {devices?.map((d) => {
          const kind = deviceLiveKind(d);
          return (
            <div key={d.deviceId} className="airlock-row">
              {editing === d.deviceId ? (
                <form className="airlock-edit" onSubmit={(e) => void rename(e, d)}>
                  <label className="field">
                    Name
                    <input name="name" defaultValue={d.name} maxLength={64} placeholder="e.g. Airlock 1" autoFocus />
                  </label>
                  <label className="field">
                    Token
                    <input value={d.deviceId} readOnly onFocus={(e) => e.currentTarget.select()} />
                  </label>
                  <div className="form-actions">
                    <button type="submit" className="small" disabled={busy}>
                      Save
                    </button>
                    <button type="button" className="small secondary" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button type="button" className="small danger" onClick={() => remove(d)} disabled={busy}>
                      Remove…
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="airlock-main">
                    <div className="airlock-name">
                      {d.name || <span className="muted">Unnamed</span>}
                      <span className="airlock-token">{shortToken(d.deviceId)}</span>
                    </div>
                    <div className="airlock-meta">
                      {kind !== 'none' && <span className={`status-line-dot ${kind}`} aria-hidden="true" />}
                      <span>{deviceSeen(d)}</span>
                      {d.activeBatch && (
                        <span>
                          · in use: <Link to={`/batches/${d.activeBatch.id}`}>{d.activeBatch.batchCode}</Link>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="airlock-actions">
                    <button type="button" className="small secondary" onClick={() => void copy(d)}>
                      Copy token
                    </button>
                    <button type="button" className="small secondary" onClick={() => setEditing(d.deviceId)}>
                      {d.name ? 'Edit' : 'Name it'}
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="error-text">{error}</p>}
      {message && <p className="success-text">{message}</p>}

      {adding ? (
        <form className="airlock-edit inset" onSubmit={(e) => void add(e)}>
          <label className="field">
            Token
            <input name="deviceId" required maxLength={64} pattern="\s*[A-Za-z0-9_\-]+\s*" placeholder="Blynk token" autoComplete="off" />
          </label>
          <label className="field">
            Name
            <input name="name" maxLength={64} placeholder="e.g. Airlock 2" />
          </label>
          <div className="form-actions">
            <button type="submit" className="small" disabled={busy}>
              Add
            </button>
            <button type="button" className="small secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="form-actions">
          <button type="button" className="secondary small" onClick={() => setAdding(true)}>
            + Add an airlock by token
          </button>
        </div>
      )}
    </section>
  );
}
