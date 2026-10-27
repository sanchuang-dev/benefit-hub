import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createYangmaoOpenV1Client,
  YangmaoOpenV1Error,
} from '../src/index.js';

const FIXED_NOW = 1793059200000;
const APP_KEY = 'fixture-app-key';
const APP_SECRET = 'test-secret-do-not-use';
const NONCE = 'abc123def456';
const PHONE = '13800138000';
const PURCHASE_CHECK_SIGNATURE =
  '39A5CD69E106D904F7F7E8888AB2427BF1DFDD1F027060D0822AE01CF13B3B58';

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

interface TestVendorServer {
  origin: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Real loopback HTTP server so the default fetch transport is exercised. */
async function startVendorServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestVendorServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(request, response);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

const openServers: TestVendorServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function createClient(origin: string, timeoutMs?: number) {
  return createYangmaoOpenV1Client({
    baseUrl: origin,
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    clock: () => FIXED_NOW,
    nonceFactory: () => NONCE,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

async function captureError(promise: Promise<unknown>): Promise<YangmaoOpenV1Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(YangmaoOpenV1Error);
    return error as YangmaoOpenV1Error;
  }
  throw new Error('Expected the client request to reject');
}

describe('A/B/C purchase-check over a controlled loopback HTTP server', () => {
  it('performs the signed POST end to end with the default fetch transport', async () => {
    const server = await startVendorServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            purchaseRestricted: true,
            giftUnclaimed: false,
            lotteryUnbet: false,
            message: '该手机号 7 天内已领取',
          },
        }),
      );
    });
    openServers.push(server);

    const eligibility = await createClient(server.origin).checkPurchase(PHONE);

    expect(eligibility).toEqual({
      provider: 'yangmao',
      observedAt: new Date(FIXED_NOW).toISOString(),
      purchaseRestricted: true,
      giftUnclaimed: false,
      lotteryUnbet: false,
      message: '该手机号 7 天内已领取',
    });

    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    if (!request) throw new Error('Server did not receive the request');
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/open/v1/prepaid/purchase-check');
    expect(request.headers['x-app-key']).toBe(APP_KEY);
    expect(request.headers['x-timestamp']).toBe(String(FIXED_NOW));
    expect(request.headers['x-nonce']).toBe(NONCE);
    expect(request.headers['x-sign']).toBe(PURCHASE_CHECK_SIGNATURE);
    expect(request.headers['x-signature']).toBeUndefined();
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.body).toBe(JSON.stringify({ phone: PHONE }));
    expect(request.url).not.toContain(PHONE);
  });

  it('aborts a non-responsive vendor request with a timeout error', async () => {
    // The handler intentionally never writes a response.
    const server = await startVendorServer(() => undefined);
    openServers.push(server);

    const error = await captureError(createClient(server.origin, 100).checkPurchase(PHONE));

    expect(error.code).toBe('YANGMAO_OPEN_V1_TIMEOUT');
    expect(server.requests).toHaveLength(1);
  });

  it('does not follow redirects that would replay credentials elsewhere', async () => {
    let followed = 0;
    const server = await startVendorServer((request, response) => {
      if (request.url === '/open/v1/prepaid/purchase-check') {
        response.writeHead(302, { location: '/must-not-be-followed' });
        response.end();
        return;
      }
      followed += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: {} }));
    });
    openServers.push(server);

    const error = await captureError(createClient(server.origin).checkPurchase(PHONE));

    expect(error.code).toBe('YANGMAO_OPEN_V1_HTTP_ERROR');
    expect(error.httpStatus).toBe(302);
    expect(followed).toBe(0);
    expect(server.requests).toHaveLength(1);
  });
});
