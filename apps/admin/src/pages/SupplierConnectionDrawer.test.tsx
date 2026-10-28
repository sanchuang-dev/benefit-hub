// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { installDomStubs, renderRoutes } from '../test-utils/render-routes';

function response(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json' },
  });
}

const admin = {
  id: 'admin-1', username: 'operator', displayName: '管理员',
  role: 'admin' as const,
};

function mockRequests(canSave: boolean) {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (path === '/api/v1/auth/session') {
      return response(200, { admin, session: { expiresAt: Date.now() + 60 * 60 * 1000 } });
    }
    if (path === '/api/v1/system/status') return response(200, {
      service: 'benefit-hub', phase: 'auth-enabled', vendorFulfillmentEnabled: false,
      adminEnabled: true, authenticationRequired: true,
    });
    if (path === '/api/v1/suppliers/yangmao') {
      return response(200, { supplier: {
        key: 'yangmao', name: '上力', fulfillmentEnabled: false,
        catalogRead: { supported: true, configured: false, source: 'none', locked: false, canEdit: canSave },
      } });
    }
    if (path === '/api/v1/suppliers/yangmao/connection' && method === 'GET') {
      return response(200, { connection: {
        provider: 'yangmao', baseUrl: 'https://dev-api.isunpow.com',
        version: 0, source: 'none', hasCredentials: false, canSave,
      } });
    }
    if (path === '/api/v1/auth/csrf') return response(200, { csrfToken: 'fixture-csrf-token' });
    if (path === '/api/v1/suppliers/yangmao/connection' && method === 'PUT') {
      return response(200, { connection: {
        provider: 'yangmao', baseUrl: 'https://dev-api.isunpow.com',
        version: 1, source: 'database', hasCredentials: true, canSave: true,
      } });
    }
    throw new Error('Unexpected request ' + method + ' ' + path);
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

beforeAll(() => installDomStubs());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('supplier connection editor', () => {
  it('persists credentials from the admin drawer to the same-origin API without provider calls', async () => {
    const calls = mockRequests(true);
    renderRoutes('/suppliers/yangmao');
    fireEvent.click(await screen.findByRole('tab', { name: '接入与规则' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑接入配置' }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.change(await within(dialog).findByLabelText('AppKey'), {
      target: { value: 'fixture-app-key' },
    });
    fireEvent.change(within(dialog).getByLabelText('AppSecret'), {
      target: { value: 'fixture-app-secret' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存配置' }));

    await waitFor(() => expect(calls.some((c) => c.path === '/api/v1/suppliers/yangmao/connection' && c.method === 'PUT')).toBe(true), { timeout: 5000 });
    const saved = calls.find((c) => c.method === 'PUT');
    expect(JSON.parse(saved?.body ?? '{}')).toEqual({
      baseUrl: 'https://dev-api.isunpow.com', appKey: 'fixture-app-key',
      appSecret: 'fixture-app-secret', version: 0,
    });
    expect(calls.every((c) => c.path.startsWith('/api/v1/'))).toBe(true);
  }, 15_000);

  it('makes the save action unavailable until the server has its one-time encryption key', async () => {
    mockRequests(false);
    renderRoutes('/suppliers/yangmao');
    fireEvent.click(await screen.findByRole('tab', { name: '接入与规则' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑接入配置' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('服务器加密主密钥尚未就绪')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled).toBe(true);
  }, 15_000);
});
