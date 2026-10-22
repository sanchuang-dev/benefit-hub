import { Hono } from 'hono';

export const app = new Hono();

app.get('/healthz', (c) => c.json({ status: 'ok', service: 'benefit-hub' }));
app.get('/api/v1/system/status', (c) =>
  c.json({
    service: 'benefit-hub',
    phase: 'bootstrap',
    vendorFulfillmentEnabled: false,
    adminEnabled: false,
  }),
);
