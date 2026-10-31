import { afterEach, describe, expect, it } from 'vitest';
import {
  operationsOverviewResponseSchema,
  operationsOrderErrorResponseSchema,
  OVERVIEW_TIMEZONE,
  OVERVIEW_TREND_DAYS,
  type OperationsOverviewResponse,
  type OperationsOrderErrorResponse,
} from '@sanchuang-dev/benefit-contracts';
import { createProduct } from '../../src/modules/catalog/products.js';
import { createSupplierMappingRepository } from '../../src/modules/catalog/supplier-mapping-repository.js';
import type { OrderStatus } from '../../src/modules/orders/benefit-orders.js';
import { createBenefitOrderRepository } from '../../src/modules/orders/repository.js';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from '../helpers/test-server.js';
import { expectNoStore } from '../helpers/api-fixtures.js';

const ENDPOINT = '/api/v1/operations/overview';

const BJ_OFFSET = 8 * 3_600_000;
const DAY = 86_400_000;

/**
 * These helpers intentionally restate the contract's Beijing calendar rules
 * instead of importing the route's internals: the test must fail when the
 * implementation's day boundary silently changes.
 */
const bjDayStart = (ms: number) => Math.floor((ms + BJ_OFFSET) / DAY) * DAY - BJ_OFFSET;
const bjDayLabel = (ms: number) => new Date(ms + BJ_OFFSET).toISOString().slice(0, 10);

let server: TestServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function startServer(): TestServer {
  const testServer = new TestServer();
  server = testServer;
  return testServer;
}

function seedProduct(testServer: TestServer, code: string) {
  return createProduct(testServer.database.db, {
    code,
    name: `总览测试商品 ${code}`,
    actorAccountId: 'test-actor',
  });
}

/** Saves, validates and activates a B-mode mapping so orders can be created. */
function activateMapping(testServer: TestServer, productId: string) {
  const repository = createSupplierMappingRepository(testServer.database.db);
  const current = repository.getDraft(productId);
  const draft = repository.saveDraft({
    productId,
    expectedVersion: current?.version ?? null,
    provider: 'yangmao',
    productCode: 'YM-OVERVIEW',
    fulfillmentMode: 'B',
    deductionUnit: 'pack',
  });
  repository.validateDraft({ productId, expectedVersion: draft.version });
  return repository.activateDraft({
    productId,
    expectedVersion: draft.version,
    actorAccountId: 'test-actor',
  });
}

function setCreatedAt(testServer: TestServer, orderId: string, createdAt: number): void {
  // Test-only seeding: createdAt is not part of the immutable order binding.
  testServer.database.sqlite
    .prepare('UPDATE benefit_orders SET created_at = ? WHERE id = ?')
    .run(createdAt, orderId);
}

interface SeedOrderInput {
  productId: string;
  businessOrderNo: string;
  createdAt: number;
  status?: OrderStatus;
}

function seedOrder(testServer: TestServer, input: SeedOrderInput) {
  const repository = createBenefitOrderRepository(testServer.database.db);
  const { order } = repository.createOrGetIntent({
    businessSource: 'local-life',
    businessOrderNo: input.businessOrderNo,
    productId: input.productId,
  });
  setCreatedAt(testServer, order.id, input.createdAt);
  if (input.status && input.status !== 'pending') {
    repository.updateStatus({
      orderId: order.id,
      expectedVersion: order.version,
      status: input.status,
    });
  }
  return order;
}

async function signIn(
  testServer: TestServer,
  role: 'admin' | 'viewer' = 'admin',
): Promise<TestClient> {
  await seedAccount(testServer, { username: `${role}.overview`, role });
  const client = new TestClient(testServer);
  const response = await client.login(`${role}.overview`, TEST_PASSWORD);
  expect(response.status).toBe(200);
  return client;
}

function parseOverview(body: unknown): OperationsOverviewResponse {
  const parsed = operationsOverviewResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Overview response does not match the shared contract: ${parsed.error.message} :: ${JSON.stringify(body)}`,
    );
  }
  return parsed.data;
}

function parseError(body: unknown): OperationsOrderErrorResponse {
  const parsed = operationsOrderErrorResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Error body does not match the shared contract: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function readOverview(client: TestClient, window?: string) {
  const path = window === undefined ? ENDPOINT : `${ENDPOINT}?window=${window}`;
  const response = await client.request(path);
  expect(response.status).toBe(200);
  expectNoStore(response);
  return parseOverview(await response.json()).overview;
}
describe('operations overview authentication', () => {
  it('requires a session and lets the read-only operator role read the aggregate', async () => {
    const testServer = startServer();

    const anonymous = await testServer.app.request(ENDPOINT);
    expect(anonymous.status).toBe(401);
    expectNoStore(anonymous);
    expect(parseError(await anonymous.json()).error).toBe('UNAUTHENTICATED');

    const viewer = await signIn(testServer, 'viewer');
    const authorized = await viewer.request(ENDPOINT);
    expect(authorized.status).toBe(200);
    expectNoStore(authorized);
    expect(parseOverview(await authorized.json()).overview.window.key).toBe('today');
  });
});

describe('operations overview empty database', () => {
  it('reports explicit zeros, a null rate and the full trend/hour grids', async () => {
    const testServer = startServer();
    const viewer = await signIn(testServer, 'viewer');

    const overview = await readOverview(viewer);

    expect(overview.byStatus).toEqual({
      pending: 0,
      processing: 0,
      awaiting_claim: 0,
      partially_completed: 0,
      completed: 0,
      failed: 0,
      unknown: 0,
    });
    expect(overview.orders).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      terminalTotal: 0,
      // Nothing terminal means "no rate", not a 0% success rate.
      completedRateBp: null,
      previousTotal: 0,
    });
    expect(overview.series).toHaveLength(OVERVIEW_TREND_DAYS);
    expect(overview.series.every((point) => point.total === 0 && point.completed === 0)).toBe(true);
    expect(overview.hourly).toHaveLength(24);
    expect(overview.hourly.every((point) => point.total === 0)).toBe(true);
    expect(overview.attempts).toEqual({ total: 0, accepted: 0, rejected: 0, unknown: 0 });
    expect(overview.window.key).toBe('today');
    expect(overview.window.timezone).toBe(OVERVIEW_TIMEZONE);
    expect(overview.window.to).toBe(overview.asOf);
    expect(overview.window.from).toBe(bjDayStart(overview.asOf));
    expect(overview.supply).toEqual({
      provider: 'yangmao',
      displayName: '上力',
      catalogConfigured: false,
      credentialSource: 'none',
      connectionUpdatedAt: null,
    });
  });
});

describe('operations overview aggregation', () => {
  it('aggregates order statuses, terminal rate and attempt results from persisted rows', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'OVW-AGG');
    activateMapping(testServer, product.id);
    const admin = await signIn(testServer);
    const repository = createBenefitOrderRepository(testServer.database.db);

    const asOf = Date.now();
    const from = bjDayStart(asOf);
    // Clamp toward the start of today so the seed stays inside the window even
    // when the suite happens to run shortly after Beijing midnight.
    const at = (offsetMs: number) => from + Math.min(offsetMs, asOf - from);

    const statuses: OrderStatus[] = [
      'completed',
      'failed',
      'partially_completed',
      'pending',
      'unknown',
    ];
    const orders = statuses.map((status, index) =>
      seedOrder(testServer, {
        productId: product.id,
        businessOrderNo: `AGG-${index + 1}`,
        createdAt: at((index + 1) * 60_000),
        status,
      }),
    );

    // Four observations inside the window plus one just before it.
    const attemptSeeds: Array<{ result: 'accepted' | 'rejected' | 'unknown'; occurredAt: number }> =
      [
        { result: 'accepted', occurredAt: at(10_000) },
        { result: 'accepted', occurredAt: at(20_000) },
        { result: 'rejected', occurredAt: at(30_000) },
        { result: 'unknown', occurredAt: at(40_000) },
        { result: 'accepted', occurredAt: from - 1 },
      ];
    for (const [index, seed] of attemptSeeds.entries()) {
      repository.appendAttempt({
        orderId: orders[index % orders.length]!.id,
        operation: 'grant',
        result: seed.result,
        occurredAt: seed.occurredAt,
      });
    }

    const overview = await readOverview(admin);

    expect(overview.byStatus).toEqual({
      pending: 1,
      processing: 0,
      awaiting_claim: 0,
      partially_completed: 1,
      completed: 1,
      failed: 1,
      unknown: 1,
    });
    expect(overview.orders.total).toBe(5);
    expect(overview.orders.completed).toBe(1);
    expect(overview.orders.failed).toBe(1);
    expect(overview.orders.terminalTotal).toBe(3);
    expect(overview.orders.completedRateBp).toBe(3333);
    expect(overview.orders.previousTotal).toBe(0);
    expect(overview.attempts).toEqual({ total: 4, accepted: 2, rejected: 1, unknown: 1 });
    expect(overview.series.at(-1)).toEqual({
      day: bjDayLabel(asOf),
      total: 5,
      completed: 1,
    });
    expect(overview.hourly.reduce((sum, point) => sum + point.total, 0)).toBe(5);
  });

  it('keeps every trend day present and ordered, including days without orders', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'OVW-SERIES');
    activateMapping(testServer, product.id);
    const viewer = await signIn(testServer, 'viewer');

    const asOf = Date.now();
    const firstDay = bjDayStart(asOf) - (OVERVIEW_TREND_DAYS - 1) * DAY;
    // A completed order on the oldest trend day only; the other 29 days are empty.
    seedOrder(testServer, {
      productId: product.id,
      businessOrderNo: 'SERIES-1',
      createdAt: firstDay + 3_600_000,
      status: 'completed',
    });

    const overview = await readOverview(viewer);

    expect(overview.series.map((point) => point.day)).toEqual(
      Array.from({ length: OVERVIEW_TREND_DAYS }, (_, index) => bjDayLabel(firstDay + index * DAY)),
    );
    expect(overview.series[0]).toEqual({ day: bjDayLabel(firstDay), total: 1, completed: 1 });
    expect(overview.series.slice(1).every((point) => point.total === 0 && point.completed === 0)).toBe(
      true,
    );
    // The trend is 30 days wide even though the selected window is only today.
    expect(overview.orders.total).toBe(0);
    expect(overview.hourly.map((point) => point.hour)).toEqual(
      Array.from({ length: 24 }, (_, hour) => hour),
    );
    expect(overview.hourly.every((point) => point.total === 0)).toBe(true);
  });

  it('buckets orders by the Beijing hour of day, not the UTC hour', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'OVW-HOUR');
    activateMapping(testServer, product.id);
    const viewer = await signIn(testServer, 'viewer');

    const today = bjDayStart(Date.now());
    // 03:00 and 21:00 Beijing two days ago: fully inside both the 7d window and
    // the 30-day trend, and unambiguous regardless of the current clock time.
    seedOrder(testServer, {
      productId: product.id,
      businessOrderNo: 'HOUR-1',
      createdAt: today - 2 * DAY + 3 * 3_600_000,
    });
    seedOrder(testServer, {
      productId: product.id,
      businessOrderNo: 'HOUR-2',
      createdAt: today - DAY + 21 * 3_600_000,
    });

    const overview = await readOverview(viewer, '7d');

    expect(overview.hourly).toHaveLength(24);
    expect(overview.hourly.map((point) => point.hour)).toEqual(
      Array.from({ length: 24 }, (_, hour) => hour),
    );
    expect(overview.hourly[3]?.total).toBe(1);
    expect(overview.hourly[21]?.total).toBe(1);
    expect(overview.hourly.reduce((sum, point) => sum + point.total, 0)).toBe(2);
    expect(overview.orders.total).toBe(2);
  });
});

describe('operations overview windows', () => {
  it('computes the previous-window total and the 7d/30d boundaries from Beijing days', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'OVW-WINDOW');
    activateMapping(testServer, product.id);
    const viewer = await signIn(testServer, 'viewer');

    const asOf = Date.now();
    const today = bjDayStart(asOf);
    const from7 = today - 6 * DAY;
    const from30 = today - 29 * DAY;

    const week = await readOverview(viewer, '7d');
    expect(week.window).toEqual({
      key: '7d',
      from: from7,
      to: week.asOf,
      timezone: OVERVIEW_TIMEZONE,
    });
    expect(week.orders.total).toBe(0);
    expect(week.orders.previousTotal).toBe(0);

    // One order inside the 7d window and one in the equally long window before it.
    seedOrder(testServer, {
      productId: product.id,
      businessOrderNo: 'WINDOW-INSIDE-7D',
      createdAt: from7 + 1_000,
    });
    seedOrder(testServer, {
      productId: product.id,
      businessOrderNo: 'WINDOW-BEFORE-7D',
      createdAt: from7 - 1_000,
    });

    const weekAfter = await readOverview(viewer, '7d');
    expect(weekAfter.orders.total).toBe(1);
    // The order immediately before `from` belongs to the previous window only.
    expect(weekAfter.orders.previousTotal).toBe(1);

    // One order just inside the 30d window and one just before its start.
    seedOrder(testServer, {
      productId: product.id,
      businessOrderNo: 'WINDOW-INSIDE-30D',
      createdAt: from30 + 1_000,
    });
    seedOrder(testServer, {
      productId: product.id,
      businessOrderNo: 'WINDOW-BEFORE-30D',
      createdAt: from30 - 1,
    });

    const month = await readOverview(viewer, '30d');
    expect(month.window.from).toBe(from30);
    expect(month.orders.total).toBe(3);
    // The 30d comparison window is also 30 days long, so only the order one
    // millisecond before its start falls in it.
    expect(month.orders.previousTotal).toBe(1);
    expect(month.series[0]?.total).toBe(1);
  });

  it('compares today against the same elapsed span of yesterday', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'OVW-TODAY-PREV');
    activateMapping(testServer, product.id);
    const viewer = await signIn(testServer, 'viewer');

    const asOf = Date.now();
    const today = bjDayStart(asOf);
    const elapsed = asOf - today;
    // Yesterday's matching span is [today - DAY, asOf - DAY). A naive
    // "immediately preceding equal-length window" would instead compare against
    // the hours just before midnight, so this case pins the intended meaning.
    const insideYesterday = today - DAY + Math.floor(elapsed / 2);
    const afterYesterday = today - DAY + elapsed + 60_000;

    seedOrder(testServer, {
      productId: product.id,
      businessOrderNo: 'TODAY-START',
      createdAt: today,
    });
    seedOrder(testServer, {
      productId: product.id,
      businessOrderNo: 'YESTERDAY-INSIDE',
      createdAt: insideYesterday,
    });
    seedOrder(testServer, {
      productId: product.id,
      businessOrderNo: 'YESTERDAY-AFTER',
      createdAt: afterYesterday,
    });

    const overview = await readOverview(viewer);

    // Only the order created inside today belongs to the current window; the
    // matching-span order is the comparison baseline and the later one is in no
    // window at all.
    expect(overview.orders.total).toBe(1);
    expect(overview.orders.previousTotal).toBe(1);
    expect(overview.series.at(-1)).toEqual({ day: bjDayLabel(asOf), total: 1, completed: 0 });
  });

  it('aligns a late-UTC order to the Beijing calendar day it was created on', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'OVW-BJDAY');
    activateMapping(testServer, product.id);
    const viewer = await signIn(testServer, 'viewer');

    const today = bjDayStart(Date.now());
    const targetDayStart = today - 5 * DAY;
    // 00:30 Beijing is 16:30 UTC on the previous calendar date.
    const createdAt = targetDayStart + 30 * 60_000;
    const beijingLabel = bjDayLabel(createdAt);
    const utcLabel = new Date(createdAt).toISOString().slice(0, 10);
    expect(beijingLabel).not.toBe(utcLabel);

    seedOrder(testServer, {
      productId: product.id,
      businessOrderNo: 'BJDAY-1',
      createdAt,
      status: 'completed',
    });

    const overview = await readOverview(viewer, '30d');

    const points = overview.series.filter((point) => point.day === beijingLabel);
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({ day: beijingLabel, total: 1, completed: 1 });
    // The UTC date of the same instant must stay empty: that would be the
    // boundary a naive `toISOString()` bucket would produce.
    expect(overview.series.find((point) => point.day === utcLabel)?.total).toBe(0);
    expect(overview.orders.total).toBe(1);
    // 00:30 Beijing is hour-of-day 0; UTC hour 16 must not be credited.
    expect(overview.hourly[0]?.total).toBe(1);
    expect(overview.hourly[16]?.total).toBe(0);
  });

  it('rejects an unknown window without leaking accepted values', async () => {
    const testServer = startServer();
    const viewer = await signIn(testServer, 'viewer');

    for (const query of ['window=90d', 'window=', 'window=TODAY']) {
      const response = await viewer.request(`${ENDPOINT}?${query}`);
      expect(response.status, query).toBe(400);
      expectNoStore(response);
      const body = parseError(await response.json());
      expect(body.error).toBe('INVALID_REQUEST');
      expect(body.fields).toContain('window');
      expect(JSON.stringify(body)).not.toContain('90d');
    }
  });
});
