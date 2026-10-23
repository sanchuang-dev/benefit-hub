export type LogValue = string | number | boolean | null;

/**
 * Structured application log line. Callers pass explicit, already-sanitized
 * fields: never raw credentials, tokens, cookies, or request bodies.
 */
export function logEvent(event: string, fields: Record<string, LogValue> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
