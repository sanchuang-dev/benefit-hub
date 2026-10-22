import assert from 'node:assert/strict';
import test from 'node:test';
import { app } from '../dist/app.js';

test('health endpoint returns a non-sensitive status', async () => {
  const response = await app.request('/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'benefit-hub' });
});

test('fulfillment remains explicitly disabled in bootstrap', async () => {
  const response = await app.request('/api/v1/system/status');
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.vendorFulfillmentEnabled, false);
  assert.equal(state.adminEnabled, false);
});
