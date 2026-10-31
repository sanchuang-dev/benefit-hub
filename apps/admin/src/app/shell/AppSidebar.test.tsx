// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppSidebar } from './AppSidebar';

const originalMatchMedia = window.matchMedia;

/** The Ant Design Sider asks matchMedia whether the `lg` breakpoint is broken. */
function stubViewport(broken: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: broken,
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

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe('AppSidebar', () => {
  it('renders the 3C Benefit Hub wordmark next to the decorative brand mark', () => {
    stubViewport(false);
    const { container } = render(<AppSidebar activeKey="/" onNavigate={vi.fn()} />);

    const brand = container.querySelector('.app-brand');
    expect(brand?.querySelector('img')?.getAttribute('src')).toBe('/brand/logo-icon-512.png');
    expect(brand?.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(brand?.querySelector('.app-brand-text')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '3C Benefit Hub',
    );
  });

  it('narrows the menu to matching pages and shows an honest empty state', () => {
    stubViewport(false);
    render(<AppSidebar activeKey="/" onNavigate={vi.fn()} />);

    const search = screen.getByLabelText('搜索菜单');
    fireEvent.change(search, { target: { value: '订单' } });

    expect(screen.getByRole('menuitem', { name: '业务订单' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '权益商品' })).toBeNull();

    fireEvent.change(search, { target: { value: '不存在的菜单' } });
    expect(screen.getByText('未找到匹配的菜单')).toBeTruthy();
  });

  it('drops the search input when the responsive sidebar is collapsed', async () => {
    stubViewport(true);
    render(<AppSidebar activeKey="/" onNavigate={vi.fn()} />);

    await waitFor(() => expect(screen.queryByLabelText('搜索菜单')).toBeNull());
  });
});
