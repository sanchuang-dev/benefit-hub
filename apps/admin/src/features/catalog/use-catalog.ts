import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../shared/lib/api-client';
import {
  createProduct,
  fetchProduct,
  fetchProducts,
  fetchSupplierProduct,
  fetchSupplierProducts,
  setProductStatus,
  updateProduct,
  type CatalogProduct,
  type ProductListParams,
  type ProductListResponse,
  type ProductStatusChange,
  type ProductWriteInput,
  type SupplierCatalogResponse,
  type SupplierProductDetail,
} from './api';

export const catalogQueryKeys = {
  root: ['catalog'] as const,
  list: (params: ProductListParams) => ['catalog', 'products', params] as const,
  detail: (id: string) => ['catalog', 'product', id] as const,
  supplierRoot: ['catalog', 'supplier-products'] as const,
  supplierDetail: (productCode: string) =>
    ['catalog', 'supplier-products', 'detail', productCode] as const,
};

export function useProductsQuery(params: ProductListParams) {
  return useQuery<ProductListResponse, ApiError>({
    queryKey: catalogQueryKeys.list(params),
    queryFn: () => fetchProducts(params),
    // Paging and filtering should not flash the previous empty table away.
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * Detail is read through the real single-product endpoint so an edit carries the
 * server's current version instead of a possibly stale list row.
 */
export function useProductQuery(id: string | undefined) {
  return useQuery<CatalogProduct, ApiError>({
    queryKey: catalogQueryKeys.detail(id ?? ''),
    queryFn: () => {
      if (!id) throw new Error('商品 ID 缺失');
      return fetchProduct(id);
    },
    enabled: Boolean(id),
    // Every drawer open must see the current version, not a 15s-old cache entry.
    staleTime: 0,
    retry: false,
  });
}

/**
 * Supplier catalogue is a single real snapshot, not per-page upstream calls.
 * Keyword filtering and pagination happen over this same server result, so the
 * browser never fans out 20+ detail requests or calls the supplier directly.
 */
export function useSupplierProductsQuery() {
  return useQuery<SupplierCatalogResponse, ApiError>({
    queryKey: catalogQueryKeys.supplierRoot,
    queryFn: fetchSupplierProducts,
    retry: false,
  });
}

/** Detail is fetched only when an operator selects one product. */
export function useSupplierProductQuery(productCode: string | null) {
  return useQuery<SupplierProductDetail, ApiError>({
    queryKey: catalogQueryKeys.supplierDetail(productCode ?? ''),
    queryFn: () => {
      if (!productCode) throw new Error('供应商商品编码缺失');
      return fetchSupplierProduct(productCode);
    },
    enabled: Boolean(productCode),
    // A drawer open must show the current snapshot rather than a stale name.
    staleTime: 0,
    retry: false,
  });
}

function useCatalogWriteInvalidation() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: catalogQueryKeys.root });
}

export function useCreateProductMutation() {
  const invalidate = useCatalogWriteInvalidation();
  return useMutation<CatalogProduct, ApiError, ProductWriteInput>({
    mutationFn: createProduct,
    onSuccess: () => {
      void invalidate();
    },
  });
}

export interface UpdateProductVariables {
  id: string;
  version: number;
  input: ProductWriteInput;
}

export function useUpdateProductMutation() {
  const invalidate = useCatalogWriteInvalidation();
  return useMutation<CatalogProduct, ApiError, UpdateProductVariables>({
    mutationFn: ({ id, version, input }) => updateProduct(id, version, input),
    onSuccess: () => {
      void invalidate();
    },
  });
}

export function useSetProductStatusMutation() {
  const invalidate = useCatalogWriteInvalidation();
  return useMutation<CatalogProduct, ApiError, ProductStatusChange>({
    mutationFn: setProductStatus,
    onSuccess: () => {
      void invalidate();
    },
  });
}
