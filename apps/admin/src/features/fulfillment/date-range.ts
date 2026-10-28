/**
 * Beijing (Asia/Shanghai) currently has a fixed UTC+8 offset and no DST, which
 * matches the display formatter used across the console. Converting the picked
 * calendar day explicitly keeps the filter stable even when the operator's
 * browser runs in another timezone.
 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Structural shape of an Ant Design DatePicker day, without importing dayjs. */
export interface CalendarDay {
  year(): number;
  month(): number;
  date(): number;
}

export interface UtcDayRange {
  /** Inclusive UTC epoch milliseconds for 00:00:00.000 Beijing time. */
  start: number;
  /** Inclusive UTC epoch milliseconds for 23:59:59.999 Beijing time. */
  end: number;
}

export function beijingDayRange(day: CalendarDay): UtcDayRange {
  const start = Date.UTC(day.year(), day.month(), day.date()) - BEIJING_OFFSET_MS;
  return { start, end: start + DAY_MS - 1 };
}
