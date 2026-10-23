// PLAATO PCB self-heating correction (from PlaatoStructure.java) — kept in
// sync by hand with fratoo-bridge/src/common/fermentation-math.ts. This is
// the one formula that still has to live in both the backend (reports,
// server-side stats) and here (per-point chart rendering) since there's no
// shared package between the two runtimes — see ProjectDocs/ARCHITECTURE.md.
const SLOPE = 0.9133;
const INTERCEPT = 1.145;

export function correctTemperature(raw: number): number {
  return SLOPE * raw - INTERCEPT;
}
