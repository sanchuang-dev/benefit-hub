import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBusinessOrderResponseSchema,
  dDispatchResponseSchema,
  operationsOrderDetailResponseSchema,
} from '@sanchuang-dev/benefit-contracts';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { createApplication, replaceApplicationProducts } from '../../src/modules/applications/applications.js';
import { createProduct } from '../../src/modules/catalog/products.js';
import { createSupplierMappingRepository } from '../../src/modules/catalog/supplier-mapping-repository.js';
import {
  seedAccount,
  TestClient,
  TestServer,
  TEST_PASSWORD,
} from '../helpers/test-server.js';

const SOURCE_TOKEN = 'fictional-d-machine-token-000000000000001';
const OTHER_TOKEN = 'fictional-d-other-token-0000000000000002';
const MOBILE = '13800138000';
const PAYMENT_REFERENCE = 'PAY-FICTIONAL-D-1';
const PRODUCT_CODE = 'INRICE-FICTIONAL-D-1';
const ORIGIN = '/api/v1/business/orders';
const MASTER_KEY = Buffer.from(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  'hex',
);

type DispatchMode = 'success' | 'delayed' | 'http500' | 'business400';
type QueryMode = 'success' | 'not-found';

interface VendorCall {
  path: string;
  method: string;
  body: string;
  dSignature?: string;
  abcSignature?: string;
}

async function mockVendor() {
  const calls: VendorCall[] = [];
  const state: { dispatchMode: DispatchMode; queryMode: QueryMode } = {
    dispatchMode: 'success',
    queryMode: 'success',
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({
        path: req.url ?? '',
        method: req.method ?? '',
        body,
        dSignature: req.headers['x-signature'] as string | undefined,
        abcSignature: req.headers['x-sign'] as string | undefined,
      });
      const reply = (status: number, payload: unknown) => {
        if (res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'POST' && req.url === '/api/open/inrice/v1/dispatch') {
        if (state.dispatchMode === 'http500') {
          reply(500, { code: 500, message: 'fictional failure' });
          return;
        }
        if (state.dispatchMode === 'business400') {
          reply(200, { code: 400, message: 'fictional rejected', data: null });
          return;
        }
        if (state.dispatchMode === 'delayed') {
          setTimeout(() => reply(200, { code: 0, message: 'success', data: {} }), 180);
          return;
        }
        reply(200, { code: 0, message: 'success', data: {} });
        return;
      }

      if (
        req.method === 'GET' &&
        req.url?.startsWith('/api/open/inrice/v1/orders/query?')
      ) {
        if (state.queryMode === 'not-found') {
          reply(200, { code: 400, message: '订单不存在', data: null });
          return;
        }
        const url = new URL(req.url, 'http://127.0.0.1');
        const partnerOrderNo = url.searchParams.get('partnerOrderNo');
        reply(200, {
          code: 0,
          message: 'success',
          data: {
            orderNo: 'D-UPSTREAM-FICTIONAL-1',
            partnerOrderNo,
            dispatchStatus: 'RECEIVE',
            fulfillmentSummary: {
              cardKey: 'SECRET-FULFILLMENT-MUST-NOT-LEAK',
            },
          },
        });
        return;
      }

      reply(404, { code: 404, message: 'fixture route missing' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    state,
    calls,
    origin: `http://127.0.0.1:${port}`,
    writes: () => calls.filter((call) => call.path === '/api/open/inrice/v1/dispatch'),
    reads: () => calls.filter((call) => call.path.startsWith('/api/open/inrice/v1/orders/query?')),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

type MockVendor = Awaited<ReturnType<typeof mockVendor>>;
let app: TestServer | undefined;

afterEach(() => {
  app?.close();
  app = undefined;
});

function startServer(vendor: MockVendor, overrides: Partial<AppConfig> = {}) {
  const base = loadConfig({
    DATABASE_FILE: ':memory:',
    BENEFIT_ORDER_CLIENTS_JSON: JSON.stringify({
      'local-life': SOURCE_TOKEN,
      'card-doctor': OTHER_TOKEN,
    }),
  });
  const server = new TestServer({
    businessOrderClients: base.businessOrderClients,
    yangmaoInrice: {
      baseUrl: vendor.origin,
      appKey: 'fictional-d-app-key',
      appSecret: 'fictional-d-app-secret',
    },
    supplierMasterKey: MASTER_KEY,
    dLiveWritesEnabled: true,
    ...overrides,
  });
  app = server;
  return server;
}

function seedDProduct(server: TestServer) {
  const product = createProduct(server.database.db, {
    code: 'MOCK-D-BENEFIT',
    name: 'Fictional D benefit',
    actorAccountId: 'test-actor',
  });
  const mappings = createSupplierMappingRepository(server.database.db);
  const saved = mappings.saveDraft({
    productId: product.id,
    expectedVersion: null,
    provider: 'yangmao',
    productCode: PRODUCT_CODE,
    fulfillmentMode: 'D',
    deductionUnit: 'amount',
  });
  mappings.validateDraft({ productId: product.id, expectedVersion: saved.version });
  mappings.activateDraft({
    productId: product.id,
    expectedVersion: saved.version,
    actorAccountId: 'test-actor',
  });

  const application = createApplication(server.database.db, {
    businessSource: 'local-life',
    name: 'Local D fixture',
    actorAccountId: 'test-actor',
  });
  replaceApplicationProducts(
    server.database.db,
    application.id,
    [product.id],
    application.version,
    'test-actor',
  );
  return product.id;
}

function bearer(token = SOURCE_TOKEN) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

async function createOrder(server: TestServer, productId: string) {
  const response = await server.app.request(ORIGIN, {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({
      businessOrderNo: 'D-ORDER-FICTIONAL-1',
      productId,
    }),
  });
  expect(response.status).toBe(201);
  return createBusinessOrderResponseSchema.parse(await response.json()).order;
}

async function dispatch(
  server: TestServer,
  orderId: string,
  body: unknown = { mobile: MOBILE, paymentReference: PAYMENT_REFERENCE },
  token = SOURCE_TOKEN,
) {
  return server.app.request(`${ORIGIN}/${orderId}/dispatch`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify(body),
  });
}

async function recover(server: TestServer, orderId: string, token = SOURCE_TOKEN) {
  return server.app.request(`${ORIGIN}/${orderId}/dispatch/recover`, {
    method: 'POST',
    headers: bearer(token),
    body: '{}',
  });
}

function dispatchRow(server: TestServer, orderId: string) {
  return server.database.sqlite
    .prepare(`
      SELECT
        state,
        partner_order_no AS partnerOrderNo,
        phone_hmac AS phoneHmac,
        payment_reference AS paymentReference,
        upstream_order_no AS upstreamOrderNo,
        provider_status AS providerStatus,
        last_verified_at AS lastVerifiedAt
      FROM benefit_order_dispatches
      WHERE order_id = ?
    `)
    .get(orderId) as
    | {
        state: string;
        partnerOrderNo: string;
        phoneHmac: string;
        paymentReference: string;
        upstreamOrderNo: string | null;
        providerStatus: string | null;
        lastVerifiedAt: number | null;
      }
    | undefined;
}

describe('D-mode dispatch Hono → mock supplier (never real balance)', () => {
  it('submits once, then recovers the same order without leaking fulfillment material', async () => {
    const vendor = await mockVendor();
    const server = startServer(vendor);
    try {
      const order = await createOrder(server, seedDProduct(server));

      const firstResponse = await dispatch(server, order.id);
      expect(firstResponse.status).toBe(200);
      const firstText = await firstResponse.text();
      expect(firstText).not.toContain(MOBILE);
      expect(firstText).not.toContain(PAYMENT_REFERENCE);
      const first = dDispatchResponseSchema.parse(JSON.parse(firstText));
      expect(first.order.status).toBe('processing');
      expect(first.dispatch.state).toBe('accepted');
      expect(first.dispatch.partnerOrderNo).toMatch(/^bhD[0-9a-f]{60}$/);
      expect(first.dispatch.providerStatus).toBeNull();
      expect(vendor.writes()).toHaveLength(1);
      expect(vendor.reads()).toHaveLength(0);

      const write = vendor.writes()[0]!;
      expect(write.method).toBe('POST');
      expect(write.dSignature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(write.abcSignature).toBeUndefined();
      expect(JSON.parse(write.body)).toEqual({
        partnerOrderNo: first.dispatch.partnerOrderNo,
        productCode: PRODUCT_CODE,
        mobile: MOBILE,
      });
      expect(write.body).not.toContain(PAYMENT_REFERENCE);

      const repeated = await dispatch(server, order.id);
      expect(repeated.status).toBe(200);
      const repeatedText = await repeated.text();
      expect(repeatedText).not.toContain('SECRET-FULFILLMENT-MUST-NOT-LEAK');
      const recovered = dDispatchResponseSchema.parse(JSON.parse(repeatedText));
      expect(recovered.dispatch.state).toBe('accepted');
      expect(recovered.dispatch.partnerOrderNo).toBe(first.dispatch.partnerOrderNo);
      expect(recovered.dispatch.upstreamOrderNo).toBe('D-UPSTREAM-FICTIONAL-1');
      expect(recovered.dispatch.providerStatus).toBe('RECEIVE');
      // RECEIVE remains provider evidence only until its terminal meaning is
      // established by live acceptance; platform completion is not invented.
      expect(recovered.order.status).toBe('processing');
      expect(vendor.writes()).toHaveLength(1);
      expect(vendor.reads()).toHaveLength(1);

      const row = dispatchRow(server, order.id)!;
      expect(row.state).toBe('accepted');
      expect(row.providerStatus).toBe('RECEIVE');
      expect(row.phoneHmac).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(MOBILE);
      expect(JSON.stringify(row)).not.toContain('SECRET-FULFILLMENT-MUST-NOT-LEAK');

      await seedAccount(server, { username: 'operator.d.test', role: 'admin' });
      const operator = new TestClient(server);
      expect((await operator.login('operator.d.test', TEST_PASSWORD)).status).toBe(200);
      const detailResponse = await operator.request(
        `/api/v1/operations/orders/${order.id}`,
      );
      expect(detailResponse.status).toBe(200);
      const detailText = await detailResponse.text();
      expect(detailText).not.toContain(MOBILE);
      expect(detailText).not.toContain(PAYMENT_REFERENCE);
      expect(detailText).not.toContain('SECRET-FULFILLMENT-MUST-NOT-LEAK');
      const detail = operationsOrderDetailResponseSchema.parse(JSON.parse(detailText));
      expect(detail.order.dispatch).toMatchObject({
        state: 'accepted',
        partnerOrderNo: first.dispatch.partnerOrderNo,
        upstreamOrderNo: 'D-UPSTREAM-FICTIONAL-1',
        providerStatus: 'RECEIVE',
      });
    } finally {
      server.close();
      await vendor.close();
    }
  }, 20_000);

  it('serializes concurrent initial dispatches so only one supplier POST can debit', async () => {
    const vendor = await mockVendor();
    vendor.state.dispatchMode = 'delayed';
    const server = startServer(vendor);
    try {
      const order = await createOrder(server, seedDProduct(server));
      const responses = await Promise.all([
        dispatch(server, order.id),
        dispatch(server, order.id),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(vendor.writes()).toHaveLength(1);
      expect(vendor.reads()).toHaveLength(0);
      expect(dispatchRow(server, order.id)?.state).toBe('accepted');
    } finally {
      server.close();
      await vendor.close();
    }
  }, 20_000);

  it('keeps HTTP 500 as unknown and recovers by GET without a second debit', async () => {
    const vendor = await mockVendor();
    vendor.state.dispatchMode = 'http500';
    const server = startServer(vendor);
    try {
      const order = await createOrder(server, seedDProduct(server));
      const failed = await dispatch(server, order.id);
      expect(failed.status).toBe(502);
      expect(dispatchRow(server, order.id)?.state).toBe('unknown');
      expect(vendor.writes()).toHaveLength(1);

      vendor.state.dispatchMode = 'success';
      const recoveredResponse = await recover(server, order.id);
      expect(recoveredResponse.status).toBe(200);
      const recovered = dDispatchResponseSchema.parse(await recoveredResponse.json());
      expect(recovered.dispatch.state).toBe('accepted');
      expect(recovered.dispatch.providerStatus).toBe('RECEIVE');
      expect(recovered.order.status).toBe('processing');
      expect(vendor.writes()).toHaveLength(1);
      expect(vendor.reads()).toHaveLength(1);
    } finally {
      server.close();
      await vendor.close();
    }
  }, 20_000);

  it('persists an explicit supplier business rejection and never retries it', async () => {
    const vendor = await mockVendor();
    vendor.state.dispatchMode = 'business400';
    const server = startServer(vendor);
    try {
      const order = await createOrder(server, seedDProduct(server));
      const rejected = await dispatch(server, order.id);
      expect(rejected.status).toBe(502);
      expect(dispatchRow(server, order.id)?.state).toBe('rejected');
      expect(vendor.writes()).toHaveLength(1);

      expect((await dispatch(server, order.id)).status).toBe(409);
      expect((await recover(server, order.id)).status).toBe(409);
      expect(vendor.writes()).toHaveLength(1);
      expect(vendor.reads()).toHaveLength(0);
    } finally {
      server.close();
      await vendor.close();
    }
  }, 20_000);

  it('fails closed when live writes are disabled and never reserves a billable operation', async () => {
    const vendor = await mockVendor();
    const server = startServer(vendor, { dLiveWritesEnabled: false });
    try {
      const order = await createOrder(server, seedDProduct(server));
      const response = await dispatch(server, order.id);
      expect(response.status).toBe(503);
      expect(vendor.calls).toHaveLength(0);
      expect(dispatchRow(server, order.id)).toBeUndefined();
      const local = server.database.sqlite
        .prepare('SELECT status FROM benefit_orders WHERE id = ?')
        .get(order.id) as { status: string };
      expect(local.status).toBe('pending');
    } finally {
      server.close();
      await vendor.close();
    }
  }, 20_000);

  it('allows only an authenticated admin with explicit confirmation to perform one D write, then only queries the same order', async () => {
    const vendor = await mockVendor();
    const server = startServer(vendor);
    try {
      const order = await createOrder(server, seedDProduct(server));

      await seedAccount(server, { username: 'ops.admin.d', role: 'admin' });
      await seedAccount(server, { username: 'ops.viewer.d', role: 'viewer' });
      const admin = new TestClient(server);
      const viewer = new TestClient(server);
      expect((await admin.login('ops.admin.d', TEST_PASSWORD)).status).toBe(200);
      expect((await viewer.login('ops.viewer.d', TEST_PASSWORD)).status).toBe(200);

      const viewerDenied = await viewer.post(
        `/api/v1/operations/orders/${order.id}/dispatch`,
        { mobile: MOBILE, paymentReference: PAYMENT_REFERENCE, confirmDispatch: true },
      );
      expect(viewerDenied.status).toBe(403);
      expect(vendor.calls).toHaveLength(0);

      const noConfirm = await admin.post(
        `/api/v1/operations/orders/${order.id}/dispatch`,
        { mobile: MOBILE, paymentReference: PAYMENT_REFERENCE },
      );
      expect(noConfirm.status).toBe(400);
      expect(vendor.calls).toHaveLength(0);

      const acceptedResponse = await admin.post(
        `/api/v1/operations/orders/${order.id}/dispatch`,
        { mobile: MOBILE, paymentReference: PAYMENT_REFERENCE, confirmDispatch: true },
      );
      expect(acceptedResponse.status).toBe(200);
      const accepted = operationsOrderDetailResponseSchema.parse(await acceptedResponse.json());
      expect(accepted.order.dispatch?.state).toBe('accepted');
      expect(accepted.order.status).toBe('processing');
      expect(vendor.writes()).toHaveLength(1);
      expect(vendor.reads()).toHaveLength(0);

      const recoveredResponse = await admin.post(
        `/api/v1/operations/orders/${order.id}/dispatch/recover`,
        {},
      );
      expect(recoveredResponse.status).toBe(200);
      const recovered = operationsOrderDetailResponseSchema.parse(await recoveredResponse.json());
      expect(recovered.order.dispatch).toMatchObject({
        state: 'accepted',
        upstreamOrderNo: 'D-UPSTREAM-FICTIONAL-1',
        providerStatus: 'RECEIVE',
      });
      expect(recovered.order.status).toBe('processing');
      expect(vendor.writes()).toHaveLength(1);
      expect(vendor.reads()).toHaveLength(1);
    } finally {
      server.close();
      await vendor.close();
    }
  }, 20_000);

  it('rejects caller-controlled supplier fields and cross-tenant access before any vendor call', async () => {
    const vendor = await mockVendor();
    const server = startServer(vendor);
    try {
      const order = await createOrder(server, seedDProduct(server));
      const injected = await dispatch(server, order.id, {
        mobile: MOBILE,
        paymentReference: PAYMENT_REFERENCE,
        partnerOrderNo: 'ATTACKER-ORDER',
        productCode: 'ATTACKER-PRODUCT',
      });
      expect(injected.status).toBe(400);
      expect(vendor.calls).toHaveLength(0);

      const foreign = await dispatch(
        server,
        order.id,
        { mobile: MOBILE, paymentReference: PAYMENT_REFERENCE },
        OTHER_TOKEN,
      );
      expect(foreign.status).toBe(404);
      expect(vendor.calls).toHaveLength(0);

      const anonymous = await server.app.request(`${ORIGIN}/${order.id}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mobile: MOBILE, paymentReference: PAYMENT_REFERENCE }),
      });
      expect(anonymous.status).toBe(401);
      expect(vendor.calls).toHaveLength(0);
    } finally {
      server.close();
      await vendor.close();
    }
  }, 20_000);
});
