import type { OperationsOverviewDto } from '@sanchuang-dev/benefit-contracts';

export type RiskLevel = 'high' | 'medium' | 'low';

export interface OverviewRisk {
  key: string;
  level: RiskLevel;
  title: string;
  detail: string;
  /** Deep link into the page that can actually resolve it. */
  href: string;
  action: string;
}

const LEVEL_ORDER: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 };

/**
 * Risks are derived on the client from facts the server already reported; this
 * module never invents a metric. Ordering is severity first, then the order the
 * checks run in, and every entry links to the page that can resolve it.
 *
 * An empty list means "no known risk in the local record", not "the business is
 * healthy": upstream outcomes we never observed stay unknown, and the page copy
 * must not claim otherwise.
 */
export function deriveRisks(overview: OperationsOverviewDto): OverviewRisk[] {
  const risks: OverviewRisk[] = [];
  const { byStatus, supply } = overview;

  if (byStatus.unknown > 0) {
    risks.push({
      key: 'orders-unknown',
      level: 'high',
      title: '订单结果未知待核实',
      detail: `${byStatus.unknown} 单上游结果未确认，不能判定成功或失败`,
      href: '/fulfillment?status=unknown',
      action: '去核实',
    });
  }

  if (byStatus.failed > 0) {
    risks.push({
      key: 'orders-failed',
      level: 'medium',
      title: '履约失败订单',
      detail: `${byStatus.failed} 单明确失败，需按对应模式核实补发规则`,
      href: '/fulfillment?status=failed',
      action: '看失败单',
    });
  }

  if (byStatus.partially_completed > 0) {
    risks.push({
      key: 'orders-partial',
      level: 'medium',
      title: '部分完成订单',
      detail: `${byStatus.partially_completed} 单仍有未完成明细，用户权益未全部到账`,
      href: '/fulfillment?status=partially_completed',
      action: '看明细',
    });
  }

  if (!supply.catalogConfigured) {
    risks.push({
      key: 'supplier-credentials',
      level: 'medium',
      title: '上力目录凭证待配置',
      detail: '未配置凭证时无法读取供货商品、报价与成本',
      href: '/suppliers/yangmao',
      action: '去配置',
    });
  } else if (supply.credentialSource === 'environment') {
    risks.push({
      key: 'supplier-env-credentials',
      level: 'low',
      title: '上力凭证来自环境变量',
      detail: '环境回退不便审计与轮换，建议在供应商管理页保存到数据库',
      href: '/suppliers/yangmao',
      action: '去核对',
    });
  }

  if (byStatus.pending > 0) {
    risks.push({
      key: 'orders-pending',
      level: 'low',
      title: '本地待处理订单',
      detail: `${byStatus.pending} 单已记录但尚未提交上游`,
      href: '/fulfillment?status=pending',
      action: '看待处理',
    });
  }

  return risks.sort((left, right) => LEVEL_ORDER[left.level] - LEVEL_ORDER[right.level]);
}

export const RISK_LEVEL_LABEL: Record<RiskLevel, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export const RISK_LEVEL_COLOR: Record<RiskLevel, string> = {
  high: 'red',
  medium: 'orange',
  low: 'default',
};
