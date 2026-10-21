import { SunMoon } from 'lucide-react';
import { nextThemePreference } from '@oto/shared/ui-preferences';
import { ThemeToggle } from '@/components/shared/ThemeToggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useStaffTheme, useCustomerTheme } from '@/lib/themePref';
import { setOperatorThemePref } from '@/mockApi';
import { useOperator } from '@/auth/OperatorContext';
import { cn } from '@/lib/utils';

interface ThemeMenuProps {
  /** Extra classes for the trigger button (e.g. sizing per surface). */
  triggerClassName?: string;
}

/**
 * The theme controls themselves: the Staff and Display switches and the note
 * under them. Shared by `ThemeMenu`'s own menu and the phone bar's overflow
 * menu (SCRUM-509), which folds the theme and Station setup into one button on
 * a narrow phone so the Lock button always stays on screen.
 */
export function ThemeMenuItems() {
  // Independent theme switches: one for the staff screens, one for the
  // customer-facing display. The staff one is the signed-in person's own and
  // is kept on their account (SCRUM-653); the display one is this device's
  // and resets on reload.
  const staff = useStaffTheme();
  const [customerTheme, setCustomerTheme] = useCustomerTheme();
  const { operator } = useOperator();
  const staffNext = nextThemePreference(staff.preference);
  const customerNext = customerTheme === 'dark' ? 'light' : 'dark';

  const handleStaffToggle = () => {
    staff.setPreference(staffNext);
  };

  const handleCustomerToggle = () => {
    setCustomerTheme(customerNext);
    if (operator) setOperatorThemePref(operator.id, staff.resolved, customerNext);
  };

  return (
    <>
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      {/* Keep the menu open while toggling so staff can flip both surfaces
          in one pass; each control still flips only its own surface. */}
      <DropdownMenuItem
        onSelect={(e) => e.preventDefault()}
        className="p-0 focus:bg-transparent"
      >
        <ThemeToggle
          theme={staff.preference}
          next={staffNext}
          onToggle={handleStaffToggle}
          label="Staff"
          className="w-full justify-start"
        />
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={(e) => e.preventDefault()}
        className="p-0 focus:bg-transparent"
      >
        <ThemeToggle
          theme={customerTheme}
          next={customerNext}
          onToggle={handleCustomerToggle}
          label="Display"
          className="w-full justify-start"
        />
      </DropdownMenuItem>
      {/* SCRUM-238 / SCRUM-653: the Staff choice is kept on the person's
          account and follows them to the launcher and the console; the
          Display choice is an in-memory map no route stores, so it cannot
          outlive the tab. Said here rather than left for staff to discover. */}
      <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
        Staff follows your account. Display: this device only, until reload.
      </p>
    </>
  );
}

// Single compact trigger that opens a menu holding both surface theme controls
// (Staff + Display). Shared by the iPad station header and the mobile shell so
// the two surfaces stay in sync and we avoid duplicating the toggle wiring.
export function ThemeMenu({ triggerClassName }: ThemeMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Theme settings"
          aria-label="Theme settings"
          className={cn(
            'inline-flex items-center justify-center h-8 w-8 rounded-full border border-border bg-muted text-muted-foreground hover-elevate active-elevate-2',
            triggerClassName,
          )}
        >
          <SunMoon className="w-4 h-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <ThemeMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
