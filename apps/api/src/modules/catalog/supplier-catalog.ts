import {
  createYangmaoInriceCatalogClient,
  YangmaoInriceError,
  type YangmaoInriceCatalog,
  type YangmaoInriceCatalogReader,
  type YangmaoInriceProductDetail,
} from '@sanchuang-dev/provider-yangmao';
import type { YangmaoInriceConfig } from '../../config.js';

/**
 * Browser-safe D-mode supplier catalogue DTO. Only fields that the read-only
 * adapter has actually validated leave the server; vendor `details`,
 * `extraJson`, `goodsStatus`, signatures and credentials are never included.
 */
export interface SupplierCatalogProductDto {
  productCode: string;
  sellPriceCents: number;
}

export interface SupplierCatalogDto {
  provider: 'yangmao';
  currency: 'CNY';
  observedAt: string;
  products: SupplierCatalogProductDto[];
}

export interface SupplierProductDetailDto {
  provider: 'yangmao';
  currency: 'CNY';
  observedAt: string;
  productCode: string;
  /**
   * Untrusted vendor display text. The browser renders it as text only; it is
   * never used as HTML and never carries saleability meaning.
   */
  name: string;
  sellPriceCents: number;
}

/**
 * Builds the existing server-only D read adapter from optional environment
 * configuration. An absent or unusable configuration returns null so callers
 * surface an explicit unavailability instead of issuing a partially signed
 * request or falling back to fixture credentials.
 */
export function createYangmaoInriceReader(
  config: YangmaoInriceConfig | null,
): YangmaoInriceCatalogReader | null {
  if (!config) return null;

  try {
    return createYangmaoInriceCatalogClient(config);
  } catch (error) {
    if (error instanceof YangmaoInriceError && error.code === 'YANGMAO_INRICE_CONFIG_INVALID') {
      return null;
    }
    throw error;
  }
}

/**
 * Explicit field picking keeps the public payload independent of future vendor
 * response additions. The list reader has no display name or availability
 * field, so the DTO does not invent either one.
 */
export function toSupplierCatalogDto(catalog: YangmaoInriceCatalog): SupplierCatalogDto {
  return {
    provider: catalog.provider,
    currency: catalog.currency,
    observedAt: catalog.observedAt,
    products: catalog.products.map((product) => ({
      productCode: product.productCode,
      sellPriceCents: product.sellPriceCents,
    })),
  };
}

export function toSupplierProductDetailDto(
  detail: YangmaoInriceProductDetail,
): SupplierProductDetailDto {
  return {
    provider: detail.provider,
    currency: detail.currency,
    observedAt: detail.observedAt,
    productCode: detail.productCode,
    name: detail.name,
    sellPriceCents: detail.sellPriceCents,
  };
}
