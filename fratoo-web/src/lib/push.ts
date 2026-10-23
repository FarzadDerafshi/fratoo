// Web Push on this device: subscribe with the server's VAPID key, hand the
// subscription to the API, unsubscribe. The service worker (public/sw.js)
// shows the notifications.

import { api } from '../api/client';

export type PushSupport =
  /** Ready to ask for permission. */
  | 'supported'
  /** iPhone/iPad Safari tab: Web Push only works in the home-screen app (iOS 16.4+). */
  | 'needs-install'
  | 'unsupported';

interface PushStatus {
  publicKey: string;
  subscriptions: number;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function pushSupport(): PushSupport {
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIos() && !isStandalone()) return 'needs-install';
  return capable ? 'supported' : 'unsupported';
}

function registration(): Promise<ServiceWorkerRegistration> {
  // main.tsx registers the worker in production builds only.
  if (import.meta.env.DEV) return Promise.reject(new Error('Push needs the production build (no service worker in dev).'));
  return navigator.serviceWorker.ready;
}

/** This device's current subscription, if notifications are on. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  return (await registration()).pushManager.getSubscription();
}

export function getPushStatus(): Promise<PushStatus> {
  return api.get<PushStatus>('/push');
}

function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Must run from a tap (iOS only shows the permission prompt for a user gesture). */
export async function enablePush(): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for Fratoo. Allow them in the phone or browser settings, then try again.'
        : 'Notifications were not allowed.',
    );
  }
  const { publicKey } = await getPushStatus();
  const reg = await registration();
  // A subscription made with an older server key can't receive anything, so replace it.
  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) });
  const json = sub.toJSON();
  await api.post('/push/subscriptions', { endpoint: json.endpoint, keys: json.keys });
  return sub;
}

export async function disablePush(sub: PushSubscription): Promise<void> {
  await api.post('/push/subscriptions/remove', { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

export function sendTestPush(sub: PushSubscription): Promise<{ sent: number; removed: number; failed: number }> {
  return api.post('/push/test', { endpoint: sub.endpoint });
}
