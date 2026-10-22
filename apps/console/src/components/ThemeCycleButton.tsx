import { Monitor, Moon, Sun } from 'lucide-react';
import {
  THEME_PREFERENCE_LABELS,
  nextThemePreference,
  type ThemePreference,
} from '@oto/shared/ui-preferences';
import { Button } from '@/components/ui/button';
import { useAccountTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

/** The words on the button: what it shows now, and what a press changes it to. */
export function themeButtonTitle(preference: ThemePreference): string {
  const next = nextThemePreference(preference);
  return `Theme: ${THEME_PREFERENCE_LABELS[preference]} — switch to ${THEME_PREFERENCE_LABELS[next].toLowerCase()}`;
}

interface ThemeCycleButtonOptions {
  className?: string;
  variant?: 'outline' | 'ghost';
}

/** The launcher's three-state control, in each existing Console toggle position. */
export function ThemeCycleButtonView({
  preference,
  onChange,
  className,
  variant = 'outline',
}: ThemeCycleButtonOptions & {
  preference: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  const Icon = ICONS[preference];
  const title = themeButtonTitle(preference);
  return (
    <Button
      type="button"
      variant={variant}
      size="icon"
      className={cn('h-9 w-9', className)}
      onClick={() => onChange(nextThemePreference(preference))}
      title={title}
      aria-label={title}
      data-theme-preference={preference}
    >
      <Icon className="w-4 h-4" />
    </Button>
  );
}

export function ThemeCycleButton({ className, variant }: ThemeCycleButtonOptions = {}) {
  const { preference, setPreference } = useAccountTheme();
  return <ThemeCycleButtonView preference={preference} onChange={setPreference} className={className} variant={variant} />;
}
