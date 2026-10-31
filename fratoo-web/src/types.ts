export type GravityUnit = 'sg' | 'brix';

export interface Batch {
  id: number;
  batchCode: string;
  deviceId: string;
  brewType: string;
  status: 'active' | 'completed' | string;
  volumeLiters: number | null;
  addedSugarG: number | null;
  notes: string | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  // ABV model inputs — see fratoo-bridge/src/fermentation/abv-model.ts.
  ogValue: number | null;
  ogUnit: GravityUnit | null;
  ogIncludesSugar: boolean;
  targetAbv: number | null;
  /** Manual per-batch override; wins over any calibration. */
  bubbleVolumeMl: number | null;
  /** Cached fit of this batch's own gravity readings (read-only). */
  calibratedBubbleVolumeMl: number | null;
  calibrationPoints: number;
  /** Whether this batch's fit joins the learned bubble volume other batches start from. */
  shareCalibration: boolean;
  // Brew log — see fratoo-bridge/db/init/003_brew_log.sql.
  yeastStrain: string | null;
  /** Typical apparent attenuation of the strain, percent. */
  yeastAttenuation: number | null;
  pitchedAt: string | null;
  pitchTempC: number | null;
  /** Temperature alert limits for this batch (°C at the airlock); null = the notification settings. */
  alertTempMinC: number | null;
  alertTempMaxC: number | null;
  hops: string | null;
  primingSugarG: number | null;
  /** Falls back to volumeLiters when null. */
  bottledVolumeL: number | null;
  bottleCount: number | null;
  tastingNotes: string | null;
}

export type BatchEventKind = 'dry_hop' | 'addition' | 'temperature' | 'disturbance' | 'bottling' | 'other';

/** GET /batches/:id/events — annotations on the chart and in the report. */
export interface BatchEvent {
  id: number;
  batchId: number;
  occurredAt: string;
  kind: BatchEventKind;
  notes: string | null;
  createdAt: string;
}

export interface Reading {
  id: number;
  deviceId: string;
  pin: string;
  value: number;
  bubbleRate: number;
  recordedAt: string;
}

export type BubbleVolumeSource = 'batch-override' | 'batch-calibration' | 'learned' | 'default';

export interface FermentationStats {
  totalBubbles: number;
  co2Liters: number;
  avgTemp: number | null;
  peakRate: number | null;
  abv: number | null;
  abvCapped: boolean;
  estimatedSg: number | null;
  apparentAttenuation: number | null;
  og: number | null;
  expectedAbv: number | null;
  targetAbv: number | null;
  bubbleVolumeMl: number;
  bubbleVolumeSource: BubbleVolumeSource;
  /** Latest V100 rate / corrected temperature, and the newest reading's time (null without telemetry). */
  currentRate: number | null;
  currentTemp: number | null;
  lastReadingAt: string | null;
  /** Bubble rate averaged into up to 48 time slices, for the batch-list graph. */
  sparkline: { t: string; rate: number }[];
}

/** GET /batches/:id/abv-series — ABV over time for the chart. */
export interface AbvPoint {
  t: string;
  abv: number | null;
}

/** A gravity reading as the model saw it — GET /batches/:id/fermentation. */
export interface CalibrationPoint {
  id?: number;
  measuredAt: string;
  value: number;
  unit: GravityUnit;
  sg: number | null;
  measuredAbv: number | null;
  cumulativeBubbles: number;
  impliedBubbleVolumeMl: number | null;
  usable: boolean;
  reason: string | null;
  predictedSg: number | null;
  predictedAbv: number | null;
}

export type AbvFormula = 'standard' | 'alternate';
export type CalibrationMode = 'auto' | 'default-only';
export type TemperatureSource = 'measured' | 'fixed';

/** Mirrors fratoo-bridge/src/fermentation/fermentation-settings.ts. */
export interface FermentationSettings {
  defaultBubbleVolumeMl: number;
  calibrationMode: CalibrationMode;
  wortCorrectionFactor: number;
  abvFormula: AbvFormula;
  pressureKpa: number;
  temperatureSource: TemperatureSource;
  fixedTemperatureC: number;
  dissolvedCo2Enabled: boolean;
  co2PerEthanolMass: number;
  sugarPointsPerKgPerLiter: number;
  expectedAttenuation: number;
  minPossibleFg: number;
  capAbvToOg: boolean;
  minCalibrationBubbles: number;
}

export interface FermentationEstimate {
  abv: number | null;
  abvCapped: boolean;
  estimatedSg: number | null;
  apparentAttenuation: number | null;
  co2Liters: number;
  bubbleVolumeMl: number;
  bubbleVolumeSource: BubbleVolumeSource;
  og: number | null;
  expectedAbv: number | null;
  /** Yeast (or default) attenuation blended with the added sugar's share. */
  expectedAttenuation: number | null;
  /** Share of the OG's gravity points from added sugar (0..1). */
  sugarShare: number;
  bottling: { primingAbv: number; bottledAbv: number; co2Volumes: number } | null;
  caloriesPer330ml: number | null;
  /** Most ABV the OG could produce — the scale of the ABV bar. */
  maxAbv: number | null;
  targetAbv: number | null;
  calibration: {
    points: CalibrationPoint[];
    fittedBubbleVolumeMl: number | null;
    usablePoints: number;
    learnedBubbleVolumeMl: number | null;
  };
  warnings: string[];
  settings: FermentationSettings;
}

export interface GravityReading {
  id: number;
  batchId: number;
  measuredAt: string;
  value: number;
  unit: GravityUnit;
  excludeFromCalibration: boolean;
  notes: string | null;
  createdAt: string;
}

// Mirrors NotificationSettings in fratoo-bridge/src/push/notification-settings.ts.
export interface NotificationSettings {
  notifyFermentationStarted: boolean;
  notifyDeviceOffline: boolean;
  notifyNoStart: boolean;
  notifyTemperature: boolean;
  notifyPeakPassed: boolean;
  notifyLooksFinished: boolean;
  notifyStalled: boolean;
  notifyDeviceRebooted: boolean;
  offlineMinutes: number;
  noStartHours: number;
  tempMinC: number;
  tempMaxC: number;
  peakDropPct: number;
  peakDropHours: number;
  finishedBpm: number;
  finishedHours: number;
  stallHours: number;
  stallPctOfExpected: number;
}

/** A known airlock (Settings → Airlocks): GET /api/devices. */
export interface Device {
  deviceId: string;
  /** '' = not named yet. */
  name: string;
  createdAt: string;
  lastReadingAt: string | null;
  activeBatch: { id: number; batchCode: string } | null;
  lastBatchStartedAt: string | null;
}
