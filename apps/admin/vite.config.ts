import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The dev server only replaces the browser-facing origin; the API stays the same
// Hono app it is in production. `changeOrigin` must stay off: the CSRF
// middleware compares the browser `Origin` header with `Host`, so rewriting the
// host would reject every write request.
const apiTarget = process.env.BENEFIT_API_ORIGIN ?? 'http://127.0.0.1:4080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4081,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget },
      '/healthz': { target: apiTarget },
    },
  },
  test: {
    // These tests render the real antd/React tree in jsdom: one page journey
    // takes seconds alone and several times longer while Vitest runs the 19
    // files in parallel. The 5 s default therefore failed only with load, not
    // with a wrong assertion. Keep a per-test ceiling with real headroom for a
    // slow CI runner, and cap concurrency so one file cannot starve the rest.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 4,
  },
});
