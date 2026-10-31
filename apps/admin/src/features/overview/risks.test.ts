import { describe, expect, it } from 'vitest';
import type { OperationsOverviewDto } from '@sanchuang-dev/benefit-contracts';
import { deriveRisks } from './risks';

function overview(overrides: {
  byStatus?: Partial<OperationsOverviewDto['byStatus']>;
  supply?: Partial<OperationsOverviewDto['supply']>;
} = {}): OperationsOverviewDto {
  const byStatus = {
    pending: 0,
    processing: 0,
    awaiting_claim: 0,
    partially_completed: 0,
    completed: 0,
    failed: 0,
    unknown: 0,
    ...overrides.byStatus,
  };
  return {
    asOf: 1_760_000_000_000,
    window: { key: 'today', from: 1_759_000_000_000, to: 1_760_000_000_000, timezone: 'Asia/Shanghai' },
    orders: {
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      completed: byStatus.completed,
      failed: byStatus.failed,
      terminalTotal: byStatus.completed + byStatus.failed + byStatus.partially_completed,
      completedRateBp: null,
      previousTotal: 0,
    },
    byStatus,
    series: [],
    hourly: [],
    attempts: { total: 0, accepted: 0, rejected: 0, unknown: 0 },
    supply: {
      provider: 'yangmao',
      displayName: '上力',
      catalogConfigured: true,
      credentialSource: 'database',
      connectionUpdatedAt: 1_759_500_000_000,
      ...overrides.supply,
    },
  };
}

describe('derived cockpit risks', () => {
  it('reports no risk only when every local check passes', () => {
    expect(deriveRisks(overview())).toEqual([]);
  });

  it('puts unverified upstream outcomes first and deep-links the matching filter', () => {
    const risks = deriveRisks(
      overview({ byStatus: { unknown: 2, failed: 1, pending: 3 } }),
    );

    expect(risks.map((risk) => risk.key)).toEqual([
      'orders-unknown',
      'orders-failed',
      'orders-pending',
    ]);
    expect(risks[0]).toMatchObject({
      level: 'high',
      href: '/fulfillment?status=unknown',
      detail: '2 单上游结果未确认，不能判定成功或失败',
    });
    expect(risks[1]?.href).toBe('/fulfillment?status=failed');
  });

  it('flags a missing supplier credential before an environment fallback', () => {
    const missing = deriveRisks(
      overview({ supply: { catalogConfigured: false, credentialSource: 'none' } }),
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ key: 'supplier-credentials', level: 'medium' });

    const envOnly = deriveRisks(overview({ supply: { credentialSource: 'environment' } }));
    expect(envOnly).toHaveLength(1);
    expect(envOnly[0]).toMatchObject({ key: 'supplier-env-credentials', level: 'low' });
  });

  it('surfaces partially completed orders as an unfinished entitlement', () => {
    const risks = deriveRisks(overview({ byStatus: { partially_completed: 4 } }));
    expect(risks[0]).toMatchObject({
      key: 'orders-partial',
      level: 'medium',
      href: '/fulfillment?status=partially_completed',
    });
  });
});
