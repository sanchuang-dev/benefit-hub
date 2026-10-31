import { useEffect, useState } from 'react';

/**
 * Subscribes to a CSS media query so layout decisions that change the DOM shape
 * (not just styles) can branch on the same breakpoint the stylesheet uses.
 *
 * The initial value is read during the first render, so server-side rendering and
 * jsdom (where tests provide a `matchMedia` stub) start from a deterministic
 * value instead of flashing the wrong layout after an effect.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => readMatches(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    // Covers environments where the query changed between render and effect.
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

function readMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

/**
 * Design §9: below 768px the persistent sidebar becomes a navigation drawer.
 * Kept next to the component so the drawer breakpoint and the stylesheet agree.
 */
export const COMPACT_NAV_MEDIA_QUERY = '(max-width: 767px)';
