import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { isPlatformSession, savePlatformTheme, themeFromPlatform } from "@/lib/platformTheme";

type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  /**
   * SCRUM-653 — the person's choice from their suite account, as `/api/user`
   * answered it for a session opened from the launcher. Wins over the
   * localStorage fast-start value, and binds the toggles to write back.
   */
  adoptPlatformTheme: (user: unknown) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);
// useThemeOptional below reads this context tolerantly for providers above the theme tree.

const PREFERS_DARK = "(prefers-color-scheme: dark)";

function prefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(PREFERS_DARK).matches
    : false;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The first paint, before /api/user answers: localStorage is a fast-start
  // cache of the last theme shown in this browser.
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("theme") as Theme;
      if (stored === "light" || stored === "dark") return stored;
      return prefersDark() ? "dark" : "light";
    }
    return "light";
  });
  // True while the account's choice is 'system': follow the device.
  const [followSystem, setFollowSystem] = useState(false);
  // True for a launcher session: a toggle is written to the suite account.
  const writesBack = useRef(false);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!followSystem || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(PREFERS_DARK);
    const follow = () => setTheme(query.matches ? "dark" : "light");
    follow();
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [followSystem]);

  const adoptPlatformTheme = useCallback((user: unknown) => {
    writesBack.current = isPlatformSession(user);
    const adopted = themeFromPlatform(user, prefersDark());
    if (!adopted) return;
    setFollowSystem(adopted.followSystem);
    setTheme(adopted.theme);
  }, []);

  const toggleTheme = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    setFollowSystem(false);
    setTheme(next);
    // Written to the person's suite account, so every other app shows it too.
    if (writesBack.current) void savePlatformTheme(next);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, adoptPlatformTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

/** The context when a ThemeProvider is above, else null - for providers (auth)
 * that must work in harnesses mounted without the theme tree. */
export function useThemeOptional() {
  return useContext(ThemeContext);
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
