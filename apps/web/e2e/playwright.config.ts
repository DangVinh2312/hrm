import { defineConfig } from '@playwright/test';

// One serial worker: the suite owns a single disposable stack (PostgreSQL, API, fake IdP, web).
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e-spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    // The stack uses a CA generated per run; the browser is told to accept it, the API trusts it
    // explicitly through NODE_EXTRA_CA_CERTS.
    ignoreHTTPSErrors: true,
    trace: 'off',
  },
});
