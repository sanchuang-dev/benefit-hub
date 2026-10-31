import { z } from 'zod';
import { productCodeSchema } from './inrice-products.js';

const visibleAscii64 = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[!-~]+$/);

const mobileSchema = z.string().regex(/^1[3-9]\d{9}$/);

const dispatchInputSchema = z
  .object({
    partnerOrderNo: visibleAscii64,
    productCode: productCodeSchema,
    mobile: mobileSchema,
  })
  .strict();

export interface YangmaoInriceDispatchInput {
  partnerOrderNo: string;
  productCode: string;
  mobile: string;
}

export interface YangmaoInriceDispatchResult {
  provider: 'yangmao';
  partnerOrderNo: string;
  /** Supplier accepted the dispatch request envelope; this is not delivery. */
  accepted: true;
  /** ISO instant when this client observed the successful code=0 response. */
  observedAt: string;
}

export function normalizeInriceDispatchInput(
  value: YangmaoInriceDispatchInput,
): YangmaoInriceDispatchInput | null {
  const parsed = dispatchInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
