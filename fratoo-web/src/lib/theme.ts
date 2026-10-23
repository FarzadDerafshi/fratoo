import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
/** What the user picked: follow the device ("system"), or pin light/dark. */
export type ThemeMode = 'system' | Theme;

// The choice is stored per browser; with nothing stored the theme follows
// the device setting (and keeps following it live). index.html applies a
// stored choice before first paint (same key) so dark mode never flashes
// light; the CSS handles the follow-the-device case on its own via
// prefers-color-scheme.
const STORAGE_KEY = 'fratoo_theme';

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Current theme and mode plus a cycle button. The cycle goes
 * Auto → the opposite of the device → the device's own look → Auto, so
 * every tap except the last visibly changes something, and Auto is always
 * one or two taps away.
 */
export function useTheme(): { theme: Theme; mode: ThemeMode; cycle: () => void } {
  const [choice, setChoice] = useState<Theme | null>(stored);
  const [system, setSystem] = useState<Theme>(systemTheme);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const theme = choice ?? system;
  const mode: ThemeMode = choice ?? 'system';

  useEffect(() => {
    if (choice) document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
    window.dispatchEvent(new CustomEvent('fratoo-theme', { detail: theme }));
  }, [choice, theme]);

  const cycle = useCallback(() => {
    const opposite: Theme = system === 'dark' ? 'light' : 'dark';
    const next: Theme | null = choice === null ? opposite : choice === opposite ? system : null;
    try {
      if (next) localStorage.setItem(STORAGE_KEY, next);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode etc. — the choice just won't survive a reload.
    }
    setChoice(next);
  }, [choice, system]);

  return { theme, mode, cycle };
}

/** Re-renders when the theme changes (for canvas-drawn things like the chart that read CSS variables). */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener('fratoo-theme', bump);
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener('change', bump);
    return () => {
      window.removeEventListener('fratoo-theme', bump);
      mq?.removeEventListener('change', bump);
    };
  }, []);
  return version;
}

/** Reads a CSS custom property from :root (e.g. "--chart-rate"). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
