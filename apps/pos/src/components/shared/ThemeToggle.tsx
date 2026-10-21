import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemePreference } from '@oto/shared/ui-preferences';
import { cn } from '@/lib/utils';

interface ThemeToggleProps {
  /** What this surface shows now. The Display row only ever passes light or dark. */
  theme: ThemePreference;
  /** What a tap changes it to. */
  next: ThemePreference;
  onToggle: () => void;
  // Short label describing which surface this controls (e.g. "Staff", "Display").
  label: string;
  className?: string;
}

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

// Compact theme switch used to step a single surface's theme. Token-based so it
// reads correctly in whichever theme it currently sits in. The Staff row steps
// light → dark → system (SCRUM-653); the Display row flips light ↔ dark.
export function ThemeToggle({ theme, next, onToggle, label, className }: ThemeToggleProps) {
  const Icon = ICONS[theme];
  return (
    <button
      type="button"
      onClick={onToggle}
      title={`${label} theme: ${theme} — tap for ${next}`}
      aria-label={`Switch ${label.toLowerCase()} theme to ${next}`}
      data-theme-preference={theme}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 rounded-full border border-border bg-muted px-2.5 text-xs font-semibold text-muted-foreground hover-elevate active-elevate-2',
        className,
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
