import { describe, expect, it } from 'vitest';
import { beijingDayRange } from './date-range';

/** Minimal structural stand-in for the Ant Design DatePicker day object. */
function day(year: number, month: number, date: number) {
  return { year: () => year, month: () => month, date: () => date };
}

describe('beijingDayRange', () => {
  it('converts a Beijing calendar day to inclusive UTC epoch bounds', () => {
    // 2026-10-20 00:00:00.000 +08:00 = 2026-10-19T16:00:00.000Z
    expect(beijingDayRange(day(2026, 9, 20))).toEqual({
      start: Date.UTC(2026, 9, 19, 16, 0, 0, 0),
      end: Date.UTC(2026, 9, 20, 15, 59, 59, 999),
    });
  });

  it('covers exactly 24 hours so adjacent days do not overlap or leave gaps', () => {
    const first = beijingDayRange(day(2026, 9, 20));
    const second = beijingDayRange(day(2026, 9, 21));
    expect(first.end + 1).toBe(second.start);
    expect(first.end - first.start).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it('handles a month boundary without relying on the browser timezone', () => {
    expect(beijingDayRange(day(2026, 10, 1)).start).toBe(Date.UTC(2026, 9, 31, 16, 0, 0, 0));
  });
});
