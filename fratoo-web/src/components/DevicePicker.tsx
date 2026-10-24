import { useState } from 'react';
import { defaultDeviceId, deviceName, deviceSeen } from '../lib/devices';
import type { Device } from '../types';

const CUSTOM = '__custom';

/**
 * The batch form's airlock field: a list of the known airlocks (Settings →
 * Airlocks) instead of a pasted token. Submits the token as `deviceId`
 * either way. `initial` '' on a new batch preselects the likeliest airlock;
 * a token that isn't in the list opens the manual field with it filled in.
 * Falls back to the plain token field while the list isn't available.
 */
export function DevicePicker({
  devices,
  initial,
  isNew,
  batchId,
}: {
  devices: Device[] | null;
  initial: string;
  /** New batch: an empty `initial` means "pick the likeliest", not "no airlock". */
  isNew: boolean;
  /** The batch being edited, so its own airlock doesn't warn "in use". */
  batchId?: number;
}) {
  const known = devices?.some((d) => d.deviceId === initial) ?? false;
  const [selected, setSelected] = useState(() => {
    if (!devices) return CUSTOM;
    if (known || (!isNew && initial === '')) return initial;
    if (initial) return CUSTOM;
    return devices.length ? defaultDeviceId(devices) : CUSTOM;
  });

  if (!devices || (selected === CUSTOM && !devices.length)) {
    return (
      <label className="field">
        Airlock token
        <input name="deviceId" defaultValue={initial} placeholder="Blynk token" autoComplete="off" />
      </label>
    );
  }

  const device = devices.find((d) => d.deviceId === selected);
  const busyWith = device?.activeBatch && device.activeBatch.id !== batchId ? device.activeBatch : null;

  return (
    <>
      <label className="field">
        Airlock
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {deviceName(d)} · {deviceSeen(d)}
              {d.activeBatch && d.activeBatch.id !== batchId ? ` · in use: ${d.activeBatch.batchCode}` : ''}
            </option>
          ))}
          <option value="">No airlock</option>
          <option value={CUSTOM}>Enter a token…</option>
        </select>
      </label>
      {selected === CUSTOM ? (
        <label className="field">
          Airlock token
          <input name="deviceId" defaultValue={known ? '' : initial} placeholder="Blynk token" autoComplete="off" required />
        </label>
      ) : (
        <input type="hidden" name="deviceId" value={selected} />
      )}
      {busyWith && (
        <p className="hint warn span-all">
          {deviceName(device!)} still has an active batch, {busyWith.batchCode}. Its readings stop where this batch
          starts, so end it first if it's finished.
        </p>
      )}
    </>
  );
}
