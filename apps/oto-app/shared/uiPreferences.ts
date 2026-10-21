/**
 * A person's theme and language, kept on their platform account (SCRUM-653).
 *
 * COPY. The master is `packages/shared/src/ui-preferences.ts` in the platform
 * workspace; the OTO App is lifted with npm and its own lockfile and cannot import
 * it, so the few lines it needs are repeated here verbatim in meaning: the
 * values, how 'system' resolves, reading them out of a `/me` answer, and the
 * body `PUT /me/preferences` takes. Radar holds the same copy
 * (`apps/radar/shared/uiPreferences.ts`). Change the master first.
 */

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const UI_LANGUAGES = ["en", "th"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export type ResolvedTheme = "light" | "dark";

export interface UiPreferences {
  theme: ThemePreference;
  language: UiLanguage;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === "string" && (UI_LANGUAGES as readonly string[]).includes(value);
}

/** 'system' becomes the device's own scheme at the moment it is applied. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

/** The preferences out of a platform `/me` answer; null when it carries none. */
export function readUiPreferences(me: unknown): UiPreferences | null {
  const prefs = (me as { preferences?: unknown } | null | undefined)?.preferences as
    | { theme?: unknown; language?: unknown }
    | null
    | undefined;
  if (!prefs || !isThemePreference(prefs.theme) || !isUiLanguage(prefs.language)) return null;
  return { theme: prefs.theme, language: prefs.language };
}

/**
 * The body of `PUT /me/preferences`: a theme, a language or both, and nothing
 * else. Null when the body is not one — the platform would refuse it anyway,
 * and saying so here keeps the refusal in Radar's own words.
 */
export function readPreferencesUpdate(body: unknown): Partial<UiPreferences> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { theme, language, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (theme === undefined && language === undefined) return null;
  if (theme !== undefined && !isThemePreference(theme)) return null;
  if (language !== undefined && !isUiLanguage(language)) return null;
  return {
    ...(theme !== undefined ? { theme } : {}),
    ...(language !== undefined ? { language } : {}),
  };
}
