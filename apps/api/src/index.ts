import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase, runMigrations } from './db/client.js';
import { logEvent } from './log.js';

const config = loadConfig(process.env);
const database = openDatabase(config.databaseFile);
const appliedMigrations = runMigrations(database.sqlite);

logEvent('database.ready', {
  file: config.databaseFile,
  migrationsApplied: appliedMigrations.length,
});

const app = createApp({ db: database.db, config });

app.use('/assets/*', serveStatic({ root: './public' }));

const readIndexHtml = () => readFile(resolve(process.cwd(), 'public/index.html'), 'utf8');

app.get('/', async (c) => c.html(await readIndexHtml()));
app.get('*', async (c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'NOT_FOUND', message: '接口不存在' }, 404);
  }
  // Client-side routing: every non-API path returns the app shell, and the
  // admin UI decides whether to show the login screen or the protected layout.
  return c.html(await readIndexHtml());
});

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
