import { Monitor, Moon, Sun } from 'lucide-react';
import {
  THEME_PREFERENCE_LABELS,
  nextThemePreference,
  type ThemePreference,
} from '@oto/shared/ui-preferences';
import { Button } from '@/components/ui/button';
import { useAccountTheme } from '@/lib/accountTheme';

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

/** The words on the button: what it shows now, and what a press changes it to. */
export function themeButtonTitle(preference: ThemePreference): string {
  const next = nextThemePreference(preference);
  return `Theme: ${THEME_PREFERENCE_LABELS[preference]} — switch to ${THEME_PREFERENCE_LABELS[next].toLowerCase()}`;
}

/**
 * One button that steps light → dark → system (SCRUM-653). The icon and title
 * show the CURRENT choice, so 'system' is visible as a choice of its own rather
 * than as whichever of light or dark the device happens to be in.
 */
export function ThemeCycleButtonView({
  preference,
  onChange,
}: {
  preference: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  const Icon = ICONS[preference];
  const title = themeButtonTitle(preference);
  return (
    <Button
      variant="outline"
      size="icon"
      className="h-9 w-9"
      onClick={() => onChange(nextThemePreference(preference))}
      title={title}
      aria-label={title}
      data-theme-preference={preference}
    >
      <Icon className="w-4 h-4" />
    </Button>
  );
}

export function ThemeCycleButton() {
  const { preference, setPreference } = useAccountTheme();
  return <ThemeCycleButtonView preference={preference} onChange={setPreference} />;
}
