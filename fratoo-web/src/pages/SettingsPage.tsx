import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { AirlocksCard } from '../components/AirlocksCard';
import { NotificationsCard } from '../components/NotificationsCard';
import type { FermentationSettings } from '../types';

// Kept in sync by hand with DEFAULT_FERMENTATION_SETTINGS in
// fratoo-bridge/src/fermentation/fermentation-settings.ts — only used to
// flag which settings differ from the default; the backend owns the values.
const DEFAULTS: FermentationSettings = {
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

type Key = keyof FermentationSettings;

interface Field {
  key: Key;
  label: string;
  help: string;
  kind: 'number' | 'boolean' | 'select';
  step?: string;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

// Ranges match UpdateFermentationSettingsDto. Sources for every default:
// ProjectDocs/DECISIONS.md "Calibrated bubble-volume ABV model".
const SECTIONS: { title: string; fields: Field[] }[] = [
  {
    title: 'Bubble volume & calibration',
    fields: [
      {
        key: 'calibrationMode',
        label: 'Calibration mode',
        help: "Auto: a batch's own gravity readings → learned from other batches → default. Default only: ignore calibration (a per-batch override still wins).",
        kind: 'select',
        options: [
          { value: 'auto', label: 'Auto (calibrate from gravity readings)' },
          { value: 'default-only', label: 'Default only' },
        ],
      },
      {
        key: 'defaultBubbleVolumeMl',
        label: 'Default bubble volume (mL)',
        help: 'Gas per airlock bubble, used until any gravity reading has calibrated it.',
        kind: 'number',
        step: 'any',
        min: 0.01,
        max: 20,
      },
      {
        key: 'minCalibrationBubbles',
        label: 'Min. bubbles before a reading calibrates',
        help: 'Readings taken earlier are dominated by dissolved CO₂ and are skipped.',
        kind: 'number',
        step: '1',
        min: 0,
      },
    ],
  },
  {
    title: 'Gravity',
    fields: [
      {
        key: 'wortCorrectionFactor',
        label: 'Refractometer wort correction factor',
        help: 'Brix readings are divided by this before conversion. 1.00 for no correction; typically 1.02–1.06.',
        kind: 'number',
        step: 'any',
        min: 0.8,
        max: 1.3,
      },
      {
        key: 'abvFormula',
        label: 'ABV formula',
        help: 'Standard: (OG − FG) × 131.25. Alternate (Hall): reads higher above ~1.060 OG.',
        kind: 'select',
        options: [
          { value: 'standard', label: 'Standard' },
          { value: 'alternate', label: 'Alternate (Hall)' },
        ],
      },
      {
        key: 'sugarPointsPerKgPerLiter',
        label: 'Sugar gravity points per kg per litre',
        help: 'Used when the OG was measured before adding sugar. Sucrose ≈ 383.9 (46 PPG).',
        kind: 'number',
        step: 'any',
        min: 0,
      },
      {
        key: 'expectedAttenuation',
        label: 'Expected apparent attenuation (0–1)',
        help: 'For the "expected ABV" mark when a batch has no strain attenuation of its own. Added sugar is counted as fully fermentable on top.',
        kind: 'number',
        step: 'any',
        min: 0,
        max: 1,
      },
      {
        key: 'minPossibleFg',
        label: 'Lowest possible FG',
        help: 'The ABV estimate is capped at what the OG could produce down to this gravity.',
        kind: 'number',
        step: 'any',
        min: 0.95,
        max: 1.05,
      },
      {
        key: 'capAbvToOg',
        label: 'Cap ABV to what the OG allows',
        help: 'Shows a "capped" flag and a warning when the bubble count implies more alcohol than possible.',
        kind: 'boolean',
      },
    ],
  },
  {
    title: 'Gas physics',
    fields: [
      {
        key: 'temperatureSource',
        label: 'Temperature source',
        help: "Measured: the device's PCB-corrected temperature for each interval. Fixed: the value below.",
        kind: 'select',
        options: [
          { value: 'measured', label: 'Measured (device)' },
          { value: 'fixed', label: 'Fixed' },
        ],
      },
      {
        key: 'fixedTemperatureC',
        label: 'Fixed temperature (°C)',
        help: 'Used when the source is Fixed, or before the first temperature reading.',
        kind: 'number',
        step: 'any',
        min: -5,
        max: 45,
      },
      {
        key: 'pressureKpa',
        label: 'Ambient pressure (kPa)',
        help: '101.325 at sea level; about 1.2 kPa less per 100 m of altitude.',
        kind: 'number',
        step: 'any',
        min: 50,
        max: 120,
      },
      {
        key: 'dissolvedCo2Enabled',
        label: 'Count dissolved CO₂',
        help: 'Adds the CO₂ that stays in solution (never reaches the airlock) back into the estimate.',
        kind: 'boolean',
      },
      {
        key: 'co2PerEthanolMass',
        label: 'g CO₂ per g ethanol',
        help: 'Balling: 0.9565.',
        kind: 'number',
        step: 'any',
        min: 0.5,
        max: 1.5,
      },
    ],
  },
];

function isDefault(key: Key, value: FermentationSettings[Key]): boolean {
  return DEFAULTS[key] === value;
}

export function SettingsPage() {
  const [settings, setSettings] = useState<FermentationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped after a save/reset so the uncontrolled inputs pick up the new values.
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    api
      .get<FermentationSettings>('/settings/fermentation')
      .then(setSettings)
      .catch(() => setError('Failed to load settings.'));
  }, []);

  async function apply(action: () => Promise<FermentationSettings>, done: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setSettings(await action());
      setFormKey((k) => k + 1);
      setMessage(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }

  function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const dto: Record<string, unknown> = {};
    for (const { fields } of SECTIONS) {
      for (const f of fields) {
        if (f.kind === 'boolean') dto[f.key] = form.get(f.key) === 'on';
        else if (f.kind === 'number') dto[f.key] = Number(form.get(f.key));
        else dto[f.key] = String(form.get(f.key));
      }
    }
    void apply(
      () => api.patch<FermentationSettings>('/settings/fermentation', dto),
      'Saved — all batches have been recalibrated.',
    );
  }

  function handleReset() {
    if (!window.confirm('Reset every fermentation-model setting to its default?')) return;
    void apply(() => api.post<FermentationSettings>('/settings/fermentation/reset'), 'Reset to defaults.');
  }

  return (
    <>
      <div className="detail-head">
        <Link to="/batches" className="back-link">
          ← All batches
        </Link>
        <h1 className="page-title">Settings</h1>
      </div>

      <AirlocksCard />

      <NotificationsCard />

      <div className="settings-section-head">
        <h2 className="card-title">ABV model</h2>
        <p className="card-sub">
          Applies to every batch. Saving recalibrates all batches. Settings that differ from the default are marked
          in amber.
        </p>
      </div>

      {error && <p className="error-text">{error}</p>}
      {message && <p className="success-text">{message}</p>}

      {settings === null ? (
        !error && <p className="empty-state">Loading…</p>
      ) : (
        <form key={formKey} onSubmit={handleSave} className="page-form">
          {SECTIONS.map((section) => (
            <section key={section.title} className="card">
              <h2 className="card-title">{section.title}</h2>
              <div className="settings-grid">
                {section.fields.map((f) => {
                  const value = settings[f.key];
                  const changed = !isDefault(f.key, value);
                  return (
                    <div key={f.key} className={`settings-field${changed ? ' settings-field-changed' : ''}`}>
                      {f.kind === 'boolean' ? (
                        <label className="check">
                          <input name={f.key} type="checkbox" defaultChecked={value as boolean} />
                          {f.label}
                        </label>
                      ) : (
                        <label className="field">
                          {f.label}
                          {f.kind === 'select' ? (
                            <select name={f.key} defaultValue={String(value)}>
                              {f.options!.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              name={f.key}
                              type="number"
                              required
                              step={f.step}
                              min={f.min}
                              max={f.max}
                              defaultValue={String(value)}
                            />
                          )}
                        </label>
                      )}
                      <p className="settings-help">
                        {f.help} <span className="settings-default">Default: {String(DEFAULTS[f.key])}</span>
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          <div className="form-actions">
            <button type="submit" disabled={busy}>
              Save settings
            </button>
            <button type="button" className="secondary" onClick={handleReset} disabled={busy}>
              Reset to defaults
            </button>
          </div>
        </form>
      )}
    </>
  );
}
