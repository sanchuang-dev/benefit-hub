import { useEffect } from 'react';

/**
 * Warns before a full page unload while a form has unsaved edits.
 *
 * In-app navigation (closing the drawer, switching routes) is guarded by the
 * drawers' own confirmation instead; this only covers refresh/close-tab, where
 * a recovery copy is intentionally not persisted because a stale draft could
 * collide with the server's optimistic-lock version.
 */
export function useUnsavedChangesWarning(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Some browsers only show the native prompt when returnValue is set.
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [active]);
}
