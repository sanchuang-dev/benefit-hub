import { describe, expect, it } from 'vitest';
import {
  EMPTY_CATALOG_FILTERS,
  hasActiveCatalogFilters,
  parseCatalogSort,
  parseCents,
  parseMappingState,
  parseProductStatus,
  parseSupplier,
  priceToCents,
  readCatalogState,
  writeCatalogState,
  type CatalogFilters,
} from './url-state';

function filters(overrides: Partial<CatalogFilters> = {}): CatalogFilters {
  return { ...EMPTY_CATALOG_FILTERS, ...overrides };
}

describe('catalogue URL whitelists', () => {
  it('accepts only contract values and ignores hand-edited ones', () => {
    expect(parseSupplier('yangmao')).toBe('yangmao');
    expect(parseSupplier('evil')).toBeUndefined();
    expect(parseSupplier('')).toBeUndefined();
    expect(parseSupplier(null)).toBeUndefined();

    expect(parseProductStatus('disabled')).toBe('disabled');
    expect(parseProductStatus('deleted')).toBeUndefined();

    expect(parseMappingState('draft')).toBe('draft');
    expect(parseMappingState('DRAFT')).toBeUndefined();
  });

  it('keeps only decimal non-negative safe integer cents', () => {
    expect(parseCents('0')).toBe(0);
    expect(parseCents('1250')).toBe(1250);
    expect(parseCents('')).toBeUndefined();
    expect(parseCents('12.5')).toBeUndefined();
    expect(parseCents('-1')).toBeUndefined();
    expect(parseCents('0x10')).toBeUndefined();
    expect(parseCents('1e3')).toBeUndefined();
    expect(parseCents('not-a-price')).toBeUndefined();
    expect(parseCents(String(Number.MAX_SAFE_INTEGER + 1))).toBeUndefined();
  });

  it('drops a sort direction without a whitelisted field', () => {
    expect(parseCatalogSort('name', 'desc')).toEqual({ key: 'name', order: 'desc' });
    expect(parseCatalogSort('displayPriceCents', null)).toEqual({
      key: 'displayPriceCents',
      order: 'asc',
    });
    expect(parseCatalogSort('displayPriceCents', 'sideways')).toEqual({
      key: 'displayPriceCents',
      order: 'asc',
    });
    expect(parseCatalogSort('evil', 'desc')).toBeUndefined();
    expect(parseCatalogSort(null, 'desc')).toBeUndefined();
  });
});

describe('catalogue panel state', () => {
  it('reads keywords, filters, paging and sort from one shareable URL', () => {
    const state = readCatalogState(
      new URLSearchParams(
        'q=咖啡&status=disabled&supplier=yangmao&mappingState=active' +
          '&displayPriceMinCents=1234&displayPriceMaxCents=2000' +
          '&page=3&pageSize=50&sortBy=displayPriceCents&sortOrder=desc',
      ),
    );

    expect(state).toEqual({
      filters: {
        keyword: '咖啡',
        status: 'disabled',
        supplier: 'yangmao',
        mappingState: 'active',
        displayPrice: { min: 12.34, max: 20 },
      },
      page: 3,
      pageSize: 50,
      sort: { key: 'displayPriceCents', order: 'desc' },
    });
  });

  it('ignores invalid and contradictory URL values instead of requesting them', () => {
    const state = readCatalogState(
      new URLSearchParams(
        'status=deleted&supplier=evil&mappingState=weird' +
          '&displayPriceMinCents=2000&displayPriceMaxCents=1000' +
          '&page=abc&pageSize=999&sortBy=evil&sortOrder=desc',
      ),
    );

    expect(state).toEqual({
      filters: EMPTY_CATALOG_FILTERS,
      page: 1,
      pageSize: 20,
      sort: undefined,
    });
  });

  it('writes defaults out of the URL and keeps canonical integer cents', () => {
    const params = writeCatalogState(
      new URLSearchParams('tab=supplier&page=4'),
      {
        filters: filters({
          keyword: '  咖啡  ',
          status: 'active',
          supplier: 'yangmao',
          mappingState: 'draft',
          displayPrice: { min: 12.34, max: 20 },
        }),
        page: 2,
        pageSize: 10,
        sort: { key: 'name', order: 'desc' },
      },
    );

    expect(params.get('q')).toBe('咖啡');
    expect(params.get('status')).toBe('active');
    expect(params.get('supplier')).toBe('yangmao');
    expect(params.get('mappingState')).toBe('draft');
    expect(params.get('displayPriceMinCents')).toBe('1234');
    expect(params.get('displayPriceMaxCents')).toBe('2000');
    expect(params.get('page')).toBe('2');
    expect(params.get('pageSize')).toBe('10');
    expect(params.get('sortBy')).toBe('name');
    expect(params.get('sortOrder')).toBe('desc');
    // Unrelated parameters survive a list-state update.
    expect(params.get('tab')).toBe('supplier');
  });

  it('omits defaults and unusable price/sort state', () => {
    const params = writeCatalogState(new URLSearchParams('page=2&sortBy=name&sortOrder=asc'), {
      filters: filters({ displayPrice: { min: 30, max: 20 } }),
      page: 1,
      pageSize: 20,
    });

    expect(params.toString()).toBe('');
  });

  it('round-trips yuan form values through integer cents', () => {
    const state = readCatalogState(
      new URLSearchParams('displayPriceMinCents=999&displayPriceMaxCents=1000'),
    );
    const written = writeCatalogState(new URLSearchParams(), state);

    expect(state.filters.displayPrice).toEqual({ min: 9.99, max: 10 });
    expect(written.get('displayPriceMinCents')).toBe('999');
    expect(written.get('displayPriceMaxCents')).toBe('1000');
  });

  it('rejects negative, fractional and unsafe form prices', () => {
    expect(priceToCents(null)).toBeUndefined();
    expect(priceToCents(-1)).toBeUndefined();
    expect(priceToCents(Number.NaN)).toBeUndefined();
    expect(priceToCents(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(priceToCents(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(priceToCents(12.34)).toBe(1234);
    expect(priceToCents(12.345)).toBeUndefined();
    expect(priceToCents(0.001)).toBeUndefined();
  });

  it('knows whether any filter narrows the list', () => {
    expect(hasActiveCatalogFilters(EMPTY_CATALOG_FILTERS)).toBe(false);
    expect(hasActiveCatalogFilters(filters({ keyword: '咖啡' }))).toBe(true);
    expect(hasActiveCatalogFilters(filters({ status: 'active' }))).toBe(true);
    expect(hasActiveCatalogFilters(filters({ mappingState: 'none' }))).toBe(true);
    expect(hasActiveCatalogFilters(filters({ displayPrice: { min: 0 } }))).toBe(true);
  });
});
