import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Segmented,
  Skeleton,
  Statistic,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import type { OperationsOverviewDto, OverviewWindow } from '@sanchuang-dev/benefit-contracts';
import { useSessionQuery } from '../features/auth/use-auth';
import {
  DailyTrendChart,
  HourlyBarChart,
  StatusDonutChart,
  formatCount,
  formatDelta,
  formatRateBp,
} from '../features/overview/overview-charts';
import {
  RISK_LEVEL_COLOR,
  RISK_LEVEL_LABEL,
  deriveRisks,
} from '../features/overview/risks';
import { useOverviewQuery } from '../features/overview/use-overview';
import { ApiError } from '../shared/lib/api-client';
import { formatDateTime } from '../shared/lib/format-date-time';
import './OverviewPage.css';
import { PageHeader } from '../shared/components/PageHeader';

const { Text } = Typography;

const WINDOW_OPTIONS: Array<{ label: string; value: OverviewWindow }> = [
  { label: '今日', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
];

const WINDOW_LABEL: Record<OverviewWindow, string> = {
  today: '今日',
  '7d': '近 7 天',
  '30d': '近 30 天',
};

interface KpiCardProps {
  title: string;
  hint: string;
  value: string | number;
  unit?: string;
  footnotes: Array<{ text: string; tone?: 'muted' | 'danger' }>;
  href: string;
  onOpen: (href: string) => void;
  emphasize?: boolean;
}

function KpiCard({
  title,
  hint,
  value,
  unit,
  footnotes,
  href,
  onOpen,
  emphasize = false,
}: KpiCardProps) {
  const { token } = theme.useToken();

  return (
    <Card
      className="overview-kpi"
      hoverable
      onClick={() => onOpen(href)}
      styles={{ body: { padding: '14px 16px 12px' } }}
    >
      <div className="overview-kpi-head">
        <Tooltip title={hint}>
          <span className="overview-kpi-title">{title}</span>
        </Tooltip>
        <Button
          type="link"
          size="small"
          className="overview-kpi-link"
          aria-label={`查看${title}明细`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen(href);
          }}
        >
          明细
          <ArrowRight size={12} />
        </Button>
      </div>
      <Statistic
        value={value}
        suffix={unit}
        styles={{
          content: {
            fontSize: 26,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: emphasize ? token.colorError : token.colorText,
          },
        }}
      />
      {footnotes.map((footnote) => (
        <p
          key={footnote.text}
          className={`overview-kpi-footnote${footnote.tone === 'danger' ? ' overview-kpi-footnote--danger' : ''}`}
        >
          {footnote.text}
        </p>
      ))}
    </Card>
  );
}

function errorCopy(error: Error): { title: string; description: string } {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        title: '登录状态已失效',
        description: '请刷新页面并重新登录后再查看业务总览。',
      };
    }
    return { title: '总览数据加载失败', description: error.message };
  }
  return { title: '总览数据加载失败', description: '请求失败，请稍后重试。' };
}

function LoadingSkeleton() {
  return (
    <div className="overview-body" aria-busy="true">
      <div className="overview-kpis">
        {[0, 1, 2, 3].map((key) => (
          <Card key={key} className="overview-kpi">
            <Skeleton active paragraph={{ rows: 2 }} title={false} />
          </Card>
        ))}
      </div>
      <div className="overview-charts">
        <Card className="overview-chart-card">
          <Skeleton active paragraph={{ rows: 4 }} />
        </Card>
        <Card className="overview-chart-card">
          <Skeleton active paragraph={{ rows: 4 }} />
        </Card>
      </div>
    </div>
  );
}

function CockpitContent({ overview }: { overview: OperationsOverviewDto }) {
  const navigate = useNavigate();
  const open = (href: string) => {
    navigate(href);
  };
  const risks = deriveRisks(overview);
  const windowLabel = WINDOW_LABEL[overview.window.key];
  const terminalCopy =
    overview.orders.terminalTotal === 0
      ? `${windowLabel}暂无已终态订单`
      : `已完成 ${formatCount(overview.orders.completed)} / 已终态 ${formatCount(overview.orders.terminalTotal)} 单`;
  const attemptCopy = `履约尝试 ${formatCount(overview.attempts.total)} 次：受理 ${formatCount(overview.attempts.accepted)}、拒绝 ${formatCount(overview.attempts.rejected)}、未知 ${formatCount(overview.attempts.unknown)}`;
  // A missing row means either an environment-only credential or nothing at
  // all; the copy must not claim an environment fallback that does not exist.
  const supplyUpdatedAt =
    overview.supply.connectionUpdatedAt !== null
      ? `配置更新于 ${formatDateTime(overview.supply.connectionUpdatedAt)}`
      : overview.supply.credentialSource === 'environment'
        ? '凭证来自环境变量，无配置更新时间'
        : '尚未保存过连接配置';
  const credentialSourceLabel =
    overview.supply.credentialSource === 'database'
      ? '数据库'
      : overview.supply.credentialSource === 'environment'
        ? '环境变量'
        : '未配置';

  return (
    <div className="overview-body">
      <div className="overview-kpis">
        <KpiCard
          title={`${windowLabel}业务订单`}
          hint="按订单创建时间统计平台本地已落库的订单，不含任何上游推算"
          value={formatCount(overview.orders.total)}
          unit="单"
          footnotes={[
            { text: formatDelta(overview.orders.total, overview.orders.previousTotal, overview.window.key) },
          ]}
          href="/fulfillment"
          onOpen={open}
        />
        <KpiCard
          title="履约完成率"
          hint="已完成 ÷ 已终态（已完成 / 失败 / 部分完成）；在途订单不计入分母，受理不等于履约"
          value={formatRateBp(overview.orders.completedRateBp)}
          footnotes={[{ text: terminalCopy }, { text: attemptCopy }]}
          href="/fulfillment?status=completed"
          onOpen={open}
        />
        <KpiCard
          title="结果未知待核实"
          hint="上游结果未确认的订单，不能判定为成功或失败，需人工核实后再处理"
          value={formatCount(overview.byStatus.unknown)}
          unit="单"
          emphasize={overview.byStatus.unknown > 0}
          footnotes={[
            {
              text:
                overview.byStatus.unknown > 0
                  ? `另有待处理 ${formatCount(overview.byStatus.pending)} 单，尚未提交上游`
                  : `没有结果未知的订单；待处理 ${formatCount(overview.byStatus.pending)} 单`,
              tone: overview.byStatus.unknown > 0 ? 'danger' : 'muted',
            },
          ]}
          href="/fulfillment?status=unknown"
          onOpen={open}
        />
        <KpiCard
          title="上力目录接入"
          hint="凭证是否已配置，以及配置存放位置；不能据此证明上游连接当前可用"
          value={overview.supply.catalogConfigured ? '已配置' : '待配置'}
          footnotes={[
            { text: `凭证来源：${credentialSourceLabel}` },
            { text: supplyUpdatedAt },
          ]}
          href="/suppliers/yangmao"
          onOpen={open}
        />
      </div>

      <div className="overview-charts">
        <Card
          title="近 30 天业务量"
          className="overview-chart-card"
          extra={<Text type="secondary">全部订单 / 已完成</Text>}
        >
          <DailyTrendChart points={overview.series} />
        </Card>
        <Card
          title={`${windowLabel}状态分布`}
          className="overview-chart-card"
          extra={
            <Text type="secondary">
              已终态 {formatCount(overview.orders.terminalTotal)} 单
            </Text>
          }
        >
          <StatusDonutChart
            counts={overview.byStatus}
            completedRateBp={overview.orders.completedRateBp}
          />
        </Card>
      </div>

      <div className="overview-lower">
        <Card
          title="时段分布（北京时间）"
          className="overview-chart-card"
          extra={<Text type="secondary">{windowLabel}</Text>}
        >
          <HourlyBarChart points={overview.hourly} />
        </Card>
        <Card
          title="风险与待办"
          className="overview-risks"
          extra={
            <Text type="secondary">
              {risks.length > 0 ? `${risks.length} 项` : '暂无'}
            </Text>
          }
        >
          {risks.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="当前窗口未发现已知风险；上游未知结果仍以订单记录为准"
            />
          ) : (
            <ul className="overview-risk-list">
              {risks.map((risk) => (
                <li key={risk.key} className="overview-risk">
                  <Tag color={RISK_LEVEL_COLOR[risk.level]}>{RISK_LEVEL_LABEL[risk.level]}</Tag>
                  <div className="overview-risk-text">
                    <span className="overview-risk-title">{risk.title}</span>
                    <span className="overview-risk-detail">{risk.detail}</span>
                  </div>
                  <Link className="overview-risk-action" to={risk.href}>
                    {risk.action}
                    <ArrowRight size={12} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * Operator cockpit (design.md §4C).
 *
 * Every number on this page comes from the server aggregate endpoint: the page
 * never computes a KPI from a paged list, because a page of 50 rows cannot
 * honestly represent a total. The server `asOf` is the only freshness claim, and
 * a window with no orders shows real zeros while missing capabilities are
 * labelled as such instead of being rendered as 0.
 */
export function OverviewPage() {
  const [window, setWindow] = useState<OverviewWindow>('today');
  const session = useSessionQuery();
  const overviewQuery = useOverviewQuery(window);
  const admin = session.data?.admin;
  const overview = overviewQuery.data;
  const copy = overviewQuery.isError ? errorCopy(overviewQuery.error) : null;

  return (
    <div className="page">
      <PageHeader
        title="总览"
        description={
          <>
            欢迎，{admin?.displayName ?? '运营人员'}。{WINDOW_LABEL[window]}业务与风险概览
            {overview ? ` · 数据截至 ${formatDateTime(overview.asOf)}` : ''}
          </>
        }
        actions={
          <>
            <Segmented
              value={window}
              onChange={(value) => setWindow(value as OverviewWindow)}
              options={WINDOW_OPTIONS}
              aria-label="统计时间窗口"
            />
            <Button
              icon={<RefreshCw size={14} />}
              loading={overviewQuery.isFetching}
              onClick={() => {
                void overviewQuery.refetch();
              }}
            >
              刷新
            </Button>
          </>
        }
      />

      {copy ? (
        <Alert
          type={overviewQuery.error instanceof ApiError && overviewQuery.error.status === 401 ? 'warning' : 'error'}
          showIcon
          title={copy.title}
          description={copy.description}
          action={
            <Button
              size="small"
              loading={overviewQuery.isFetching}
              onClick={() => {
                void overviewQuery.refetch();
              }}
            >
              重试
            </Button>
          }
        />
      ) : null}

      {overview ? <CockpitContent overview={overview} /> : null}
      {!overview && !copy ? <LoadingSkeleton /> : null}

    </div>
  );
}
