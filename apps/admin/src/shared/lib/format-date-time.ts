const formatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'Asia/Shanghai',
  timeZoneName: 'short',
});

/** Displays timestamps with an explicit timezone; session expiry is user-visible. */
export function formatDateTime(timestamp: number): string {
  return formatter.format(new Date(timestamp));
}
