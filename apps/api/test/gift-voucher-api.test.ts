import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  businessOrderErrorResponseSchema,
  createBusinessOrderResponseSchema,
  giftVoucherResponseSchema,
  type BusinessOrderErrorResponse,
  type GiftVoucherResponse,
} from '@sanchuang-dev/benefit-contracts';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createApplication, replaceApplicationProducts } from '../src/modules/applications/applications.js';
import { createProduct } from '../src/modules/catalog/products.js';
import { createSupplierMappingRepository } from '../src/modules/catalog/supplier-mapping-repository.js';
import type { FulfillmentMode } from '../src/modules/orders/benefit-orders.js';
import { createBenefitOrderRepository } from '../src/modules/orders/repository.js';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from './helpers/test-server.js';

/**
 * FICTIONAL FIXTURES ONLY. Every token, phone, product code, voucher code, link
 * and vendor response in this file is synthetic; nothing here is a real
 * credential or a real supplier response. The loopback server only exists in
 * this test process.
 */
const COLLECTION = '/api/v1/business/orders';
const TOKEN_LOCAL = 'fictional-local-life-voucher-token-000001';
const TOKEN_DOCTOR = 'fictional-card-doctor-voucher-token-00002';
const PHONE = '13800138000';
const REF_CODE = 'ref_abc123';
const VOUCHER_CODE = 'GV-FICTIONAL-0001';
const CLAIM_URL = 'https://h5.example.test/voucher?code=GV-FICTIONAL-0001';
const FIXTURE_MASTER_KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

let server: TestServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function clientsConfig(entries: Record<string, string>) {
  return loadConfig({
    DATABASE_FILE: ':memory:',
    BENEFIT_ORDER_CLIENTS_JSON: JSON.stringify(entries),
  }).businessOrderClients;
}

interface VendorState {
  issueMode: 'success' | 'malformed' | 'business400' | 'business403' | 'http401' | 'http500';
  queryMode: 'success' | 'business400' | 'malformed' | 'http500';
  voucherCode: string;
  claimUrl: string;
  packTotal: number;
  packRemaining: number;
  expiresAt: string | number;
  issueDelayMs: number;
  /** Used to test a read carrying only one quota field. */
  omitQueryPackTotal?: boolean;
  omitQueryPackRemaining?: boolean;
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
    issueMode: 'success',
    queryMode: 'success',
    voucherCode: VOUCHER_CODE,
    claimUrl: CLAIM_URL,
    packTotal: 3,
    packRemaining: 2,
    expiresAt: '2026-11-28 00:00:00',
    issueDelayMs: 0,
  };
  const calls: VendorCall[] = [];

  const vendor = createServer((req: IncomingMessage, res: ServerResponse) => {
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

      if (req.method === 'POST' && req.url === '/open/v1/gift-vouchers') {
        const respond = () => {
          if (state.issueMode === 'success') {
            reply(200, {
              code: 0,
              data: {
                voucherCode: state.voucherCode,
                claimUrl: state.claimUrl,
                packTotal: state.packTotal,
                packRemaining: state.packRemaining,
                expiresAt: state.expiresAt,
                balanceAfter: 99,
                idempotentReplay: false,
              },
            });
            return;
          }
          if (state.issueMode === 'malformed') {
            // code=0 but no usable voucherCode/claimUrl: the packCount may
            // already be pre-deducted, so this must stay unknown.
            reply(200, { code: 0, data: { packTotal: state.packTotal } });
            return;
          }
          if (state.issueMode === 'business400') {
            reply(200, { code: 400, message: 'fictional not found', data: null });
            return;
          }
          if (state.issueMode === 'business403') {
            reply(200, { code: 403, message: 'fictional forbidden', data: null });
            return;
          }
          if (state.issueMode === 'http401') {
            reply(401, { error: 'fictional unauthorized' });
            return;
          }
          reply(500, { error: 'fictional upstream failure' });
        };
        if (state.issueDelayMs > 0) setTimeout(respond, state.issueDelayMs);
        else respond();
        return;
      }

      if (req.method === 'GET' && req.url?.startsWith('/open/v1/gift-vouchers/')) {
        if (state.queryMode === 'success') {
          reply(200, {
            code: 0,
            data: {
              claimUrl: state.claimUrl,
              ...(state.omitQueryPackTotal ? {} : { packTotal: state.packTotal }),
              ...(state.omitQueryPackRemaining ? {} : { packRemaining: state.packRemaining }),
              expiresAt: state.expiresAt,
              // A query is not an issuance; an unknown vendor field is dropped.
              redeemed: true,
            },
          });
          return;
        }
        if (state.queryMode === 'malformed') {
          reply(200, { code: 0, data: { unknownFutureField: true } });
          return;
        }
        if (state.queryMode === 'http500') {
          reply(500, { error: 'fictional query failure' });
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
    vendor.once('error', reject);
    vendor.listen(0, '127.0.0.1', resolve);
  });
  const address = vendor.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    state,
    calls,
    issueCalls: () =>
      calls.filter((call) => call.method === 'POST' && call.path === '/open/v1/gift-vouchers'),
    queryCalls: () =>
      calls.filter(
        (call) => call.method === 'GET' && call.path.startsWith('/open/v1/gift-vouchers/'),
      ),
    close: () =>
      new Promise<void>((resolve, reject) => {
        vendor.close((error) => (error ? reject(error) : resolve()));
        vendor.closeAllConnections();
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
    ...overrides,
  });
  server = testServer;
  return testServer;
}

function seedProduct(testServer: TestServer, code: string) {
  return createProduct(testServer.database.db, {
    code,
    name: `C 礼包券测试商品 ${code}`,
    actorAccountId: 'test-actor',
  });
}

function activateMapping(
  testServer: TestServer,
  productId: string,
  options: { mode: FulfillmentMode; productCode: string },
) {
  const repository = createSupplierMappingRepository(testServer.database.db);
  const current = repository.getDraft(productId);
  const draft = repository.saveDraft({
    productId,
    expectedVersion: current?.version ?? null,
    provider: 'yangmao',
    productCode: options.productCode,
    fulfillmentMode: options.mode,
    deductionUnit: options.mode === 'D' ? 'amount' : 'pack',
  });
  repository.validateDraft({ productId, expectedVersion: draft.version });
  return repository.activateDraft({
    productId,
    expectedVersion: draft.version,
    actorAccountId: 'test-actor',
  });
}

function registerApplication(
  testServer: TestServer,
  businessSource: string,
  productIds: string | string[],
) {
  const application = createApplication(testServer.database.db, {
    businessSource,
    name: `测试应用 ${businessSource}`,
    actorAccountId: 'test-actor',
  });
  return replaceApplicationProducts(
    testServer.database.db,
    application.id,
    Array.isArray(productIds) ? productIds : [productIds],
    application.version,
    'test-actor',
  );
}

function bearer(token: string | null, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({ 'content-type': 'application/json', ...extra });
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  return headers;
}

async function postOrder(testServer: TestServer, token: string, body: unknown): Promise<Response> {
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

async function issueVoucher(
  testServer: TestServer,
  orderId: string,
  body: unknown,
  token: string | null = TOKEN_LOCAL,
): Promise<Response> {
  return testServer.app.request(`${COLLECTION}/${orderId}/gift-voucher`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify(body),
  });
}

async function recoverVoucher(
  testServer: TestServer,
  orderId: string,
  token: string | null = TOKEN_LOCAL,
): Promise<Response> {
  return testServer.app.request(`${COLLECTION}/${orderId}/gift-voucher/recover`, {
    method: 'POST',
    headers: bearer(token),
    body: '{}',
  });
}

function parseVoucher(body: unknown): GiftVoucherResponse {
  return giftVoucherResponseSchema.parse(body);
}

function parseError(body: unknown): BusinessOrderErrorResponse {
  return businessOrderErrorResponseSchema.parse(body);
}

function voucherRow(testServer: TestServer, orderId: string) {
  return testServer.database.sqlite
    .prepare('SELECT * FROM benefit_order_gift_vouchers WHERE order_id = ?')
    .get(orderId) as Record<string, unknown> | undefined;
}

function orderRow(testServer: TestServer, orderId: string) {
  return testServer.database.sqlite
    .prepare('SELECT status, version FROM benefit_orders WHERE id = ?')
    .get(orderId) as { status: string; version: number };
}

function attempts(testServer: TestServer, orderId: string) {
  return testServer.database.sqlite
    .prepare(
      'SELECT operation, result, upstream_request_no, upstream_order_no FROM fulfillment_attempts WHERE order_id = ? ORDER BY occurred_at, id',
    )
    .all(orderId) as Record<string, unknown>[];
}

function statusHistory(testServer: TestServer, orderId: string) {
  return (
    testServer.database.sqlite
      .prepare('SELECT status FROM benefit_order_status_events WHERE order_id = ? ORDER BY version')
      .all(orderId) as { status: string }[]
  ).map((event) => event.status);
}

const VALID_BODY = { packCount: 3, refCode: REF_CODE, phone: PHONE };

function expectNoStore(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
}

describe('C-mode gift-voucher issuance happy path', () => {
  it('signs exactly one issuance, stores the code encrypted and reports awaiting_claim', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      const mapping = activateMapping(testServer, product.id, {
        mode: 'C',
        productCode: 'YM-PACK-C-FROZEN',
      });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-1001', product.id);

      const response = await issueVoucher(testServer, order.id, VALID_BODY);
      expect(response.status).toBe(200);
      expectNoStore(response);
      const issued = parseVoucher(await response.json());

      expect(issued.order).toMatchObject({
        id: order.id,
        status: 'awaiting_claim',
        fulfillmentMode: 'C',
        mappingVersionId: mapping.id,
      });
      expect(issued.voucher.state).toBe('issued');
      expect(issued.voucher.requestId).toMatch(/^bhC[0-9a-f]{60}$/);
      expect(issued.voucher.packCount).toBe(3);
      expect(issued.voucher.packTotal).toBe(3);
      expect(issued.voucher.packRemaining).toBe(2);
      expect(issued.voucher.lastObservedAt).toEqual(expect.any(Number));
      expect(issued.voucherCode).toBe(VOUCHER_CODE);
      expect(issued.claimUrl).toBe(CLAIM_URL);
      expect(issued.expiresAt).toBe('2026-11-28 00:00:00');
      expect(issued.balanceAfter).toBe(99);
      expect(issued.idempotentReplay).toBe(false);
      // Issuance is not a redemption or a completed benefit.
      expect(JSON.stringify(issued)).not.toContain('completed');
      expect(JSON.stringify(issued)).not.toContain('redeemed');

      // Exactly one signed supplier write; no purchase-check is required for C.
      expect(vendor.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        'POST /open/v1/gift-vouchers',
      ]);
      const call = vendor.issueCalls()[0]!;
      expect(call.dSignature).toBeUndefined();
      expect(call.signature).toMatch(/^[A-F0-9]{64}$/);
      expect(call.timestamp).toMatch(/^\d{13}$/);
      expect(call.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.parse(call.body)).toEqual({
        refCode: REF_CODE,
        packCount: 3,
        requestId: issued.voucher.requestId,
        phone: PHONE,
        productCode: 'YM-PACK-C-FROZEN',
      });
      expect(call.path).not.toContain(PHONE);
      expect(call.path).not.toContain(VOUCHER_CODE);

      const row = voucherRow(testServer, order.id)!;
      expect(row).toMatchObject({
        request_id: issued.voucher.requestId,
        state: 'issued',
        pack_count: 3,
        ref_code: REF_CODE,
        pack_total: 3,
        pack_remaining: 2,
      });
      expect(row.phone_hmac).toMatch(/^[0-9a-f]{64}$/);
      // The voucher code, link and phone are never stored in plaintext.
      const rawRow = JSON.stringify(row);
      expect(rawRow).not.toContain(VOUCHER_CODE);
      expect(rawRow).not.toContain(CLAIM_URL);
      expect(rawRow).not.toContain(PHONE);
      expect(rawRow).not.toContain('2026-11-28');
      expect(String(row.encrypted_voucher)).toMatch(/^v1:/);

      // The operation identity is immutable at the database boundary.
      expect(() =>
        testServer.database.sqlite
          .prepare("UPDATE benefit_order_gift_vouchers SET pack_count = 12 WHERE order_id = ?")
          .run(order.id),
      ).toThrow(/identity is immutable/);
      expect(() =>
        testServer.database.sqlite
          .prepare('DELETE FROM benefit_order_gift_vouchers WHERE order_id = ?')
          .run(order.id),
      ).toThrow(/never deleted/);

      expect(attempts(testServer, order.id)).toEqual([
        {
          operation: 'grant',
          result: 'unknown',
          upstream_request_no: issued.voucher.requestId,
          upstream_order_no: null,
        },
        {
          operation: 'grant',
          result: 'accepted',
          upstream_request_no: issued.voucher.requestId,
          upstream_order_no: null,
        },
      ]);
      expect(statusHistory(testServer, order.id)).toEqual([
        'pending',
        'processing',
        'awaiting_claim',
      ]);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('uses the frozen C mapping product code after the mapping rotates', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C-FROZEN' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-1002', product.id);
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C-ROTATED' });

      expect((await issueVoucher(testServer, order.id, VALID_BODY)).status).toBe(200);
      expect(JSON.parse(vendor.issueCalls()[0]!.body).productCode).toBe('YM-PACK-C-FROZEN');
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);
});

describe('C-mode gift-voucher repeat and recovery', () => {
  it('replays the stored issuance and recovers quota with the uppercase code only', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-2001', product.id);

      const first = parseVoucher(await (await issueVoucher(testServer, order.id, VALID_BODY)).json());
      const secondResponse = await issueVoucher(testServer, order.id, VALID_BODY);
      expect(secondResponse.status).toBe(200);
      const second = parseVoucher(await secondResponse.json());

      expect(second.voucher.requestId).toBe(first.voucher.requestId);
      expect(second.voucherCode).toBe(first.voucherCode);
      expect(second.claimUrl).toBe(first.claimUrl);
      expect(second.voucher.packRemaining).toBe(2);
      // A repeat never issues a second voucher.
      expect(vendor.issueCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(0);

      // The vendor issues uppercase; recovery signs/queries that exact code.
      vendor.state.packRemaining = 1;
      const recoveredResponse = await recoverVoucher(testServer, order.id);
      expect(recoveredResponse.status).toBe(200);
      const recovered = parseVoucher(await recoveredResponse.json());
      expect(recovered.voucher.state).toBe('issued');
      expect(recovered.voucher.packRemaining).toBe(1);
      expect(recovered.voucher.packTotal).toBe(3);
      expect(recovered.voucherCode).toBe(first.voucherCode);
      expect(recovered.claimUrl).toBe(first.claimUrl);
      expect(recovered.order.status).toBe('awaiting_claim');
      expect(vendor.issueCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(1);
      expect(vendor.queryCalls()[0]!.path).toBe(
        `/open/v1/gift-vouchers/${VOUCHER_CODE}`,
      );
      expect(vendor.queryCalls()[0]!.signature).toMatch(/^[A-F0-9]{64}$/);
      expect(vendor.queryCalls()[0]!.body).toBe('');
      expect(attempts(testServer, order.id).map((attempt) => attempt.operation)).toEqual([
        'grant',
        'grant',
        'query',
      ]);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it.each(['partially_completed', 'completed'] as const)(
    'preserves the downstream %s status after a read-only C recovery',
    async (status) => {
      const vendor = await fixtureVendor();
      const testServer = startServer(vendor);
      try {
        const product = seedProduct(testServer, 'YM-VOUCHER-C');
        activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
        registerApplication(testServer, 'local-life', product.id);
        const order = await createOrder(testServer, `LO-C-STATUS-${status}`, product.id);
        expect((await issueVoucher(testServer, order.id, VALID_BODY)).status).toBe(200);

        const before = orderRow(testServer, order.id);
        createBenefitOrderRepository(testServer.database.db).updateStatus({
          orderId: order.id,
          expectedVersion: before.version,
          status,
        });
        const expectedHistory = statusHistory(testServer, order.id);
        const expectedVersion = orderRow(testServer, order.id).version;
        vendor.state.packRemaining = 1;

        const recovered = await recoverVoucher(testServer, order.id);
        expect(recovered.status).toBe(200);
        const result = parseVoucher(await recovered.json());
        expect(result.order.status).toBe(status);
        expect(result.voucher.state).toBe('issued');
        expect(result.voucher.packRemaining).toBe(1);
        expect(orderRow(testServer, order.id)).toEqual({
          status,
          version: expectedVersion,
        });
        expect(statusHistory(testServer, order.id)).toEqual(expectedHistory);
        expect(vendor.issueCalls()).toHaveLength(1);
        expect(vendor.queryCalls()).toHaveLength(1);
      } finally {
        testServer.close();
        await vendor.close();
      }
    },
    20_000,
  );

  it('rejects altered packCount, recipient or refCode without a second issuance', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-2002', product.id);
      expect((await issueVoucher(testServer, order.id, VALID_BODY)).status).toBe(200);

      const conflicts = [
        { ...VALID_BODY, packCount: 4 },
        { ...VALID_BODY, phone: '13900139000' },
        { packCount: 3, refCode: REF_CODE },
        { ...VALID_BODY, refCode: 'ref_other' },
      ];
      for (const body of conflicts) {
        const response = await issueVoucher(testServer, order.id, body);
        expect(response.status, JSON.stringify(body)).toBe(409);
        expect(parseError(await response.json()).error).toBe('GIFT_VOUCHER_INPUT_CONFLICT');
      }
      expect(vendor.issueCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(0);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('lets only one concurrent caller reserve and sends exactly one issuance', async () => {
    const vendor = await fixtureVendor();
    vendor.state.issueDelayMs = 50;
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-2003', product.id);

      const responses = await Promise.all([
        issueVoucher(testServer, order.id, VALID_BODY),
        issueVoucher(testServer, order.id, VALID_BODY),
      ]);
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 409]);
      const rejected = responses.find((response) => response.status === 409)!;
      expect(parseError(await rejected.json()).error).toBe('GIFT_VOUCHER_IN_PROGRESS');
      expect(vendor.issueCalls()).toHaveLength(1);
      expect(voucherRow(testServer, order.id)).toMatchObject({ state: 'issued' });
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('does not let another business recover or issue the order', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-2004', product.id);
      expect((await issueVoucher(testServer, order.id, VALID_BODY)).status).toBe(200);

      const otherIssue = await issueVoucher(testServer, order.id, VALID_BODY, TOKEN_DOCTOR);
      expect(otherIssue.status).toBe(404);
      expect(parseError(await otherIssue.json()).error).toBe('ORDER_NOT_FOUND');
      const otherRecover = await recoverVoucher(testServer, order.id, TOKEN_DOCTOR);
      expect(otherRecover.status).toBe(404);
      expect(vendor.issueCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(0);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);
});

describe('C-mode gift-voucher preconditions', () => {
  it('rejects invalid pack counts and unauthenticated callers before any vendor call', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-3001', product.id);

      for (const body of [
        { packCount: 0, refCode: REF_CODE },
        { packCount: 13, refCode: REF_CODE },
        { packCount: 1.5, refCode: REF_CODE },
        { packCount: '3', refCode: REF_CODE },
        { packCount: 3, refCode: REF_CODE, phone: '12345' },
        { packCount: 3, refCode: REF_CODE, paymentReference: 'PAY-NOT-ALLOWED' },
      ]) {
        const response = await issueVoucher(testServer, order.id, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(parseError(await response.json()).error).toBe('INVALID_REQUEST');
      }

      const anonymous = await issueVoucher(testServer, order.id, VALID_BODY, null);
      expect(anonymous.status).toBe(401);
      expect(vendor.calls).toHaveLength(0);
      expect(voucherRow(testServer, order.id)).toBeUndefined();
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('rejects an unauthorized product, a non-C order and a missing master key before any vendor call', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      const otherProduct = seedProduct(testServer, 'YM-OTHER-C');
      activateMapping(testServer, otherProduct.id, { mode: 'C', productCode: 'YM-OTHER' });
      const aProduct = seedProduct(testServer, 'YM-MODE-A');
      activateMapping(testServer, aProduct.id, { mode: 'A', productCode: 'YM-PACK-A' });
      const application = registerApplication(testServer, 'local-life', [
        product.id,
        otherProduct.id,
        aProduct.id,
      ]);

      const otherOrder = await createOrder(testServer, 'LO-C-3002', otherProduct.id);
      const aOrder = await createOrder(testServer, 'LO-C-3003', aProduct.id);

      // Remove the other product from the allowlist after the intent exists.
      replaceApplicationProducts(
        testServer.database.db,
        application.id,
        [product.id, aProduct.id],
        application.version,
        'test-actor',
      );

      const unauthorized = await issueVoucher(testServer, otherOrder.id, VALID_BODY);
      expect(unauthorized.status).toBe(403);
      expect(parseError(await unauthorized.json()).error).toBe('PRODUCT_NOT_AUTHORIZED');

      const wrongMode = await issueVoucher(testServer, aOrder.id, VALID_BODY);
      expect(wrongMode.status).toBe(409);
      expect(parseError(await wrongMode.json()).error).toBe('ORDER_MODE_UNSUPPORTED');

      expect(vendor.calls).toHaveLength(0);
      expect(voucherRow(testServer, aOrder.id)).toBeUndefined();
      expect(voucherRow(testServer, otherOrder.id)).toBeUndefined();

      // Missing master key fails closed before the signed POST.
      const cProduct = seedProduct(testServer, 'YM-NOKEY-C');
      activateMapping(testServer, cProduct.id, { mode: 'C', productCode: 'YM-PACK-C' });
      replaceApplicationProducts(
        testServer.database.db,
        application.id,
        [product.id, aProduct.id, cProduct.id],
        application.version + 1,
        'test-actor',
      );
      const cOrder = await createOrder(testServer, 'LO-C-3004', cProduct.id);
      testServer.config.supplierMasterKey = null;
      const keyless = await issueVoucher(testServer, cOrder.id, VALID_BODY);
      expect(keyless.status).toBe(503);
      expect(parseError(await keyless.json()).error).toBe('SUPPLIER_KEY_UNAVAILABLE');
      expect(vendor.calls).toHaveLength(0);
      expect(voucherRow(testServer, cOrder.id)).toBeUndefined();
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);
});

describe('C-mode gift-voucher unknown and rejection semantics', () => {
  it('does not accept impossible quota after a possibly charged C issuance', async () => {
    const vendor = await fixtureVendor();
    vendor.state.packRemaining = 4; // Greater than the declared 3-pack voucher.
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-IMPOSSIBLE-ISSUE', product.id);

      const rejected = await issueVoucher(testServer, order.id, VALID_BODY);
      expect(rejected.status).toBe(502);
      expect(parseError(await rejected.json()).error).toBe('SUPPLIER_RESPONSE_UNVERIFIED');
      expect(voucherRow(testServer, order.id)).toMatchObject({
        state: 'unknown', pack_total: null, pack_remaining: null,
      });
      expect(orderRow(testServer, order.id).status).toBe('unknown');
      const repeated = await issueVoucher(testServer, order.id, VALID_BODY);
      expect(repeated.status).toBe(409);
      expect(parseError(await repeated.json()).error).toBe('GIFT_VOUCHER_OUTCOME_UNKNOWN');
      expect(vendor.issueCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(0);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it.each([
    { label: 'both fields', omitTotal: false, omitRemaining: false, total: 3, remaining: 4 },
    { label: 'remaining only', omitTotal: true, omitRemaining: false, total: 3, remaining: 4 },
    { label: 'total only', omitTotal: false, omitRemaining: true, total: 1, remaining: 2 },
  ])('rejects contradictory C recovery quota ($label) without overwriting verified facts', async ({
    label: _label, omitTotal, omitRemaining, total, remaining,
  }) => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, `LO-C-IMPOSSIBLE-READ-${omitTotal}-${omitRemaining}`, product.id);
      expect((await issueVoucher(testServer, order.id, VALID_BODY)).status).toBe(200);
      const prior = voucherRow(testServer, order.id)!;
      const priorHistory = statusHistory(testServer, order.id);
      vendor.state.packTotal = total;
      vendor.state.packRemaining = remaining;
      vendor.state.omitQueryPackTotal = omitTotal;
      vendor.state.omitQueryPackRemaining = omitRemaining;

      const recovered = await recoverVoucher(testServer, order.id);
      expect(recovered.status).toBe(502);
      expect(parseError(await recovered.json()).error).toBe('SUPPLIER_RESPONSE_UNVERIFIED');
      expect(voucherRow(testServer, order.id)).toMatchObject({
        state: 'issued',
        pack_total: prior.pack_total,
        pack_remaining: prior.pack_remaining,
        last_observed_at: prior.last_observed_at,
      });
      expect(orderRow(testServer, order.id).status).toBe('awaiting_claim');
      expect(statusHistory(testServer, order.id)).toEqual(priorHistory);
      expect(vendor.issueCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(1);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('keeps a malformed success unknown and never re-signs another voucher', async () => {
    const vendor = await fixtureVendor();
    vendor.state.issueMode = 'malformed';
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-4001', product.id);

      const failed = await issueVoucher(testServer, order.id, VALID_BODY);
      expect(failed.status).toBe(502);
      const failedBody = await failed.json();
      expect(parseError(failedBody).error).toBe('SUPPLIER_RESPONSE_UNVERIFIED');
      expect(voucherRow(testServer, order.id)).toMatchObject({ state: 'unknown' });
      expect(orderRow(testServer, order.id).status).toBe('unknown');
      expect(JSON.stringify(failedBody)).not.toContain(VOUCHER_CODE);
      expect(vendor.issueCalls()).toHaveLength(1);

      const repeated = await issueVoucher(testServer, order.id, VALID_BODY);
      expect(repeated.status).toBe(409);
      expect(parseError(await repeated.json()).error).toBe('GIFT_VOUCHER_OUTCOME_UNKNOWN');
      const recovered = await recoverVoucher(testServer, order.id);
      expect(recovered.status).toBe(409);
      expect(parseError(await recovered.json()).error).toBe('GIFT_VOUCHER_OUTCOME_UNKNOWN');
      // No requestId reissue and no code query without a known code.
      expect(vendor.issueCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(0);
      expect(voucherRow(testServer, order.id)).toMatchObject({ state: 'unknown' });
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('records an explicit business rejection as terminal without blind retry', async () => {
    const vendor = await fixtureVendor();
    vendor.state.issueMode = 'business400';
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-4002', product.id);

      const failed = await issueVoucher(testServer, order.id, VALID_BODY);
      expect(failed.status).toBe(502);
      const body = parseError(await failed.json());
      expect(body.error).toBe('SUPPLIER_BUSINESS_FAILED');
      expect(body.vendorCode).toBe(400);
      expect(voucherRow(testServer, order.id)).toMatchObject({ state: 'rejected' });
      expect(orderRow(testServer, order.id).status).toBe('failed');

      const retried = await issueVoucher(testServer, order.id, VALID_BODY);
      expect(retried.status).toBe(409);
      expect(parseError(await retried.json()).error).toBe('GIFT_VOUCHER_NOT_RETRYABLE');
      expect(vendor.issueCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(0);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it.each([
    { issueMode: 'business403' as const, error: 'SUPPLIER_AUTH_FAILED' },
    { issueMode: 'http401' as const, error: 'SUPPLIER_AUTH_FAILED' },
    { issueMode: 'http500' as const, error: 'SUPPLIER_UNAVAILABLE' },
  ])(
    'keeps $issueMode from being reported as a successful issuance',
    async ({ issueMode, error }) => {
      const vendor = await fixtureVendor();
      vendor.state.issueMode = issueMode;
      const testServer = startServer(vendor);
      try {
        const product = seedProduct(testServer, 'YM-VOUCHER-C');
        activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
        registerApplication(testServer, 'local-life', product.id);
        const order = await createOrder(testServer, `LO-C-${issueMode}`, product.id);

        const failed = await issueVoucher(testServer, order.id, VALID_BODY);
        expect(failed.status).toBe(502);
        expect(parseError(await failed.json()).error).toBe(error);
        const expectedState = issueMode === 'http500' ? 'unknown' : 'rejected';
        expect(voucherRow(testServer, order.id)).toMatchObject({ state: expectedState });
        expect(orderRow(testServer, order.id).status).not.toBe('awaiting_claim');
        expect(vendor.issueCalls()).toHaveLength(1);
        expect(vendor.queryCalls()).toHaveLength(0);
      } finally {
        testServer.close();
        await vendor.close();
      }
    },
    20_000,
  );

  it('does not infer a refund or downgrade issuance when the recovery query says 400', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-4003', product.id);
      expect((await issueVoucher(testServer, order.id, VALID_BODY)).status).toBe(200);

      vendor.state.queryMode = 'business400';
      const recovered = await recoverVoucher(testServer, order.id);
      expect(recovered.status).toBe(502);
      expect(parseError(await recovered.json()).error).toBe('SUPPLIER_BUSINESS_FAILED');
      // The issued fact and vendor-observed quota remain; no refund inference.
      expect(voucherRow(testServer, order.id)).toMatchObject({
        state: 'issued',
        pack_total: 3,
        pack_remaining: 2,
      });
      expect(orderRow(testServer, order.id).status).toBe('awaiting_claim');
      expect(vendor.issueCalls()).toHaveLength(1);
      expect(vendor.queryCalls()).toHaveLength(1);
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);

  it('keeps an issued voucher when the recovery read is malformed', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-4004', product.id);
      expect((await issueVoucher(testServer, order.id, VALID_BODY)).status).toBe(200);

      vendor.state.queryMode = 'malformed';
      const recovered = await recoverVoucher(testServer, order.id);
      expect(recovered.status).toBe(502);
      expect(parseError(await recovered.json()).error).toBe('SUPPLIER_RESPONSE_UNVERIFIED');
      expect(voucherRow(testServer, order.id)).toMatchObject({
        state: 'issued',
        pack_remaining: 2,
      });
      expect(orderRow(testServer, order.id).status).toBe('awaiting_claim');
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);
});

describe('C-mode operator visibility', () => {
  it('surfaces issuance state and quota facts without the voucher code or link', async () => {
    const vendor = await fixtureVendor();
    const testServer = startServer(vendor);
    try {
      const product = seedProduct(testServer, 'YM-VOUCHER-C');
      activateMapping(testServer, product.id, { mode: 'C', productCode: 'YM-PACK-C' });
      registerApplication(testServer, 'local-life', product.id);
      const order = await createOrder(testServer, 'LO-C-5001', product.id);
      expect((await issueVoucher(testServer, order.id, VALID_BODY)).status).toBe(200);

      await seedAccount(testServer, { username: 'ops.voucher', role: 'admin' });
      const admin = new TestClient(testServer);
      expect((await admin.login('ops.voucher', TEST_PASSWORD)).status).toBe(200);
      const response = await admin.request(`/api/v1/operations/orders/${order.id}`);
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(raw).not.toContain(VOUCHER_CODE);
      expect(raw).not.toContain(CLAIM_URL);
      expect(raw).not.toContain(PHONE);
      expect(raw).not.toContain('phone_hmac');
      expect(raw).not.toContain('encrypted_voucher');

      const detail = JSON.parse(raw).order;
      expect(detail.fulfillmentMode).toBe('C');
      expect(detail.giftVoucher).toMatchObject({
        state: 'issued',
        packCount: 3,
        packTotal: 3,
        packRemaining: 2,
        lastObservedAt: expect.any(Number),
      });
      expect(detail.giftVoucher.requestId).toMatch(/^bhC[0-9a-f]{60}$/);
      expect(detail.grant).toBeNull();
    } finally {
      testServer.close();
      await vendor.close();
    }
  }, 20_000);
});
