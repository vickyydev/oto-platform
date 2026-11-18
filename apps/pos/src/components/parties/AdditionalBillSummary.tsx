import type { PartyAdditionalBill } from '@oto/shared';
import { satangText } from '@/lib/bahtText';

/**
 * SCRUM-1001 — THE PAYMENT STEP'S SUMMARY OF ONE ADDITIONAL BILL, the same on
 * the counter and phone tills. The guest paying it sees that bill only: its
 * own lines, its total, what was paid on it and what is left. Never the
 * party's package, deposit or first receipt — the parents settled those.
 */
export function AdditionalBillSummary({
  bill,
  name,
  className = '',
}: {
  bill: PartyAdditionalBill;
  name: string;
  className?: string;
}) {
  const items = bill.charges.flatMap((charge) => charge.items);
  // A charge taken for less than its lines (a discount) reconciles here, as the customer's bill does.
  const adjustment = bill.totalSatang - items.reduce((sum, item) => sum + item.lineTotalSatang, 0);
  return (
    <div className={`rounded-lg border p-4 space-y-2 text-sm ${className}`} data-testid="additional-bill-summary">
      <div className="font-semibold">{name}</div>
      {items.map((item, at) => (
        <div key={at} className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground min-w-0">{item.qty} x {item.name}</span>
          <span className="tabular-nums shrink-0">฿{satangText(item.lineTotalSatang)}</span>
        </div>
      ))}
      {adjustment !== 0 && (
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{adjustment < 0 ? 'Discount' : 'Adjustment'}</span>
          <span className="tabular-nums">{adjustment < 0 ? '−' : '+'}฿{satangText(Math.abs(adjustment))}</span>
        </div>
      )}
      <div className="flex items-center justify-between border-t pt-2 mt-1">
        <span className="text-muted-foreground">Total</span>
        <span className="tabular-nums">฿{satangText(bill.totalSatang)}</span>
      </div>
      {bill.paidSatang > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Payments taken</span>
          <span className="tabular-nums">−฿{satangText(bill.paidSatang)}</span>
        </div>
      )}
      <div className="flex items-center justify-between border-t pt-2 mt-1 font-bold">
        <span>Outstanding</span>
        <span className="text-2xl tabular-nums">฿{satangText(bill.outstandingSatang)}</span>
      </div>
    </div>
  );
}
