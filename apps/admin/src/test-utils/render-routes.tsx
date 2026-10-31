import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../app/routes';
import { useUiPrefs } from '../shared/lib/ui-prefs';

/**
 * Clears UI preferences between tests through the persist API, not a concrete
 * storage API, so the helper keeps working if the backend is swapped. The store
 * is a module singleton, so without this a tab/view chosen in one test would
 * leak into the next one even though its component tree was unmounted.
 *
 * An async backend (IndexedDB) would make this return a Promise; callers should
 * then await it in afterEach.
 */
export function resetUiPrefs(): void {
  useUiPrefs.getState().reset();
  void useUiPrefs.persist.clearStorage();
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

  // jsdom ships no canvas implementation. Even with the SVG renderer ECharts
  // measures text through a 2d context, so provide the small surface it reads.
  // The charts still render as real SVG DOM, which is what the tests assert on;
  // this only stops jsdom from logging "getContext not implemented" for every
  // label measurement.
  const canvasPrototype = window.HTMLCanvasElement?.prototype;
  if (canvasPrototype) {
    Object.defineProperty(canvasPrototype, 'getContext', {
      configurable: true,
      writable: true,
      value: () => ({
        measureText: (text: string) => ({ width: String(text).length * 6 }),
        fillText: () => undefined,
        strokeText: () => undefined,
        fillRect: () => undefined,
        clearRect: () => undefined,
        save: () => undefined,
        restore: () => undefined,
        scale: () => undefined,
        translate: () => undefined,
        setTransform: () => undefined,
        beginPath: () => undefined,
        moveTo: () => undefined,
        lineTo: () => undefined,
        closePath: () => undefined,
        stroke: () => undefined,
        fill: () => undefined,
        arc: () => undefined,
        rect: () => undefined,
        clip: () => undefined,
        createLinearGradient: () => ({ addColorStop: () => undefined }),
      }),
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
