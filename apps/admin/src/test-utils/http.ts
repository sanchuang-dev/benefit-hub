import { vi } from 'vitest';

/**
 * Shared HTTP fixture for admin tests. Every admin test stubs the same-origin
 * API at the `fetch` boundary, so these helpers live here instead of being
 * copied into each test file.
 */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Replaces `fetch` with a handler keyed by URL. An unhandled request throws
 * instead of silently returning an empty body, so a test cannot pass because a
 * request it assumed was made never reached the network boundary.
 */
export function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const response = await handler(url, init);
    if (!response) throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
