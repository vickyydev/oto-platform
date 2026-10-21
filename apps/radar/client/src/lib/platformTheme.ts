import {
  readUiPreferences,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "@shared/uiPreferences";

/**
 * Radar's theme, kept on the person's platform account (SCRUM-653; plan
 * docs/progress/plans/suite-ui-preferences/PLAN.md in the platform repo).
 *
 * The launcher's `apps/launcher/src/lib/accountTheme.ts` is the master of the
 * behaviour; Radar keeps its own ThemeProvider and toggle and only learns
 * two things from here: what to paint once `/api/me` names the account's
 * choice, and how to write a toggle back. Its localStorage "theme" stays as a
 * fast-start cache for the first paint before `/api/me` answers.
 */

export interface PlatformTheme {
  /** What to paint now. */
  theme: ResolvedTheme;
  /** True while the account says 'system': keep following the device. */
  followSystem: boolean;
}

/** The account's choice out of Radar's `/api/me` answer, resolved; null when it names none. */
export function themeFromPlatform(me: unknown, prefersDark: boolean): PlatformTheme | null {
  const prefs = readUiPreferences(me);
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
 * Write a toggle to the account through Radar's own proxy, fire-and-forget:
 * one retry on the same replay key, then give up quietly. The screen keeps the
 * choice either way. Resolves true when the platform took it.
 */
export async function savePlatformTheme(theme: ThemePreference, deps: SaveDeps = defaultDeps()): Promise<boolean> {
  const key = deps.newKey();
  const attempt = async () => {
    const res = await deps.fetch("/api/me/preferences", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ theme }),
    });
    return res.ok;
  };
  try {
    if (await attempt()) return true;
  } catch {
    // Offline or the proxy did not answer: one more try below.
  }
  await deps.wait(1500);
  try {
    return await attempt();
  } catch {
    return false;
  }
}
