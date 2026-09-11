import { TxnStatus } from '@/types';
import { cn } from '@/lib/utils';

const CONFIG: Record<TxnStatus, { label: string; className: string }> = {
  paid: { label: 'Paid', className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  partially_refunded: {
    label: 'Partial refund',
    className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  },
  refunded: { label: 'Refunded', className: 'bg-rose-500/15 text-rose-400 border-rose-500/30' },
};

export function StatusBadge({ status, className }: { status: TxnStatus; className?: string }) {
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
