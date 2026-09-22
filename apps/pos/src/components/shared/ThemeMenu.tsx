import { SunMoon } from 'lucide-react';
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

// Single compact trigger that opens a menu holding both surface theme controls
// (Staff + Display). Shared by the iPad station header and the mobile shell so
// the two surfaces stay in sync and we avoid duplicating the toggle wiring.
export function ThemeMenu({ triggerClassName }: ThemeMenuProps) {
  // Independent manual theme switches: one for the staff screens, one for the
  // customer-facing display. Both default to light and reset on reload.
  const [staffTheme, setStaffTheme] = useStaffTheme();
  const [customerTheme, setCustomerTheme] = useCustomerTheme();
  const { operator } = useOperator();

  const handleStaffToggle = () => {
    const next = staffTheme === 'dark' ? 'light' : 'dark';
    setStaffTheme(next);
    if (operator) setOperatorThemePref(operator.id, next, customerTheme);
  };

  const handleCustomerToggle = () => {
    const next = customerTheme === 'dark' ? 'light' : 'dark';
    setCustomerTheme(next);
    if (operator) setOperatorThemePref(operator.id, staffTheme, next);
  };

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
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {/* Keep the menu open while toggling so staff can flip both surfaces
            in one pass; each control still flips only its own surface. */}
        <DropdownMenuItem
          onSelect={(e) => e.preventDefault()}
          className="p-0 focus:bg-transparent"
        >
          <ThemeToggle
            theme={staffTheme}
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
            onToggle={handleCustomerToggle}
            label="Display"
            className="w-full justify-start"
          />
        </DropdownMenuItem>
        {/* SCRUM-238: `setOperatorThemePref` writes an in-memory map and no
            route stores it, so the choice cannot outlive the tab. Said here
            rather than left for staff to discover on the next reload. */}
        <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
          This device only, until reload (SCRUM-238).
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
