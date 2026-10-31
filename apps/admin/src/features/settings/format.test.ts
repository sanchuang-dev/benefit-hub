import { describe, expect, it } from 'vitest';
import { formatSwitch, formatUptime } from './format';

describe('settings formatting', () => {
  it('formats uptime from server timestamps without reading the browser clock', () => {
    const startedAt = Date.UTC(2026, 9, 29, 4, 0, 0);

    expect(formatUptime(startedAt, startedAt + 12_000)).toBe('12 秒');
    expect(formatUptime(startedAt, startedAt + 5 * 60_000)).toBe('5 分钟');
    expect(formatUptime(startedAt, startedAt + (2 * 60 + 30) * 60_000)).toBe('2 小时 30 分钟');
    expect(formatUptime(startedAt, startedAt + (26 * 60 + 5) * 60_000)).toBe('1 天 2 小时');
  });

  it('never reports a negative elapsed time when clocks are equal', () => {
    expect(formatUptime(1_000, 0)).toBe('0 秒');
  });

  it('labels effective switches explicitly', () => {
    expect(formatSwitch(true)).toBe('已启用');
    expect(formatSwitch(false)).toBe('未启用');
  });
});
