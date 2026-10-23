// App-wide alert switches and thresholds (app_settings key 'notifications').
// Mirrored by hand in fratoo-web/src/components/NotificationsCard.tsx.

export interface NotificationSettings {
  notifyFermentationStarted: boolean;
  /** No reading for offlineMinutes while a batch is active, and "back online" when readings return. */
  notifyDeviceOffline: boolean;
  /** No sustained bubbling noStartHours after pitching (or the batch start). */
  notifyNoStart: boolean;
  /** Airlock temperature outside tempMinC–tempMaxC (a batch's own limits win), and back inside. */
  notifyTemperature: boolean;
  /** The hourly rate stayed below (100 − peakDropPct)% of the peak for peakDropHours. */
  notifyPeakPassed: boolean;
  /** Under finishedBpm for finishedHours, with the estimated ABV near the expected mark. */
  notifyLooksFinished: boolean;
  /** Under finishedBpm for stallHours while the estimated ABV is below stallPctOfExpected% of the expected mark. */
  notifyStalled: boolean;
  /** The bubble counter reset (power cut or reboot). Informational, so off by default. */
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

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  notifyFermentationStarted: true,
  notifyDeviceOffline: true,
  notifyNoStart: true,
  notifyTemperature: true,
  notifyPeakPassed: true,
  notifyLooksFinished: true,
  notifyStalled: true,
  notifyDeviceRebooted: false,

  // The device wakes every ~4m47s, so 30 min is ~6 missed wake-ups.
  offlineMinutes: 30,
  noStartHours: 24,
  // Measured at the airlock, not in the beer (2–4 °C warmer at peak). An ale
  // band; lagers or a Kveik batch set their own limits on the batch.
  tempMinC: 16,
  tempMaxC: 24,
  peakDropPct: 50,
  peakDropHours: 3,
  finishedBpm: 2,
  finishedHours: 24,
  stallHours: 12,
  stallPctOfExpected: 70,
};
