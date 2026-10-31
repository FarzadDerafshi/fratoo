import type { BatchEventKind, BubbleVolumeSource, GravityUnit } from '../types';

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

/** Converts an ISO timestamp to the value a `<input type="datetime-local">` expects (local wall-clock time, no timezone suffix, minute precision). */
export function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatSg(sg: number | null): string {
  return sg !== null ? sg.toFixed(3) : '—';
}

/** A gravity value as entered — "1.012" or "6.4 °Bx". */
export function formatGravity(value: number, unit: GravityUnit): string {
  return unit === 'brix' ? `${value} °Bx` : value.toFixed(3);
}

export function formatPercent(value: number | null, digits = 2): string {
  return value !== null ? `${value.toFixed(digits)}%` : '—';
}

export const BUBBLE_SOURCE_LABELS: Record<BubbleVolumeSource, string> = {
  'batch-override': 'manual override',
  'batch-calibration': "this batch's readings",
  learned: 'learned from other batches',
  default: 'default (uncalibrated)',
};

export const EVENT_LABELS: Record<BatchEventKind, string> = {
  dry_hop: 'Dry hop',
  addition: 'Addition',
  temperature: 'Temperature change',
  disturbance: 'Disturbance',
  airlock: 'Airlock changed',
  bottling: 'Bottling',
  other: 'Note',
};

/** Empty string → null, otherwise a number — for optional numeric form fields. */
export function optionalNumber(raw: FormDataEntryValue | null): number | null {
  const s = raw === null ? '' : String(raw).trim();
  return s === '' ? null : Number(s);
}

/** Empty `<input type="datetime-local">` → null, otherwise an ISO timestamp. */
export function optionalDateTime(raw: FormDataEntryValue | null): string | null {
  const s = raw === null ? '' : String(raw).trim();
  return s === '' ? null : new Date(s).toISOString();
}
