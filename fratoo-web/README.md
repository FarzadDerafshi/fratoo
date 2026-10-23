# fratoo-web

The Fratoo dashboard: a React + TypeScript + Vite single-page app, installable as a PWA.
It talks to [`fratoo-bridge`](../fratoo-bridge/) over `/api` with a JWT and has no
fermentation math of its own beyond the temperature correction (see
[ARCHITECTURE.md](../ProjectDocs/ARCHITECTURE.md#fratoo-web-react--vite--standalone-frontend)).

## Develop

```powershell
npm ci
npm run dev        # http://localhost:5173, proxies /api to the backend on :3000
npm run build      # type-check (tsc -b) + production bundle in dist/
npm run lint       # oxlint
```

Run the backend separately (`npm run start:dev` in `fratoo-bridge`), or point the proxy in
`vite.config.ts` at a running stack.

## Layout

| Path | What |
|---|---|
| `src/pages/` | Login, batch list, batch detail, settings |
| `src/components/` | App frame, chart, gravity readings, events, notifications, logo… |
| `src/api/client.ts` | Fetch wrapper: base `/api`, JWT, 401 → back to login |
| `src/lib/` | Formatting, theme, notes renderer, push subscription, temperature correction |
| `src/index.css` | All colours as CSS variables (light, dark) |
| `public/sw.js` | Service worker: app-shell cache, push notifications (never caches `/api`) |
| `public/manifest.webmanifest`, `public/icons/` | PWA manifest and icons (`icons/*.svg` are the sources, rendered by `../scripts/build-icons.ps1`) |
| `nginx.conf`, `Dockerfile` | Production image: static bundle + `/api` reverse proxy |

In production the bundle is baked into the nginx image, so source changes need
`docker compose up -d --build web` (or a normal deploy), not just a restart.
