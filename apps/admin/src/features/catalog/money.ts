/** Monetary values are integer minor units (cents) on the wire and in storage. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}¥${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

export function centsToYuan(cents: number | null): number | null {
  return cents === null ? null : cents / 100;
}

export function yuanToCents(yuan: number | null | undefined): number | null {
  if (yuan === null || yuan === undefined) return null;
  // Round to avoid binary floating point artefacts such as 12.35 * 100 = 1234.999…
  return Math.round(yuan * 100);
}
