import { useCallback, useSyncExternalStore } from 'react';
import {
  PREFERS_DARK_QUERY,
  createThemeController,
  type ColorSchemeQuery,
  type ResolvedTheme,
  type ThemeController,
  type ThemePreference,
  type ThemeRoot,
} from '@oto/shared/ui-preferences';
import { preferencesApi } from '@/api/platform';
import { idemKey } from '@/api/client';
import { customerDisplayTheme } from '@/lib/displayTheme';

// Independent manual dark/light theme for the two surfaces of the POS:
//   - the STAFF screens (drives document root, so portaled dialogs/toasts follow)
//   - the CUSTOMER-facing display(s) shown alongside in the split-screen harness
//
// The STAFF theme is the person's own, kept on their account (SCRUM-653; plan
// docs/progress/plans/suite-ui-preferences/PLAN.md): adopted from `/me` at
// sign-in, written back by the staff toggle, and the same choice the launcher
// and the console show them. 'system' follows the device. The controller is
// `@oto/shared/ui-preferences`, wired here the way the launcher's master copy
// (`apps/launcher/src/lib/accountTheme.ts`) wires it. Before anyone signs in
// the till shows light, as it always has.
//
// The DISPLAY theme is a property of this device, not of whoever is signed in
// at it, so it stays in module memory as before (`lib/displayTheme.ts`, which
// since SCRUM-929 also tells a paired display when Display is pressed). Neither
// value touches the till's browser storage, per the app's hard rules: the
// account is the store.
export type Theme = 'dark' | 'light';

type Updater = Theme | ((prev: Theme) => Theme);

function root(): ThemeRoot | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

function colorScheme(): ColorSchemeQuery | null {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(PREFERS_DARK_QUERY);
}

export interface StaffThemeDeps {
  root: () => ThemeRoot | null;
  colorScheme: () => ColorSchemeQuery | null;
  write: (body: { theme: ThemePreference }, idempotencyKey: string) => Promise<unknown>;
  newKey: () => string;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

export function createStaffTheme(deps: StaffThemeDeps): ThemeController {
  return createThemeController({ initial: 'light', ...deps });
}

/** The staff screens' one controller. `OperatorProvider` adopts and releases it. */
export const staffThemeController = createStaffTheme({
  root,
  colorScheme,
  write: (body, key) => preferencesApi.put(body, key),
  newKey: idemKey,
});

export interface StaffThemeValue {
  /** The person's choice, 'system' included — what the staff toggle shows. */
  preference: ThemePreference;
  /** What the staff screens paint. */
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

// Theme of the staff screens. All mounted staff surfaces stay in sync.
export function useStaffTheme(controller: ThemeController = staffThemeController): StaffThemeValue {
  const preference = useSyncExternalStore(controller.subscribe, controller.preference, controller.preference);
  const resolved = useSyncExternalStore(controller.subscribe, controller.resolved, controller.resolved);
  return { preference, resolved, setPreference: controller.set };
}

// Theme of the customer-facing display(s). Independent of the staff theme.
// The setter is a restore (the sign-in's), not a press: a press of Display
// goes through `customerDisplayTheme.choose` so a paired display is told.
export function useCustomerTheme(): [Theme, (value: Updater) => void] {
  const value = useSyncExternalStore(customerDisplayTheme.subscribe, customerDisplayTheme.get);
  const set = useCallback((next: Updater) => {
    customerDisplayTheme.restore(typeof next === 'function' ? next(customerDisplayTheme.get()) : next);
  }, []);
  return [value, set];
}
