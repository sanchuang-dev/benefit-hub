import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createBusinessOrderResponseSchema, createPrepaidGrantRequestSchema, prepaidGrantResponseSchema, type PrepaidGrantResponse } from '@sanchuang-dev/benefit-contracts';
import { type AppConfig } from '../../src/config.js';
import { createApplication, replaceApplicationProducts } from '../../src/modules/applications/applications.js';
import { issueApplicationCredential, revokeApplicationCredential } from '../../src/modules/applications/credentials.js';
import { createProduct } from '../../src/modules/catalog/products.js';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from '../helpers/test-server.js';
import { activateMapping, bearer, clientsConfig, countRows, expectNoStore, parseError } from '../helpers/api-fixtures.js';

/**
 * FICTIONAL FIXTURES ONLY. Every token, phone, application, master key and
 * vendor response in this file is synthetic; nothing here is a real credential
 * or a real supplier response. The loopback server only exists in this test.
 */
const COLLECTION = '/api/v1/business/orders';
const TOKEN_LOCAL = 'fictional-local-life-order-token-00000001';
const TOKEN_DOCTOR = 'fictional-card-doctor-order-token-000002';
const PHONE = '13800138000';
const REF_CODE = 'ref_abc123';
const PAYMENT_REFERENCE = 'PAY-FICTIONAL-1001';
const CLAIM_URL = 'https://h5.example.test/bet?orderNo=PKG-FICTIONAL-1';
const FIXTURE_MASTER_KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

let server: TestServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});
interface VendorState {
  eligibility: {
    purchaseRestricted: boolean;
    giftUnclaimed: boolean;
    lotteryUnbet: boolean;
  };
  orderMode: 'success' | 'malformed' | 'business400' | 'http500';
  queryMode: 'success' | 'business400' | 'malformed' | 'noLink';
  claimUrl: string;
  orderNo: string;
  orderDelayMs: number;
  /** Deterministic operator change while the live read-only check is in flight. */
  onPurchaseCheck?: () => void;
}

interface VendorCall {
  method: string;
  path: string;
  signature: string | undefined;
  dSignature: string | undefined;
  timestamp: string | undefined;
  nonce: string | undefined;
  body: string;
}

async function fixtureVendor() {
  const state: VendorState = {
    eligibility: { purchaseRestricted: false, giftUnclaimed: false, lotteryUnbet: false },
    orderMode: 'success',
    queryMode: 'success',
    claimUrl: CLAIM_URL,
    orderNo: 'PKG-FICTIONAL-1',
    orderDelayMs: 0,
  };
  const calls: VendorCall[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: req.method ?? '',
        path: req.url ?? '',
        signature: req.headers['x-sign'] as string | undefined,
        dSignature: req.headers['x-signature'] as string | undefined,
        timestamp: req.headers['x-timestamp'] as string | undefined,
        nonce: req.headers['x-nonce'] as string | undefined,
        body,
      });
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.url === '/open/v1/prepaid/purchase-check') {
        state.onPurchaseCheck?.();
        reply(200, { code: 0, data: state.eligibility });
        return;
      }
      if (req.url === '/open/v1/prepaid/orders') {
        const respond = () => {
          if (state.orderMode === 'success') {
            reply(200, {
              code: 0,
              data: {
                orderNo: state.orderNo,
                claimUrl: state.claimUrl,
                balanceAfter: 99,
                idempotentReplay: false,
              },
            });
            return;
          }
          if (state.orderMode === 'malformed') {
            // code=0 but no claimUrl: a real debit may have happened, so the
            // caller must keep this as unknown rather than a success.
            reply(200, { code: 0, data: { orderNo: state.orderNo } });
            return;
          }
          if (state.orderMode === 'business400') {
            reply(200, { code: 400, message: 'fictional business failure', data: null });
            return;
          }
          reply(500, { error: 'fictional upstream failure' });
        };
        if (state.orderDelayMs > 0) setTimeout(respond, state.orderDelayMs);
        else respond();
        return;
      }
      if (req.url === '/open/v1/prepaid/orders/query') {
        if (state.queryMode === 'success') {
          reply(200, {
            code: 0,
            data: { orderNo: state.orderNo, claimable: true, claimUrl: state.claimUrl },
          });
          return;
        }
        if (state.queryMode === 'noLink') {
          reply(200, { code: 0, data: { orderNo: state.orderNo, claimable: false } });
          return;
        }
        if (state.queryMode === 'malformed') {
          reply(200, { code: 0, data: { unknownFutureField: true } });
          return;
        }
        reply(200, { code: 400, message: 'fictional not found', data: null });
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    state,
    calls,
    orderCalls: () => calls.filter((call) => call.path === '/open/v1/prepaid/orders'),
    queryCalls: () => calls.filter((call) => call.path === '/open/v1/prepaid/orders/query'),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

type Vendor = Awaited<ReturnType<typeof fixtureVendor>>;

function startServer(vendor: Vendor, overrides: Partial<AppConfig> = {}) {
  const testServer = new TestServer({
    businessOrderClients: clientsConfig({
      'local-life': TOKEN_LOCAL,
      'card-doctor': TOKEN_DOCTOR,
    }),
    yangmaoInrice: {
      baseUrl: vendor.origin,
      appKey: 'fixture-app-key',
      appSecret: 'fixture-app-secret',
    },
    supplierMasterKey: Buffer.from(FIXTURE_MASTER_KEY_HEX, 'hex'),
    aLiveWritesEnabled: true,
    ...overrides,
  });
  server = testServer;
  return testServer;
}

function seedProduct(testServer: TestServer, code: string) {
  return createProduct(testServer.database.db, {
    code,
    name: `A 预充值测试商品 ${code}`,
    actorAccountId: 'test-actor',
  });
}

function registerApplication(testServer: TestServer, businessSource: string, productId: string) {
  const application = createApplication(testServer.database.db, {
    businessSource,
    name: `测试应用 ${businessSource}`,
    actorAccountId: 'test-actor',
  });
  return replaceApplicationProducts(
    testServer.database.db,
    application.id,
    [productId],
    application.version,
    'test-actor',
  );
}

async function postOrder(
  testServer: TestServer,
  token: string | null,
  body: unknown,
): Promise<Response> {
  return testServer.app.request(COLLECTION, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify(body),
  });
}

async function createOrder(testServer: TestServer, businessOrderNo: string, productId: string) {
  const response = await postOrder(testServer, TOKEN_LOCAL, { businessOrderNo, productId });
  expect(response.status).toBe(201);
  return createBusinessOrderResponseSchema.parse(await response.json()).order;
}

async function grantOrder(
  testServer: TestServer,
  orderId: string,
  body: unknown,
  token: string | null = TOKEN_LOCAL,
): Promise<Response> {
  return testServer.app.request(`${COLLECTION}/${orderId}/grant`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify(body),
  });
}

async function recoverOrder(
  testServer: TestServer,
  orderId: string,
  token: string | null = TOKEN_LOCAL,
): Promise<Response> {
  return testServer.app.request(`${COLLECTION}/${orderId}/recover`, {
    method: 'POST',
    headers: bearer(token),
    body: '{}',
  });
}

function parseGrant(body: unknown): PrepaidGrantResponse {
  return prepaidGrantResponseSchema.parse(body);
}

function grantRow(testServer: TestServer, orderId: string) {
  return testServer.database.sqlite
    .prepare('SELECT * FROM benefit_order_grants WHERE order_id = ?')
    .get(orderId) as Record<string, unknown> | undefined;
}
const VALID_GRANT_BODY = {
  phone: PHONE,
  refCode: REF_CODE,
  paymentReference: PAYMENT_REFERENCE,
};
describe('A-mode live-write gate and admin acceptance', () => {
  it('blocks before any supplier call while the A live gate is disabled', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor, { aLiveWritesEnabled: false });
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A-GATE');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-A-GATE-1', product.id);

      const response = await grantOrder(testServer, order.id, VALID_GRANT_BODY);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: 'PREPAID_GRANT_WRITE_DISABLED',
      });
      expect(vendor.calls).toHaveLength(0);
      expect(grantRow(testServer, order.id)).toBeUndefined();
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('lets only an admin confirm one A write, then recovers the same requestId read-only', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A-ADMIN');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-A-ADMIN-1', product.id);

      await seedAccount(testServer, { username: 'ops.admin.a', role: 'admin' });
      await seedAccount(testServer, { username: 'ops.viewer.a', role: 'viewer' });
      const admin = new TestClient(testServer);
      const viewer = new TestClient(testServer);
      expect((await admin.login('ops.admin.a', TEST_PASSWORD)).status).toBe(200);
      expect((await viewer.login('ops.viewer.a', TEST_PASSWORD)).status).toBe(200);

      const viewerDenied = await viewer.post(
        `/api/v1/operations/orders/${order.id}/prepaid-grant`,
        { ...VALID_GRANT_BODY, confirmGrant: true },
      );
      expect(viewerDenied.status).toBe(403);
      expect(vendor.calls).toHaveLength(0);

      const missingConfirm = await admin.post(
        `/api/v1/operations/orders/${order.id}/prepaid-grant`,
        VALID_GRANT_BODY,
      );
      expect(missingConfirm.status).toBe(400);
      expect(vendor.calls).toHaveLength(0);

      const grantedResponse = await admin.post(
        `/api/v1/operations/orders/${order.id}/prepaid-grant`,
        { ...VALID_GRANT_BODY, confirmGrant: true },
      );
      expect(grantedResponse.status).toBe(200);
      const grantedBody = (await grantedResponse.json()) as {
        order: { status: string; grant: { requestId: string; state: string } | null };
        claimUrl?: string;
      };
      expect(grantedBody.order.status).toBe('awaiting_claim');
      expect(grantedBody.order.grant?.state).toBe('accepted');
      expect(grantedBody.claimUrl).toBe(CLAIM_URL);
      expect(vendor.orderCalls()).toHaveLength(1);

      const requestId = grantedBody.order.grant?.requestId;
      const recoveredResponse = await admin.post(
        `/api/v1/operations/orders/${order.id}/prepaid-grant/recover`,
        {},
      );
      expect(recoveredResponse.status).toBe(200);
      const recoveredBody = (await recoveredResponse.json()) as {
        order: { grant: { requestId: string } | null };
        claimUrl?: string;
      };
      expect(recoveredBody.order.grant?.requestId).toBe(requestId);
      expect(recoveredBody.claimUrl).toBe(CLAIM_URL);
      expect(vendor.orderCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(1);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);
});

describe('A-mode prepaid grant happy path', () => {
  it('runs purchase-check then the signed order call once and persists an awaiting_claim fact', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A');
      const mapping = activateMapping(testServer, product.id, {
        mode: 'A',
        productCode: 'YM-PACK-FROZEN',
      });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-A-1001', product.id);

      const response = await grantOrder(testServer, order.id, VALID_GRANT_BODY);
      expect(response.status).toBe(200);
      expectNoStore(response);
      const granted = parseGrant(await response.json());

      expect(granted.order).toMatchObject({
        id: order.id,
        status: 'awaiting_claim',
        fulfillmentMode: 'A',
        mappingVersionId: mapping.id,
      });
      expect(granted.grant.state).toBe('accepted');
      expect(granted.grant.requestId).toMatch(/^bhA[0-9a-f]{60}$/);
      expect(granted.grant.upstreamOrderNo).toBe('PKG-FICTIONAL-1');
      expect(granted.claimUrl).toBe(CLAIM_URL);
      // A link is not a claimed/completed benefit.
      expect(JSON.stringify(granted)).not.toContain('completed');
      expect(JSON.stringify(granted)).not.toContain('claimed');

      // Exactly one read-only eligibility check followed by exactly one debit.
      expect(vendor.calls.map((call) => call.path)).toEqual([
        '/open/v1/prepaid/purchase-check',
        '/open/v1/prepaid/orders',
      ]);
      const orderCall = vendor.orderCalls()[0]!;
      expect(orderCall.dSignature).toBeUndefined();
      expect(orderCall.signature).toMatch(/^[A-F0-9]{64}$/);
      expect(orderCall.timestamp).toMatch(/^\d{13}$/);
      expect(orderCall.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.parse(orderCall.body)).toEqual({
        phone: PHONE,
        refCode: REF_CODE,
        requestId: granted.grant.requestId,
        productCode: 'YM-PACK-FROZEN',
      });
      // The phone travels in the JSON body only.
      expect(orderCall.path).not.toContain(PHONE);

      const row = grantRow(testServer, order.id)!;
      expect(row).toMatchObject({
        request_id: granted.grant.requestId,
        state: 'accepted',
        upstream_order_no: 'PKG-FICTIONAL-1',
        ref_code: REF_CODE,
        payment_reference: PAYMENT_REFERENCE,
      });
      expect(row.phone_hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(PHONE);

      // The operation identity is frozen at the database boundary too.
      expect(() =>
        testServer.database.sqlite
          .prepare("UPDATE benefit_order_grants SET request_id = 'forged' WHERE order_id = ?")
          .run(order.id),
      ).toThrow(/identity is immutable/);
      expect(() =>
        testServer.database.sqlite
          .prepare('DELETE FROM benefit_order_grants WHERE order_id = ?')
          .run(order.id),
      ).toThrow(/never deleted/);

      // Two grant facts: the mandatory pre-send unknown record and the result.
      const attempts = testServer.database.sqlite
        .prepare('SELECT operation, result, upstream_request_no, upstream_order_no FROM fulfillment_attempts WHERE order_id = ? ORDER BY occurred_at, id')
        .all(order.id) as Record<string, unknown>[];
      expect(attempts).toHaveLength(2);
      expect(attempts.filter((attempt) => attempt.result === 'unknown')).toEqual([
        {
          operation: 'grant',
          result: 'unknown',
          upstream_request_no: granted.grant.requestId,
          upstream_order_no: null,
        },
      ]);
      expect(attempts.filter((attempt) => attempt.result === 'accepted')).toEqual([
        {
          operation: 'grant',
          result: 'accepted',
          upstream_request_no: granted.grant.requestId,
          upstream_order_no: 'PKG-FICTIONAL-1',
        },
      ]);
      const statuses = (
        testServer.database.sqlite
          .prepare('SELECT status FROM benefit_order_status_events WHERE order_id = ? ORDER BY version')
          .all(order.id) as { status: string }[]
      ).map((event) => event.status);
      expect(statuses).toEqual(['pending', 'processing', 'awaiting_claim']);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('reuses the same requestId and recovers the link without a second debit', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-A-1002', product.id);

      const first = parseGrant(await (await grantOrder(testServer, order.id, VALID_GRANT_BODY)).json());
      const secondResponse = await grantOrder(testServer, order.id, VALID_GRANT_BODY);
      expect(secondResponse.status).toBe(200);
      const second = parseGrant(await secondResponse.json());

      expect(second.grant.requestId).toBe(first.grant.requestId);
      expect(second.grant.upstreamOrderNo).toBe(first.grant.upstreamOrderNo);
      expect(second.claimUrl).toBe(first.claimUrl);
      // The retry is a read-only query, not a second order POST.
      expect(vendor.orderCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(1);

      const recoveredResponse = await recoverOrder(testServer, order.id);
      expect(recoveredResponse.status).toBe(200);
      const recovered = parseGrant(await recoveredResponse.json());
      expect(recovered.grant.requestId).toBe(first.grant.requestId);
      expect(recovered.claimUrl).toBe(first.claimUrl);
      expect(vendor.orderCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(2);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('uses the frozen mapping product code after the mapping rotates', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-FROZEN' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-A-1003', product.id);
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-ROTATED' });

      const response = await grantOrder(testServer, order.id, VALID_GRANT_BODY);
      expect(response.status).toBe(200);
      expect(JSON.parse(vendor.orderCalls()[0]!.body).productCode).toBe('YM-PACK-FROZEN');
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);
});

describe('A-mode prepaid grant preconditions', () => {
  it('rejects invalid input and missing payment authorization before any vendor call', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-A-2001', product.id);

      const invalidPhone = await grantOrder(testServer, order.id, {
        ...VALID_GRANT_BODY,
        phone: '12345',
      });
      expect(invalidPhone.status).toBe(400);
      expect(parseError(await invalidPhone.json()).fields).toContain('phone');

      const invalidRef = await grantOrder(testServer, order.id, {
        ...VALID_GRANT_BODY,
        refCode: 'bad ref',
      });
      expect(invalidRef.status).toBe(400);
      expect(parseError(await invalidRef.json()).fields).toContain('refCode');

      const missingPayment = await grantOrder(testServer, order.id, {
        phone: PHONE,
        refCode: REF_CODE,
      });
      expect(missingPayment.status).toBe(400);
      expect(parseError(await missingPayment.json()).fields).toContain('paymentReference');

      const injectedMode = await grantOrder(testServer, order.id, {
        ...VALID_GRANT_BODY,
        fulfillmentMode: 'B',
      });
      expect(injectedMode.status).toBe(400);
      expect(parseError(await injectedMode.json()).fields).toContain('fulfillmentMode');

      expect(vendor.calls).toHaveLength(0);
      expect(grantRow(testServer, order.id)).toBeUndefined();
      expect(countRows(testServer, 'fulfillment_attempts')).toBe(0);

      // Explicit JSON schema contract used by the route.
      expect(createPrepaidGrantRequestSchema.safeParse(VALID_GRANT_BODY).success).toBe(true);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('rejects an unauthorized product, a non-A order and a missing master key before any vendor call', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const aProduct = seedProduct(testServer, 'YM-PREPAID-A');
      const bProduct = seedProduct(testServer, 'YM-TRAVEL-B');
      activateMapping(testServer, aProduct.id, { mode: 'A', productCode: 'YM-PACK-A' });
      activateMapping(testServer, bProduct.id, { mode: 'B', productCode: 'YM-PACK-B' });

      // Create both intents while the legacy source is still unregistered.
      const aOrder = await createOrder(testServer, 'LO-A-2002', aProduct.id);
      const bOrder = await createOrder(testServer, 'LO-B-2003', bProduct.id);

      const application = createApplication(testServer.database.db, {
        businessSource: 'local-life',
        name: '仅授权 B 商品的应用',
        actorAccountId: 'test-actor',
      });
      // The A product is intentionally not on the allowlist.
      replaceApplicationProducts(
        testServer.database.db,
        application.id,
        [bProduct.id],
        application.version,
        'test-actor',
      );

      const unauthorized = await grantOrder(testServer, aOrder.id, VALID_GRANT_BODY);
      expect(unauthorized.status).toBe(403);
      expect(parseError(await unauthorized.json()).error).toBe('PRODUCT_NOT_AUTHORIZED');
      expect(vendor.calls).toHaveLength(0);

      const modeRejected = await grantOrder(testServer, bOrder.id, VALID_GRANT_BODY);
      expect(modeRejected.status).toBe(409);
      expect(parseError(await modeRejected.json()).error).toBe('ORDER_MODE_UNSUPPORTED');
      expect(vendor.calls).toHaveLength(0);

      // A fresh server with no master key fails closed before the supplier call.
      testServer.close();
      const noKey = startServer(vendor, { supplierMasterKey: null });
      const standalone = seedProduct(noKey, 'YM-PREPAID-NOKEY');
      activateMapping(noKey, standalone.id, { mode: 'A', productCode: 'YM-PACK-A' });
      const orderNoKey = await createOrder(noKey, 'LO-A-2004', standalone.id);
      const keyRejected = await grantOrder(noKey, orderNoKey.id, VALID_GRANT_BODY);
      expect(keyRejected.status).toBe(503);
      expect(parseError(await keyRejected.json()).error).toBe('SUPPLIER_KEY_UNAVAILABLE');
      expect(vendor.calls).toHaveLength(0);
      expect(grantRow(noKey, orderNoKey.id)).toBeUndefined();
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it.each([
    { name: 'purchase restriction', eligibility: { purchaseRestricted: true, giftUnclaimed: false, lotteryUnbet: false } },
    { name: 'unclaimed gift', eligibility: { purchaseRestricted: false, giftUnclaimed: true, lotteryUnbet: false } },
    { name: 'unbet lottery', eligibility: { purchaseRestricted: false, giftUnclaimed: false, lotteryUnbet: true } },
  ])('refuses $name after purchase-check with no reservation or debit', async ({ eligibility }) => {
    const vendor = await fixtureVendor();
    vendor.state.eligibility = eligibility;
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      const order = await createOrder(testServer, 'LO-A-2005', product.id);

      const response = await grantOrder(testServer, order.id, VALID_GRANT_BODY);
      expect(response.status).toBe(409);
      expect(parseError(await response.json()).error).toBe('PURCHASE_NOT_ELIGIBLE');
      expect(vendor.calls.map((call) => call.path)).toEqual(['/open/v1/prepaid/purchase-check']);
      expect(grantRow(testServer, order.id)).toBeUndefined();
      expect(countRows(testServer, 'fulfillment_attempts')).toBe(0);
      const orderRow = testServer.database.sqlite
        .prepare('SELECT status FROM benefit_orders WHERE id = ?')
        .get(order.id) as { status: string };
      expect(orderRow.status).toBe('pending');
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);
});

describe('A-mode prepaid grant authorization at the debit reservation', () => {
  it('rejects a disabled application or removed product while purchase-check is in flight', async () => {
    for (const mutation of ['disabled', 'allowlist_removed'] as const) {
      const vendor = await fixtureVendor();
      const testServer = startServer(vendor);
      try {
        const product = seedProduct(testServer, `YM-PREPAID-A-${mutation}`);
        activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
        registerApplication(testServer, 'local-life', product.id);
        const order = await createOrder(testServer, `LO-A-AUTH-${mutation}`, product.id);

        // The Bearer has already authenticated and purchase-check has begun.
        // An operator mutation commits before reserveGrant obtains its write lock.
        vendor.state.onPurchaseCheck = () => {
          if (mutation === 'disabled') {
            testServer.database.sqlite
              .prepare("UPDATE business_applications SET status = 'disabled' WHERE business_source = 'local-life'")
              .run();
          } else {
            testServer.database.sqlite
              .prepare(
                "DELETE FROM business_application_products WHERE application_id = (SELECT id FROM business_applications WHERE business_source = 'local-life')",
              )
              .run();
          }
        };

        const response = await grantOrder(testServer, order.id, VALID_GRANT_BODY);
        expect(response.status).toBe(403);
        expect(parseError(await response.json()).error).toBe(
          mutation === 'disabled' ? 'APPLICATION_DISABLED' : 'PRODUCT_NOT_AUTHORIZED',
        );
        expect(vendor.calls.map((call) => call.path)).toEqual([
          '/open/v1/prepaid/purchase-check',
        ]);
        expect(vendor.orderCalls()).toHaveLength(0);
        expect(countRows(testServer, 'benefit_order_grants')).toBe(0);
        expect(countRows(testServer, 'fulfillment_attempts')).toBe(0);
        const local = testServer.database.sqlite
          .prepare('SELECT status FROM benefit_orders WHERE id = ?')
          .get(order.id) as { status: string };
        expect(local.status).toBe('pending');
      } finally {
        testServer.close();
        await vendor.close();
      }
    }
  }, 20_000);

  it('rejects a DB-issued credential revoked during purchase-check before any supplier debit', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A-CREDENTIAL');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      registerApplication(testServer, 'local-life', product.id);
      const app = testServer.database.sqlite
        .prepare("SELECT id FROM business_applications WHERE business_source = 'local-life'")
        .get() as { id: string };
      const issued = issueApplicationCredential(testServer.database.db, app.id, 'test-actor');
      const order = await createOrder(testServer, 'LO-A-AUTH-REVOKED', product.id);

      vendor.state.onPurchaseCheck = () => {
        revokeApplicationCredential(
          testServer.database.db,
          app.id,
          issued.credential.id,
          'test-actor',
        );
      };

      // Middleware initially accepts this token, but the transaction must
      // refuse it once the supplier eligibility read returns.
      const response = await grantOrder(
        testServer, order.id, VALID_GRANT_BODY, issued.secret,
      );
      expect(response.status).toBe(401);
      expect(parseError(await response.json()).error).toBe('UNAUTHORIZED');
      expect(vendor.calls.map((call) => call.path)).toEqual([
        '/open/v1/prepaid/purchase-check',
      ]);
      expect(vendor.orderCalls()).toHaveLength(0);
      expect(countRows(testServer, 'benefit_order_grants')).toBe(0);
      expect(countRows(testServer, 'fulfillment_attempts')).toBe(0);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);
});

describe('A-mode prepaid grant concurrency and tenant isolation', () => {
  it('lets only one concurrent caller reserve and sends exactly one debit', async () => {
    const vendor = await fixtureVendor();
    vendor.state.orderDelayMs = 60;
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      const order = await createOrder(testServer, 'LO-A-3001', product.id);

      const responses = await Promise.all([
        grantOrder(testServer, order.id, VALID_GRANT_BODY),
        grantOrder(testServer, order.id, VALID_GRANT_BODY),
      ]);
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 409]);
      const rejected = responses.find((response) => response.status === 409)!;
      expect(parseError(await rejected.json()).error).toBe('GRANT_IN_PROGRESS');

      expect(vendor.orderCalls()).toHaveLength(1);
      expect(countRows(testServer, 'benefit_order_grants')).toBe(1);
      expect(grantRow(testServer, order.id)).toMatchObject({ state: 'accepted' });
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('does not let another business source grant or recover the order', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      const order = await createOrder(testServer, 'LO-A-3002', product.id);

      const foreignGrant = await grantOrder(testServer, order.id, VALID_GRANT_BODY, TOKEN_DOCTOR);
      expect(foreignGrant.status).toBe(404);
      expect(parseError(await foreignGrant.json()).error).toBe('ORDER_NOT_FOUND');
      const foreignRecover = await recoverOrder(testServer, order.id, TOKEN_DOCTOR);
      expect(foreignRecover.status).toBe(404);
      expect(vendor.calls).toHaveLength(0);

      // Bearer credential is mandatory even though the machine POST is CSRF-exempt.
      const anonymous = await grantOrder(testServer, order.id, VALID_GRANT_BODY, null);
      expect(anonymous.status).toBe(401);
      expect(vendor.calls).toHaveLength(0);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);
});

describe('A-mode prepaid grant unknown and recovery semantics', () => {
  it('keeps a malformed success as unknown and recovers the same request without a second debit', async () => {
    const vendor = await fixtureVendor();
    vendor.state.orderMode = 'malformed';
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      const order = await createOrder(testServer, 'LO-A-4001', product.id);

      const failed = await grantOrder(testServer, order.id, VALID_GRANT_BODY);
      expect(failed.status).toBe(502);
      expect(parseError(await failed.json()).error).toBe('SUPPLIER_RESPONSE_UNVERIFIED');
      expect(grantRow(testServer, order.id)).toMatchObject({ state: 'unknown' });
      expect(vendor.orderCalls()).toHaveLength(1);

      vendor.state.orderMode = 'success';
      const recoveredResponse = await recoverOrder(testServer, order.id);
      expect(recoveredResponse.status).toBe(200);
      const recovered = parseGrant(await recoveredResponse.json());
      expect(recovered.grant.state).toBe('accepted');
      expect(recovered.grant.requestId).toBe(grantRow(testServer, order.id)!.request_id);
      expect(recovered.claimUrl).toBe(CLAIM_URL);
      expect(recovered.order.status).toBe('awaiting_claim');
      // The recovery used the read-only query only.
      expect(vendor.orderCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(1);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('preserves an explicit business rejection without blind reissue', async () => {
    const vendor = await fixtureVendor();
    vendor.state.orderMode = 'business400';
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      const order = await createOrder(testServer, 'LO-A-4002', product.id);

      const failed = await grantOrder(testServer, order.id, VALID_GRANT_BODY);
      expect(failed.status).toBe(502);
      const failedBody = parseError(await failed.json());
      expect(failedBody.error).toBe('SUPPLIER_BUSINESS_FAILED');
      expect(failedBody.vendorCode).toBe(400);
      expect(grantRow(testServer, order.id)).toMatchObject({ state: 'rejected' });
      const orderRow = testServer.database.sqlite
        .prepare('SELECT status FROM benefit_orders WHERE id = ?')
        .get(order.id) as { status: string };
      expect(orderRow.status).toBe('failed');

      const retried = await grantOrder(testServer, order.id, VALID_GRANT_BODY);
      expect(retried.status).toBe(409);
      expect(parseError(await retried.json()).error).toBe('GRANT_NOT_RETRYABLE');
      expect(vendor.orderCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(0);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('keeps an upstream HTTP 500 and a failed recovery query as unknown/non-success', async () => {
    const vendor = await fixtureVendor();
    vendor.state.orderMode = 'http500';
    vendor.state.queryMode = 'malformed';
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      const order = await createOrder(testServer, 'LO-A-4003', product.id);

      const failed = await grantOrder(testServer, order.id, VALID_GRANT_BODY);
      expect(failed.status).toBe(502);
      expect(parseError(await failed.json()).error).toBe('SUPPLIER_UNAVAILABLE');
      expect(grantRow(testServer, order.id)).toMatchObject({ state: 'unknown' });

      const recoverFailed = await recoverOrder(testServer, order.id);
      expect(recoverFailed.status).toBe(502);
      expect(parseError(await recoverFailed.json()).error).toBe(
        'SUPPLIER_RESPONSE_UNVERIFIED',
      );
      expect(grantRow(testServer, order.id)).toMatchObject({ state: 'unknown' });
      const orderRow = testServer.database.sqlite
        .prepare('SELECT status FROM benefit_orders WHERE id = ?')
        .get(order.id) as { status: string };
      expect(orderRow.status).toBe('unknown');
      expect(vendor.orderCalls()).toHaveLength(1);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('does not report an accepted order as recovered when the read has no link', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      const order = await createOrder(testServer, 'LO-A-4005', product.id);
      expect((await grantOrder(testServer, order.id, VALID_GRANT_BODY)).status).toBe(200);

      vendor.state.queryMode = 'noLink';
      const recovered = await recoverOrder(testServer, order.id);
      expect(recovered.status).toBe(502);
      expect(parseError(await recovered.json()).error).toBe('SUPPLIER_RESPONSE_UNVERIFIED');
      // The previously accepted fact is preserved; no downgrade and no link.
      expect(grantRow(testServer, order.id)).toMatchObject({ state: 'accepted' });
      const orderRow = testServer.database.sqlite
        .prepare('SELECT status FROM benefit_orders WHERE id = ?')
        .get(order.id) as { status: string };
      expect(orderRow.status).toBe('awaiting_claim');
      expect(vendor.orderCalls()).toHaveLength(1);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('rejects a conflicting repeat input for the same order', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-PREPAID-A');
      activateMapping(testServer, product.id, { mode: 'A', productCode: 'YM-PACK-A' });
      const order = await createOrder(testServer, 'LO-A-4004', product.id);
      expect((await grantOrder(testServer, order.id, VALID_GRANT_BODY)).status).toBe(200);

      const conflict = await grantOrder(testServer, order.id, {
        ...VALID_GRANT_BODY,
        phone: '13900139000',
      });
      expect(conflict.status).toBe(409);
      expect(parseError(await conflict.json()).error).toBe('GRANT_INPUT_CONFLICT');
      expect(vendor.orderCalls()).toHaveLength(1);

      const refConflict = await grantOrder(testServer, order.id, {
        ...VALID_GRANT_BODY,
        refCode: 'ref_other',
      });
      expect(refConflict.status).toBe(409);
      expect(parseError(await refConflict.json()).error).toBe('GRANT_INPUT_CONFLICT');

      const paymentConflict = await grantOrder(testServer, order.id, {
        ...VALID_GRANT_BODY,
        paymentReference: 'PAY-DIFFERENT-REFERENCE',
      });
      expect(paymentConflict.status).toBe(409);
      expect(parseError(await paymentConflict.json()).error).toBe('GRANT_INPUT_CONFLICT');
      // Every conflicted input is rejected locally, never queried or re-issued.
      expect(vendor.orderCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(0);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);
});
