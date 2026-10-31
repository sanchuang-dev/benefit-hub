/**
 * Parsing/formatting for list state that lives in the URL.
 *
 * URLs are user-editable, so every value is validated against a whitelist and
 * clamped before it reaches a request. Defaults are omitted from the URL to
 * keep shareable links short. Shared by every list panel that keeps its
 * filters URL-owned (catalogue, supplier registry).
 */

export type PageSize = 10 | 20 | 50;
export const PAGE_SIZE_OPTIONS: PageSize[] = [10, 20, 50];
export const DEFAULT_PAGE_SIZE: PageSize = 20;

const MAX_PAGE = 10_000;
const MAX_KEYWORD_LENGTH = 100;

export function parsePage(raw: string | null): number {
  if (raw === null) return 1;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_PAGE ? value : 1;
}

export function parsePageSize(raw: string | null): PageSize {
  const value = Number(raw);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(value)
    ? (value as PageSize)
    : DEFAULT_PAGE_SIZE;
}

export function parseKeyword(raw: string | null): string {
  const value = raw?.trim() ?? '';
  return value.length > MAX_KEYWORD_LENGTH ? value.slice(0, MAX_KEYWORD_LENGTH) : value;
}

/** Deletes the parameter when it holds the default value. */
export function setOptionalParam(
  params: URLSearchParams,
  key: string,
  value: string | null | undefined,
): void {
  if (value === null || value === undefined || value === '') params.delete(key);
  else params.set(key, value);
}
