/**
 * A PERSON'S LOOK, KEPT ON THEIR ACCOUNT (SCRUM-653; plan
 * docs/progress/plans/suite-ui-preferences/PLAN.md).
 *
 * Theme and language live on `core.account` (`ui_theme`, `ui_language`), are
 * answered by `GET /me` as `preferences`, and are written by
 * `PUT /me/preferences`. Every staff app reads them after sign-in and writes
 * them back from its own toggle, so the choice follows the person from the
 * launcher to the till to the console instead of resetting per app and per
 * reload.
 *
 * This file is the rule, written once: the values, the request body, how
 * 'system' becomes light or dark, the order a toggle cycles in — and a small
 * framework-free controller each React app wraps in a hook of its own
 * (`lib/accountTheme.ts` in the launcher, `lib/themePref.ts` in the till).
 * Nothing here touches browser storage: the till's rule is that nothing lands
 * there, and the account is the store.
 *
 * The DOM is reached through two structural types below rather than the DOM
 * lib, so the package still compiles for the api.
 */
import { z } from 'zod';

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** Staff-side languages. Customer-facing screens keep their own wider lists. */
export const UI_LANGUAGES = ['en', 'th'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/** What a screen actually paints. 'system' is never painted; it is resolved. */
export type ResolvedTheme = 'light' | 'dark';

export interface UiPreferences {
  theme: ThemePreference;
  language: UiLanguage;
}

/** The column defaults: follow the device, English. */
export const DEFAULT_UI_PREFERENCES: UiPreferences = { theme: 'system', language: 'en' };

/**
 * `PUT /me/preferences`. Either field may be sent alone, so one app changing
 * the theme cannot overwrite a language another app changed a moment ago with
 * the value it read at sign-in. At least one is required.
 */
export const uiPreferencesUpdateSchema = z
  .object({
    theme: z.enum(THEME_PREFERENCES).optional(),
    language: z.enum(UI_LANGUAGES).optional(),
  })
  .strict()
  .refine((body) => body.theme !== undefined || body.language !== undefined, {
    message: 'Send a theme, a language or both',
  });
export type UiPreferencesUpdate = z.infer<typeof uiPreferencesUpdateSchema>;

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && (UI_LANGUAGES as readonly string[]).includes(value);
}

/**
 * The preferences out of a `/me` answer, or null when it carries none — an
 * older api during a rolling deploy answers without them, and that must read
 * as "nothing to adopt", not as a reset to the defaults.
 */
export function readUiPreferences(me: unknown): UiPreferences | null {
  const prefs = (me as { preferences?: unknown } | null | undefined)?.preferences as
    | { theme?: unknown; language?: unknown }
    | null
    | undefined;
  if (!prefs || !isThemePreference(prefs.theme) || !isUiLanguage(prefs.language)) return null;
  return { theme: prefs.theme, language: prefs.language };
}

/** The media query 'system' follows. */
export const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

/** 'system' becomes the device's own scheme at the moment it is applied. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

/** The order one toggle button steps through: light → dark → system → light. */
export function nextThemePreference(preference: ThemePreference): ThemePreference {
  return preference === 'light' ? 'dark' : preference === 'dark' ? 'system' : 'light';
}

export const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

// --- The controller -----------------------------------------------------------

/** The document root, as far as this needs it. */
export interface ThemeRoot {
  classList: { toggle(token: string, force?: boolean): boolean };
}

/** A `MediaQueryList`, as far as this needs it. */
export interface ColorSchemeQuery {
  matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

export interface ThemeControllerOptions {
  /** What shows before anybody has signed in on this page. */
  initial: ThemePreference;
  /** The element that carries `dark`/`light`; null where there is none (a test). */
  root: () => ThemeRoot | null;
  /** `window.matchMedia(PREFERS_DARK_QUERY)`; null where there is none. */
  colorScheme: () => ColorSchemeQuery | null;
  /** `PUT /me/preferences` with this body and replay key. */
  write: (body: { theme: ThemePreference }, idempotencyKey: string) => Promise<unknown>;
  newKey: () => string;
  /** Before the one retry. */
  retryDelayMs?: number;
  /** After the retry failed too. The screen keeps the choice either way. */
  onWriteFailed?: (err: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

export interface ThemeController {
  /** The person's choice, 'system' included. */
  preference(): ThemePreference;
  /** What is painted now. */
  resolved(): ResolvedTheme;
  subscribe(listener: () => void): () => void;
  /** Paint the current choice and follow the device while it is 'system'. Returns the stop. */
  start(): () => void;
  /**
   * The account's choice from `/me`, at sign-in or resume. Applies it and
   * binds write-back to the account. Null (an api without preferences) binds
   * write-back and keeps what is painted.
   */
  adopt(preferences: Pick<UiPreferences, 'theme'> | null | undefined): void;
  /** Sign-out: stop writing to an account. What is painted stays until the next sign-in. */
  release(): void;
  /** A toggle: applies at once, and writes to the account when one is signed in. */
  set(preference: ThemePreference): void;
  /** True while a choice is written back to an account. */
  bound(): boolean;
}

export function createThemeController(options: ThemeControllerOptions): ThemeController {
  const later = options.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const retryDelayMs = options.retryDelayMs ?? 1500;
  let preference: ThemePreference = options.initial;
  let painted: ResolvedTheme = 'light';
  let accountBound = false;
  /** Bumped by every write, so a retry of a choice already replaced is dropped. */
  let generation = 0;
  const listeners = new Set<() => void>();

  const prefersDark = () => options.colorScheme()?.matches ?? false;

  function paint(): void {
    painted = resolveTheme(preference, prefersDark());
    const root = options.root();
    if (root) {
      root.classList.toggle('dark', painted === 'dark');
      root.classList.toggle('light', painted === 'light');
    }
  }

  function changed(): void {
    paint();
    listeners.forEach((listener) => listener());
  }

  function writeBack(value: ThemePreference): void {
    const mine = ++generation;
    const key = options.newKey();
    const failed = (err: unknown) => options.onWriteFailed?.(err);
    options.write({ theme: value }, key).catch(() => {
      later(() => {
        // A newer choice, or a sign-out, has happened since: this one is moot.
        if (mine !== generation || !accountBound) return;
        options.write({ theme: value }, key).catch(failed);
      }, retryDelayMs);
    });
  }

  paint();

  return {
    preference: () => preference,
    resolved: () => painted,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      paint();
      const query = options.colorScheme();
      const onDeviceChange = () => {
        if (preference === 'system') changed();
      };
      query?.addEventListener?.('change', onDeviceChange);
      return () => query?.removeEventListener?.('change', onDeviceChange);
    },
    adopt(preferences) {
      accountBound = true;
      generation++;
      if (preferences && isThemePreference(preferences.theme)) {
        preference = preferences.theme;
        changed();
      }
    },
    release() {
      accountBound = false;
      generation++;
    },
    set(next) {
      if (!isThemePreference(next)) return;
      preference = next;
      changed();
      if (accountBound) writeBack(next);
    },
    bound: () => accountBound,
  };
}
