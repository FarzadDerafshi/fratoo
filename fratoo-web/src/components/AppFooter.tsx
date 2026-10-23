import { useEffect, useState } from 'react';
import { api } from '../api/client';

interface VersionInfo {
  version: string;
  commit: string;
  startedAt: string;
}

// Which build is running. The dashboard and API are deployed together, so
// they should always match; if they don't (e.g. a stale browser cache or a
// half-finished deploy), the API's build is shown too.
export function AppFooter() {
  const [apiInfo, setApiInfo] = useState<VersionInfo | null>(null);

  useEffect(() => {
    api
      .get<VersionInfo>('/version')
      .then(setApiInfo)
      .catch(() => setApiInfo(null));
  }, []);

  const web = `v${__APP_VERSION__} (${__GIT_COMMIT__})`;
  const mismatch = apiInfo && (apiInfo.version !== __APP_VERSION__ || apiInfo.commit !== __GIT_COMMIT__);

  return (
    <footer className="app-footer">
      Fratoo {web}
      {mismatch && (
        <span className="app-footer-warning">
          {' '}
          · API v{apiInfo.version} ({apiInfo.commit}) — reload the page if this persists
        </span>
      )}
      {apiInfo && <span> · API up since {new Date(apiInfo.startedAt).toLocaleString()}</span>}
    </footer>
  );
}
