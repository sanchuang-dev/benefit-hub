// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installDomStubs, resetUiPrefs } from '../../test-utils/render-routes';
import { AppShell } from './AppShell';

const ADMIN = {
  id: 'account-1',
  username: 'ops.admin',
  displayName: '运维管理员',
  role: 'admin' as const,
};

const originalMatchMedia = window.matchMedia;

/** Mirrors the CSS breakpoint used by the shell and the stylesheet. */
function stubViewport(compact: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: compact && query.includes('max-width: 767px'),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function renderShell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppShell admin={ADMIN} />,
        children: [
          { index: true, element: <div>总览内容</div> },
          { path: 'catalog', element: <div>商品内容</div> },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );

  render(
    <AntdApp>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AntdApp>,
  );

  return router;
}

beforeAll(() => installDomStubs());

afterEach(() => {
  cleanup();
  resetUiPrefs();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe('AppShell responsive navigation', () => {
  it('keeps the persistent sidebar and exposes it as a navigation landmark on desktop', async () => {
    stubViewport(false);
    renderShell();

    expect(screen.queryByRole('button', { name: '打开导航菜单' })).toBeNull();
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: '已打开页面' })).toBeTruthy();
    expect(await screen.findByRole('menuitem', { name: '权益商品' })).toBeTruthy();
  });

  it('opens navigation in a labelled drawer below 768px and closes it after navigating', async () => {
    stubViewport(true);
    const router = renderShell();

    // The permanent rail is gone; navigation only exists inside the drawer.
    expect(document.querySelector('.app-sider')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '权益商品' })).toBeNull();

    const trigger = screen.getByRole('button', { name: '打开导航菜单' });
    fireEvent.click(trigger);

    expect(await screen.findByRole('dialog', { name: '导航菜单' })).toBeTruthy();
    expect(screen.getByLabelText('搜索菜单')).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: '权益商品' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/catalog'));
    // antd keeps the closed drawer mounted but hidden from the accessibility
    // tree; role queries ignore it, so the menu is no longer reachable by name.
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '权益商品' })).toBeNull());
  });

  it('filters the drawer menu with the same sidebar search', async () => {
    stubViewport(true);
    renderShell();

    fireEvent.click(screen.getByRole('button', { name: '打开导航菜单' }));
    const search = await screen.findByLabelText('搜索菜单');
    fireEvent.change(search, { target: { value: '订单' } });

    expect(screen.getByRole('menuitem', { name: '业务订单' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '权益商品' })).toBeNull();
  });
});
