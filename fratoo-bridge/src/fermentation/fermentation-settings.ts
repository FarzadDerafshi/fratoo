// App-wide knobs for the ABV model (abv-model.ts). Deliberately exposes far
// more than the eventual UI needs: while the bubble-volume calibration is
// still learning, every assumption should be adjustable without a code
// change. Persisted as one JSONB row in app_settings (key 'fermentation') —
// see SettingsService. Sources for each default: ProjectDocs/DECISIONS.md.

export type AbvFormula = 'standard' | 'alternate';
export type CalibrationMode = 'auto' | 'default-only';
export type TemperatureSource = 'measured' | 'fixed';

export interface FermentationSettings {
  /** mL of gas per airlock bubble, used until calibration data exists. */
  defaultBubbleVolumeMl: number;
  /** 'auto': batch's own gravity readings → learned from other batches → default. 'default-only': ignore calibration (per-batch override still wins). */
  calibrationMode: CalibrationMode;
  /** Refractometer wort correction factor; Brix readings are divided by it. */
  wortCorrectionFactor: number;
  /** 'standard': (OG − FG) × 131.25. 'alternate': Hall, "Brew by the Numbers" — reads higher above ~1.060. */
  abvFormula: AbvFormula;
  /** Ambient pressure at the airlock, used for gas molar volume. */
  pressureKpa: number;
  /** Temperature used for gas volume and CO₂ solubility: the device's PCB-corrected V101, or a fixed value. */
  temperatureSource: TemperatureSource;
  fixedTemperatureC: number;
  /** Count the CO₂ that stays dissolved in the beer (never reaches the airlock). */
  dissolvedCo2Enabled: boolean;
  /** g CO₂ released per g ethanol produced — Balling: 0.9565 / 1. */
  co2PerEthanolMass: number;
  /** Gravity points per kg of added sugar per litre — sucrose 46 PPG ≈ 383.9. */
  sugarPointsPerKgPerLiter: number;
  /** Apparent attenuation assumed for the "expected ABV" figure (0..1). */
  expectedAttenuation: number;
  /** Lowest FG considered physically possible; caps the ABV estimate against the OG. */
  minPossibleFg: number;
  capAbvToOg: boolean;
  /** Bubbles that must have been counted before a gravity reading can calibrate (early readings are dominated by dissolved CO₂). */
  minCalibrationBubbles: number;
}

export const DEFAULT_FERMENTATION_SETTINGS: FermentationSettings = {
  // Back-solved from the first production batch (1.38M bubbles, ~11 °Bx
  // kit IPA in 24 L) — a starting point, not a measurement. See DECISIONS.md.
  defaultBubbleVolumeMl: 0.3,
  calibrationMode: 'auto',
  wortCorrectionFactor: 1.04,
  abvFormula: 'standard',
  pressureKpa: 101.325,
  temperatureSource: 'measured',
  fixedTemperatureC: 20,
  dissolvedCo2Enabled: true,
  co2PerEthanolMass: 0.9565,
  sugarPointsPerKgPerLiter: 383.9,
  expectedAttenuation: 0.75,
  minPossibleFg: 0.99,
  capAbvToOg: true,
  minCalibrationBubbles: 5000,
};
