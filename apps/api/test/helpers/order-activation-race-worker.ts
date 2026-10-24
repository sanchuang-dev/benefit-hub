import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../src/db/client.js';
import { createSupplierMappingRepository } from '../../src/modules/catalog/supplier-mapping-repository.js';
import { createBenefitOrderRepository } from '../../src/modules/orders/repository.js';

interface WorkerTask {
  kind: 'activate-mapping' | 'create-order';
  file: string;
  productId: string;
  expectedVersion?: number;
  businessSource?: string;
  businessOrderNo?: string;
}

interface WorkerResult {
  type: 'done';
  result: unknown;
}

const task = (workerData as { task: WorkerTask }).task;
const port = parentPort;
if (!port) throw new Error('This module must run inside a worker thread');

const handle = openDatabase(task.file);
try {
  port.postMessage({ type: 'ready' });

  // Wait for the main thread to release both workers together, so activation
  // and creation contend for SQLite's writer lock instead of running apart.
  await new Promise<void>((resolve) => port.once('message', () => resolve()));

  try {
    const result =
      task.kind === 'activate-mapping'
        ? createSupplierMappingRepository(handle.db).activateDraft({
            productId: task.productId,
            expectedVersion: task.expectedVersion ?? 0,
            actorAccountId: 'race-actor',
          })
        : createBenefitOrderRepository(handle.db).createOrGetIntent({
            productId: task.productId,
            businessSource: task.businessSource ?? '',
            businessOrderNo: task.businessOrderNo ?? '',
          });
    const message: WorkerResult = { type: 'done', result };
    port.postMessage(message);
  } catch (error) {
    port.postMessage({
      type: 'error',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
} finally {
  handle.close();
}
