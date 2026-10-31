// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { OperationsOverviewDto } from '@sanchuang-dev/benefit-contracts';
import { installDomStubs, renderRoutes, resetUiPrefs } from '../test-utils/render-routes';
import { jsonResponse, mockFetch } from '../test-utils/http';

const SESSION_EXPIRES_AT = Date.now() + 60 * 60 * 1000;
const AS_OF = Date.UTC(2026, 9, 29, 4, 20, 41);

const ADMIN = {
  id: 'account-1',
  username: 'ops.admin',
  displayName: '运维管理员',
  role: 'admin' as const,
};

function trendSeries(totals: number[] = Array.from({ length: 30 }, () => 0)) {
  return totals.map((total, index) => ({
    day: `2026-10-${String(index + 1).padStart(2, '0')}`,
    total,
    completed: Math.max(0, total - 1),
  }));
}

function hourly(totals: number[] = Array.from({ length: 24 }, () => 0)) {
  return totals.map((total, hour) => ({ hour, total }));
}

function overview(overrides: Partial<OperationsOverviewDto> = {}): OperationsOverviewDto {
  return {
    asOf: AS_OF,
    window: {
      key: 'today',
      from: Date.UTC(2026, 9, 28, 16),
      to: AS_OF,
      timezone: 'Asia/Shanghai',
    },
    orders: {
      total: 4,
      completed: 3,
      failed: 1,
      terminalTotal: 4,
      completedRateBp: 7500,
      previousTotal: 2,
    },
    byStatus: {
      pending: 0,
      processing: 0,
      awaiting_claim: 0,
      partially_completed: 0,
      completed: 3,
      failed: 1,
      unknown: 0,
    },
    series: trendSeries(),
    hourly: hourly(),
    attempts: { total: 4, accepted: 3, rejected: 1, unknown: 0 },
    supply: {
      provider: 'yangmao',
      displayName: '上力',
      catalogConfigured: true,
      credentialSource: 'database',
      connectionUpdatedAt: AS_OF - 3_600_000,
    },
    ...overrides,
  };
}

function baseHandler(payload: { overview?: OperationsOverviewDto; overviewStatus?: number }) {
  return (url: string): Response | undefined => {
    if (url === '/api/v1/auth/session') {
      return jsonResponse(200, { admin: ADMIN, session: { expiresAt: SESSION_EXPIRES_AT } });
    }
    if (url.startsWith('/api/v1/operations/overview')) {
      if (payload.overviewStatus && payload.overviewStatus !== 200) {
        return jsonResponse(payload.overviewStatus, {
          error: 'INTERNAL_ERROR',
          message: '服务器内部错误',
        });
      }
      // Mirror the server: the response describes the window that was asked for.
      const key = (new URL(url, 'http://localhost').searchParams.get('window') ??
        'today') as OperationsOverviewDto['window']['key'];
      return jsonResponse(200, {
        overview: { ...payload.overview, window: { ...payload.overview?.window, key } },
      });
    }
    if (url.startsWith('/api/v1/operations/orders?')) {
      return jsonResponse(200, { orders: [], page: 1, pageSize: 20, total: 0 });
    }
    return undefined;
  };
}

function overviewCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .map(([url]) => url)
    .filter((url) => url.startsWith('/api/v1/operations/overview'));
}

beforeAll(() => installDomStubs());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetUiPrefs();
});

describe('operator cockpit', () => {
  it('renders server aggregates, as-of freshness and chart summaries', async () => {
    mockFetch(
      baseHandler({
        overview: overview({ series: trendSeries([...Array(29).fill(0), 4]) }),
      }),
    );

    renderRoutes('/');

    expect(await screen.findByRole('heading', { name: '总览' })).toBeTruthy();
    expect(await screen.findByText('今日业务订单')).toBeTruthy();
    expect(screen.getByText('履约完成率')).toBeTruthy();
    expect(screen.getByText('结果未知待核实')).toBeTruthy();
    expect(screen.getByText('上力目录接入')).toBeTruthy();

    // The rate is the KPI the boss will quote, so the denominator is printed too.
    // The same rate appears in both the KPI card and the donut centre.
    expect(screen.getAllByText('75%').length).toBeGreaterThan(0);
    expect(screen.getByText('已完成 3 / 已终态 4 单')).toBeTruthy();
    expect(screen.getByText('已配置')).toBeTruthy();
    expect(screen.getByText('凭证来源：数据库')).toBeTruthy();
    expect(screen.getByText(/履约尝试 4 次：受理 3、拒绝 1、未知 0/)).toBeTruthy();
    expect(screen.getByText(/数据截至/)).toBeTruthy();

    // Charts are accessible SVG nodes with a text summary, never colour-only.
    expect(screen.getByRole('img', { name: /近 30 天共 4 单/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /状态分布：已完成 3，失败 1/ })).toBeTruthy();
  });

  it('shows real zeros and an em dash rate when the window has no orders', async () => {
    mockFetch(
      baseHandler({
        overview: overview({
          orders: {
            total: 0,
            completed: 0,
            failed: 0,
            terminalTotal: 0,
            completedRateBp: null,
            previousTotal: 0,
          },
          byStatus: {
            pending: 0,
            processing: 0,
            awaiting_claim: 0,
            partially_completed: 0,
            completed: 0,
            failed: 0,
            unknown: 0,
          },
        }),
      }),
    );

    renderRoutes('/');

    expect(await screen.findByText('今日业务订单')).toBeTruthy();
    // "Nothing finished yet" must not be reported as a 0% success rate.
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('今日暂无已终态订单')).toBeTruthy();
    expect(screen.getByText('近 30 天暂无业务订单')).toBeTruthy();
    expect(screen.getByText('当前窗口没有业务订单，暂无图表')).toBeTruthy();
  });

  it('keeps the header and offers a retry when the aggregate fails', async () => {
    mockFetch(baseHandler({ overviewStatus: 500 }));

    renderRoutes('/');

    expect(await screen.findByRole('heading', { name: '总览' })).toBeTruthy();
    expect(await screen.findByText('总览数据加载失败')).toBeTruthy();
    // antd inserts a space between two CJK characters in a button label.
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeTruthy();
  });

  it('re-requests the aggregate when the operator switches the window', async () => {
    const fetchMock = mockFetch(baseHandler({ overview: overview() }));

    renderRoutes('/');
    expect(await screen.findByText('今日业务订单')).toBeTruthy();

    fireEvent.click(screen.getByText('近 7 天'));

    await waitFor(() => {
      expect(overviewCalls(fetchMock).some((url) => url.endsWith('window=7d'))).toBe(true);
    });
    expect(await screen.findByText('近 7 天业务订单')).toBeTruthy();
  });

  it('lists unverified outcomes as a high risk and deep-links the filtered order list', async () => {
    mockFetch(
      baseHandler({
        overview: overview({
          byStatus: {
            pending: 0,
            processing: 0,
            awaiting_claim: 0,
            partially_completed: 0,
            completed: 0,
            failed: 0,
            unknown: 2,
          },
        }),
      }),
    );

    const { router } = renderRoutes('/');

    expect(await screen.findByText('订单结果未知待核实')).toBeTruthy();
    expect(screen.getByText('2 单上游结果未确认，不能判定成功或失败')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: /去核实/ }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/fulfillment');
    });
    // The fulfilment page must receive the status hint so the cockpit click is
    // a real drill-down instead of a bare navigation.
    expect(router.state.location.search).toContain('status=unknown');
  });

  it('opens the supplier page from the supply KPI', async () => {
    mockFetch(baseHandler({ overview: overview() }));

    const { router } = renderRoutes('/');
    expect(await screen.findByText('上力目录接入')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '查看上力目录接入明细' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/suppliers/yangmao');
    });
  });
});
