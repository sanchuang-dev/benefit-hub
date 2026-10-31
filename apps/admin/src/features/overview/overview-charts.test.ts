// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type {
  OverviewDailyPointDto,
  OverviewHourlyPointDto,
  OverviewStatusCounts,
} from '@sanchuang-dev/benefit-contracts';
import {
  buildDailyTrendOption,
  buildHourlyBarOption,
  buildStatusDonutOption,
  formatDelta,
  formatRateBp,
  summarizeDailyTrend,
  summarizeHourly,
} from './overview-charts';
import { CHART_PALETTE, ORDER_STATUS_CHART_COLORS } from '../../shared/charts/chart-theme';

function days(counts: number[]): OverviewDailyPointDto[] {
  return counts.map((total, index) => ({
    day: `2026-10-${String(index + 1).padStart(2, '0')}`,
    total,
    completed: Math.max(0, total - 1),
  }));
}

function statusCounts(overrides: Partial<OverviewStatusCounts> = {}): OverviewStatusCounts {
  return {
    pending: 0,
    processing: 0,
    awaiting_claim: 0,
    partially_completed: 0,
    completed: 0,
    failed: 0,
    unknown: 0,
    ...overrides,
  };
}

interface LineSeries {
  name: string;
  data: number[];
  lineStyle: { color: string };
}

interface PieSlice {
  name: string;
  value: number;
  itemStyle: { color: string };
}

describe('daily trend option', () => {
  it('plots the served series in order without recomputing totals', () => {
    const option = buildDailyTrendOption(days([3, 0, 7]));
    const series = option.series as unknown as LineSeries[];

    expect(series).toHaveLength(2);
    expect(series[0]?.name).toBe('全部订单');
    expect(series[0]?.data).toEqual([3, 0, 7]);
    expect(series[1]?.name).toBe('已完成');
    expect(series[1]?.data).toEqual([2, 0, 6]);
    expect(series[0]?.lineStyle.color).toBe(CHART_PALETTE.primary);
    expect(option.xAxis as unknown as { data: string[] }).toMatchObject({
      data: ['10/01', '10/02', '10/03'],
    });
  });
});

describe('status donut option', () => {
  it('keeps only non-zero statuses and colours them with the shared status palette', () => {
    const option = buildStatusDonutOption(
      statusCounts({ completed: 9, failed: 1, unknown: 2 }),
      7500,
    );
    const slices = (option.series as unknown as Array<{ data: PieSlice[] }>)[0]?.data ?? [];

    expect(slices.map((slice) => slice.name)).toEqual([
      '已完成',
      '失败',
      '结果未知待核实',
    ]);
    expect(slices[0]?.itemStyle.color).toBe(ORDER_STATUS_CHART_COLORS.completed);
    expect(slices[2]?.itemStyle.color).toBe(ORDER_STATUS_CHART_COLORS.unknown);
    expect((option.title as unknown as { text: string }).text).toBe('75%');
  });

  it('shows an em dash instead of 0% when nothing is terminal yet', () => {
    const option = buildStatusDonutOption(statusCounts({ pending: 4 }), null);
    expect((option.title as unknown as { text: string }).text).toBe('—');
  });
});

describe('hourly bar option', () => {
  it('always renders all 24 Beijing hours, filling gaps with real zeros', () => {
    const points: OverviewHourlyPointDto[] = [
      { hour: 0, total: 2 },
      { hour: 9, total: 5 },
    ];
    const option = buildHourlyBarOption(points);
    const series = (option.series as unknown as Array<{ data: number[] }>)[0];

    expect(series?.data).toHaveLength(24);
    expect(series?.data[0]).toBe(2);
    expect(series?.data[9]).toBe(5);
    expect(series?.data[1]).toBe(0);
    expect((option.xAxis as unknown as { data: string[] }).data[0]).toBe('00时');
  });
});

describe('rate and delta formatting', () => {
  it('formats basis points without inventing precision', () => {
    expect(formatRateBp(9610)).toBe('96.1%');
    expect(formatRateBp(10_000)).toBe('100%');
    expect(formatRateBp(0)).toBe('0%');
    expect(formatRateBp(null)).toBe('—');
  });

  it('labels the comparison window honestly', () => {
    expect(formatDelta(12, 10, 'today')).toBe('较昨日同时段 +2 单（+20%）');
    expect(formatDelta(10, 0, 'today')).toBe('较昨日同时段 0 单');
    expect(formatDelta(0, 0, '7d')).toBe('较前 7 天无订单');
    expect(formatDelta(5, 9, '30d')).toBe('较前 30 天 -4 单（-44%）');
  });
});

describe('chart text summaries', () => {
  it('summarises the trend so the chart is readable without colour', () => {
    expect(summarizeDailyTrend(days([0, 0, 0]))).toBe('近 30 天暂无业务订单');
    const summary = summarizeDailyTrend(days([1, 9, 2]));
    expect(summary).toContain('近 3 天共 12 单');
    expect(summary).toContain('日均 4 单');
    expect(summary).toContain('最高 10/02 的 9 单');
  });

  it('names the peak hour in the hourly summary', () => {
    expect(summarizeHourly([{ hour: 0, total: 0 }])).toBe('当前窗口暂无业务订单');
    expect(
      summarizeHourly([
        { hour: 0, total: 1 },
        { hour: 14, total: 6 },
      ]),
    ).toContain('高峰 14 时（6 单）');
  });
});
