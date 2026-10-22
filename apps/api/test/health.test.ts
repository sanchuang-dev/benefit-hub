import { describe, expect, it } from 'vitest';
import { app } from '../src/app';

describe('Benefit Hub bootstrap API', () => {
  it('returns a non-sensitive health status', async () => {
    const response = await app.request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'benefit-hub',
    });
  });

  it('keeps vendor fulfillment and admin login disabled', async () => {
    const response = await app.request('/api/v1/system/status');
    expect(response.status).toBe(200);
    const state = await response.json();
    expect(state.vendorFulfillmentEnabled).toBe(false);
    expect(state.adminEnabled).toBe(false);
  });
});
