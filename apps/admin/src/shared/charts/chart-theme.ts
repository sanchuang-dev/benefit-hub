import type { OrderStatus } from '@sanchuang-dev/benefit-contracts';

/**
 * Charts need concrete colors, while the business UI is required to use the
 * Ant Design semantic tokens. This module is the single place where the two
 * meet: the values mirror the Ant Design 6 preset palette that
 * `ORDER_STATUS_COLORS` names for tables and tags, so the same status can never
 * appear in one hue on a tag and a different one in a chart.
 *
 * Keep this file in sync with `features/fulfillment/labels.ts`; the unit test
 * asserts that every platform status has a color here.
 */
export const CHART_PALETTE = {
  primary: '#2563EB',
  success: '#52C41A',
  warning: '#FAAD14',
  danger: '#FF4D4F',
  info: '#1677FF',
  neutral: '#94A3B8',
  text: '#1F2937',
  textSecondary: '#64748B',
  grid: '#EEF0F2',
  axis: '#E5E7EB',
  surface: '#FFFFFF',
} as const;

/**
 * Same preset hues as the status tags. `pending` and `unknown` deliberately
 * stay visually distinct from `completed`, because an unverified outcome must
 * never read as a success on a summary chart.
 */
export const ORDER_STATUS_CHART_COLORS: Record<OrderStatus, string> = {
  pending: '#94A3B8',
  processing: '#1677FF',
  awaiting_claim: '#FAAD14',
  partially_completed: '#FA8C16',
  completed: '#52C41A',
  failed: '#FF4D4F',
  unknown: '#EB2F96',
};

/** Baseline axis/grid style shared by every overview chart. */
export const CHART_CATEGORY_AXIS = {
  axisLine: { lineStyle: { color: CHART_PALETTE.axis } },
  axisTick: { show: false },
  axisLabel: { color: CHART_PALETTE.textSecondary, fontSize: 11 },
} as const;

export const CHART_VALUE_AXIS = {
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: { color: CHART_PALETTE.textSecondary, fontSize: 11 },
  splitLine: { lineStyle: { color: CHART_PALETTE.grid } },
} as const;

/**
 * Floating layer only: a chart tooltip is a transient surface, so a light
 * shadow is acceptable here even though content cards stay flat.
 */
export const CHART_TOOLTIP = {
  confine: true,
  backgroundColor: CHART_PALETTE.surface,
  borderColor: '#E8EAED',
  borderWidth: 1,
  padding: [6, 10],
  textStyle: { color: CHART_PALETTE.text, fontSize: 12 },
  extraCssText: 'box-shadow: 0 6px 16px rgba(15, 23, 42, 0.08); border-radius: 6px;',
} as const;

export const CHART_LEGEND = {
  icon: 'roundRect',
  itemWidth: 8,
  itemHeight: 8,
  itemGap: 16,
  textStyle: { color: CHART_PALETTE.textSecondary, fontSize: 12 },
} as const;

/** Fixed 8% area fill; the only gradient the design allows on this page. */
export function areaFill(color: string): Record<string, unknown> {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: `${color}1F` },
      { offset: 1, color: `${color}00` },
    ],
  };
}
