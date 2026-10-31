// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  OperationsOrderDetailDto,
  OperationsOrderListItemDto,
  OperationsOrderListResponse,
} from '@sanchuang-dev/benefit-contracts';
import { installDomStubs, renderRoutes } from '../test-utils/render-routes';
import { jsonResponse, mockFetch } from '../test-utils/http';
import { findButtonText, queryParams, writeCalls } from '../test-utils/dom';

const SESSION_EXPIRES_AT = Date.now() + 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 1, 0, 0);

const ADMIN = {
  id: 'account-1',
  username: 'ops.admin',
  displayName: '运维管理员',
  role: 'admin' as const,
};

function sessionResponse(): Response {
  return jsonResponse(200, { admin: ADMIN, session: { expiresAt: SESSION_EXPIRES_AT } });
}

function order(overrides: Partial<OperationsOrderListItemDto> = {}): OperationsOrderListItemDto {
  return {
    id: 'order-1',
    businessSource: 'local-life',
    businessOrderNo: 'LO-1001',
    productId: 'product-1',
    productName: '腾讯出行券 10 元',
    status: 'pending',
    version: 1,
    fulfillmentMode: 'B',
    mappingVersionId: 'mapping-version-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function listResponse(
  orders: OperationsOrderListItemDto[],
  params: URLSearchParams = new URLSearchParams(),
): OperationsOrderListResponse {
  return {
    orders,
    page: Number(params.get('page') ?? '1'),
    pageSize: Number(params.get('pageSize') ?? '20') as 10 | 20 | 50,
    total: orders.length,
  };
}

function detail(overrides: Partial<OperationsOrderDetailDto> = {}): OperationsOrderDetailDto {
  return {
    id: 'order-1',
    businessSource: 'local-life',
    businessOrderNo: 'LO-1001',
    productId: 'product-1',
    status: 'pending',
    version: 1,
    fulfillmentMode: 'B',
    mappingVersionId: 'mapping-version-1',
    createdAt: NOW,
    updatedAt: NOW,
    product: {
      id: 'product-1',
      code: 'TRAVEL-10',
      name: '腾讯出行券 10 元',
      status: 'active',
    },
    frozenMapping: {
      id: 'mapping-version-1',
      mappingId: 'mapping-1',
      versionNumber: 1,
      provider: 'yangmao',
      productCode: 'YM-TRAVEL-B',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
      activatedAt: NOW - 60_000,
    },
    grant: null,
    giftVoucher: null,
    statusEvents: [{ id: 'event-1', status: 'pending', version: 1, createdAt: NOW }],
    attempts: [],
    ...overrides,
  };
}

function listCalls(fetchMock: ReturnType<typeof vi.fn>): URLSearchParams[] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([url]) => url.startsWith('/api/v1/operations/orders?'))
    .map(([url]) => queryParams(url));
}
beforeAll(() => installDomStubs());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('platform order list', () => {
  it('lists persisted orders through server-side filters and never sends write requests', { timeout: 60_000 }, async () => {
    const pending = order();
    const completed = order({
      id: 'order-2',
      businessSource: 'card-doctor',
      businessOrderNo: 'CD-2002',
      productId: 'product-2',
      productName: '咖啡券',
      status: 'completed',
      version: 3,
      fulfillmentMode: 'D',
      mappingVersionId: null,
    });

    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url.startsWith('/api/v1/operations/orders?')) {
        const params = queryParams(url);
        const source = params.get('businessSource');
        const status = params.get('status');
        const matched = [pending, completed].filter((item) => {
          const sourceMatches = !source || item.businessSource === source;
          const statusMatches = !status || item.status === status;
          return sourceMatches && statusMatches;
        });
        return jsonResponse(200, listResponse(matched, params));
      }
      return undefined;
    });

    renderRoutes('/fulfillment');

    expect(await screen.findByText('LO-1001', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('CD-2002')).toBeTruthy();
    expect(screen.getByText('腾讯出行券 10 元')).toBeTruthy();
    expect(screen.getByText('咖啡券')).toBeTruthy();
    expect(screen.getByText('待处理')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('共 2 条')).toBeTruthy();
    // Legacy row exposes the absent frozen mapping instead of guessing a provider.
    expect(screen.getByText('无冻结映射')).toBeTruthy();

    const initialParams = listCalls(fetchMock).at(-1);
    expect(initialParams?.get('page')).toBe('1');
    expect(initialParams?.get('pageSize')).toBe('20');
    expect(initialParams?.get('businessSource')).toBeNull();

    // Refresh issues a real new query instead of reusing a browser-side copy.
    const requestsBeforeRefresh = listCalls(fetchMock).length;
    fireEvent.click(findButtonText('刷新'));
    await waitFor(() => expect(listCalls(fetchMock).length).toBeGreaterThan(requestsBeforeRefresh));

    fireEvent.change(screen.getByLabelText('业务来源'), { target: { value: 'LOCAL-LIFE' } });
    fireEvent.click(findButtonText('查询'));

    await waitFor(() =>
      expect(listCalls(fetchMock).at(-1)?.get('businessSource')).toBe('local-life'),
    );
    await waitFor(() => expect(screen.queryByText('CD-2002')).toBeNull());
    expect(screen.getByText('LO-1001')).toBeTruthy();

    fireEvent.click(findButtonText('重置'));
    await screen.findByText('CD-2002');

    fireEvent.mouseDown(screen.getByLabelText('平台状态'));
    fireEvent.click(await screen.findByTitle('已完成'));
    fireEvent.click(findButtonText('查询'));

    await waitFor(() => expect(listCalls(fetchMock).at(-1)?.get('status')).toBe('completed'));
    await waitFor(() => expect(screen.queryByText('LO-1001')).toBeNull());
    expect(screen.getByText('CD-2002')).toBeTruthy();

    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('distinguishes an empty platform from a filter with no results', { timeout: 60_000 }, async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url.startsWith('/api/v1/operations/orders?')) {
        return jsonResponse(200, listResponse([]));
      }
      return undefined;
    });

    renderRoutes('/fulfillment');

    expect(await screen.findByText(/平台还没有订单/, undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('业务订单号'), { target: { value: 'NOT-FOUND' } });
    fireEvent.click(findButtonText('查询'));

    expect(await screen.findByText('没有符合条件的订单')).toBeTruthy();
    expect(screen.queryByText(/平台还没有订单/)).toBeNull();

    fireEvent.click(findButtonText('清除筛选'));
    expect(await screen.findByText(/平台还没有订单/)).toBeTruthy();
  });

  it('shows a load failure, retries, and distinguishes session expiry from an empty list', { timeout: 60_000 }, async () => {
    let fail = true;
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url.startsWith('/api/v1/operations/orders?')) {
        if (fail) {
          return jsonResponse(500, { error: 'INTERNAL_ERROR', message: '订单查询暂时不可用' });
        }
        return jsonResponse(200, listResponse([order()]));
      }
      return undefined;
    });

    renderRoutes('/fulfillment');

    expect(await screen.findByText('平台订单加载失败', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('订单查询暂时不可用')).toBeTruthy();
    expect(screen.queryByText(/平台还没有订单/)).toBeNull();

    fail = false;
    fireEvent.click(findButtonText('重试'));
    expect(await screen.findByText('LO-1001', undefined, { timeout: 5000 })).toBeTruthy();
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('keeps the page usable and visible when the list API reports an expired session', { timeout: 60_000 }, async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url.startsWith('/api/v1/operations/orders?')) {
        return jsonResponse(401, {
          error: 'SESSION_EXPIRED',
          message: '登录已过期，请重新登录',
        });
      }
      return undefined;
    });

    renderRoutes('/fulfillment');

    expect(await screen.findByText('登录状态已失效', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('请刷新页面并重新登录后再加载订单记录。')).toBeTruthy();
    expect(screen.queryByText(/平台还没有订单/)).toBeNull();
  });
});

describe('platform order detail drawer', () => {
  it('groups local facts, frozen provenance and recorded attempts without inventing results', { timeout: 60_000 }, async () => {
    const detailData = detail({
      status: 'processing',
      version: 2,
      statusEvents: [
        { id: 'event-1', status: 'pending', version: 1, createdAt: NOW },
        { id: 'event-2', status: 'processing', version: 2, createdAt: NOW + 1_000 },
      ],
      attempts: [
        {
          id: 'attempt-1',
          operation: 'query',
          result: 'accepted',
          observedStatus: 'processing',
          upstreamRequestNo: 'REQ-FICTIONAL-1',
          upstreamOrderNo: 'UPSTREAM-FICTIONAL-1',
          occurredAt: NOW + 2_000,
          lastVerifiedAt: NOW + 3_000,
        },
      ],
    });

    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/operations/orders/order-1') {
        return jsonResponse(200, { order: detailData });
      }
      if (url.startsWith('/api/v1/operations/orders?')) {
        return jsonResponse(200, listResponse([order()]));
      }
      return undefined;
    });

    renderRoutes('/fulfillment');
    expect(await screen.findByText('LO-1001', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('查看'));

    expect(await screen.findByText('平台订单详情', undefined, { timeout: 5000 })).toBeTruthy();
    const drawer = await screen.findByRole('dialog');

    expect(within(drawer).getByText('平台订单')).toBeTruthy();
    expect(within(drawer).getByText('履约来源')).toBeTruthy();
    expect(within(drawer).getByText('本地状态与尝试记录')).toBeTruthy();
    expect(within(drawer).getByText(/当前名称，不是下单时的历史快照/)).toBeTruthy();
    expect(within(drawer).getByText('上力（yangmao）')).toBeTruthy();
    expect(within(drawer).getByText('YM-TRAVEL-B')).toBeTruthy();
    expect(within(drawer).getByText('上力（yangmao）模式 B')).toBeTruthy();
    expect(within(drawer).getByText(/下单时冻结的不可变映射快照/)).toBeTruthy();
    expect(within(drawer).getByText('状态查询')).toBeTruthy();
    expect(within(drawer).getByText('供应商已受理')).toBeTruthy();
    expect(within(drawer).getByText('REQ-FICTIONAL-1')).toBeTruthy();
    expect(within(drawer).getByText('UPSTREAM-FICTIONAL-1')).toBeTruthy();
    expect(within(drawer).getByText(/不代表权益已发放到账/)).toBeTruthy();

    // No fabricated supplier-native or financial conclusions.
    for (const fabricated of ['已派发', '已扣额', '已到账', '扣款成功', 'dispatchStatus']) {
      expect(within(drawer).queryByText(fabricated)).toBeNull();
    }
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('lets an admin create A once and then only recover the original requestId', { timeout: 60_000 }, async () => {
    const pendingA = detail({
      fulfillmentMode: 'A',
      status: 'pending',
      frozenMapping: {
        id: 'mapping-version-a-live',
        mappingId: 'mapping-a-live',
        versionNumber: 1,
        provider: 'yangmao',
        productCode: 'YM-PREPAID-A-LIVE',
        fulfillmentMode: 'A',
        deductionUnit: 'pack',
        activatedAt: NOW - 60_000,
      },
      grant: null,
    });
    const acceptedA = detail({
      ...pendingA,
      status: 'awaiting_claim',
      version: 3,
      grant: {
        state: 'accepted',
        requestId: 'bhA0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab',
        upstreamOrderNo: 'PKG-A-FICTIONAL-1',
        attemptedAt: NOW + 1_000,
        updatedAt: NOW + 2_000,
      },
    });
    const claimUrl = 'https://h5.example.test/claim?orderNo=PKG-A-FICTIONAL-1';

    let current = pendingA;
    let grantBody: Record<string, unknown> | null = null;
    let recoverCalls = 0;
    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/auth/csrf') {
        return jsonResponse(200, { csrfToken: 'fictional-csrf-token' });
      }
      if (url === '/api/v1/operations/orders/order-1/prepaid-grant' && init?.method === 'POST') {
        grantBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        current = acceptedA;
        return jsonResponse(200, { order: acceptedA, claimUrl });
      }
      if (
        url === '/api/v1/operations/orders/order-1/prepaid-grant/recover' &&
        init?.method === 'POST'
      ) {
        recoverCalls += 1;
        return jsonResponse(200, { order: acceptedA, claimUrl });
      }
      if (url === '/api/v1/operations/orders/order-1') {
        return jsonResponse(200, { order: current });
      }
      if (url.startsWith('/api/v1/operations/orders?')) {
        return jsonResponse(
          200,
          listResponse([order({ fulfillmentMode: 'A', status: current.status })]),
        );
      }
      return undefined;
    });

    renderRoutes('/fulfillment');
    expect(await screen.findByText('LO-1001', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('查看'));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('上力 A 预充值下单')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: '管理员真实下单一次' })).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: /恢复原领取链接/ })).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([]);

    fireEvent.click(within(drawer).getByRole('button', { name: '管理员真实下单一次' }));
    expect(await screen.findByText('确认上力 A 真实下单')).toBeTruthy();
    expect(writeCalls(fetchMock)).toEqual([]);

    fireEvent.change(screen.getByPlaceholderText('请输入本次真实验收收件手机号'), {
      target: { value: '13800138000' },
    });
    fireEvent.change(screen.getByPlaceholderText('例如 SLD'), {
      target: { value: 'ref_abc123' },
    });
    fireEvent.change(screen.getByPlaceholderText('例如 A-LIVE-ACCEPT-20261031'), {
      target: { value: 'PAY-FICTIONAL-A-1' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '确认真实下单一次' }));

    await waitFor(() => expect(grantBody).not.toBeNull());
    expect(grantBody).toEqual({
      phone: '13800138000',
      refCode: 'ref_abc123',
      paymentReference: 'PAY-FICTIONAL-A-1',
      confirmGrant: true,
    });
    await waitFor(() =>
      expect(within(drawer).queryByRole('button', { name: '管理员真实下单一次' })).toBeNull(),
    );
    expect(await within(drawer).findByRole('button', { name: /恢复原领取链接/ })).toBeTruthy();
    expect(within(drawer).getByText(claimUrl)).toBeTruthy();

    fireEvent.click(within(drawer).getByRole('button', { name: /恢复原领取链接/ }));
    await waitFor(() => expect(recoverCalls).toBe(1));
    expect(within(drawer).getByText(claimUrl)).toBeTruthy();

    expect(writeCalls(fetchMock)).toEqual([
      'POST /api/v1/operations/orders/order-1/prepaid-grant',
      'POST /api/v1/operations/orders/order-1/prepaid-grant/recover',
    ]);
  });

  it('shows the durable A operation identity without persisting or inventing a claim link', { timeout: 60_000 }, async () => {
    const detailData = detail({
      fulfillmentMode: 'A',
      status: 'awaiting_claim',
      version: 3,
      statusEvents: [
        { id: 'event-1', status: 'pending', version: 1, createdAt: NOW },
        { id: 'event-2', status: 'processing', version: 2, createdAt: NOW + 1_000 },
        { id: 'event-3', status: 'awaiting_claim', version: 3, createdAt: NOW + 2_000 },
      ],
      frozenMapping: {
        id: 'mapping-version-1',
        mappingId: 'mapping-1',
        versionNumber: 1,
        provider: 'yangmao',
        productCode: 'YM-PREPAID-A',
        fulfillmentMode: 'A',
        deductionUnit: 'pack',
        activatedAt: NOW - 60_000,
      },
      grant: {
        state: 'accepted',
        requestId: 'bhA0123456789abcdef',
        upstreamOrderNo: 'PKG-FICTIONAL-1',
        attemptedAt: NOW + 1_000,
        updatedAt: NOW + 2_000,
      },
    });

    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/operations/orders/order-1') {
        return jsonResponse(200, { order: detailData });
      }
      if (url.startsWith('/api/v1/operations/orders?')) {
        return jsonResponse(200, listResponse([order()]));
      }
      return undefined;
    });

    renderRoutes('/fulfillment');
    expect(await screen.findByText('LO-1001', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('查看'));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('上力 A 预充值下单')).toBeTruthy();
    expect(within(drawer).getByText('上力已受理（待用户领取）')).toBeTruthy();
    expect(within(drawer).getByText('bhA0123456789abcdef')).toBeTruthy();
    expect(within(drawer).getByText('PKG-FICTIONAL-1')).toBeTruthy();
    expect(within(drawer).getByText(/领取链接不落库/)).toBeTruthy();
    expect(within(drawer).getByText(/不代表用户已领取到账/)).toBeTruthy();
    // No claim URL, phone or supplier payload is present in the operator detail.
    expect(within(drawer).queryByText(/claimUrl=/)).toBeNull();
    expect(within(drawer).queryByText(/13800138000/)).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('shows C voucher issuance state and vendor-observed quota without exposing the code', { timeout: 60_000 }, async () => {
    const detailData = detail({
      fulfillmentMode: 'C',
      status: 'awaiting_claim',
      version: 3,
      statusEvents: [
        { id: 'event-1', status: 'pending', version: 1, createdAt: NOW },
        { id: 'event-2', status: 'processing', version: 2, createdAt: NOW + 1_000 },
        { id: 'event-3', status: 'awaiting_claim', version: 3, createdAt: NOW + 2_000 },
      ],
      frozenMapping: {
        id: 'mapping-version-c',
        mappingId: 'mapping-c',
        versionNumber: 1,
        provider: 'yangmao',
        productCode: 'YM-VOUCHER-C',
        fulfillmentMode: 'C',
        deductionUnit: 'pack',
        activatedAt: NOW - 60_000,
      },
      giftVoucher: {
        state: 'issued',
        requestId: 'bhC0123456789abcdef',
        packCount: 3,
        packTotal: 3,
        packRemaining: 2,
        attemptedAt: NOW + 1_000,
        updatedAt: NOW + 2_000,
        lastObservedAt: NOW + 2_000,
      },
    });

    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/operations/orders/order-1') {
        return jsonResponse(200, { order: detailData });
      }
      if (url.startsWith('/api/v1/operations/orders?')) {
        return jsonResponse(200, listResponse([order({ fulfillmentMode: 'C' })]));
      }
      return undefined;
    });

    renderRoutes('/fulfillment');
    expect(await screen.findByText('LO-1001', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('查看'));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('上力 C 公众号礼包券')).toBeTruthy();
    expect(within(drawer).getByText('上力已签发（待用户领取）')).toBeTruthy();
    expect(within(drawer).getByText('bhC0123456789abcdef')).toBeTruthy();
    // Both the issuance pack count and the vendor-reported total are 3.
    expect(within(drawer).getAllByText('3 个')).toHaveLength(2);
    expect(within(drawer).getByText('2 个')).toBeTruthy();
    expect(within(drawer).getByText(/签发时预扣礼包额度/)).toBeTruthy();
    expect(within(drawer).getByText(/不因券码查询不到或到期而推断额度退回/)).toBeTruthy();
    // The voucher code and claim link are never shown in the operator detail.
    expect(within(drawer).queryByText(/GV-FICTIONAL/)).toBeNull();
    expect(within(drawer).queryByText(/claimUrl=/)).toBeNull();
    expect(within(drawer).queryByText(/13800138000/)).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('shows the B partial snapshots and requires explicit admin form confirmation for reissue', { timeout: 60_000 }, async () => {
    const partial = detail({
      status: 'partially_completed',
      fulfillmentMode: 'B',
      directTopup: {
        state: 'partial',
        requestId: 'bhBf1f1f1f1f1f1',
        upstreamOrderNo: 'PKG-B-FICTIONAL-1',
        successCount: 1,
        totalCount: 2,
        items: [{ claimed: true, status: 'completed' }, { claimed: false, status: 'failed' }],
        observations: [{
          operation: 'grant',
          upstreamOrderNo: 'PKG-B-FICTIONAL-1',
          successCount: 1,
          totalCount: 2,
          items: [{ claimed: true, status: 'completed' }, { claimed: false, status: 'failed' }],
          observedAt: NOW,
        }],
        lastVerifiedAt: NOW,
        attemptedAt: NOW,
        updatedAt: NOW,
      },
    });
    const completed = detail({
      ...partial,
      status: 'completed',
      directTopup: {
        ...partial.directTopup!,
        state: 'completed',
        successCount: 2,
        items: [{ claimed: true, status: 'completed' }, { claimed: true, status: 'completed' }],
      },
    });
    let current = partial;
    let confirmedPostBody: Record<string, unknown> | null = null;
    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'fictional-csrf-token' });
      if (url === '/api/v1/operations/orders/order-1/direct-topup/reissue' && init?.method === 'POST') {
        confirmedPostBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        current = completed;
        return jsonResponse(200, { order: completed });
      }
      if (url === '/api/v1/operations/orders/order-1') return jsonResponse(200, { order: current });
      if (url.startsWith('/api/v1/operations/orders?')) return jsonResponse(200, listResponse([order({ status: 'partially_completed' })]));
      return undefined;
    });
    renderRoutes('/fulfillment');
    expect(await screen.findByText('LO-1001', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('查看'));
    expect(await screen.findByText('原单逐次观察记录', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('PKG-B-FICTIONAL-1')).toBeTruthy();
    expect(writeCalls(fetchMock)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /管理员受控补发/ }));
    expect(await screen.findByText('确认 B 模式原单受控补发')).toBeTruthy();
    // Opening the dialog is not a supplier write.
    expect(writeCalls(fetchMock)).toEqual([]);
    fireEvent.change(screen.getByPlaceholderText('需与原订单完全一致'), {
      target: { value: '13800138000' },
    });
    fireEvent.change(screen.getByPlaceholderText('原推广编码'), {
      target: { value: 'ref_abc123' },
    });
    fireEvent.change(screen.getByPlaceholderText('原支付或授权凭据号'), {
      target: { value: 'PAY-FICTIONAL-B-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认按原 requestId 补发' }));
    await waitFor(() => expect(confirmedPostBody).not.toBeNull());
    expect(confirmedPostBody).toEqual({
      phone: '13800138000', refCode: 'ref_abc123',
      paymentReference: 'PAY-FICTIONAL-B-1', confirmReissue: true,
    });
    expect(writeCalls(fetchMock)).toEqual([
      'POST /api/v1/operations/orders/order-1/direct-topup/reissue',
    ]);
  });

  it('hides the B reissue control for a viewer even when the order is partial', { timeout: 60_000 }, async () => {
    const partial = detail({
      status: 'partially_completed',
      directTopup: {
        state: 'partial', requestId: 'bhBf1f1f1f1f1f1', upstreamOrderNo: 'PKG-B-FICTIONAL-1',
        successCount: 1, totalCount: 2, items: [{ claimed: true }, { claimed: false }],
        observations: [], lastVerifiedAt: NOW, attemptedAt: NOW, updatedAt: NOW,
      },
    });
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') {
        return jsonResponse(200, {
          admin: { ...ADMIN, role: 'viewer' }, session: { expiresAt: SESSION_EXPIRES_AT },
        });
      }
      if (url === '/api/v1/operations/orders/order-1') return jsonResponse(200, { order: partial });
      if (url.startsWith('/api/v1/operations/orders?')) return jsonResponse(200, listResponse([order({ status: 'partially_completed' })]));
      return undefined;
    });
    renderRoutes('/fulfillment');
    expect(await screen.findByText('LO-1001', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('查看'));
    expect(await screen.findByText('上力 B · 纯腾讯出行礼包直充')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /管理员受控补发/ })).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('lets an admin dispatch D exactly once and then exposes only original-order query', { timeout: 60_000 }, async () => {
    const pendingD = detail({
      fulfillmentMode: 'D',
      status: 'pending',
      frozenMapping: {
        id: 'mapping-version-d-live',
        mappingId: 'mapping-d-live',
        versionNumber: 1,
        provider: 'yangmao',
        productCode: 'INRICE-D-LIVE-FICTIONAL',
        fulfillmentMode: 'D',
        deductionUnit: 'amount',
        activatedAt: NOW - 60_000,
      },
      dispatch: null,
    });
    const acceptedD = detail({
      ...pendingD,
      status: 'processing',
      version: 2,
      dispatch: {
        state: 'accepted',
        partnerOrderNo: 'bhD0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab',
        upstreamOrderNo: null,
        providerStatus: null,
        lastVerifiedAt: NOW + 1_000,
        attemptedAt: NOW + 1_000,
        updatedAt: NOW + 1_000,
      },
    });
    const recoveredD = detail({
      ...acceptedD,
      dispatch: {
        ...acceptedD.dispatch!,
        upstreamOrderNo: 'D-UPSTREAM-FICTIONAL-1',
        providerStatus: 'RECEIVE',
        lastVerifiedAt: NOW + 3_000,
        updatedAt: NOW + 3_000,
      },
    });

    let current = pendingD;
    let dispatchBody: Record<string, unknown> | null = null;
    let recoverCalls = 0;
    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'fictional-csrf-token' });
      if (url === '/api/v1/operations/orders/order-1/dispatch' && init?.method === 'POST') {
        dispatchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        current = acceptedD;
        return jsonResponse(200, { order: acceptedD });
      }
      if (url === '/api/v1/operations/orders/order-1/dispatch/recover' && init?.method === 'POST') {
        recoverCalls += 1;
        current = recoveredD;
        return jsonResponse(200, { order: recoveredD });
      }
      if (url === '/api/v1/operations/orders/order-1') return jsonResponse(200, { order: current });
      if (url.startsWith('/api/v1/operations/orders?')) {
        return jsonResponse(200, listResponse([order({ fulfillmentMode: 'D', status: current.status })]));
      }
      return undefined;
    });

    renderRoutes('/fulfillment');
    expect(await screen.findByText('LO-1001', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('查看'));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('上力 D · 权益商品派发')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: '管理员真实派发一次' })).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: /查原单/ })).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([]);

    fireEvent.click(within(drawer).getByRole('button', { name: '管理员真实派发一次' }));
    expect(await screen.findByText('确认上力 D 真实派发')).toBeTruthy();
    expect(writeCalls(fetchMock)).toEqual([]);

    fireEvent.change(screen.getByPlaceholderText('请输入本次真实验收收件手机号'), {
      target: { value: '13800138000' },
    });
    fireEvent.change(screen.getByPlaceholderText('例如 D-LIVE-ACCEPT-20261031'), {
      target: { value: 'PAY-FICTIONAL-D-1' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '确认真实派发一次' }));

    await waitFor(() => expect(dispatchBody).not.toBeNull());
    expect(dispatchBody).toEqual({
      mobile: '13800138000',
      paymentReference: 'PAY-FICTIONAL-D-1',
      confirmDispatch: true,
    });
    await waitFor(() =>
      expect(within(drawer).queryByRole('button', { name: '管理员真实派发一次' })).toBeNull(),
    );
    expect(await within(drawer).findByRole('button', { name: /查原单/ })).toBeTruthy();

    fireEvent.click(within(drawer).getByRole('button', { name: /查原单/ }));
    await waitFor(() => expect(recoverCalls).toBe(1));
    expect(await within(drawer).findByText('RECEIVE')).toBeTruthy();

    expect(writeCalls(fetchMock)).toEqual([
      'POST /api/v1/operations/orders/order-1/dispatch',
      'POST /api/v1/operations/orders/order-1/dispatch/recover',
    ]);
  });

  it('shows D dispatch progress without exposing recipient payment or fulfillment secrets', { timeout: 60_000 }, async () => {
    const detailData = detail({
      fulfillmentMode: 'D',
      status: 'processing',
      frozenMapping: {
        id: 'mapping-version-d',
        mappingId: 'mapping-d',
        versionNumber: 1,
        provider: 'yangmao',
        productCode: 'INRICE-D-FICTIONAL',
        fulfillmentMode: 'D',
        deductionUnit: 'amount',
        activatedAt: NOW - 60_000,
      },
      dispatch: {
        state: 'accepted',
        partnerOrderNo: 'bhD0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab',
        upstreamOrderNo: 'D-UPSTREAM-FICTIONAL-1',
        providerStatus: 'RECEIVE',
        lastVerifiedAt: NOW + 3_000,
        attemptedAt: NOW + 1_000,
        updatedAt: NOW + 3_000,
      },
      attempts: [
        {
          id: 'attempt-d-1',
          operation: 'query',
          result: 'accepted',
          observedStatus: 'processing',
          upstreamRequestNo: 'bhD0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab',
          upstreamOrderNo: 'D-UPSTREAM-FICTIONAL-1',
          occurredAt: NOW + 3_000,
          lastVerifiedAt: NOW + 3_000,
        },
      ],
    });

    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/operations/orders/order-1') {
        return jsonResponse(200, { order: detailData });
      }
      if (url.startsWith('/api/v1/operations/orders?')) {
        return jsonResponse(200, listResponse([order({ fulfillmentMode: 'D', status: 'processing' })]));
      }
      return undefined;
    });

    renderRoutes('/fulfillment');
    expect(await screen.findByText('LO-1001', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('查看'));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('上力 D · 权益商品派发')).toBeTruthy();
    expect(within(drawer).getByText('供应商已受理，继续核实履约状态')).toBeTruthy();
    expect(within(drawer).getAllByText('D-UPSTREAM-FICTIONAL-1').length).toBeGreaterThanOrEqual(2);
    expect(within(drawer).getByText('RECEIVE')).toBeTruthy();
    expect(within(drawer).getByText(/RECEIVE 等供应商状态只按原值展示/)).toBeTruthy();

    for (const secret of [
      '13800138000',
      'PAY-FICTIONAL-D-1',
      'SECRET-FULFILLMENT-MUST-NOT-LEAK',
      '已到账',
    ]) {
      expect(within(drawer).queryByText(secret)).toBeNull();
    }
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('shows a legacy order as no frozen mapping and states the absence of local attempt records', { timeout: 60_000 }, async () => {
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/operations/orders/order-1') {
        return jsonResponse(200, {
          order: detail({ mappingVersionId: null, frozenMapping: null }),
        });
      }
      if (url.startsWith('/api/v1/operations/orders?')) {
        return jsonResponse(200, listResponse([order({ mappingVersionId: null })]));
      }
      return undefined;
    });

    renderRoutes('/fulfillment');
    expect(await screen.findByText('LO-1001', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('查看'));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('无冻结映射（历史订单）')).toBeTruthy();
    expect(within(drawer).getByText('平台暂无供应商调用记录')).toBeTruthy();
    expect(within(drawer).getByText(/不代表供应商一定未处理/)).toBeTruthy();
    expect(within(drawer).queryByText(/上力/)).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('shows a detail load failure with retry instead of an empty-looking order', { timeout: 60_000 }, async () => {
    let fail = true;
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/operations/orders/order-1') {
        if (fail) {
          return jsonResponse(404, { error: 'ORDER_NOT_FOUND', message: '订单不存在' });
        }
        return jsonResponse(200, { order: detail() });
      }
      if (url.startsWith('/api/v1/operations/orders?')) {
        return jsonResponse(200, listResponse([order()]));
      }
      return undefined;
    });

    renderRoutes('/fulfillment');
    expect(await screen.findByText('LO-1001', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('查看'));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('订单不存在')).toBeTruthy();
    expect(within(drawer).getByText('没有找到该平台订单，可能已被移除或链接不正确。')).toBeTruthy();

    fail = false;
    fireEvent.click(within(drawer).getByRole('button', { name: /重\s*试/ }));
    expect(await within(drawer).findByText('平台订单', undefined, { timeout: 5000 })).toBeTruthy();
    expect(writeCalls(fetchMock)).toEqual([]);
  });
});
