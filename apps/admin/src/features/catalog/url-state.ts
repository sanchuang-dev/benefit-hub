import { MAPPING_PROVIDERS, type MappingProvider } from '@sanchuang-dev/benefit-contracts';
import {
  DEFAULT_PAGE_SIZE,
  parseKeyword,
  parsePage,
  parsePageSize,
  setOptionalParam,
} from '../../shared/lib/url-state';
import {
  PRODUCT_MAPPING_STATES,
  PRODUCT_SORT_FIELDS,
  PRODUCT_SORT_ORDERS,
  PRODUCT_STATUSES,
  type ProductMappingState,
  type ProductSortField,
  type ProductSortOrder,
  type ProductStatus,
} from './api';

/**
 * Catalogue list state is URL-owned: filters, paging and server sorting are all
 * parsed from the query string and written back to it. Every value is checked
 * against the shared contract whitelist before it reaches a request, because a
 * URL can be hand-edited or shared after the contract changes.
 */

export interface CatalogPriceRange {
  /** Yuan values shown in the filter form; the URL and API keep integer cents. */
  min?: number | null;
  max?: number | null;
}

export interface CatalogFilters {
  keyword: string;
  status: ProductStatus | 'all';
  supplier: MappingProvider | 'all';
  mappingState: ProductMappingState | 'all';
  displayPrice: CatalogPriceRange;
}

export interface CatalogSort {
  key: ProductSortField;
  order: ProductSortOrder;
}

/** The exact controlled state the DataPanel and the list request share. */
export interface CatalogPanelQuery {
  filters: CatalogFilters;
  page: number;
  pageSize: number;
  sort?: CatalogSort;
}

/** Stable DataPanel id so column/view preferences are not shared with other lists. */
export const CATALOG_PANEL_ID = 'catalog-products';

export const EMPTY_CATALOG_FILTERS: CatalogFilters = {
  keyword: '',
  status: 'all',
  supplier: 'all',
  mappingState: 'all',
  displayPrice: {},
};

const CENTS_PATTERN = /^\d+$/;

/**
 * The supplier filter is a provider key, not a free-text value. Anything that
 * is not in the shared `MAPPING_PROVIDERS` whitelist is dropped, so a hand-edited
 * URL can never make the console request an unknown supplier.
 */
export function parseSupplier(raw: string | null): MappingProvider | undefined {
  if (!raw) return undefined;
  return MAPPING_PROVIDERS.find((provider) => provider === raw);
}

export function parseProductStatus(raw: string | null): ProductStatus | undefined {
  if (!raw) return undefined;
  return PRODUCT_STATUSES.find((status) => status === raw);
}

export function parseMappingState(raw: string | null): ProductMappingState | undefined {
  if (!raw) return undefined;
  return PRODUCT_MAPPING_STATES.find((state) => state === raw);
}

/**
 * Price bounds are decimal non-negative integer cents on the wire. Invalid,
 * empty, negative or unsafe values are ignored rather than sent as `NaN`/hex.
 */
export function parseCents(raw: string | null): number | undefined {
  if (raw === null || !CENTS_PATTERN.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * A direction without a field is meaningless; it is ignored rather than turned
 * into a hidden sort. A whitelisted field without a direction uses the server's
 * documented ascending default.
 */
export function parseCatalogSort(
  sortBy: string | null,
  sortOrder: string | null,
): CatalogSort | undefined {
  const key = PRODUCT_SORT_FIELDS.find((field) => field === sortBy);
  if (!key) return undefined;
  const order = PRODUCT_SORT_ORDERS.find((candidate) => candidate === sortOrder) ?? 'asc';
  return { key, order };
}

/** Converts a validated cent value to the yuan number the filter form edits. */
function centsToYuanValue(cents: number): number {
  return cents / 100;
}

/**
 * Converts a form value in yuan back to integer cents. Out-of-range input is
 * ignored instead of being sent as a fractional or unsafe amount.
 */
export function priceToCents(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) return undefined;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

function readPriceRange(params: URLSearchParams): CatalogPriceRange {
  const minCents = parseCents(params.get('displayPriceMinCents'));
  const maxCents = parseCents(params.get('displayPriceMaxCents'));
  // A contradictory pair cannot be requested (the API rejects it). Keeping
  // neither bound is the only honest fallback: guessing which one the operator
  // meant would silently filter on an invented range.
  if (minCents !== undefined && maxCents !== undefined && minCents > maxCents) {
    return {};
  }
  return {
    ...(minCents === undefined ? {} : { min: centsToYuanValue(minCents) }),
    ...(maxCents === undefined ? {} : { max: centsToYuanValue(maxCents) }),
  };
}

export function hasActiveCatalogFilters(filters: CatalogFilters): boolean {
  return (
    filters.keyword !== '' ||
    filters.status !== 'all' ||
    filters.supplier !== 'all' ||
    filters.mappingState !== 'all' ||
    filters.displayPrice.min !== undefined ||
    filters.displayPrice.max !== undefined
  );
}

/** Reads every list parameter, ignoring values outside the contract whitelists. */
export function readCatalogState(params: URLSearchParams): CatalogPanelQuery {
  return {
    filters: {
      keyword: parseKeyword(params.get('q')),
      status: parseProductStatus(params.get('status')) ?? 'all',
      supplier: parseSupplier(params.get('supplier')) ?? 'all',
      mappingState: parseMappingState(params.get('mappingState')) ?? 'all',
      displayPrice: readPriceRange(params),
    },
    page: parsePage(params.get('page')),
    pageSize: parsePageSize(params.get('pageSize')),
    sort: parseCatalogSort(params.get('sortBy'), params.get('sortOrder')),
  };
}

/**
 * Writes the complete panel state back to the URL. Defaults are omitted so a
 * shared link stays short and a refresh reproduces exactly the same request.
 */
export function writeCatalogState(
  current: URLSearchParams,
  next: CatalogPanelQuery,
): URLSearchParams {
  const params = new URLSearchParams(current);
  const { filters } = next;

  setOptionalParam(params, 'q', filters.keyword.trim() || null);
  setOptionalParam(params, 'status', filters.status === 'all' ? null : filters.status);
  setOptionalParam(params, 'supplier', filters.supplier === 'all' ? null : filters.supplier);
  setOptionalParam(
    params,
    'mappingState',
    filters.mappingState === 'all' ? null : filters.mappingState,
  );

  const minCents = priceToCents(filters.displayPrice.min);
  const maxCents = priceToCents(filters.displayPrice.max);
  const rangeIsUsable =
    minCents === undefined || maxCents === undefined || minCents <= maxCents;
  setOptionalParam(
    params,
    'displayPriceMinCents',
    rangeIsUsable && minCents !== undefined ? String(minCents) : null,
  );
  setOptionalParam(
    params,
    'displayPriceMaxCents',
    rangeIsUsable && maxCents !== undefined ? String(maxCents) : null,
  );

  if (next.sort) {
    params.set('sortBy', next.sort.key);
    params.set('sortOrder', next.sort.order);
  } else {
    params.delete('sortBy');
    params.delete('sortOrder');
  }

  if (next.page <= 1) params.delete('page');
  else params.set('page', String(next.page));

  if (next.pageSize === DEFAULT_PAGE_SIZE) params.delete('pageSize');
  else params.set('pageSize', String(next.pageSize));

  return params;
}
