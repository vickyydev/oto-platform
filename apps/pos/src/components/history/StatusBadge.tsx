import { TxnStatus } from '@/types';
import { cn } from '@/lib/utils';

/**
 * SCRUM-238 — two states the prototype never had.
 *
 * Its three badges all describe money that was taken. The platform's ledger
 * also holds an order that was rung up and never paid for (`tendering`) and one
 * that was voided, and both turn up in a real day's History. Showing either as
 * "Paid" would put a figure in front of staff that nobody collected, so they get
 * their own words in the same badge.
 */
type BadgeStatus = TxnStatus | 'unpaid' | 'voided';

const CONFIG: Record<BadgeStatus, { label: string; className: string }> = {
  paid: { label: 'Paid', className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  partially_refunded: {
    label: 'Partial refund',
    className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  },
  refunded: { label: 'Refunded', className: 'bg-rose-500/15 text-rose-400 border-rose-500/30' },
  unpaid: {
    label: 'Unpaid',
    className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  },
  voided: { label: 'Voided', className: 'bg-muted text-muted-foreground border-border' },
};

export function StatusBadge({ status, className }: { status: BadgeStatus; className?: string }) {
  const { label, className: tone } = CONFIG[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        tone,
        className,
      )}
    >
      {label}
    </span>
  );
}
