import { MAPPING_PROVIDERS, type MappingProvider } from '@sanchuang-dev/benefit-contracts';

/**
 * The supplier filter is a provider key, not a free-text value. Anything that
 * is not in the shared `MAPPING_PROVIDERS` whitelist is dropped, so a hand-edited
 * URL can never make the console request an unknown supplier.
 *
 * Generic URL parsing lives in `shared/lib/url-state`; this module keeps the
 * catalogue-only whitelist check next to the domain that owns it.
 */
export function parseSupplier(raw: string | null): MappingProvider | undefined {
  if (!raw) return undefined;
  return MAPPING_PROVIDERS.find((provider) => provider === raw);
}
