import { useState } from 'react';
import { Banknote } from 'lucide-react';
import { useCashDrawer } from '@/components/eod/useCashDrawer';
import { CashDrawerDialog } from '@/components/eod/CashDrawerDialog';
import { cn } from '@/lib/utils';

/**
 * S2-15a round 1 — the station header's "Cash" action (UI addition, plan
 * docs/progress/plans/cash/PLAN.md §2.2): this counter's drawer — open it,
 * see what it should hold, record a paid-out, safe drop or top-up, and count
 * and close it. Shown only when the till works a platform station; a dot says
 * whether the drawer is open. The header's own button styling, unchanged.
 */
export function CashDrawerButton({ className }: { className: string }) {
  const drawer = useCashDrawer();
  const [open, setOpen] = useState(false);
  if (!drawer.stationId) return null;
  if (drawer.view && !drawer.view.station.hasDrawer) return null;
  const isOpen = drawer.view?.session?.status === 'open';
  return (
    <>
      <button
        type="button"
        className={className}
        title={isOpen ? 'Cash drawer — open' : 'Cash drawer — closed'}
        onClick={() => {
          drawer.reload();
          setOpen(true);
        }}
      >
        <span className="relative">
          <Banknote className="w-4 h-4" />
          <span
            aria-hidden
            className={cn(
              'absolute -top-1 -right-1 h-2 w-2 rounded-full',
              isOpen ? 'bg-emerald-500' : 'bg-muted-foreground/50',
            )}
          />
        </span>
        Cash
      </button>
      <CashDrawerDialog open={open} onOpenChange={setOpen} view={drawer.view} error={drawer.error} />
    </>
  );
}
