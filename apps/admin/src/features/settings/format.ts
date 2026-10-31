/**
 * Formats a non-negative elapsed duration for the runtime card. The server
 * sends epoch milliseconds; the page must not read the browser clock.
 */
export function formatUptime(startedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);

  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${totalSeconds} 秒`;
}

/** `已启用/未启用` for an effective security switch. */
export function formatSwitch(value: boolean): string {
  return value ? '已启用' : '未启用';
}
