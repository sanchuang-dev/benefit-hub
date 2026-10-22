import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { app } from './app.js';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Invalid PORT');
}

app.use('/assets/*', serveStatic({ root: './public' }));
app.get('/', async (c) => c.html(await readFile(resolve(process.cwd(), 'public/index.html'), 'utf8')));
app.get('*', async (c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'NOT_FOUND' }, 404);
  return c.html(await readFile(resolve(process.cwd(), 'public/index.html'), 'utf8'));
});

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(JSON.stringify({ event: 'listening', port: info.port, mode: 'bootstrap' }));
});
