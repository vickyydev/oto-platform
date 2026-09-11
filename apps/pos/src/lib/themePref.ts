import { useCallback, useSyncExternalStore } from 'react';

// Independent manual dark/light theme for the two surfaces of the POS:
//   - the STAFF screens (drives document root, so portaled dialogs/toasts follow)
//   - the CUSTOMER-facing display(s) shown alongside in the split-screen harness
//
// These are operator/harness preferences, NOT sale data, so they live in module
// memory (no browser storage, per the app's hard rules). Both default to light and
// reset to light on a full page reload. The two values are fully independent so all
// four staff×customer theme combinations work simultaneously.
export type Theme = 'dark' | 'light';

let staffTheme: Theme = 'light';
let customerTheme: Theme = 'light';

const staffListeners = new Set<() => void>();
const customerListeners = new Set<() => void>();

type Updater = Theme | ((prev: Theme) => Theme);

function subscribeStaff(listener: () => void) {
  staffListeners.add(listener);
  return () => staffListeners.delete(listener);
}

function subscribeCustomer(listener: () => void) {
  customerListeners.add(listener);
  return () => customerListeners.delete(listener);
}

// Theme of the staff screens. All mounted staff surfaces stay in sync.
export function useStaffTheme(): [Theme, (value: Updater) => void] {
  const value = useSyncExternalStore(subscribeStaff, () => staffTheme);
  const set = useCallback((next: Updater) => {
    staffTheme = typeof next === 'function' ? next(staffTheme) : next;
    staffListeners.forEach((l) => l());
  }, []);
  return [value, set];
}

// Theme of the customer-facing display(s). Independent of the staff theme.
export function useCustomerTheme(): [Theme, (value: Updater) => void] {
  const value = useSyncExternalStore(subscribeCustomer, () => customerTheme);
  const set = useCallback((next: Updater) => {
    customerTheme = typeof next === 'function' ? next(customerTheme) : next;
    customerListeners.forEach((l) => l());
  }, []);
  return [value, set];
}
