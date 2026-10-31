import { useEffect, useRef } from 'react';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

/**
 * Only the visualizations the overview actually uses are registered, so the
 * console does not ship the whole ECharts catalogue. The SVG renderer is chosen
 * on purpose: it produces real DOM nodes, which keeps the charts assertable in
 * jsdom instead of requiring a canvas implementation in tests.
 */
echarts.use([
  LineChart,
  BarChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  SVGRenderer,
]);

/**
 * Container width used until the browser reports a real layout. jsdom and the
 * first paint both report 0, and an ECharts instance initialized at 0×0 would
 * render nothing at all instead of simply looking narrow for one frame.
 */
const FALLBACK_WIDTH = 640;

export interface EChartProps {
  option: EChartsCoreOption;
  /** Required accessible name; a chart is meaningless to a screen reader alone. */
  ariaLabel: string;
  /** Reserved height in pixels so the card never collapses while loading. */
  height: number;
  className?: string;
}

/**
 * Thin, disposable wrapper around ECharts. It owns the instance lifecycle and
 * nothing else: every visual decision belongs to the caller's option object so
 * the option builders stay pure and unit-testable.
 */
export function EChart({ option, ariaLabel, height, className }: EChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const chart = echarts.init(element, undefined, {
      renderer: 'svg',
      width: element.clientWidth || FALLBACK_WIDTH,
      height: element.clientHeight || height,
    });
    chartRef.current = chart;

    // ResizeObserver is stubbed in the test environment, so never assume it.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => chart.resize());
    observer?.observe(element);

    return () => {
      observer?.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    // `notMerge` keeps a shorter series from leaving stale points behind when
    // the operator switches windows.
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
    />
  );
}
