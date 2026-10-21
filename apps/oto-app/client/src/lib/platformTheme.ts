import {
  readUiPreferences,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "@shared/uiPreferences";

/**
 * The OTO App's theme, kept on the person's suite account (SCRUM-653; plan
 * docs/progress/plans/suite-ui-preferences/PLAN.md in the platform repo).
 *
 * The launcher's `apps/launcher/src/lib/accountTheme.ts` is the master of the
 * behaviour, and Radar's `client/src/lib/platformTheme.ts` is this file's
 * twin. The app keeps its own ThemeProvider and toggles and learns two things
 * here: what to paint once `/api/user` names the account's choice (a session
 * opened from the launcher carries `platformPreferences`), and how to write a
 * toggle back through the app's own `PUT /api/platform/preferences`. The
 * localStorage "theme" stays as the fast-start cache for the first paint.
 */

export interface PlatformTheme {
  /** What to paint now. */
  theme: ResolvedTheme;
  /** True while the account says 'system': keep following the device. */
  followSystem: boolean;
}

/** True when `/api/user` came from a launcher session, which can write back. */
export function isPlatformSession(user: unknown): boolean {
  return !!user && typeof user === "object" && "platformPreferences" in user;
}

/** The account's choice out of `/api/user`, resolved; null when it names none. */
export function themeFromPlatform(user: unknown, prefersDark: boolean): PlatformTheme | null {
  const prefs = readUiPreferences({
    preferences: (user as { platformPreferences?: unknown } | null | undefined)?.platformPreferences,
  });
  if (!prefs) return null;
  return { theme: resolveTheme(prefs.theme, prefersDark), followSystem: prefs.theme === "system" };
}

export interface SaveDeps {
  fetch: typeof fetch;
  newKey: () => string;
  /** Before the one retry. */
  wait: (ms: number) => Promise<void>;
}

const defaultDeps = (): SaveDeps => ({
  fetch: (...args) => fetch(...args),
  newKey: () =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `prefs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/**
 * Write a toggle to the account, fire-and-forget: one retry on the same
 * replay key, then give up quietly. The screen keeps the choice either way.
 * A refusal (4xx) is not retried: it will not change on a second asking.
 */
export async function savePlatformTheme(theme: ThemePreference, deps: SaveDeps = defaultDeps()): Promise<boolean> {
  const key = deps.newKey();
  const attempt = async (): Promise<"ok" | "refused" | "failed"> => {
    const res = await deps.fetch("/api/platform/preferences", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ theme }),
    });
    if (res.ok) return "ok";
    return res.status >= 400 && res.status < 500 ? "refused" : "failed";
  };
  try {
    const first = await attempt();
    if (first !== "failed") return first === "ok";
  } catch {
    // Offline or the app did not answer: one more try below.
  }
  await deps.wait(1500);
  try {
    return (await attempt()) === "ok";
  } catch {
    return false;
  }
}
