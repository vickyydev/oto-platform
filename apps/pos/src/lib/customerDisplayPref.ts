import { useCallback, useSyncExternalStore } from 'react';

// Whether the staff wants the side-by-side customer display shown. This is a
// test-harness/operator preference, NOT sale data — so it lives in module memory
// (no browser storage, per the app's hard rules) and survives navigating between
// staff screens or remounting a screen. It only resets on a full page reload.
let showCustomerDisplay = true;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type Updater = boolean | ((prev: boolean) => boolean);

// Shared toggle for the customer display across every staff surface. All mounted
// instances stay in sync and the choice persists until toggled again.
export function useCustomerDisplayPref(): [boolean, (value: Updater) => void] {
  const value = useSyncExternalStore(subscribe, () => showCustomerDisplay);
  const set = useCallback((next: Updater) => {
    showCustomerDisplay = typeof next === 'function' ? next(showCustomerDisplay) : next;
    listeners.forEach((l) => l());
  }, []);
  return [value, set];
}
