import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Dev only: the browser talks to one origin; /api is proxied to the API without rewriting
// Origin/Host, so the API's exact-origin CSRF check sees the page origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'HRM_');
  return {
    plugins: [react()],
    server: {
      // strictPort: the OIDC redirectUri and APP_ORIGIN are fixed to this port.
      port: Number(env.HRM_WEB_PORT) || 5173,
      strictPort: true,
      proxy: { '/api': { target: env.HRM_API_TARGET || 'http://127.0.0.1:3000' } },
    },
    test: {
      environment: 'jsdom',
      include: ['test/**/*.spec.{ts,tsx}'],
      setupFiles: ['./test/setup.ts'],
    },
  };
});
