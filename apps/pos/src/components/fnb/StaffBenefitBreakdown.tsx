import { Button } from '@/components/ui/button';
import { Gift, Trash2 } from 'lucide-react';

/**
 * Per-primitive relief breakdown for an applied staff benefit — shown
 * wherever the aggregate amount alone isn't enough (live cart preview,
 * receipt): comp / free items / credit / standing % discount, in the order
 * the engine applies them (lib/benefits.ts).
 */
export interface StaffBenefitBreakdownData {
  scannedOperatorName: string;
  compedTHB: number;
  freeItemsTHB: number;
  creditTHB: number;
  discountTHB: number;
  totalReliefTHB: number;
  /**
   * S2-21 round 3 (UI addition, plan §1 "When the box is offline") — the
   * stages this person has that the counter's box does not apply with the
   * link down: free items and credit draw on a quota the platform keeps, so
   * they say "Online only" and nothing is used. Absent online.
   */
  onlineOnly?: readonly ('freeItems' | 'credit')[];
}

/** The rows a box leaves for the platform, under the prototype's own labels. */
const ONLINE_ONLY_ROWS: { stage: 'freeItems' | 'credit'; label: string }[] = [
  { stage: 'freeItems', label: 'Free item(s)' },
  { stage: 'credit', label: 'Staff credit' },
];

const ROWS: { key: 'compedTHB' | 'freeItemsTHB' | 'creditTHB' | 'discountTHB'; label: string }[] = [
  { key: 'compedTHB', label: 'Comped (100% off)' },
  { key: 'freeItemsTHB', label: 'Free item(s)' },
  { key: 'creditTHB', label: 'Staff credit' },
  { key: 'discountTHB', label: 'Standing discount' },
];

export function StaffBenefitBreakdown({
  data,
  onRemove,
}: {
  data: StaffBenefitBreakdownData;
  onRemove?: () => void;
}) {
  const rows = ROWS.filter((r) => data[r.key] > 0);
  const onlineOnly = ONLINE_ONLY_ROWS.filter((r) => data.onlineOnly?.includes(r.stage));
  if ((rows.length === 0 || data.totalReliefTHB <= 0) && onlineOnly.length === 0) return null;

  return (
    <div className="text-emerald-500 bg-emerald-500/10 p-3 rounded-lg">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <Gift className="w-4 h-4 shrink-0" />
          <div className="font-medium text-sm truncate">Staff benefit</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-bold tabular-nums">-฿{data.totalReliefTHB}</span>
          {onRemove && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-emerald-500 hover:bg-emerald-500/20 hover:text-emerald-600"
              onClick={onRemove}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
      <div className="text-xs text-emerald-500/70 mb-1.5 truncate">Scanned: {data.scannedOperatorName}</div>
      <div className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between text-xs">
            <span className="text-emerald-500/80">{r.label}</span>
            <span className="tabular-nums font-semibold">-฿{data[r.key]}</span>
          </div>
        ))}
        {onlineOnly.map((r) => (
          <div key={r.stage} className="flex items-center justify-between text-xs">
            <span className="text-emerald-500/80">{r.label}</span>
            <span className="font-semibold">Online only</span>
          </div>
        ))}
      </div>
    </div>
  );
}
