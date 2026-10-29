import type {
  YangmaoOpenV1PurchaseReader,
} from '@sanchuang-dev/provider-yangmao';
import { createYangmaoOpenV1Client } from '@sanchuang-dev/provider-yangmao';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { findApplicationBySource, listApplicationProducts } from '../applications/applications.js';
import {
  activeYangmaoReadConfig,
  SupplierCredentialUnavailableError,
} from '../suppliers/connection.js';
import {
  OrderApplicationDisabledError,
  OrderProductNotAuthorizedError,
} from './benefit-orders.js';

/**
 * Shared runtime-access checks for supplier-writing order slices (A and C).
 * They are intentionally mode-agnostic: the caller still decides which frozen
 * mode/product may be executed, but the application enablement and allowlist
 * rules must stay identical across every paid or quota-deducting path.
 */
export class SupplierNotConfiguredError extends Error {}
export class SupplierKeyUnavailableError extends Error {}

export function assertApplicationEntitlement(
  db: AppDatabase,
  businessSource: string,
  productId: string,
): void {
  const application = findApplicationBySource(db, businessSource);
  // Legacy environment clients have no registered application, matching the
  // existing create-intent compatibility path.
  if (!application) return;
  if (application.status !== 'enabled') {
    throw new OrderApplicationDisabledError('应用已停用，不能发起上力操作');
  }
  const authorized = listApplicationProducts(db, application.id).some(
    (product) => product.productId === productId,
  );
  if (!authorized) {
    throw new OrderProductNotAuthorizedError('该应用未被授权使用此内部商品');
  }
}

/** Server-only supplier client built from the encrypted connection record. */
export function requireYangmaoClient(
  db: AppDatabase,
  config: AppConfig,
): YangmaoOpenV1PurchaseReader {
  let supplier: ReturnType<typeof activeYangmaoReadConfig>;
  try {
    supplier = activeYangmaoReadConfig(db, config);
  } catch (error) {
    if (error instanceof SupplierCredentialUnavailableError) {
      throw new SupplierKeyUnavailableError('上力凭证加密主密钥不可用');
    }
    throw error;
  }
  if (!supplier) throw new SupplierNotConfiguredError('上力接口凭证尚未保存');
  return createYangmaoOpenV1Client(supplier);
}

export function requireSupplierMasterKey(config: AppConfig): Buffer {
  const key = config.supplierMasterKey;
  if (!key || key.length !== 32) {
    throw new SupplierKeyUnavailableError('上力凭证加密主密钥不可用');
  }
  return key;
}
