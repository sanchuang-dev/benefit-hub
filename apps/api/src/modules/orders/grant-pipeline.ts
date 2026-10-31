import type { YangmaoOpenV1PurchaseReader } from '@sanchuang-dev/provider-yangmao';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { OrderNotGrantableError, type BenefitOrder } from './benefit-orders.js';
import { RESERVATION_IN_FLIGHT_MS, requireOwnedOrder } from './grant-mechanics.js';
import type { BenefitOrderRepository } from './repository.js';
import {
  assertApplicationEntitlement,
  requireSupplierMasterKey,
  requireYangmaoClient,
} from './supplier-access.js';

/** The minimal shape the pipeline needs from a mode's durable operation row. */
export interface GrantOperation {
  requestId: string;
  state: string;
  updatedAt: number;
}

/** Fields every machine-facing grant command must carry. */
export interface GrantStartCommand {
  businessSource: string;
  orderId: string;
  signal?: AbortSignal;
}

export interface GrantRecoverCommand {
  businessSource: string;
  orderId: string;
  signal?: AbortSignal;
}

export interface GrantReserveInput<TCommand extends GrantStartCommand> {
  order: BenefitOrder;
  command: TCommand;
  masterKey: Buffer;
}

export interface GrantContinueInput<
  TOperation extends GrantOperation,
  TCommand extends GrantStartCommand,
> {
  order: BenefitOrder;
  operation: TOperation;
  command: TCommand;
  masterKey: Buffer;
  client: YangmaoOpenV1PurchaseReader;
}

export interface GrantExecuteInput<
  TOperation extends GrantOperation,
  TCommand extends GrantStartCommand,
> extends GrantContinueInput<TOperation, TCommand> {
  productCode: string;
}

export interface GrantRecoverInput<TOperation extends GrantOperation> {
  order: BenefitOrder;
  operation: TOperation;
  masterKey: Buffer;
  client: YangmaoOpenV1PurchaseReader;
  signal: AbortSignal | undefined;
}

/**
 * Everything that differs between signed grant modes. The pipeline owns the
 * sequence and its ordering guarantees; a mode only supplies the pieces that
 * are genuinely mode-specific (frozen-mapping check, reservation payload,
 * provider call, durable settlement and error vocabulary).
 */
export interface GrantPipelineSpec<
  TOperation extends GrantOperation,
  TCommand extends GrantStartCommand,
  TOutcome,
> {
  /** Verb used in the "order status does not allow ..." error, e.g. 上力下单. */
  actionLabel: string;
  /** Rejects orders whose frozen mapping is not this mode. */
  requireFrozen(order: BenefitOrder): { productCode: string };
  findOperation(orderId: string): TOperation | null;
  /** Optional live pre-check that must pass before any reservation or debit. */
  preflight?(input: {
    order: BenefitOrder;
    command: TCommand;
    client: YangmaoOpenV1PurchaseReader;
  }): Promise<void>;
  reserve(input: GrantReserveInput<TCommand>): {
    created: boolean;
    order: BenefitOrder;
    operation: TOperation;
  };
  /** Resumes an existing operation: same-input check, then a read-only recovery. */
  continueExisting(input: GrantContinueInput<TOperation, TCommand>): Promise<TOutcome>;
  /** Performs the single signed supplier write and durably settles the outcome. */
  execute(input: GrantExecuteInput<TOperation, TCommand>): Promise<TOutcome>;
  /** Read-only recovery; modes with no vendor read-by-request path omit it. */
  recovery?: GrantRecoverySpec<TOperation, TOutcome>;
}

/** Options used only by the read-only recovery path. */
export interface GrantRecoverySpec<TOperation extends GrantOperation, TOutcome> {
  /** Recovers an already-reserved operation from persisted or vendor facts. */
  recoverExisting(input: GrantRecoverInput<TOperation>): Promise<TOutcome>;
  operationNotFoundError(): Error;
  operationRejectedError(): Error;
  operationInFlightError(): Error;
}

export interface GrantPipelineDeps {
  db: AppDatabase;
  config: AppConfig;
  repository: BenefitOrderRepository;
  now: () => number;
}

/** A durable reservation must not be raced by a recovery read while it may still be in flight. */
export function isInFlight(
  operation: Pick<GrantOperation, 'state' | 'updatedAt'>,
  now: number,
): boolean {
  return (
    operation.state === 'reserved' &&
    now - operation.updatedAt < RESERVATION_IN_FLIGHT_MS
  );
}

/**
 * Shared execution order for every signed grant mode (A/B/C/D):
 *
 * start: ownership -> entitlement -> frozen mapping -> existing operation ->
 *        order status -> live preflight -> reservation -> one signed write.
 * recover: ownership -> entitlement -> frozen mapping -> existing operation ->
 *        terminal/in-flight guards -> read-only recovery.
 *
 * No DB transaction is ever held across the supplier HTTP call; an unknown
 * outcome always stays recoverable and is never retried as a fresh debit.
 */
export function createGrantPipeline<
  TOperation extends GrantOperation,
  TCommand extends GrantStartCommand,
  TOutcome,
>(
  deps: GrantPipelineDeps,
  spec: GrantPipelineSpec<TOperation, TCommand, TOutcome>,
): {
  start(command: TCommand): Promise<TOutcome>;
  recover(command: GrantRecoverCommand): Promise<TOutcome>;
} {
  async function start(command: TCommand): Promise<TOutcome> {
    const order = requireOwnedOrder(deps.repository, command.businessSource, command.orderId);
    assertApplicationEntitlement(deps.db, command.businessSource, order.productId);
    const frozen = spec.requireFrozen(order);
    const masterKey = requireSupplierMasterKey(deps.config);
    const client = requireYangmaoClient(deps.db, deps.config);

    const existing = spec.findOperation(order.id);
    if (existing) {
      return spec.continueExisting({ order, operation: existing, command, masterKey, client });
    }

    if (order.status !== 'pending') {
      throw new OrderNotGrantableError(
        `订单当前状态不允许${spec.actionLabel}：${order.status}`,
      );
    }

    // Live, read-only eligibility must pass before any local reservation or
    // supplier debit. A restricted recipient must not be charged.
    await spec.preflight?.({ order, command, client });

    const reservation = spec.reserve({ order, command, masterKey });
    if (!reservation.created) {
      // A concurrent caller won the reservation. Never send a second debit.
      return spec.continueExisting({
        order: reservation.order,
        operation: reservation.operation,
        command,
        masterKey,
        client,
      });
    }

    return spec.execute({
      order: reservation.order,
      operation: reservation.operation,
      command,
      productCode: frozen.productCode,
      masterKey,
      client,
    });
  }

  async function recover(command: GrantRecoverCommand): Promise<TOutcome> {
    const recovery = spec.recovery;
    if (!recovery) throw new Error('该履约模式没有只读恢复路径');
    const order = requireOwnedOrder(deps.repository, command.businessSource, command.orderId);
    assertApplicationEntitlement(deps.db, command.businessSource, order.productId);
    spec.requireFrozen(order);
    const masterKey = requireSupplierMasterKey(deps.config);
    const client = requireYangmaoClient(deps.db, deps.config);

    const operation = spec.findOperation(order.id);
    if (!operation) throw recovery.operationNotFoundError();
    if (operation.state === 'rejected') throw recovery.operationRejectedError();
    if (isInFlight(operation, deps.now())) throw recovery.operationInFlightError();

    return recovery.recoverExisting({
      order,
      operation,
      masterKey,
      client,
      signal: command.signal,
    });
  }

  return { start, recover };
}
