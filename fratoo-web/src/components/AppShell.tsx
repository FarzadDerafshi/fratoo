import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useTheme } from '../lib/theme';
import { AppFooter } from './AppFooter';
import { AutoThemeIcon, MoonIcon, SunIcon } from './Icons';
import { Logo } from './Logo';

// Frame around every signed-in page: top bar (logo, navigation, theme
// button, log out), the page, and the version footer.

const THEME_LABEL = {
  system: 'Theme: automatic (follows device)',
  light: 'Theme: light',
  dark: 'Theme: dark',
} as const;
export function AppShell() {
  const { logout } = useAuth();
  const { mode, cycle } = useTheme();

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/batches" className="topbar-brand" aria-label="Fratoo — all batches">
            <Logo size={28} />
          </Link>
          <nav className="topbar-nav">
            <NavLink to="/batches" className="nav-link">
              Batches
            </NavLink>
            <NavLink to="/settings" className="nav-link">
              Settings
            </NavLink>
          </nav>
          <div className="topbar-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={cycle}
              aria-label={`${THEME_LABEL[mode]}. Tap to change.`}
              title={THEME_LABEL[mode]}
            >
              {mode === 'system' ? <AutoThemeIcon /> : mode === 'dark' ? <MoonIcon /> : <SunIcon />}
            </button>
            <button type="button" className="secondary" onClick={logout}>
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
      <AppFooter />
    </div>
  );
}
