import { useMemo } from 'react';
import { Empty } from 'antd';
import type {
  OverviewDailyPointDto,
  OverviewHourlyPointDto,
  OverviewStatusCounts,
  OverviewWindow,
} from '@sanchuang-dev/benefit-contracts';
import { ORDER_STATUSES } from '@sanchuang-dev/benefit-contracts';
import type { EChartsCoreOption } from 'echarts/core';
import { ORDER_STATUS_LABELS } from '../fulfillment/labels';
import { EChart } from '../../shared/charts/EChart';
import {
  CHART_CATEGORY_AXIS,
  CHART_LEGEND,
  CHART_PALETTE,
  CHART_TOOLTIP,
  CHART_VALUE_AXIS,
  ORDER_STATUS_CHART_COLORS,
  areaFill,
} from '../../shared/charts/chart-theme';

const EMPTY_TEXT = '当前窗口没有业务订单，暂无图表';

export function formatCount(value: number): string {
  return value.toLocaleString('zh-CN');
}

/** Basis points to a human rate; `null` means "nothing terminal to rate". */
export function formatRateBp(basisPoints: number | null): string {
  if (basisPoints === null) return '—';
  const percent = basisPoints / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/**
 * Volume deltas are stated against the equal-length previous window. They stay
 * neutral (never green/red) because a volume change is not a success or failure;
 * only fulfilment risk carries semantic color on this page.
 */
export function formatDelta(
  current: number,
  previous: number,
  window: OverviewWindow,
): string {
  const label =
    window === 'today' ? '较昨日同时段' : window === '7d' ? '较前 7 天' : '较前 30 天';
  if (previous === 0) return current === 0 ? `${label}无订单` : `${label} 0 单`;
  const diff = current - previous;
  const percent = Math.round((diff / previous) * 100);
  const sign = diff > 0 ? '+' : '';
  return `${label} ${sign}${formatCount(diff)} 单（${sign}${percent}%）`;
}

export function buildDailyTrendOption(points: OverviewDailyPointDto[]): EChartsCoreOption {
  return {
    color: [CHART_PALETTE.primary, CHART_PALETTE.success],
    tooltip: {
      ...CHART_TOOLTIP,
      trigger: 'axis',
      valueFormatter: (value: unknown) => `${formatCount(Number(value))} 单`,
    },
    legend: { ...CHART_LEGEND, top: 0, right: 0 },
    grid: { left: 4, right: 8, top: 32, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: points.map((point) => point.day.slice(5).replace('-', '/')),
      ...CHART_CATEGORY_AXIS,
    },
    yAxis: { type: 'value', minInterval: 1, ...CHART_VALUE_AXIS },
    series: [
      {
        name: '全部订单',
        type: 'line',
        smooth: 0.25,
        showSymbol: false,
        lineStyle: { width: 2, color: CHART_PALETTE.primary },
        itemStyle: { color: CHART_PALETTE.primary },
        areaStyle: { color: areaFill(CHART_PALETTE.primary) },
        data: points.map((point) => point.total),
      },
      {
        name: '已完成',
        type: 'line',
        smooth: 0.25,
        showSymbol: false,
        lineStyle: { width: 2, color: CHART_PALETTE.success },
        itemStyle: { color: CHART_PALETTE.success },
        data: points.map((point) => point.completed),
      },
    ],
  };
}

export function buildStatusDonutOption(
  counts: OverviewStatusCounts,
  completedRateBp: number | null,
): EChartsCoreOption {
  const data = ORDER_STATUSES.filter((status) => counts[status] > 0).map((status) => ({
    name: ORDER_STATUS_LABELS[status],
    value: counts[status],
    itemStyle: { color: ORDER_STATUS_CHART_COLORS[status] },
  }));

  return {
    tooltip: { ...CHART_TOOLTIP, trigger: 'item', formatter: '{b}<br/>{c} 单（{d}%）' },
    legend: { ...CHART_LEGEND, bottom: 0, left: 'center' },
    title: {
      text: formatRateBp(completedRateBp),
      subtext: '完成率',
      left: 'center',
      top: '32%',
      textAlign: 'center',
      textStyle: { fontSize: 22, fontWeight: 600, color: CHART_PALETTE.text },
      subtextStyle: { fontSize: 12, color: CHART_PALETTE.textSecondary },
    },
    series: [
      {
        type: 'pie',
        radius: ['52%', '72%'],
        center: ['50%', '44%'],
        itemStyle: { borderColor: CHART_PALETTE.surface, borderWidth: 2 },
        label: { show: false },
        labelLine: { show: false },
        data,
      },
    ],
  };
}

export function buildHourlyBarOption(points: OverviewHourlyPointDto[]): EChartsCoreOption {
  const byHour = new Map(points.map((point) => [point.hour, point.total]));
  const totals = Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? 0);

  return {
    tooltip: {
      ...CHART_TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (value: unknown) => `${formatCount(Number(value))} 单`,
    },
    grid: { left: 4, right: 8, top: 16, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: totals.map((_, hour) => `${String(hour).padStart(2, '0')}时`),
      ...CHART_CATEGORY_AXIS,
      axisLabel: { ...CHART_CATEGORY_AXIS.axisLabel, interval: 2 },
    },
    yAxis: { type: 'value', minInterval: 1, ...CHART_VALUE_AXIS },
    series: [
      {
        name: '订单数',
        type: 'bar',
        barMaxWidth: 14,
        itemStyle: { color: CHART_PALETTE.primary, borderRadius: [2, 2, 0, 0] },
        data: totals,
      },
    ],
  };
}

/** Text summary shown under each chart: readable without color and in a screenshot. */
export function summarizeDailyTrend(points: OverviewDailyPointDto[]): string {
  const total = points.reduce((sum, point) => sum + point.total, 0);
  if (total === 0) return '近 30 天暂无业务订单';
  const peak = points.reduce((best, point) => (point.total > best.total ? point : best), points[0]!);
  const average = Math.round(total / points.length);
  return `近 ${points.length} 天共 ${formatCount(total)} 单，日均 ${formatCount(average)} 单，最高 ${peak.day.slice(5).replace('-', '/')} 的 ${formatCount(peak.total)} 单`;
}

export function summarizeHourly(points: OverviewHourlyPointDto[]): string {
  const total = points.reduce((sum, point) => sum + point.total, 0);
  if (total === 0) return '当前窗口暂无业务订单';
  const peak = points.reduce((best, point) => (point.total > best.total ? point : best), points[0]!);
  return `当前窗口共 ${formatCount(total)} 单，高峰 ${String(peak.hour).padStart(2, '0')} 时（${formatCount(peak.total)} 单）`;
}

/** Trend always renders: an empty 30-day line is itself a fact, not a chart error. */
export function DailyTrendChart({ points }: { points: OverviewDailyPointDto[] }) {
  const option = useMemo(() => buildDailyTrendOption(points), [points]);
  const summary = summarizeDailyTrend(points);
  if (points.every((point) => point.total === 0)) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={summary} />;
  }
  return (
    <>
      <EChart ariaLabel={summary} height={220} option={option} />
      <p className="overview-chart-summary">{summary}</p>
    </>
  );
}

export function StatusDonutChart({
  counts,
  completedRateBp,
}: {
  counts: OverviewStatusCounts;
  completedRateBp: number | null;
}) {
  const option = useMemo(
    () => buildStatusDonutOption(counts, completedRateBp),
    [counts, completedRateBp],
  );
  const labelled = ORDER_STATUSES.filter((status) => counts[status] > 0)
    .map((status) => `${ORDER_STATUS_LABELS[status]} ${formatCount(counts[status])}`)
    .join('，');
  const summary = labelled === '' ? EMPTY_TEXT : `状态分布：${labelled}`;

  if (labelled === '') {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={summary} />;
  }
  return (
    <>
      <EChart ariaLabel={summary} height={220} option={option} />
      <p className="overview-chart-summary">{summary}</p>
    </>
  );
}

export function HourlyBarChart({ points }: { points: OverviewHourlyPointDto[] }) {
  const option = useMemo(() => buildHourlyBarOption(points), [points]);
  const summary = summarizeHourly(points);
  if (points.every((point) => point.total === 0)) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={summary} />;
  }
  return (
    <>
      <EChart ariaLabel={summary} height={200} option={option} />
      <p className="overview-chart-summary">{summary}</p>
    </>
  );
}
