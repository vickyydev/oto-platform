import { useSyncExternalStore } from 'react';
import {
  PREFERS_DARK_QUERY,
  createThemeController,
  type ColorSchemeQuery,
  type ResolvedTheme,
  type ThemeController,
  type ThemePreference,
  type ThemeRoot,
} from '@oto/shared/ui-preferences';
import { preferencesApi } from '../api/platform';

/**
 * Console wiring of the person's account theme (SCRUM-654), copied from
 * apps/launcher/src/lib/accountTheme.ts, the master wiring. The rule and
 * controller are `@oto/shared/ui-preferences`; this file supplies the root,
 * the device's colour scheme and this app's own preferences client.
 *
 * Before sign-in the page shows light. SessionContext adopts the account's
 * choice and releases it at sign-out. A toggle applies at once and, while
 * signed in, writes back with one retry. Nothing goes to browser storage.
 */
function root(): ThemeRoot | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

function colorScheme(): ColorSchemeQuery | null {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(PREFERS_DARK_QUERY);
}

function newKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `prefs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface AccountThemeDeps {
  root: () => ThemeRoot | null;
  colorScheme: () => ColorSchemeQuery | null;
  write: (body: { theme: ThemePreference }, idempotencyKey: string) => Promise<unknown>;
  newKey: () => string;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

export function createAccountTheme(deps: AccountThemeDeps): ThemeController {
  return createThemeController({
    initial: 'light',
    root: deps.root,
    colorScheme: deps.colorScheme,
    write: deps.write,
    newKey: deps.newKey,
    setTimeout: deps.setTimeout,
  });
}

/** The one controller this page has. */
export const accountTheme = createAccountTheme({
  root,
  colorScheme,
  write: (body, key) => preferencesApi.put(body, key),
  newKey,
});

export interface AccountThemeValue {
  /** The person's choice, 'system' included — what the toggle shows. */
  preference: ThemePreference;
  /** What is painted. */
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

export function useAccountTheme(controller: ThemeController = accountTheme): AccountThemeValue {
  const preference = useSyncExternalStore(controller.subscribe, controller.preference, controller.preference);
  const resolved = useSyncExternalStore(controller.subscribe, controller.resolved, controller.resolved);
  return { preference, resolved, setPreference: controller.set };
}
