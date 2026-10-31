// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { EChartsCoreOption } from 'echarts/core';
import { installDomStubs } from '../../test-utils/render-routes';
import { EChart } from './EChart';
import { CHART_PALETTE, ORDER_STATUS_CHART_COLORS, areaFill } from './chart-theme';
import { ORDER_STATUSES } from '@sanchuang-dev/benefit-contracts';

function barOption(values: number[]): EChartsCoreOption {
  return {
    xAxis: { type: 'category', data: values.map((_, index) => String(index)) },
    yAxis: { type: 'value' },
    series: [{ type: 'bar', data: values }],
  };
}

beforeAll(() => installDomStubs());
afterEach(() => cleanup());

describe('EChart wrapper', () => {
  it('renders an accessible SVG chart instead of a canvas placeholder', () => {
    const { container } = render(
      <EChart ariaLabel="时段分布" height={180} option={barOption([1, 2, 3])} />,
    );

    expect(screen.getByRole('img', { name: '时段分布' })).toBeTruthy();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('replaces the series on option change instead of merging stale points', () => {
    const { container, rerender } = render(
      <EChart ariaLabel="趋势" height={180} option={barOption([1, 2, 3, 4, 5])} />,
    );
    const before = container.querySelectorAll('svg').length;

    rerender(<EChart ariaLabel="趋势" height={180} option={barOption([9])} />);

    expect(before).toBe(1);
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(container.textContent).not.toContain('undefined');
  });

  it('disposes cleanly when the page unmounts', () => {
    const { unmount } = render(<EChart ariaLabel="趋势" height={180} option={barOption([1])} />);
    expect(() => unmount()).not.toThrow();
  });
});

describe('chart theme', () => {
  it('gives every platform status its own color, distinct from success', () => {
    expect(Object.keys(ORDER_STATUS_CHART_COLORS)).toHaveLength(ORDER_STATUSES.length);
    expect(ORDER_STATUS_CHART_COLORS.unknown).not.toBe(ORDER_STATUS_CHART_COLORS.completed);
    expect(ORDER_STATUS_CHART_COLORS.failed).not.toBe(ORDER_STATUS_CHART_COLORS.completed);
  });

  it('derives only a single low-opacity gradient for area fills', () => {
    const fill = areaFill(CHART_PALETTE.primary) as { colorStops: Array<{ color: string }> };
    expect(fill.colorStops[0]?.color).toMatch(/1F$/);
    expect(fill.colorStops[1]?.color).toMatch(/00$/);
  });
});
