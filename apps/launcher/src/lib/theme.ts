import { useCallback, useSyncExternalStore } from 'react';

// The POS's mechanism (apps/pos/src/lib/themePref.ts): a manual light/dark
// choice held in module memory, defaulting to light and resetting on reload.
// Kept identical so the two apps cannot drift apart on the one thing a person
// notices immediately.
export type Theme = 'dark' | 'light';

let theme: Theme = 'light';
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): [Theme, (value: Theme | ((prev: Theme) => Theme)) => void] {
  const value = useSyncExternalStore(subscribe, () => theme);
  const set = useCallback((next: Theme | ((prev: Theme) => Theme)) => {
    theme = typeof next === 'function' ? next(theme) : next;
    listeners.forEach((l) => l());
  }, []);
  return [value, set];
}
