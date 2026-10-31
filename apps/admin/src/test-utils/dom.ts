import { screen } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * DOM helpers shared by the route-page tests. They exist so a test can express
 * "click the save button" without depending on antd's internal DOM structure;
 * every page test used to carry its own copy of these functions.
 */

/** Resolves a button by its accessible text, ignoring whitespace in the label. */
export function findButtonText(text: string): HTMLElement {
  const element = screen.getByText((content) => content.replace(/\s/g, '') === text);
  const button = element.closest('button');
  if (!button) throw new Error(`No button containing ${text}`);
  return button;
}

/** Same as `findButtonText`, but waits for a button that appears asynchronously. */
export async function findButtonTextAsync(text: string, timeout = 5000): Promise<HTMLElement> {
  const element = await screen.findByText(
    (content) => content.replace(/\s/g, '') === text,
    undefined,
    { timeout },
  );
  const button = element.closest('button');
  if (!button) throw new Error(`No button containing ${text}`);
  return button;
}

/** Lists the non-GET requests the stubbed `fetch` received, as `METHOD url`. */
export function writeCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([, init]) => (init?.method ?? 'GET') !== 'GET')
    .map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
}

/** Parses the query string of an API URL; the same-origin base is irrelevant. */
export function queryParams(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams;
}
