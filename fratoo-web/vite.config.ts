import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import pkg from './package.json' with { type: 'json' }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Shown in the footer (AppFooter.tsx). GIT_COMMIT comes from the Docker
  // build arg set by ProdRelease.bat; local builds say 'dev'.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_COMMIT__: JSON.stringify(process.env.GIT_COMMIT || 'dev'),
  },
  server: {
    // Local dev: `npm run dev` here + the backend running separately on
    // :3000 (e.g. `npm run start:dev` in fratoo-bridge). In production,
    // nginx does the equivalent /api proxy — see ../docker-compose.yml and
    // nginx.conf in this folder.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
