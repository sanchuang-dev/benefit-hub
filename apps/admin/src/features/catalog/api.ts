import { apiRequest } from '../../shared/lib/api-client';

export const PRODUCT_STATUSES = ['active', 'disabled'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * Mirrors the BHB-003 HTTP DTO. `vendorFulfillmentEnabled` is always false in
 * this slice because no supplier mapping exists yet; the UI must not present
 * such a product as fulfillable.
 */
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
  vendorFulfillmentEnabled: false;
}

export interface ProductListParams {
  page: number;
  pageSize: number;
  keyword?: string;
  status?: ProductStatus;
}

export interface ProductListResponse {
  products: CatalogProduct[];
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

export function fetchProducts(params: ProductListParams): Promise<ProductListResponse> {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  if (params.keyword) query.set('keyword', params.keyword);
  if (params.status) query.set('status', params.status);
  return apiRequest<ProductListResponse>(`/api/v1/catalog/products?${query.toString()}`);
}

export async function fetchProduct(id: string): Promise<CatalogProduct> {
  const body = await apiRequest<ProductResponse>(`/api/v1/catalog/products/${id}`);
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
