import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../app/routes';
import { useUiPrefs } from '../shared/lib/ui-prefs';

/**
 * Clears session-scoped UI preferences between tests. The store is a module
 * singleton, so without this a tab/view chosen in one test would leak into the
 * next one even though its component tree was unmounted.
 */
export function resetUiPrefs(): void {
  useUiPrefs.getState().reset();
  sessionStorage.clear();
}

export function installDomStubs(): void {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
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

  if (!('ResizeObserver' in globalThis)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      writable: true,
      value: ResizeObserverStub,
    });
  }
}

/** Renders the real route tree with the same providers used by main.tsx. */
export function renderRoutes(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
  const result = render(
    <ConfigProvider>
      <AntdApp>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>,
  );
  return { ...result, router, queryClient };
}
