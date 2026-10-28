// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  ApplicationCredential,
  ApplicationDetailResponse,
  ApplicationListResponse,
  ApplicationProduct,
  BusinessApplication,
} from '../features/applications/api';
import type { CatalogProduct } from '../features/catalog/api';
import { installDomStubs, renderRoutes } from '../test-utils/render-routes';

const NOW = Date.UTC(2026, 9, 28, 4, 0, 0);
const SESSION_EXPIRES_AT = NOW + 60 * 60 * 1000;

const ADMIN = {
  id: 'account-1',
  username: 'ops.admin',
  displayName: '运维管理员',
  role: 'admin' as const,
};

const VIEWER = {
  id: 'account-2',
  username: 'read.only',
  displayName: '只读观察员',
  role: 'viewer' as const,
};

type SessionUser = typeof ADMIN | typeof VIEWER;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sessionResponse(admin: SessionUser): Response {
  return jsonResponse(200, { admin, session: { expiresAt: SESSION_EXPIRES_AT } });
}

function application(
  overrides: Partial<BusinessApplication> & Pick<BusinessApplication, 'id' | 'businessSource' | 'name'>,
): BusinessApplication {
  return {
    note: '',
    status: 'enabled',
    version: 1,
    configuredProductCount: 0,
    activeCredentialCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function listResponse(
  applications: BusinessApplication[],
  page = 1,
  pageSize = 20,
): Response {
  const body: ApplicationListResponse = {
    applications,
    page,
    pageSize,
    total: applications.length,
    runtimeAuthorizationEnforced: true,
  };
  return jsonResponse(200, body);
}

function product(id: string, code: string, status: 'active' | 'disabled' = 'active'): CatalogProduct {
  return {
    id,
    code,
    name: `内部商品 ${code}`,
    shortDescription: '',
    status,
    displayPriceCents: null,
    estimatedCostCents: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function configured(
  productId: string,
  code: string,
  status: 'active' | 'disabled' = 'active',
): ApplicationProduct {
  return { productId, code, name: `内部商品 ${code}`, status, configuredAt: NOW };
}

function productListResponse(products: CatalogProduct[]): Response {
  return jsonResponse(200, { products, page: 1, pageSize: 10, total: products.length });
}

function detailResponse(
  app: BusinessApplication,
  products: ApplicationProduct[],
  credentials: ApplicationCredential[] = [],
): Response {
  const body: ApplicationDetailResponse = {
    application: {
      ...app,
      configuredProductCount: products.length,
      activeCredentialCount: credentials.filter((item) => item.status === 'active').length,
    },
    products,
    credentials,
    runtimeAuthorizationEnforced: true,
  };
  return jsonResponse(200, body);
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const response = await handler(url, init);
    if (!response) throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function findButtonText(text: string): HTMLElement {
  const element = screen.getByText((content) => content.replace(/\s/g, '') === text);
  const button = element.closest('button');
  if (!button) throw new Error(`No button containing ${text}`);
  return button;
}

async function findButtonTextAsync(text: string, timeout = 5000): Promise<HTMLElement> {
  const element = await screen.findByText(
    (content) => content.replace(/\s/g, '') === text,
    undefined,
    { timeout },
  );
  const button = element.closest('button');
  if (!button) throw new Error(`No button containing ${text}`);
  return button;
}

function queryParams(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams;
}

function writeCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([, init]) => (init?.method ?? 'GET') !== 'GET')
    .map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
}

function checkboxInRow(code: string): HTMLElement {
  const row = screen
    .queryAllByRole('row')
    .find((candidate) => within(candidate).queryByText(code));
  if (!row) throw new Error(`No row for ${code}`);
  return within(row).getByRole('checkbox');
}

beforeAll(() => installDomStubs());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('downstream application list', () => {
  it('lists real registered applications, marks runtime authorization unbound, and filters on the server', { timeout: 60_000 }, async () => {
    const localLife = application({
      id: 'app-1',
      businessSource: 'local-life',
      name: '本地生活',
      configuredProductCount: 2,
    });
    const doctor = application({
      id: 'app-2',
      businessSource: 'card-doctor',
      name: '卡博士',
      status: 'disabled',
    });
    const listRequests: URLSearchParams[] = [];

    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/applications?')) {
        const params = queryParams(url);
        listRequests.push(params);
        const keyword = params.get('keyword');
        const status = params.get('status');
        const matched = [localLife, doctor].filter((item) => {
          const matchesKeyword =
            !keyword || item.name.includes(keyword) || item.businessSource.includes(keyword);
          const matchesStatus = !status || item.status === status;
          return matchesKeyword && matchesStatus;
        });
        return listResponse(matched);
      }
      return undefined;
    });

    renderRoutes('/applications');

    expect(await screen.findByText('本地生活', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('local-life')).toBeTruthy();
    expect(screen.getByText('card-doctor')).toBeTruthy();
    expect(screen.getByText('2 个')).toBeTruthy();
    expect(screen.getByText('未签发有效凭证')).toBeTruthy();
    expect(screen.getByText('已停用 · 机器调用被拒')).toBeTruthy();
    expect(
      screen.getByText('运行时授权已生效：应用启停、凭证状态与商品授权都会约束真实机器调用。'),
    ).toBeTruthy();
    expect(screen.queryByText('运行时鉴权未接入')).toBeNull();

    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '本地' } });
    fireEvent.click(findButtonText('查询'));
    await waitFor(() =>
      expect(listRequests.some((params) => params.get('keyword') === '本地')).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('卡博士')).toBeNull());
    expect(screen.getByText('本地生活')).toBeTruthy();

    fireEvent.click(findButtonText('重置'));
    await screen.findByText('卡博士');
    fireEvent.mouseDown(screen.getByLabelText('配置状态'));
    fireEvent.click(await screen.findByTitle('已停用'));
    fireEvent.click(findButtonText('查询'));

    await waitFor(() =>
      expect(listRequests.some((params) => params.get('status') === 'disabled')).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('本地生活')).toBeNull());
    expect(screen.getByText('卡博士')).toBeTruthy();
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('shows a load failure with retry instead of pretending the registry is empty', { timeout: 60_000 }, async () => {
    let fail = true;
    const localLife = application({
      id: 'app-1',
      businessSource: 'local-life',
      name: '本地生活',
    });

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/applications?')) {
        if (fail) return jsonResponse(500, { error: 'INTERNAL_ERROR', message: '应用服务暂时不可用' });
        return listResponse([localLife]);
      }
      return undefined;
    });

    renderRoutes('/applications');

    expect(await screen.findByText('应用列表加载失败', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('应用服务暂时不可用')).toBeTruthy();
    expect(screen.queryByText('还没有登记的下游应用')).toBeNull();

    fail = false;
    fireEvent.click(findButtonText('重试'));
    expect(await screen.findByText('本地生活', undefined, { timeout: 5000 })).toBeTruthy();
  });

  it('distinguishes an expired session from a generic load failure', { timeout: 60_000 }, async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/applications?')) {
        return jsonResponse(401, { error: 'SESSION_EXPIRED', message: '登录已过期，请重新登录' });
      }
      return undefined;
    });

    renderRoutes('/applications');

    expect(await screen.findByText('登录状态已失效', undefined, { timeout: 5000 })).toBeTruthy();
    expect(
      screen.getByText('请刷新页面并重新登录后再加载应用配置。'),
    ).toBeTruthy();
    expect(screen.queryByText('还没有登记的下游应用')).toBeNull();
  });

  it('keeps a viewer read-only and sends no write requests', { timeout: 60_000 }, async () => {
    const localLife = application({
      id: 'app-1',
      businessSource: 'local-life',
      name: '本地生活',
      configuredProductCount: 1,
    });

    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(VIEWER);
      if (url === '/api/v1/applications/app-1') {
        return detailResponse(localLife, [configured('p-1', 'APP-A')]);
      }
      if (url.startsWith('/api/v1/applications?')) return listResponse([localLife]);
      return undefined;
    });

    renderRoutes('/applications');

    expect(await screen.findByText('本地生活', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('当前为只读身份')).toBeTruthy();
    expect((findButtonText('登记应用') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('编辑')).toBeNull();

    fireEvent.click(findButtonText('查看'));
    expect(await screen.findByText('下游应用详情', undefined, { timeout: 5000 })).toBeTruthy();
    expect(
      screen.getByText(
        '只读身份可以查看应用、商品授权与凭证状态，但不能保存、启停、签发或撤销凭证；服务端同时拒绝越权写入。',
      ),
    ).toBeTruthy();
    expect((screen.getByLabelText('应用名称') as HTMLInputElement).disabled).toBe(true);
    expect(await screen.findByText('APP-A')).toBeTruthy();
    expect(screen.getByText('尚未签发服务凭证')).toBeTruthy();
    expect(screen.queryByText((content) => content.replace(/\s/g, '') === '保存')).toBeNull();
    expect(screen.queryByText('停用应用')).toBeNull();
    expect(screen.queryByText('签发新凭证')).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([]);
  });
});

describe('application writes', () => {
  it('registers an application through the API and hands off to product configuration', { timeout: 60_000 }, async () => {
    let postedBody: Record<string, unknown> | null = null;
    const created = application({
      id: 'app-new',
      businessSource: 'local-life',
      name: '本地生活',
      note: '首期接入',
    });

    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/applications' && init?.method === 'POST') {
        postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse(201, { application: created });
      }
      if (url === '/api/v1/applications') return listResponse([]);
      if (url.startsWith('/api/v1/applications?')) return listResponse([]);
      if (url === '/api/v1/applications/app-new') return detailResponse(created, []);
      if (url.startsWith('/api/v1/catalog/products?')) return productListResponse([]);
      return undefined;
    });

    renderRoutes('/applications');
    expect(
      await screen.findByText('还没有登记的下游应用', undefined, { timeout: 5000 }),
    ).toBeTruthy();

    fireEvent.click(findButtonText('登记应用'));
    expect(await screen.findByText('登记下游应用', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(findButtonText('保存'));
    expect(await screen.findByText('请输入应用来源标识')).toBeTruthy();
    expect(writeCalls(fetchMock)).toEqual([]);

    fireEvent.change(screen.getByLabelText('应用来源标识'), { target: { value: 'Local-Life' } });
    expect((screen.getByLabelText('应用来源标识') as HTMLInputElement).value).toBe('local-life');
    fireEvent.change(screen.getByLabelText('应用名称'), { target: { value: '本地生活' } });
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '首期接入' } });
    fireEvent.click(findButtonText('保存'));

    expect(
      await screen.findByText('应用已登记；尚未生成服务凭证', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(postedBody).toEqual({
      businessSource: 'local-life',
      name: '本地生活',
      note: '首期接入',
    });
    const postCall = (fetchMock.mock.calls as [string, RequestInit][]).find(
      ([url, init]) => url === '/api/v1/applications' && init.method === 'POST',
    );
    if (!postCall) throw new Error('expected a create request');
    expect((postCall[1].headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token');

    // The drawer stays open on the new application so products can be assigned.
    expect(await screen.findByText('编辑下游应用', undefined, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByText('已选 0 个内部商品')).toBeTruthy();
  });

  it('keeps a duplicate source editable instead of locking the create drawer', { timeout: 60_000 }, async () => {
    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/applications' && init?.method === 'POST') {
        return jsonResponse(409, {
          error: 'APPLICATION_SOURCE_CONFLICT',
          message: '应用来源标识已存在',
        });
      }
      if (url === '/api/v1/applications') return listResponse([]);
      if (url.startsWith('/api/v1/applications?')) return listResponse([]);
      return undefined;
    });

    renderRoutes('/applications');
    expect(await screen.findByText('还没有登记的下游应用', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('登记应用'));
    fireEvent.change(await screen.findByLabelText('应用来源标识'), {
      target: { value: 'dup-source' },
    });
    fireEvent.change(screen.getByLabelText('应用名称'), { target: { value: '重复应用' } });
    fireEvent.click(findButtonText('保存'));

    expect(await screen.findByText('应用来源标识已存在', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('应用配置已被他人修改')).toBeNull();
    expect((screen.getByLabelText('应用来源标识') as HTMLInputElement).value).toBe('dup-source');
    expect((findButtonText('保存') as HTMLButtonElement).disabled).toBe(false);
  });

  it('assigns real internal products through a bounded server-backed picker', { timeout: 60_000 }, async () => {
    const localLife = application({
      id: 'app-1',
      businessSource: 'local-life',
      name: '本地生活',
      configuredProductCount: 1,
    });
    const products = [
      product('p-a', 'APP-A'),
      product('p-b', 'APP-B'),
      product('p-off', 'APP-OFF', 'disabled'),
    ];
    const catalogRequests: URLSearchParams[] = [];
    let savedBody: Record<string, unknown> | null = null;
    let saved = false;

    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/applications/app-1') {
        return saved
          ? detailResponse(
              { ...localLife, version: 2, configuredProductCount: 2 },
              [configured('p-a', 'APP-A'), configured('p-b', 'APP-B')],
            )
          : detailResponse(localLife, [configured('p-a', 'APP-A')]);
      }
      if (url === '/api/v1/applications/app-1/products' && init?.method === 'PUT') {
        savedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        saved = true;
        return detailResponse(
          { ...localLife, version: 2, configuredProductCount: 2 },
          [configured('p-a', 'APP-A'), configured('p-b', 'APP-B')],
        );
      }
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        catalogRequests.push(params);
        const keyword = params.get('keyword');
        return productListResponse(
          products.filter((item) => !keyword || item.code.includes(keyword.toUpperCase())),
        );
      }
      if (url.startsWith('/api/v1/applications?')) return listResponse([localLife]);
      return undefined;
    });

    renderRoutes('/applications');
    expect(await screen.findByText('本地生活', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('编辑'));

    expect(await screen.findByText('已选 1 个内部商品', undefined, { timeout: 5000 })).toBeTruthy();
    await screen.findByText('APP-B');
    expect((checkboxInRow('APP-OFF') as HTMLInputElement).disabled).toBe(true);
    expect((checkboxInRow('APP-B') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(checkboxInRow('APP-B'));
    expect(await screen.findByText('已选 2 个内部商品')).toBeTruthy();
    fireEvent.click(findButtonText('保存'));

    expect(
      await screen.findByText('应用配置已保存；已启用的应用将按商品授权校验机器调用', undefined, {
        timeout: 5000,
      }),
    ).toBeTruthy();
    expect(savedBody).toEqual({ version: 1, productIds: ['p-a', 'p-b'] });
    expect(catalogRequests.length).toBeGreaterThan(0);
    expect(catalogRequests.every((params) => Number(params.get('pageSize')) <= 10)).toBe(true);
  });

  it('issues a one-time secret in the browser without persisting it, then revokes it', {
    timeout: 60_000,
  }, async () => {
    const localLife = application({
      id: 'app-1',
      businessSource: 'local-life',
      name: '本地生活',
    });
    const SECRET = 'bhk_fictional-once-only-secret-000000000001';
    let credentials: ApplicationCredential[] = [];

    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/applications/app-1') return detailResponse(localLife, [], credentials);
      if (url === '/api/v1/applications/app-1/credentials' && init?.method === 'POST') {
        credentials = [{ id: 'cred-1', status: 'active', issuedAt: NOW, revokedAt: null }];
        return jsonResponse(201, { credential: credentials[0], secret: SECRET });
      }
      if (
        url === '/api/v1/applications/app-1/credentials/cred-1/revoke' &&
        init?.method === 'POST'
      ) {
        credentials = [
          { id: 'cred-1', status: 'revoked', issuedAt: NOW, revokedAt: NOW + 1000 },
        ];
        return jsonResponse(200, { credential: credentials[0] });
      }
      if (url.startsWith('/api/v1/catalog/products?')) return productListResponse([]);
      if (url.startsWith('/api/v1/applications?')) return listResponse([localLife]);
      return undefined;
    });

    renderRoutes('/applications');
    expect(await screen.findByText('本地生活', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('编辑'));
    expect(await screen.findByText('尚未签发服务凭证', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(findButtonText('签发新凭证'));
    expect(
      await screen.findByText('服务凭证（仅显示一次）', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.getByText(SECRET)).toBeTruthy();
    expect(
      screen.getByText('请立即保存到调用方的服务器端配置'),
    ).toBeTruthy();

    // The raw secret must not be persisted anywhere in the browser.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain(SECRET);
    const requestUrls = (fetchMock.mock.calls as [string, RequestInit | undefined][]).map(
      ([url]) => url,
    );
    expect(requestUrls.every((url) => !url.includes(SECRET))).toBe(true);

    // Closing the one-time view removes the secret from the DOM.
    fireEvent.click(findButtonText('我已保存'));
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());
    expect(screen.queryByText('服务凭证（仅显示一次）')).toBeNull();
    expect(await screen.findByText('有效')).toBeTruthy();

    // Revocation is a real version-free write and updates the visible state.
    fireEvent.click(findButtonText('撤销'));
    fireEvent.click(await findButtonTextAsync('确认撤销'));
    expect(
      await screen.findByText('服务凭证已撤销；后续调用将被拒绝', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(await screen.findByText('已撤销')).toBeTruthy();
    expect(screen.queryByText('撤销')).toBeNull();
  });

  it('toggles persisted status from the list without claiming a credential change', { timeout: 60_000 }, async () => {
    let current = application({
      id: 'app-1',
      businessSource: 'local-life',
      name: '本地生活',
    });
    let statusBody: Record<string, unknown> | null = null;

    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/applications/app-1/disable' && init?.method === 'POST') {
        statusBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        current = { ...current, status: 'disabled', version: 2 };
        return jsonResponse(200, { application: current });
      }
      if (url.startsWith('/api/v1/applications?')) return listResponse([current]);
      return undefined;
    });

    renderRoutes('/applications');
    expect(await screen.findByText('本地生活', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('已启用')).toBeTruthy();

    fireEvent.click(findButtonText('停用'));
    fireEvent.click(await findButtonTextAsync('确认'));

    expect(
      await screen.findByText(
        '应用已停用；该来源的机器调用立即被拒绝（订单与配置保留）',
        undefined,
        { timeout: 5000 },
      ),
    ).toBeTruthy();
    expect(statusBody).toEqual({ version: 1 });
    await waitFor(() => expect(screen.getByText('已停用')).toBeTruthy());
    expect(screen.queryByText('调用权限已生效')).toBeNull();
  });

  it('confirms before discarding unsaved application edits', { timeout: 60_000 }, async () => {
    const localLife = application({
      id: 'app-1',
      businessSource: 'local-life',
      name: '本地生活',
    });
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/applications/app-1') return detailResponse(localLife, []);
      if (url.startsWith('/api/v1/catalog/products?')) return productListResponse([]);
      if (url.startsWith('/api/v1/applications?')) return listResponse([localLife]);
      return undefined;
    });

    renderRoutes('/applications');
    expect(await screen.findByText('本地生活', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('编辑'));
    fireEvent.change(await screen.findByDisplayValue('本地生活'), {
      target: { value: '尚未保存的名称' },
    });
    fireEvent.click(findButtonText('关闭'));

    expect((await screen.findAllByText('放弃未保存的修改？')).length).toBeGreaterThan(0);
    fireEvent.click(findButtonText('继续编辑'));
    expect((screen.getByLabelText('应用名称') as HTMLInputElement).value).toBe('尚未保存的名称');

    fireEvent.click(findButtonText('关闭'));
    expect((await screen.findAllByText('放弃未保存的修改？')).length).toBeGreaterThan(0);
    fireEvent.click(findButtonText('放弃修改'));
    await waitFor(() => expect(screen.queryByText('编辑下游应用')).toBeNull());
  });

  it('locks the drawer on a 409 until the latest configuration is reloaded', { timeout: 60_000 }, async () => {
    let current = application({
      id: 'app-1',
      businessSource: 'local-life',
      name: '原始名称',
      version: 2,
    });
    const writes: Record<string, unknown>[] = [];

    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/applications/app-1' && (init?.method ?? 'GET') === 'GET') {
        return detailResponse(current, []);
      }
      if (url === '/api/v1/applications/app-1' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push(body);
        if (body.version === 2) {
          current = { ...current, name: '其他管理员修改', version: 3 };
          return jsonResponse(409, {
            error: 'APPLICATION_VERSION_CONFLICT',
            message: '应用已被他人更新，请刷新后按最新版本重试',
          });
        }
        return jsonResponse(200, { application: current });
      }
      if (url.startsWith('/api/v1/catalog/products?')) return productListResponse([]);
      if (url.startsWith('/api/v1/applications?')) return listResponse([current]);
      return undefined;
    });

    renderRoutes('/applications');
    expect(await screen.findByText('原始名称', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('编辑'));
    fireEvent.change(await screen.findByDisplayValue('原始名称'), {
      target: { value: '我的未保存修改' },
    });
    fireEvent.click(findButtonText('保存'));

    expect(
      await screen.findByText('应用配置已被他人修改', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(writes).toHaveLength(1);
    expect((findButtonText('保存') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(findButtonText('重新加载详情'));
    expect(await screen.findByDisplayValue('其他管理员修改')).toBeTruthy();
    await waitFor(() => expect((findButtonText('保存') as HTMLButtonElement).disabled).toBe(false));
  });
});
