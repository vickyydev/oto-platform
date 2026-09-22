import { useEffect, useState } from 'react';
import { Sale, CreditGrant } from '@/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CheckCircle2, Baby, User, Printer, UtensilsCrossed, ShoppingBag } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { computeTotals } from '@/lib/sale';
import { summarizeTax, roundTHB } from '@/lib/tax';
import { getPrintTemplate } from '@/mockApi';
import { paymentMethodLabel } from '@/lib/payments';
import { salesApi } from '@/api/sales';
import { QrCode } from './QrCode';

/**
 * WHAT THIS SALE IS CALLED — SCRUM-203.
 *
 * The screen before this one promises a receipt number, and the number is the
 * platform's: allocated when the tender closed the sale, printed on the paper
 * in the visitor's hand, and the only handle either side of the counter can say
 * out loud. This screen used to show `sale.id` instead — a UUID nobody can read
 * back over a queue — so a visitor returning with a query and a member of staff
 * searching for their sale had no word in common.
 *
 * A sale the platform holds but has not numbered is a real state, not an error:
 * the row exists, in `tendering`, and the tender has not closed it. It says so
 * rather than reaching for an identifier.
 */
export type SaleNumber =
  /** Finalised: the platform allocated this number, e.g. "T2-000002". */
  | { kind: 'receipt'; number: string }
  /** The platform holds the sale and has not numbered it. */
  | { kind: 'recorded' }
  /** This screen has no answer about a number, and says nothing rather than guess. */
  | { kind: 'unknown' };

/** The platform's own sale ids are UUIDs; a till-local record carries something else. */
const PLATFORM_SALE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The sale's number, from the caller where the caller knows it and from the
 * platform where it does not.
 *
 * The ask is one GET on a screen where nothing is waiting on it — the receipt
 * and the bands have already printed — and it is skipped entirely for a sale
 * that was never offered to the platform. A refusal or a dead connection
 * leaves the screen without a number rather than with a wrong one.
 */
export function useSaleNumber(saleId: string, given?: SaleNumber): SaleNumber {
  const [asked, setAsked] = useState<SaleNumber>({ kind: 'unknown' });

  useEffect(() => {
    if (given || !PLATFORM_SALE_ID.test(saleId)) return;
    let live = true;
    setAsked({ kind: 'unknown' });
    void salesApi
      .get(saleId)
      .then(({ sale }) => {
        if (!live) return;
        setAsked(
          sale.receiptNumber
            ? { kind: 'receipt', number: sale.receiptNumber }
            : { kind: 'recorded' },
        );
      })
      .catch(() => {
        // Nothing to say about the number, which is what `unknown` means.
      });
    return () => {
      live = false;
    };
  }, [saleId, given]);

  return given ?? asked;
}

/** How the sale is named on screen, or null when this screen cannot name it. */
export function saleNumberLabel(number: SaleNumber): string | null {
  if (number.kind === 'receipt') return `Receipt ${number.number}`;
  if (number.kind === 'recorded') return 'Recorded — no receipt number yet';
  return null;
}

interface StepConfirmationProps {
  sale: Sale;
  onNewSale: () => void;
  /**
   * The sale's number where the caller already holds the platform's answer.
   * Left out, this screen asks the platform for it once.
   */
  saleNumber?: SaleNumber;
}

function CreditGrantRow({ voucher: grant, index }: { voucher: CreditGrant; index: number }) {
  const isCredit = grant.type === 'fnb_credit';
  return (
    <div className="flex items-center gap-4 bg-background border rounded-xl p-3 shrink-0">
      <QrCode seed={grant.id} className="w-16 h-16" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-muted-foreground text-sm font-medium">
          {isCredit ? (
            <UtensilsCrossed className="w-4 h-4" />
          ) : (
            <ShoppingBag className="w-4 h-4" />
          )}
          <span className="truncate">{grant.label}</span>
        </div>
        {isCredit ? (
          <div className="text-2xl font-bold text-primary leading-tight">
            ฿{grant.valueTHB} <span className="text-base font-medium text-muted-foreground">credit</span>
          </div>
        ) : (
          <div className="text-2xl font-bold leading-tight">
            ×{grant.quantity} <span className="text-base font-medium text-muted-foreground">to collect</span>
          </div>
        )}
      </div>
      <div className="text-xs text-muted-foreground font-mono shrink-0">#{index + 1}</div>
    </div>
  );
}

export function StepConfirmation({ sale, onNewSale, saleNumber }: StepConfirmationProps) {
  const resolvedNumber = useSaleNumber(sale.id, saleNumber);
  const numberLabel = saleNumberLabel(resolvedNumber);
  // Drop-off / nanny children's bands are issued through the door check-in choice
  // (now or later at check-in), never the standard sale print — so exclude their
  // lines from the "Bracelets to Print" panel.
  const braceletRows = sale.lines.filter((line) => !line.dropOff).flatMap((line) => {
    const rows: { id: string; kind: 'child' | 'adult'; count: number; duration: string; ticket: string }[] = [];
    if (line.kids > 0) {
      rows.push({ id: `${line.id}-c`, kind: 'child', count: line.kids, duration: line.ticketType.durationLabel, ticket: line.ticketType.name });
    }
    if (line.adults > 0) {
      rows.push({ id: `${line.id}-a`, kind: 'adult', count: line.adults, duration: line.ticketType.durationLabel, ticket: line.ticketType.name });
    }
    return rows;
  });

  const totalBracelets = braceletRows.reduce((sum, row) => sum + row.count, 0);
  // The sale's own figures, not a second computation of them (S2-09a): what is
  // read out here is what the platform charged. A sale with no quoted figures —
  // seeded history, a deployment with no ledger — still totals the old way.
  const taxRows =
    sale.quoted?.taxRows ??
    summarizeTax(computeTotals(sale.lines, sale.discounts ?? [], sale.manualDiscounts).taxBreakdown);

  // The receipt's CONTENT follows the active receipt template. Routing is
  // unchanged. With no template configured, default to showing the breakdown.
  const receiptTpl = getPrintTemplate('receipt');
  const showTaxBreakdown = receiptTpl ? !!receiptTpl.fields.taxServiceBreakdown : true;
  const showCreditInfo = receiptTpl ? !!receiptTpl.fields.voucherInfo : true;

  return (
    <div className="flex flex-col h-full animate-in zoom-in-95 duration-500">
      <div className="flex flex-col items-center justify-center text-center mb-6">
        <div className="w-20 h-20 bg-emerald-500/20 rounded-full flex items-center justify-center mb-3 text-emerald-500">
          <CheckCircle2 className="w-11 h-11" />
        </div>
        {receiptTpl?.headerText && (
          <p className="text-muted-foreground/80 text-sm font-semibold tracking-wide mb-1">
            {receiptTpl.headerText}
          </p>
        )}
        <h2 className="text-4xl font-bold tracking-tight">Payment Successful</h2>
        <p className="text-muted-foreground mt-2 text-xl">
          {[numberLabel, `฿${sale.total}`, paymentMethodLabel(sale.paymentMethod ?? '')]
            .filter(Boolean)
            .join(' • ')}
        </p>
        {showTaxBreakdown && taxRows.length > 0 && (
          <p className="text-muted-foreground/80 mt-1 text-sm">
            {taxRows.map((r) => `${r.label} ฿${roundTHB(r.amount)}`).join(' · ')}
          </p>
        )}
        {receiptTpl?.footerText && (
          <p className="text-muted-foreground/70 mt-1 text-xs italic">
            {receiptTpl.footerText}
          </p>
        )}
      </div>

      <div className="flex-1 grid grid-cols-2 gap-6 overflow-hidden">
        <Card className="p-6 flex flex-col bg-card/50 overflow-hidden">
          <div className="flex items-center justify-between mb-4 border-b pb-4">
            <div className="flex items-center gap-3">
              <Printer className="w-6 h-6 text-primary" />
              <h3 className="text-2xl font-bold">Bracelets to Print</h3>
            </div>
            <span className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
              {totalBracelets} total
            </span>
          </div>
          <ScrollArea className="flex-1 -mx-2 px-2">
            <div className="space-y-3">
              {braceletRows.map((row) => (
                <div
                  key={row.id}
                  className="flex items-center gap-4 bg-background border rounded-xl p-4 shrink-0"
                >
                  <div
                    className={cn(
                      'w-12 h-12 rounded-full flex items-center justify-center shrink-0',
                      row.kind === 'child' ? 'bg-primary/15 text-primary' : 'bg-sky-500/15 text-sky-400'
                    )}
                  >
                    {row.kind === 'child' ? <Baby className="w-6 h-6" /> : <User className="w-6 h-6" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-lg font-bold">
                      {row.count}× {row.kind === 'child' ? 'Child' : 'Adult'} bracelet{row.count > 1 ? 's' : ''}
                    </div>
                    <div className="text-sm text-muted-foreground truncate">
                      {row.duration} • {row.ticket}
                    </div>
                  </div>
                  <div
                    className={cn(
                      'px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide shrink-0',
                      row.kind === 'child' ? 'bg-primary/15 text-primary' : 'bg-sky-500/15 text-sky-400'
                    )}
                  >
                    {row.duration}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </Card>

        <Card className="p-6 flex flex-col bg-card/50 overflow-hidden">
          <div className="flex items-center justify-between mb-4 border-b pb-4">
            <div className="flex items-center gap-3">
              <UtensilsCrossed className="w-6 h-6 text-primary" />
              <h3 className="text-2xl font-bold">Credit Grants to Print</h3>
            </div>
            <span className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
              {sale.creditGrants.length} total
            </span>
          </div>
          {!showCreditInfo ? (
            <div className="flex-1 flex items-center justify-center text-center text-muted-foreground px-4">
              Credit details hidden by the receipt template.
            </div>
          ) : sale.creditGrants.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-center text-muted-foreground px-4">
              No credit grants for this order.
            </div>
          ) : (
            <ScrollArea className="flex-1 -mx-2 px-2">
              <div className="space-y-3">
                {sale.creditGrants.map((v, i) => (
                  <CreditGrantRow key={v.id} voucher={v} index={i} />
                ))}
              </div>
            </ScrollArea>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Button size="lg" className="w-full h-20 text-2xl font-bold" onClick={onNewSale}>
          Start New Sale
        </Button>
      </div>
    </div>
  );
}
