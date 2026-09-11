import { Sun, Moon } from 'lucide-react';
import type { Theme } from '@/lib/themePref';
import { cn } from '@/lib/utils';

interface ThemeToggleProps {
  theme: Theme;
  onToggle: () => void;
  // Short label describing which surface this controls (e.g. "Staff", "Display").
  label: string;
  className?: string;
}

// Compact dark/light switch used to flip a single surface's theme. Token-based so
// it reads correctly in whichever theme it currently sits in.
export function ThemeToggle({ theme, onToggle, label, className }: ThemeToggleProps) {
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={onToggle}
      title={`${label} theme: ${isDark ? 'dark' : 'light'} — tap for ${isDark ? 'light' : 'dark'}`}
      aria-label={`Switch ${label.toLowerCase()} theme to ${isDark ? 'light' : 'dark'}`}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 rounded-full border border-border bg-muted px-2.5 text-xs font-semibold text-muted-foreground hover-elevate active-elevate-2',
        className,
      )}
    >
      {isDark ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
