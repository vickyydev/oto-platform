import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { savePlatformTheme, themeFromPlatform } from "@/lib/platformTheme";

type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  /**
   * SCRUM-653 — the person's choice from their platform account, as Radar's
   * `/api/me` answered it. Wins over the localStorage fast-start value.
   */
  adoptPlatformTheme: (me: unknown) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const PREFERS_DARK = "(prefers-color-scheme: dark)";

function prefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(PREFERS_DARK).matches
    : false;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The first paint, before /api/me answers: localStorage is a fast-start
  // cache of the last theme shown here, nothing more.
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

  const adoptPlatformTheme = useCallback((me: unknown) => {
    const adopted = themeFromPlatform(me, prefersDark());
    if (!adopted) return;
    setFollowSystem(adopted.followSystem);
    setTheme(adopted.theme);
  }, []);

  const toggleTheme = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    setFollowSystem(false);
    setTheme(next);
    // Written to the person's account, so every other app shows it too.
    void savePlatformTheme(next);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, adoptPlatformTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
