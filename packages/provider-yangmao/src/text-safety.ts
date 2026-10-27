/**
 * Rejects ASCII control characters that could corrupt HTTP headers or log
 * lines. Used for credentials and vendor identifiers, never for free text.
 */
export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
