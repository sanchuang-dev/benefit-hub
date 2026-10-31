import type { MappingProvider } from '@sanchuang-dev/benefit-contracts';
import { apiRequest } from '../../shared/lib/api-client';

export const PRODUCT_STATUSES = ['active', 'disabled'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * Mapping state shown next to a product row. `none` means no supplier mapping
 * exists; `draft` is saved but not effective; `active` is the version that new
 * orders would use. The list must never imply a draft is live.
 */
export const PRODUCT_MAPPING_STATES = ['none', 'draft', 'active'] as const;
export type ProductMappingState = (typeof PRODUCT_MAPPING_STATES)[number];

export interface CatalogProduct {
  id: string;
  code: string;
  name: string;
  shortDescription: string;
  status: ProductStatus;
  displayPriceCents: number | null;
  estimatedCostCents: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * List-only mapping projection. The provider is kept as a string because the
 * list response is server data; the filter parameter itself is narrowed to the
 * shared `MappingProvider` contract below. `versionNumber` only carries a value
 * once a version exists (draft/active), never for `none`.
 */
export interface ProductMappingSummary {
  state: ProductMappingState;
  provider: string | null;
  productCode: string | null;
  fulfillmentMode: string | null;
  versionNumber: number | null;
}

/** A product row in the list, which also carries its mapping summary. */
export type CatalogProductListItem = CatalogProduct & {
  mapping: ProductMappingSummary;
};

/** Server-owned supplier facet used by the filter; `configured` is a real fact. */
export interface SupplierFilterOption {
  key: MappingProvider;
  name: string;
  configured: boolean;
}

export interface ProductListParams {
  page: number;
  pageSize: number;
  keyword?: string;
  status?: ProductStatus;
  supplier?: MappingProvider;
}

export interface ProductListResponse {
  products: CatalogProductListItem[];
  suppliers: SupplierFilterOption[];
  page: number;
  pageSize: number;
  total: number;
}

interface ProductResponse {
  product: CatalogProduct;
}

export interface ProductWriteInput {
  code: string;
  name: string;
  shortDescription: string;
  displayPriceCents: number | null;
  estimatedCostCents: number | null;
}

export interface ProductStatusChange {
  id: string;
  status: ProductStatus;
  version: number;
}

/**
 * Read-only supplier catalogue DTO. `provider`/`currency`/`observedAt` come from
 * the server-side adapter response; there is no browser-side supplier call.
 * The list omits the vendor name because the list endpoint does not provide it
 * reliably, and it omits availability because that is not contract-grounded.
 */
export interface SupplierCatalogProduct {
  productCode: string;
  sellPriceCents: number;
}

export interface SupplierCatalogResponse {
  provider: 'yangmao';
  currency: 'CNY';
  /** ISO timestamp of the server-side response that produced this snapshot. */
  observedAt: string;
  products: SupplierCatalogProduct[];
}

export interface SupplierProductDetail {
  provider: 'yangmao';
  currency: 'CNY';
  observedAt: string;
  productCode: string;
  /** Untrusted vendor text; always rendered as text, never as HTML. */
  name: string;
  sellPriceCents: number;
}

export function fetchProducts(params: ProductListParams): Promise<ProductListResponse> {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  if (params.keyword) query.set('keyword', params.keyword);
  if (params.status) query.set('status', params.status);
  if (params.supplier) query.set('supplier', params.supplier);
  return apiRequest<ProductListResponse>(`/api/v1/catalog/products?${query.toString()}`);
}

export async function fetchProduct(id: string): Promise<CatalogProduct> {
  const body = await apiRequest<ProductResponse>(`/api/v1/catalog/products/${id}`);
  return body.product;
}

/** Same-origin read only; the browser never talks to the supplier directly. */
export function fetchSupplierProducts(): Promise<SupplierCatalogResponse> {
  return apiRequest<SupplierCatalogResponse>('/api/v1/catalog/supplier-products');
}

export async function fetchSupplierProduct(productCode: string): Promise<SupplierProductDetail> {
  const body = await apiRequest<{ product: SupplierProductDetail }>(
    `/api/v1/catalog/supplier-products/${encodeURIComponent(productCode)}`,
  );
  return body.product;
}

export async function createProduct(input: ProductWriteInput): Promise<CatalogProduct> {
  const body = await apiRequest<ProductResponse>('/api/v1/catalog/products', {
    method: 'POST',
    body: input,
  });
  return body.product;
}

export async function updateProduct(
  id: string,
  version: number,
  input: ProductWriteInput,
): Promise<CatalogProduct> {
  const body = await apiRequest<ProductResponse>(`/api/v1/catalog/products/${id}`, {
    method: 'PATCH',
    body: { version, ...input },
  });
  return body.product;
}

/**
 * Enable and disable are separate API actions, both version-guarded. The UI
 * never treats a successful HTTP call as proof that the product can be granted.
 */
export async function setProductStatus({
  id,
  status,
  version,
}: ProductStatusChange): Promise<CatalogProduct> {
  const body = await apiRequest<ProductResponse>(
    `/api/v1/catalog/products/${id}/${status === 'active' ? 'enable' : 'disable'}`,
    { method: 'POST', body: { version } },
  );
  return body.product;
}
