import { useEffect } from 'react';

/** The part of `window` the prompt needs, so a test can hand in its own. */
export type UnloadTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * Ask before a reload or a closed tab drops the editor's unsaved changes
 * (SCRUM-472).
 *
 * The browser's own "Leave site?" question, raised only while `active`: an
 * untouched template leaves without a word. It covers what the page itself
 * cannot intercept — a reload, a closed tab, an address typed over this one.
 * Moving to another Admin panel is an in-app navigation (`Admin.tsx` writes the
 * address and the panel unmounts), which this does not see; guarding that needs
 * the panel switcher to ask first.
 */
export function useUnsavedChangesPrompt(
  active: boolean,
  target: UnloadTarget | undefined = typeof window === 'undefined' ? undefined : window,
): void {
  useEffect(() => {
    if (!active || !target) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // What older Chrome and Edge read instead of `preventDefault`.
      event.returnValue = true;
    };
    target.addEventListener('beforeunload', onBeforeUnload);
    return () => target.removeEventListener('beforeunload', onBeforeUnload);
  }, [active, target]);
}
