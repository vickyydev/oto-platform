// The Inbox's theme (SCRUM-653): light, dark, or the device's own choice,
// kept on the account so it follows the person between tills and tabs. The
// preference rides the platform profile — `GET /api/me` carries it when the
// preferences route has landed, `PUT /api/me/preferences` saves it — and both
// are optional: until that route exists the switch still works, in memory,
// starting from light, so this lane and the preferences lane land in either
// order.
import { useEffect, useState } from 'react';
import { ApiError, api } from '@/api/client';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_ORDER: readonly Theme[] = ['light', 'dark', 'system'];

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** The toggle cycles light → dark → system → light. */
export function nextTheme(theme: Theme): Theme {
  const at = THEME_ORDER.indexOf(theme);
  return THEME_ORDER[(at + 1) % THEME_ORDER.length] ?? 'light';
}

/** Whether the page shows dark, given the preference and the device's answer. */
export function resolvedDark(theme: Theme, systemDark: boolean): boolean {
  return theme === 'dark' || (theme === 'system' && systemDark);
}

/** The control's title: what is set now, and what one press does. */
export function themeTitle(theme: Theme): string {
  return `Theme: ${theme} — switch to ${nextTheme(theme)}`;
}

/** The account's saved preference out of the `GET /me` body, when it is there. */
export function themeFromMe(me: unknown): Theme | null {
  if (typeof me !== 'object' || me === null) return null;
  const prefs = (me as { preferences?: unknown }).preferences;
  if (typeof prefs !== 'object' || prefs === null) return null;
  const theme = (prefs as { theme?: unknown }).theme;
  return isTheme(theme) ? theme : null;
}

/** What the controller touches, injectable so the pins run without a browser. */
export interface ThemeEnv {
  /** `<html>`'s classList — the `dark` class lives on the root. */
  root: { classList: { toggle(name: string, force: boolean): void } };
  /** `(prefers-color-scheme: dark)`, for `system`. */
  media: {
    matches: boolean;
    addEventListener(type: 'change', listener: () => void): void;
    removeEventListener(type: 'change', listener: () => void): void;
  };
  /** `GET /me` — the profile, with `preferences.theme` once that lane lands. */
  readMe(): Promise<unknown>;
  /** `PUT /me/preferences` — absent until that lane lands (404). */
  writePreference(theme: Theme): Promise<void>;
}

export interface ThemeController {
  theme(): Theme;
  /** Read the saved preference and apply it; light when nothing is saved. */
  init(): Promise<void>;
  /** Apply at once, then save when the route exists; 404 keeps it in memory. */
  set(theme: Theme): void;
  subscribe(listener: () => void): () => void;
  /** Drop the system listener when the workspace closes. */
  dispose(): void;
}

export function createThemeController(env: ThemeEnv): ThemeController {
  let theme: Theme = 'light';
  const listeners = new Set<() => void>();

  const apply = () => {
    env.root.classList.toggle('dark', resolvedDark(theme, env.media.matches));
    for (const l of listeners) l();
  };

  // The device changing its mind matters only while the preference is to follow it.
  const onMedia = () => {
    if (theme === 'system') apply();
  };
  env.media.addEventListener('change', onMedia);

  return {
    theme: () => theme,

    async init() {
      try {
        theme = themeFromMe(await env.readMe()) ?? 'light';
      } catch {
        // No profile, or no preference yet: light, the page as it always was.
        theme = 'light';
      }
      apply();
    },

    set(next: Theme) {
      theme = next;
      apply();
      env.writePreference(next).catch((err: unknown) => {
        // 404: the preferences route has not landed — the choice holds in
        // memory for this visit. Anything else is just as non-fatal: a theme
        // that did not save still shows.
        if (err instanceof ApiError && err.status === 404) return;
      });
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      env.media.removeEventListener('change', onMedia);
    },
  };
}

/** The browser's real environment, wired to the platform api. */
function browserEnv(): ThemeEnv {
  return {
    root: document.documentElement,
    media: window.matchMedia('(prefers-color-scheme: dark)'),
    readMe: () => api.get<unknown>('/me'),
    writePreference: (theme: Theme) => api.put<void>('/me/preferences', { theme }),
  };
}

/** The header control's hook: the current theme, and the switch. */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const [controller] = useState(() => createThemeController(browserEnv()));
  const [theme, setThemeState] = useState<Theme>(controller.theme());
  useEffect(() => {
    const off = controller.subscribe(() => setThemeState(controller.theme()));
    void controller.init();
    return () => {
      off();
      controller.dispose();
    };
  }, [controller]);
  return { theme, setTheme: (t: Theme) => controller.set(t) };
}
