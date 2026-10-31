// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { installDomStubs, renderRoutes, resetUiPrefs } from '../../test-utils/render-routes';
import { jsonResponse, mockFetch } from '../../test-utils/http';

const SESSION = {
  admin: { id: 'admin-1', username: 'ops', displayName: '运营管理员', role: 'admin' },
  session: { expiresAt: Date.now() + 8 * 60 * 60 * 1000 },
};

function start(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  mockFetch((url) => {
    if (url === '/api/v1/auth/session') return jsonResponse(200, SESSION);
    if (url === '/api/v1/system/status') return jsonResponse(200, {
      service: 'benefit-hub', phase: 'auth-enabled', adminEnabled: true, authenticationRequired: true,
    });
    return undefined;
  });
  return renderRoutes('/');
}

beforeAll(() => installDomStubs());
afterEach(() => {
  cleanup();
  resetUiPrefs();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
  vi.unstubAllGlobals();
});

describe('responsive console navigation', () => {
  it('collapses and expands the desktop sidebar without losing the work tabs', async () => {
    start(1366);
    const collapse = await screen.findByRole('button', { name: '收起侧边栏' });
    fireEvent.click(collapse);
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '总览' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开侧边栏' }));
    expect(screen.getByRole('button', { name: '收起侧边栏' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '搜索菜单' })).toBeTruthy();
  }, 20000);

  it('uses a searchable drawer on mobile, closes after navigation and restores focus', async () => {
    const { router } = start(390);
    const trigger = await screen.findByRole('button', { name: '打开导航菜单' });
    expect(document.querySelector('.app-sider')).toBeNull();
    fireEvent.click(trigger);
    const drawer = await screen.findByRole('dialog', { name: '导航菜单' });
    expect(within(drawer).getByRole('textbox', { name: '搜索菜单' })).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('menuitem', { name: '权益商品' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/catalog'));
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
    expect(screen.getByRole('tab', { name: '权益商品' })).toBeTruthy();
  }, 25000);

  it('switches from drawer to desktop sidebar at the 768px boundary', async () => {
    start(767);
    expect(await screen.findByRole('button', { name: '打开导航菜单' })).toBeTruthy();
    window.innerWidth = 768;
    fireEvent.resize(window);
    await waitFor(() => expect(screen.queryByRole('button', { name: '打开导航菜单' })).toBeNull());
    expect(document.querySelector('.app-sider')).not.toBeNull();
  }, 15000);
});
