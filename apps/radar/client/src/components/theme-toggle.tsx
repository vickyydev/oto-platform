import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className={`
        relative flex items-center justify-center w-9 h-9 sm:w-8 sm:h-8 rounded-full transition-all duration-200 select-none shrink-0
        ${theme === "dark"
          ? "bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700"
          : "bg-gradient-to-r from-pink-400 via-orange-400 to-yellow-400 text-white border-2 border-black shadow-[2px_2px_0px_rgba(0,0,0,0.8)] hover:shadow-[3px_3px_0px_rgba(0,0,0,0.8)] hover:translate-x-[-1px] hover:translate-y-[-1px] active:shadow-[1px_1px_0px_rgba(0,0,0,0.8)] active:translate-x-[1px] active:translate-y-[1px]"
        }
      `}
      data-testid="button-theme-toggle"
      title={theme === "dark" ? "Switch to Fun Mode" : "Switch to Dark Mode"}
    >
      {theme === "dark" ? (
        <Moon className="h-4 w-4" />
      ) : (
        <Sun className="h-4 w-4" />
      )}
    </button>
  );
}
