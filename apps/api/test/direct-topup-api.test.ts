import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBusinessOrderResponseSchema,
  directTopupResponseSchema,
  operationsOrderDetailResponseSchema,
} from '@sanchuang-dev/benefit-contracts';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createApplication, replaceApplicationProducts } from '../src/modules/applications/applications.js';
import { createProduct } from '../src/modules/catalog/products.js';
import { createSupplierMappingRepository } from '../src/modules/catalog/supplier-mapping-repository.js';
import { createDirectTopupRepository } from '../src/modules/orders/b-direct-topup-repository.js';
import { TestServer, TestClient, seedAccount, TEST_PASSWORD } from './helpers/test-server.js';

/** Fictional fixture only: no real provider keys, numbers, or quota writes. */
const SOURCE_TOKEN = 'fictional-b-mode-machine-token-0000000001';
const OTHER_TOKEN = 'fictional-b-mode-other-token-00000000002';
const PHONE = '13800138000';
const REF_CODE = 'ref_abc123';
const PAYMENT_REFERENCE = 'PAY-FICTIONAL-B-1';
const PRODUCT_CODE = 'YM-FICTIONAL-PURE-TRAVEL';
const ORIGIN = '/api/v1/business/orders';
const KEY = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');
const AUTHORISED_BODY = { phone: PHONE, refCode: REF_CODE, paymentReference: PAYMENT_REFERENCE };

let app: TestServer | undefined;
afterEach(() => { app?.close(); app = undefined; });

type ResponseMode = 'completed' | 'partial' | 'partial-short' | 'malformed' | 'http500' | 'business400' | 'delayed';
interface Call { path: string; method: string; body: string; signature?: string; dSignature?: string }
async function mockVendor() {
  const state: {
    mode: ResponseMode;
    eligible: boolean;
    orderNo: string;
    onCheck?: () => void;
  } = { mode: 'completed', eligible: true, orderNo: 'PKG-MOCK-B-1' };
  const calls: Call[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({
        path: req.url ?? '', method: req.method ?? '', body,
        signature: req.headers['x-sign'] as string | undefined,
        dSignature: req.headers['x-signature'] as string | undefined,
      });
      const reply = (status: number, payload: unknown) => {
        if (res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/open/v1/prepaid/purchase-check') {
        state.onCheck?.();
        reply(200, {
          code: 0, data: {
            purchaseRestricted: !state.eligible,
            giftUnclaimed: false, lotteryUnbet: false,
          },
        });
        return;
      }
      if (req.url === '/open/v1/prepaid/direct-topup') {
        if (state.mode === 'http500') return reply(500, { error: 'fictional upstream failure' });
        if (state.mode === 'business400') return reply(200, { code: 400, data: null });
        if (state.mode === 'malformed') return reply(200, { code: 0, data: { orderNo: state.orderNo } });
        if (state.mode === 'delayed') {
          setTimeout(() => reply(200, { code: 0, data: {
            orderNo: state.orderNo, allClaimed: true, successCount: 2, totalCount: 2,
            items: [{ claimed: true }, { claimed: true }],
          } }), 180);
          return;
        }
        const partial = state.mode === 'partial' || state.mode === 'partial-short';
        reply(200, { code: 0, data: {
          orderNo: state.orderNo, allClaimed: !partial,
          successCount: partial ? 1 : 2, totalCount: 2,
          items: state.mode === 'partial-short'
            ? [{ claimed: false, status: 'failed', message: 'NEW-SENSITIVE-ERROR' }]
            : partial
              ? [{ claimed: true, status: 'completed', cardKey: 'NEVER-STORE-THIS' },
                { claimed: false, status: 'failed', message: 'SENSITIVE-NEVER-STORE' }]
              : [{ claimed: true, status: 'completed' }, { claimed: true, status: 'completed' }],
          balanceAfter: 99, idempotentReplay: !partial,
        } });
        return;
      }
      reply(404, { code: 404 });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    state, calls,
    origin: 'http://127.0.0.1:' + address.port,
    writes: () => calls.filter((x) => x.path === '/open/v1/prepaid/direct-topup'),
    reads: () => calls.filter((x) => x.path === '/open/v1/prepaid/purchase-check'),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

type MockVendor = Awaited<ReturnType<typeof mockVendor>>;
function startServer(vendor: MockVendor, config: Partial<AppConfig> = {}) {
  const server = new TestServer({
    businessOrderClients: loadConfig({
      DATABASE_FILE: ':memory:',
      BENEFIT_ORDER_CLIENTS_JSON: JSON.stringify({
        'local-life': SOURCE_TOKEN, 'card-doctor': OTHER_TOKEN,
      }),
    }).businessOrderClients,
    yangmaoInrice: {
      baseUrl: vendor.origin, appKey: 'fictional-app-key', appSecret: 'fictional-app-secret',
    },
    supplierMasterKey: KEY,
    bLiveWritesEnabled: true,
    verifiedBTravelProducts: { [PRODUCT_CODE]: 'fixture-vendor-confirmation-B-01' },
    ...config,
  });
  app = server;
  return server;
}
function seedOrder(server: TestServer, mode: 'A' | 'B' = 'B') {
  const product = createProduct(server.database.db, {
    code: 'MOCK-TRAVEL', name: 'Fictional B travel pack', actorAccountId: 'test-actor',
  });
  const repo = createSupplierMappingRepository(server.database.db);
  const saved = repo.saveDraft({
    productId: product.id, expectedVersion: null, provider: 'yangmao',
    productCode: PRODUCT_CODE, fulfillmentMode: mode, deductionUnit: 'pack',
  });
  repo.validateDraft({ productId: product.id, expectedVersion: saved.version });
  repo.activateDraft({
    productId: product.id, expectedVersion: saved.version, actorAccountId: 'test-actor',
  });
  const application = createApplication(server.database.db, {
    businessSource: 'local-life', name: 'Local fixture', actorAccountId: 'test-actor',
  });
  replaceApplicationProducts(
    server.database.db, application.id, [product.id], application.version, 'test-actor',
  );
  return product.id;
}
function bearer(token: string) {
  return { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
}
async function order(server: TestServer, productId: string) {
  const response = await server.app.request(ORIGIN, {
    method: 'POST', headers: bearer(SOURCE_TOKEN),
    body: JSON.stringify({ businessOrderNo: 'B-ORDER-FICTIONAL-1', productId }),
  });
  expect(response.status).toBe(201);
  return createBusinessOrderResponseSchema.parse(await response.json()).order;
}
async function issue(server: TestServer, id: string, body: unknown = AUTHORISED_BODY,
  token = SOURCE_TOKEN) {
  return server.app.request(ORIGIN + '/' + id + '/direct-topup', {
    method: 'POST', headers: bearer(token), body: JSON.stringify(body),
  });
}
async function reissue(server: TestServer, id: string, body: unknown = {
  ...AUTHORISED_BODY, confirmReissue: true,
}) {
  return server.app.request(ORIGIN + '/' + id + '/direct-topup/reissue', {
    method: 'POST', headers: bearer(SOURCE_TOKEN), body: JSON.stringify(body),
  });
}
async function detail(server: TestServer, id: string) {
  await seedAccount(server, { username: 'operator.b.test', role: 'admin' });
  const admin = new TestClient(server);
  expect((await admin.login('operator.b.test', TEST_PASSWORD)).status).toBe(200);
  return admin;
}

describe('B-mode direct topup Hono → mock supplier (never real quota)', () => {
  it('authorizes and signs one pack debit, persists completion and never repeats it', async () => {
    const vendor = await mockVendor(); const server = startServer(vendor);
    try {
      const id = (await order(server, seedOrder(server))).id;
      const result = await issue(server, id);
      expect(result.status).toBe(200);
      const dto = directTopupResponseSchema.parse(await result.json());
      expect(dto.order.status).toBe('completed');
      expect(dto.topup).toMatchObject({
        state: 'completed', successCount: 2, totalCount: 2,
        upstreamOrderNo: 'PKG-MOCK-B-1',
      });
      expect(dto.topup.requestId).toMatch(/^bhB[0-9a-f]{60}$/);
      expect(dto).not.toHaveProperty('claimUrl');
      expect(vendor.reads()).toHaveLength(1);
      expect(vendor.writes()).toHaveLength(1);
      expect(vendor.writes()[0]).toMatchObject({ method: 'POST', dSignature: undefined });
      expect(vendor.writes()[0]?.signature).toMatch(/^[A-F0-9]{64}$/);
      expect(JSON.parse(vendor.writes()[0]!.body)).toMatchObject({
        phone: PHONE, refCode: REF_CODE, productCode: PRODUCT_CODE,
        requestId: dto.topup.requestId,
      });
      server.restart();
      const repeated = await issue(server, id);
      expect(repeated.status).toBe(200);
      expect(directTopupResponseSchema.parse(await repeated.json()).topup.state).toBe('completed');
      expect(vendor.writes()).toHaveLength(1);
      const operator = await detail(server, id);
      const response = await operator.request('/api/v1/operations/orders/' + id);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain(PAYMENT_REFERENCE);
      const parsed = operationsOrderDetailResponseSchema.parse(JSON.parse(text));
      expect(parsed.order.directTopup?.state).toBe('completed');
      expect(parsed.order.directTopup?.successCount).toBe(2);
    } finally { server.close(); await vendor.close(); }
  }, 20_000);

  it('allows manual original-key reissue only for verified partial, and never leaks item secrets', async () => {
    const vendor = await mockVendor(); vendor.state.mode = 'partial';
    const server = startServer(vendor);
    try {
      const id = (await order(server, seedOrder(server))).id;
      const partial = await issue(server, id);
      expect(partial.status).toBe(200);
      const first = directTopupResponseSchema.parse(await partial.json());
      expect(first.order.status).toBe('partially_completed');
      expect(first.topup).toMatchObject({ state: 'partial', successCount: 1, totalCount: 2 });
      expect(JSON.stringify(first)).not.toContain('SENSITIVE-NEVER-STORE');
      expect(JSON.stringify(first)).not.toContain('NEVER-STORE-THIS');
      const repo = createDirectTopupRepository(server.database.db);
      expect(repo.get(id)?.state).toBe('partial');
      expect(repo.get(id)?.items).toHaveLength(2);
      // The first partial grant may leave a real unclaimed benefit. Reissue
      // is the SAME supplier purchase, not a second purchase-check.
      vendor.state.eligible = false;
      vendor.state.mode = 'completed';
      const reissued = await reissue(server, id);
      expect(reissued.status).toBe(200);
      const complete = directTopupResponseSchema.parse(await reissued.json());
      expect(complete.order.status).toBe('completed');
      expect(complete.topup.state).toBe('completed');
      expect(vendor.writes()).toHaveLength(2);
      expect(vendor.reads()).toHaveLength(1);
      expect(JSON.parse(vendor.writes()[0]!.body).requestId)
        .toBe(JSON.parse(vendor.writes()[1]!.body).requestId);
      expect((await reissue(server, id)).status).toBe(409);
      expect(vendor.writes()).toHaveLength(2);
    } finally { server.close(); await vendor.close(); }
  }, 20_000);

  it('keeps all earlier successful item evidence when reissue returns only one failing item', async () => {
    const vendor = await mockVendor(); vendor.state.mode = 'partial';
    const server = startServer(vendor);
    try {
      const id = (await order(server, seedOrder(server))).id;
      expect((await issue(server, id)).status).toBe(200);
      const original = createDirectTopupRepository(server.database.db).get(id)!;
      expect(original.observations).toHaveLength(1);
      expect(original.observations[0]?.items[0]?.claimed).toBe(true);
      vendor.state.mode = 'partial-short';
      const repeated = await reissue(server, id);
      expect(repeated.status).toBe(200);
      const body = directTopupResponseSchema.parse(await repeated.json());
      expect(body.order.status).toBe('partially_completed');
      expect(body.topup.observations).toHaveLength(2);
      expect(body.topup.observations[0]?.items[0]?.claimed).toBe(true);
      expect(body.topup.observations[1]?.items).toEqual([
        { claimed: false, status: 'failed' },
      ]);
      expect(JSON.stringify(body)).not.toContain('NEW-SENSITIVE-ERROR');
      expect(vendor.writes()).toHaveLength(2);
      const first = JSON.parse(vendor.writes()[0]!.body) as { requestId: string };
      const second = JSON.parse(vendor.writes()[1]!.body) as { requestId: string };
      expect(first.requestId).toBe(second.requestId);
      server.restart();
      const recovered = createDirectTopupRepository(server.database.db).get(id)!;
      expect(recovered.observations).toHaveLength(2);
      expect(recovered.observations[0]?.items[0]?.claimed).toBe(true);
      expect(recovered.upstreamOrderNo).toBe('PKG-MOCK-B-1');
      const operator = await detail(server, id);
      const response = await operator.request('/api/v1/operations/orders/' + id);
      const parsed = operationsOrderDetailResponseSchema.parse(await response.json());
      expect(parsed.order.directTopup?.observations).toHaveLength(2);
      expect(parsed.order.directTopup?.observations[0]?.items[0]?.claimed).toBe(true);
    } finally { server.close(); await vendor.close(); }
  }, 20_000);

  it('serializes concurrent initial debits and concurrent partial reissues', async () => {
    const vendor = await mockVendor(); vendor.state.mode = 'delayed';
    const server = startServer(vendor);
    try {
      const id = (await order(server, seedOrder(server))).id;
      const attempts = await Promise.all([issue(server, id), issue(server, id)]);
      expect(attempts.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(vendor.writes()).toHaveLength(1);
      expect(createDirectTopupRepository(server.database.db).get(id)?.state).toBe('completed');
    } finally { server.close(); await vendor.close(); }
  }, 20_000);

  it('serializes simultaneous original-key retries on a partially completed order', async () => {
    const vendor = await mockVendor(); vendor.state.mode = 'partial';
    const server = startServer(vendor);
    try {
      const id = (await order(server, seedOrder(server))).id;
      expect((await issue(server, id)).status).toBe(200);
      vendor.state.mode = 'delayed';
      const attempts = await Promise.all([reissue(server, id), reissue(server, id)]);
      expect(attempts.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(vendor.writes()).toHaveLength(2);
      expect(createDirectTopupRepository(server.database.db).get(id)?.state).toBe('completed');
      const first = JSON.parse(vendor.writes()[0]!.body) as { requestId: string };
      const second = JSON.parse(vendor.writes()[1]!.body) as { requestId: string };
      expect(first.requestId).toBe(second.requestId);
    } finally { server.close(); await vendor.close(); }
  }, 20_000);

  it('blocks unauthenticated, viewer-role and CSRF-less admin reissue without vendor writes', async () => {
    const vendor = await mockVendor(); vendor.state.mode = 'partial';
    const server = startServer(vendor);
    try {
      const id = (await order(server, seedOrder(server))).id;
      expect((await issue(server, id)).status).toBe(200);
      const path = '/api/v1/operations/orders/' + id + '/direct-topup/reissue';
      expect((await server.app.request(path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...AUTHORISED_BODY, confirmReissue: true }),
      })).status).not.toBe(200);
      await seedAccount(server, { username: 'b.viewer.test', role: 'viewer' });
      const viewer = new TestClient(server);
      expect((await viewer.login('b.viewer.test', TEST_PASSWORD)).status).toBe(200);
      expect((await viewer.post(path, { ...AUTHORISED_BODY, confirmReissue: true })).status).toBe(403);
      const admin = await detail(server, id);
      expect((await admin.request(path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...AUTHORISED_BODY, confirmReissue: true }),
      })).status).not.toBe(200);
      expect(vendor.writes()).toHaveLength(1);
      vendor.state.mode = 'completed';
      const success = await admin.post(path, { ...AUTHORISED_BODY, confirmReissue: true });
      expect(success.status).toBe(200);
      expect(operationsOrderDetailResponseSchema.parse(await success.json()).order.status)
        .toBe('completed');
      expect(vendor.writes()).toHaveLength(2);
    } finally { server.close(); await vendor.close(); }
  }, 20_000);

  it('preserves the unknown state after a potentially billed malformed response; no blind retry', async () => {
    const vendor = await mockVendor(); vendor.state.mode = 'malformed';
    const server = startServer(vendor);
    try {
      const id = (await order(server, seedOrder(server))).id;
      const failed = await issue(server, id);
      expect(failed.status).toBe(502);
      const topup = createDirectTopupRepository(server.database.db).get(id);
      expect(topup).toMatchObject({ state: 'unknown', upstreamOrderNo: null });
      expect((await issue(server, id)).status).toBe(409);
      expect((await reissue(server, id)).status).toBe(409);
      expect(vendor.writes()).toHaveLength(1);
    } finally { server.close(); await vendor.close(); }
  }, 20_000);

  it('treats an HTTP 500 after a possibly charged B write as unknown and never auto-resends', async () => {
    const vendor = await mockVendor(); vendor.state.mode = 'http500';
    const server = startServer(vendor);
    try {
      const id = (await order(server, seedOrder(server))).id;
      const result = await issue(server, id);
      expect(result.status).toBe(502);
      expect(createDirectTopupRepository(server.database.db).get(id)?.state).toBe('unknown');
      server.restart();
      expect((await issue(server, id)).status).toBe(409);
      expect((await reissue(server, id)).status).toBe(409);
      expect(vendor.writes()).toHaveLength(1);
    } finally { server.close(); await vendor.close(); }
  }, 20_000);

  it('rejects missing product verification, disabled write and ineligible recipients before any write', async () => {
    const vendor = await mockVendor();
    const server = startServer(vendor, {
      bLiveWritesEnabled: false,
      verifiedBTravelProducts: {},
    });
    try {
      const id = (await order(server, seedOrder(server))).id;
      expect((await issue(server, id)).status).toBe(503);
      expect(vendor.writes()).toHaveLength(0);
      server.config.bLiveWritesEnabled = true;
      expect((await issue(server, id)).status).toBe(409);
      expect(vendor.writes()).toHaveLength(0);
      server.config.verifiedBTravelProducts = { [PRODUCT_CODE]: 'fixture-vendor-confirmation-B-01' };
      vendor.state.eligible = false;
      expect((await issue(server, id)).status).toBe(409);
      expect(vendor.writes()).toHaveLength(0);
      expect(createDirectTopupRepository(server.database.db).get(id)).toBeNull();
    } finally { server.close(); await vendor.close(); }
  }, 20_000);

  it('rejects other business source and incomplete reissue confirmation', async () => {
    const vendor = await mockVendor(); const server = startServer(vendor);
    try {
      const id = (await order(server, seedOrder(server))).id;
      expect((await issue(server, id, AUTHORISED_BODY, OTHER_TOKEN)).status).toBe(404);
      expect((await reissue(server, id, AUTHORISED_BODY)).status).toBe(400);
      expect(vendor.writes()).toHaveLength(0);
    } finally { server.close(); await vendor.close(); }
  }, 20_000);
});
