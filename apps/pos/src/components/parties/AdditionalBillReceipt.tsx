import type { PartyAdditionalBillReceipt } from '@oto/shared';

/**
 * SCRUM-1002 — AN ADDITIONAL BILL'S OWN RECEIPT, as the counter and phone
 * tills show it once the bill is paid in full: the platform's paper exactly as
 * the printer got it — its number, that bill's lines, the VAT line, the total
 * and how it was paid. Never the party's main bill or package: the guest who
 * paid this bill sees this bill only.
 */
export function AdditionalBillReceipt({
  receipt,
  name,
  className = '',
}: {
  receipt: PartyAdditionalBillReceipt;
  name: string;
  className?: string;
}) {
  const paper = receipt.document;
  const row = (label: string, value: string, strong = false) => (
    <div className={`flex items-center justify-between gap-3 ${strong ? 'font-bold' : ''}`}>
      <span className={strong ? '' : 'text-muted-foreground'}>{label}</span>
      <span className="tabular-nums shrink-0">{value}</span>
    </div>
  );
  return (
    <div className={`rounded-lg border p-4 space-y-2 text-sm text-left ${className}`} data-testid="additional-bill-receipt">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold">Receipt {receipt.receiptNumber ?? '—'}</span>
        <span className="text-xs text-muted-foreground">{name}</span>
      </div>
      {paper.dateTime && <p className="text-xs text-muted-foreground">{paper.dateTime}</p>}
      <div className="border-t pt-2 space-y-1">
        {paper.lines.map((line, at) => (
          <div key={at} className="flex items-center justify-between gap-3">
            <span className="min-w-0">{line.qty} x {line.name}</span>
            {line.price && <span className="tabular-nums shrink-0">{line.price}</span>}
          </div>
        ))}
      </div>
      <div className="border-t pt-2 space-y-1">
        {(paper.taxRows ?? []).map((tax, at) => <div key={at}>{row(tax.label, tax.amount)}</div>)}
        {row('Total', paper.total, true)}
      </div>
      {(paper.tenders ?? []).length > 0 && (
        <div className="border-t pt-2 space-y-1">
          {(paper.tenders ?? []).map((tender, at) => <div key={at}>{row(tender.label, tender.amount)}</div>)}
        </div>
      )}
    </div>
  );
}
