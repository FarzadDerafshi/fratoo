import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { currentSubscription, disablePush, enablePush, getPushStatus, pushSupport, sendTestPush } from '../lib/push';
import type { NotificationSettings } from '../types';

type SwitchKey = { [K in keyof NotificationSettings]: NotificationSettings[K] extends boolean ? K : never }[keyof NotificationSettings];
type NumberKey = Exclude<keyof NotificationSettings, SwitchKey>;

interface AlertDef {
  key: SwitchKey;
  label: string;
  help: string;
  fields: { key: NumberKey; label: string; step: number; min: number; max: number }[];
}

// Ranges match UpdateNotificationSettingsDto in fratoo-bridge/src/push/push.dto.ts.
const ALERTS: AlertDef[] = [
  {
    key: 'notifyFermentationStarted',
    label: 'Fermentation started',
    help: 'Steady bubbling has begun (the end of the lag phase).',
    fields: [],
  },
  {
    key: 'notifyDeviceOffline',
    label: 'Airlock offline / back online',
    help: 'No reading from the airlock while a batch is active, and again when readings return.',
    fields: [{ key: 'offlineMinutes', label: 'After (min)', step: 5, min: 10, max: 1440 }],
  },
  {
    key: 'notifyNoStart',
    label: 'No start',
    help: 'Still no steady bubbling this long after pitching (or after the batch started).',
    fields: [{ key: 'noStartHours', label: 'After (h)', step: 1, min: 1, max: 168 }],
  },
  {
    key: 'notifyTemperature',
    label: 'Temperature out of range',
    help: 'Airlock temperature outside the limits for two readings in a row, and again when it’s back. A batch can set its own limits (Edit batch → Temperature alerts).',
    fields: [
      { key: 'tempMinC', label: 'Low (°C)', step: 0.5, min: -10, max: 60 },
      { key: 'tempMaxC', label: 'High (°C)', step: 0.5, min: -10, max: 60 },
    ],
  },
  {
    key: 'notifyPeakPassed',
    label: 'Peak passed',
    help: 'The hourly bubble rate has stayed this far below the peak. A good moment for a gravity reading or a dry hop.',
    fields: [
      { key: 'peakDropPct', label: 'Drop (%)', step: 5, min: 10, max: 90 },
      { key: 'peakDropHours', label: 'For (h)', step: 1, min: 1, max: 48 },
    ],
  },
  {
    key: 'notifyLooksFinished',
    label: 'Looks finished',
    help: 'Bubbling has nearly stopped and the estimated ABV is close to the expected mark. Time for the final gravity reading.',
    fields: [
      { key: 'finishedBpm', label: 'Under (bpm)', step: 0.5, min: 0.1, max: 50 },
      { key: 'finishedHours', label: 'For (h)', step: 1, min: 1, max: 168 },
    ],
  },
  {
    key: 'notifyStalled',
    label: 'Possibly stalled',
    help: 'Bubbling has nearly stopped (same bpm limit as above) while the estimated ABV is below this share of the expected mark. Needs the batch OG.',
    fields: [
      { key: 'stallHours', label: 'For (h)', step: 1, min: 1, max: 168 },
      { key: 'stallPctOfExpected', label: 'Below (%)', step: 5, min: 10, max: 100 },
    ],
  },
  {
    key: 'notifyDeviceRebooted',
    label: 'Airlock restarted',
    help: 'The bubble counter reset after a power cut or reboot. Counting carries on, so this is just for information.',
    fields: [],
  },
];

/** Settings → Notifications: push on/off for this device, a test, and which alerts are sent (for every device). */
export function NotificationsCard() {
  const support = pushSupport();
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [devices, setDevices] = useState<number | null>(null);
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    currentSubscription()
      .then(setSub)
      .catch(() => setSub(null));
    getPushStatus()
      .then((s) => setDevices(s.subscriptions))
      .catch(() => setDevices(null));
    api
      .get<NotificationSettings>('/settings/notifications')
      .then(setSettings)
      .catch(() => setError('Failed to load the alert settings.'));
  }, []);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await action());
      setDevices((await getPushStatus()).subscriptions);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }

  const enable = () =>
    run(async () => {
      setSub(await enablePush());
      return 'Notifications are on for this device.';
    });

  const disable = () =>
    run(async () => {
      if (sub) await disablePush(sub);
      setSub(null);
      return 'Notifications are off for this device.';
    });

  const test = () =>
    run(async () => {
      if (!sub) return '';
      const result = await sendTestPush(sub);
      if (result.sent) return 'Test sent. It should arrive within a few seconds.';
      if (result.removed) {
        setSub(null);
        throw new Error('This device is no longer subscribed. Turn notifications on again.');
      }
      throw new Error('The push service refused the test. Try turning notifications off and on again.');
    });

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const dto: Partial<Record<keyof NotificationSettings, boolean | number>> = {};
    for (const alert of ALERTS) {
      dto[alert.key] = form.get(alert.key) === 'on';
      for (const f of alert.fields) dto[f.key] = Number(form.get(f.key));
    }
    void run(async () => {
      setSettings(await api.patch<NotificationSettings>('/settings/notifications', dto));
      setFormKey((k) => k + 1);
      return 'Alert settings saved.';
    });
  }

  return (
    <section className="card">
      <h2 className="card-title">Notifications</h2>
      <p className="card-sub">
        Push notifications about active batches. Turn them on for each phone or computer that should get them; the
        alerts below apply to all of them.
      </p>

      <div className="notify-body">
        {support === 'needs-install' && (
          <p className="hint">
            On iPhone and iPad, notifications only work in the installed app: tap Share → Add to Home Screen, open
            Fratoo from the home screen, then come back here.
          </p>
        )}
        {support === 'unsupported' && <p className="hint">This browser doesn't support push notifications.</p>}

        {support === 'supported' && (
          <>
            <div className="notify-state">
              <span className={`pill${sub ? ' good' : ''}`}>{sub ? 'On for this device' : 'Off for this device'}</span>
              {devices !== null && (
                <span className="hint">
                  {devices} device{devices === 1 ? '' : 's'} subscribed in total
                </span>
              )}
            </div>
            <div className="form-actions">
              {sub ? (
                <>
                  <button type="button" onClick={test} disabled={busy}>
                    Send a test
                  </button>
                  <button type="button" className="secondary" onClick={disable} disabled={busy}>
                    Turn off
                  </button>
                </>
              ) : (
                <button type="button" onClick={enable} disabled={busy}>
                  Turn on notifications
                </button>
              )}
            </div>
          </>
        )}

        {error && <p className="error-text">{error}</p>}
        {message && <p className="success-text">{message}</p>}

        {settings && (
          <form key={formKey} onSubmit={save} className="alert-list">
            <h3 className="alert-list-title">Alerts</h3>
            {ALERTS.map((alert) => (
              <div key={alert.key} className="alert-item">
                <label className="check">
                  <input name={alert.key} type="checkbox" defaultChecked={settings[alert.key]} />
                  <strong>{alert.label}</strong>
                </label>
                <p className="settings-help">{alert.help}</p>
                {alert.fields.length > 0 && (
                  <div className="alert-fields">
                    {alert.fields.map((f) => (
                      <label key={f.key} className="field">
                        {f.label}
                        <input
                          name={f.key}
                          type="number"
                          required
                          step={f.step}
                          min={f.min}
                          max={f.max}
                          defaultValue={String(settings[f.key])}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div className="form-actions">
              <button type="submit" disabled={busy}>
                Save alerts
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
