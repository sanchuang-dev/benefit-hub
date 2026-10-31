// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Architectural guard for the shared route-level page head.
 *
 * The jitter operators saw when switching a work tab was caused by every page
 * hand-rolling its own <header className="page-header">: the title box, the
 * action placement and the description line differed per route, so the body
 * started at a different offset on each page. PageHeader now owns that chrome,
 * and this test fails if a page goes back to writing its own header markup.
 *
 * It is a source check rather than a render test on purpose: rendering eleven
 * full route trees dominates the suite runtime, and the rule to enforce is a
 * structural one (no page-local header markup), which source text states
 * exactly.
 */
const PAGES_DIR = new URL('../pages/', import.meta.url).pathname;

function pageSources(): { file: string; source: string }[] {
  return readdirSync(PAGES_DIR)
    .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
    .map((file) => ({ file, source: readFileSync(join(PAGES_DIR, file), 'utf8') }));
}

describe('shared page head', () => {
  it('never lets a page hand-roll its own header chrome', () => {
    const offenders = pageSources()
      .filter(({ source }) => /<header[^>]*className="[^"]*\bpage-header\b/.test(source))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('has every content page render the shared PageHeader component', () => {
    const offenders = pageSources()
      .filter(({ file }) => !file.startsWith('LoginPage'))
      .filter(({ source }) => !source.includes('<PageHeader'))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('keeps the one scroll container reserving its scrollbar gutter', () => {
    // Tall pages and short pages must keep the same content box width; without
    // a reserved gutter a work-tab switch shifted the pinned header by 15px.
    const css = readFileSync(new URL('../app/shell/shell.css', import.meta.url).pathname, 'utf8');
    const block = css.slice(css.indexOf('.app-content {'), css.indexOf('.app-content {') + 900);
    expect(block).toContain('scrollbar-gutter: stable');
  });
});
