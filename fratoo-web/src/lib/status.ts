// Device liveness from the newest reading. The airlock reports about every
// 4m47s, so a quarter of an hour without a reading means something is
// wrong (device, Wi-Fi, or the server — like the 18 h outage on Oct 13–14).

export type LiveKind = 'live' | 'stale' | 'offline' | 'done' | 'none';

export const STALE_AFTER_MIN = 15;
export const OFFLINE_AFTER_MIN = 60;

/** "3 min ago", "5 h ago", "2 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "42 min", "18 h", "3 days" — for "no reading for …". */
export function span(iso: string, now = Date.now()): string {
  return ago(iso, now).replace(' ago', '');
}

export function liveKind(status: string, lastReadingAt: string | null, now = Date.now()): LiveKind {
  if (status === 'completed') return 'done';
  if (!lastReadingAt) return 'none';
  const min = (now - new Date(lastReadingAt).getTime()) / 60000;
  if (min < STALE_AFTER_MIN) return 'live';
  if (min < OFFLINE_AFTER_MIN) return 'stale';
  return 'offline';
}

/** Whole days since the start, counting the start day as day 1. */
export function dayNumber(startedAt: string, endedAt: string | null, now = Date.now()): number {
  const end = endedAt ? new Date(endedAt).getTime() : now;
  return Math.max(1, Math.floor((end - new Date(startedAt).getTime()) / 86_400_000) + 1);
}

/** "1 Oct 2026, 19:08" in the viewer's locale. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "1 Oct, 19:08". */
export function formatShortDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
