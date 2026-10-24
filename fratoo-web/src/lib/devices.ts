import { ago, liveKind, type LiveKind } from './status';
import type { Device } from '../types';

/** "01234567…cdef": the full 32-character Blynk token is noise on screen. */
export function shortToken(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** The airlock's name, or its short token until it has one. */
export function deviceName(device: Pick<Device, 'deviceId' | 'name'>): string {
  return device.name || shortToken(device.deviceId);
}

/** live / stale / offline from the newest reading ('none' = never sent one). */
export function deviceLiveKind(device: Device, now = Date.now()): LiveKind {
  return liveKind('active', device.lastReadingAt, now);
}

/** "online", "last seen 3 h ago", "never connected". */
export function deviceSeen(device: Device, now = Date.now()): string {
  if (!device.lastReadingAt) return 'never connected';
  return deviceLiveKind(device, now) === 'live' ? 'online' : `last seen ${ago(device.lastReadingAt, now)}`;
}

/**
 * Which airlock a new batch most likely uses: the one from the newest batch,
 * else the one that sent a reading most recently, else the first. '' when
 * there are none.
 */
export function defaultDeviceId(devices: Device[]): string {
  const newest = (key: 'lastBatchStartedAt' | 'lastReadingAt') =>
    devices
      .filter((d) => d[key])
      .sort((a, b) => new Date(b[key]!).getTime() - new Date(a[key]!).getTime())[0];
  return (newest('lastBatchStartedAt') ?? newest('lastReadingAt') ?? devices[0])?.deviceId ?? '';
}
