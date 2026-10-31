import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase, runMigrations } from './db/client.js';
import { logEvent } from './log.js';
import { createStaticApp } from './static-app.js';

const config = loadConfig(process.env);
const database = openDatabase(config.databaseFile);
const appliedMigrations = runMigrations(database.sqlite);

logEvent('database.ready', {
  file: config.databaseFile,
  migrationsApplied: appliedMigrations.length,
});

const app = createApp({ db: database.db, config });

// `public/` is the admin build output (index.html, assets/, brand/). The static
// app mounts the console under /admin and keeps the origin root out of it; see
// docs/brand/README.md for the brand inventory and serving rules.
const publicRoot = resolve(process.cwd(), 'public');

app.route('/', createStaticApp(publicRoot));

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  logEvent('server.listening', {
    port: info.port,
    cookieSecure: config.cookieSecure,
    trustProxy: config.trustProxy,
    sessionTtlHours: Math.round(config.sessionTtlMs / 3_600_000),
  });
});

function shutdown(signal: string): void {
  logEvent('server.shutdown', { signal });
  const forceExit = setTimeout(() => process.exit(1), 5_000);
  forceExit.unref();
  server.close(() => {
    database.close();
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
