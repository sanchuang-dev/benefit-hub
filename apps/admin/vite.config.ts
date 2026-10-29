import { defineConfig } from 'vite';
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
});
