import { useEffect, useState, type ReactNode } from 'react';
import { Sale, CreditGrant } from '@/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CheckCircle2, Baby, User, Printer, UtensilsCrossed, ShoppingBag } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { getPrintTemplate } from '@/mockApi';
import { paymentMethodLabel } from '@/lib/payments';
import { bandsByCartLine, getSale, type ApiSaleBand, type ApiSaleLine, type ApiSalePrintJob } from '@/api/history';
import type { BoxSaleIssue } from '@/api/boxSales';
import { reportsCreditVoucher } from '@/lib/salePrinting';
import { grantsOf, walletQrFor, type ApiWalletGrant } from '@/api/wallet';
import { platformId, shownBaht, taxRowsOf, ticketTotals } from '@/lib/cartWire';
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
 * What the platform issued for this sale: its number and — S2-11 (SCRUM-208) —
 * the bands it minted, by short code, with the lines that place each band on
 * its bracelet row.
 *
 * The number comes from the caller where the caller knows it and from the
 * platform where it does not. The ask is one GET on a screen where nothing is
 * waiting on it — the receipt and the bands have already been queued — and it
 * is skipped entirely for a sale that was never offered to the platform. A
 * refusal or a dead connection leaves the screen without a number and without
 * codes rather than with wrong ones.
 */
export interface SaleIssue {
  number: SaleNumber;
  /** Null until the platform has answered, or when it answered with no bands field at all. */
  bands: ApiSaleBand[] | null;
  lines: Pick<ApiSaleLine, 'id' | 'cartLineId'>[];
  /**
   * SCRUM-208 — the sale's print jobs, so the "Credit Grants to Print" block is
   * shown only when the platform reported a credit-voucher printout. Null until
   * the read lands (or when it carries none).
   */
  printJobs: ApiSalePrintJob[] | null;
  /**
   * S2-14a — the wallets the platform granted for this sale, each with the ONE
   * QR its voucher printed. The credit rows draw that QR rather than one
   * seeded from the till's grant id. Null until the read lands.
   */
  grants: ApiWalletGrant[] | null;
}

export function useSaleIssue(saleId: string, given?: SaleNumber, box?: BoxSaleIssue | null): SaleIssue {
  const [asked, setAsked] = useState<SaleIssue>({ number: { kind: 'unknown' }, bands: null, lines: [], printJobs: null, grants: null });

  useEffect(() => {
    // The box lane already answered with its bands (offline finding 3): the
    // platform's read is unreachable, so nothing is asked and the codes come
    // from the finalise answer instead, drawn by the same rows below.
    if (box || !PLATFORM_SALE_ID.test(saleId)) return;
    let live = true;
    setAsked({ number: { kind: 'unknown' }, bands: null, lines: [], printJobs: null, grants: null });
    void getSale(saleId)
      .then((detail) => {
        if (!live) return;
        setAsked({
          number: detail.sale.receiptNumber
            ? { kind: 'receipt', number: detail.sale.receiptNumber }
            : { kind: 'recorded' },
          bands: detail.bands ?? null,
          lines: detail.lines ?? [],
          printJobs: detail.printJobs ?? null,
          grants: grantsOf(detail),
        });
      })
      .catch(() => {
        // Nothing to say about the number or the codes, which is what `unknown` means.
      });
    return () => {
      live = false;
    };
  }, [saleId, box]);

  if (box) {
    const fromBox: SaleIssue = {
      number: box.receiptNumber ? { kind: 'receipt', number: box.receiptNumber } : { kind: 'recorded' },
      bands: box.bands,
      lines: box.lines,
      // The platform's print-job read is what shows the credit-voucher block;
      // the box lane does not carry it, so nothing pretends it did.
      printJobs: null,
      grants: null,
    };
    return given ? { ...fromBox, number: given } : fromBox;
  }

  return given ? { ...asked, number: given } : asked;
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
  /**
   * S2-10b — one line under the amount, for what the payment also did: the
   * Lucky Wheel voucher it used up (`components/till/RedeemVoucher`).
   */
  note?: ReactNode;
  /**
   * The bands a sale closed on the box lane minted (offline finding 3). When
   * present, the screen reads its codes from here rather than the platform's
   * sale read, which is unreachable offline.
   */
  boxIssue?: BoxSaleIssue | null;
}

/**
 * SCRUM-484 — WHY THE ROWS FIT THEIR COLUMN. Radix draws a scroll area's
 * content in a `display: table` box, and a table is as wide as its content's
 * narrowest possible layout — which, for a row with a one-line `truncate`
 * caption, is the WHOLE caption. With the Credit Grants column beside it the
 * bracelets column is half the width, so every row was laid out wider than
 * the card and the card cut off its right end: "ALL DAY + MEAL" read "ALL",
 * a "1 Hour" badge vanished, and the credit rows lost their label's end and
 * their number. As a block the content is the column's width, the captions
 * truncate as they were meant to, and the badge keeps its place (the same
 * override the F&B and shop carts use).
 */
const ROWS_SCROLL = 'flex-1 -mx-2 px-2 [&_[data-radix-scroll-area-viewport]>div]:!block';

/**
 * The bracelet row's text and duration badge share what the icon leaves. The
 * text keeps room for its longest word ("bracelets"); the badge gives way
 * first, so on a narrow column a long label ("All Day + Meal") wraps inside
 * the badge rather than running off the card's edge or over the text.
 */
const ROW_TEXT = 'min-w-[5.5rem] flex-1';
const DURATION_BADGE = 'px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide text-center';

/**
 * The short codes the platform printed on these bands (`T1-7KMQ4X`), each with
 * the child it was issued to — what staff read out when a band does not print.
 * Never the signed code: that is the gate credential and no read carries it.
 */
function BandCodes({ bands }: { bands: readonly ApiSaleBand[] }) {
  if (bands.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm" data-testid="band-codes">
      {bands.map((band) => (
        <span key={band.id} className="whitespace-nowrap">
          <span className="font-mono font-semibold text-foreground">{band.shortCode ?? 'No code'}</span>
          {band.childName && <span className="text-muted-foreground"> {band.childName}</span>}
        </span>
      ))}
    </div>
  );
}

function CreditGrantRow({ voucher: grant, index, qrCode }: { voucher: CreditGrant; index: number; qrCode?: string | null }) {
  const isCredit = grant.type === 'fnb_credit';
  return (
    <div className="flex items-center gap-4 bg-background border rounded-xl p-3 shrink-0">
      {/* S2-14a — an F&B credit row shows its wallet's ONE QR, the one its voucher printed. */}
      <QrCode seed={qrCode ?? grant.id} className="w-16 h-16" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-muted-foreground text-sm font-medium">
          {/* `shrink-0`: in a row held to its column (ROWS_SCROLL) a long
              label would otherwise squeeze the icon rather than truncate. */}
          {isCredit ? (
            <UtensilsCrossed className="w-4 h-4 shrink-0" />
          ) : (
            <ShoppingBag className="w-4 h-4 shrink-0" />
          )}
          <span className="truncate" title={grant.label}>{grant.label}</span>
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

export function StepConfirmation({ sale, onNewSale, saleNumber, note, boxIssue }: StepConfirmationProps) {
  const issue = useSaleIssue(sale.id, saleNumber, boxIssue);
  const numberLabel = saleNumberLabel(issue.number);
  // S2-11 — the codes the platform minted, on the rows they belong to, so a
  // band that fails to print can be read out and reprinted from History. The
  // platform files a band under the cart line id it was SENT, which is the
  // till's own id translated at the wire (`platformId`, lib/cartWire.ts).
  const issued = issue.bands ? bandsByCartLine(issue.bands, issue.lines) : null;
  const bandsOnRow = (lineId: string, kind: 'child' | 'adult'): ApiSaleBand[] =>
    issued?.byRow.get(`${platformId(lineId)}:${kind === 'child' ? 'kid' : 'adult'}`) ?? [];
  // Drop-off / nanny children's bands are issued through the door check-in choice
  // (now or later at check-in), never the standard sale print — so exclude their
  // lines from the "Bracelets to Print" panel.
  const braceletRows = sale.lines.filter((line) => !line.dropOff).flatMap((line) => {
    const rows: { id: string; lineId: string; kind: 'child' | 'adult'; count: number; duration: string; ticket: string }[] = [];
    if (line.kids > 0) {
      rows.push({ id: `${line.id}-c`, lineId: line.id, kind: 'child', count: line.kids, duration: line.ticketType.durationLabel, ticket: line.ticketType.name });
    }
    if (line.adults > 0) {
      rows.push({ id: `${line.id}-a`, lineId: line.id, kind: 'adult', count: line.adults, duration: line.ticketType.durationLabel, ticket: line.ticketType.name });
    }
    return rows;
  });

  const totalBracelets = braceletRows.reduce((sum, row) => sum + row.count, 0);
  // Every issued band shows somewhere: a code no row claims — its line was not
  // one of these rows, or could not be placed — is listed under them.
  const onRows = new Set(braceletRows.flatMap((row) => bandsOnRow(row.lineId, row.kind).map((b) => b.id)));
  const leftover = (issue.bands ?? []).filter((b) => b.status !== 'revoked' && !onRows.has(b.id));
  // The sale's own figures, not a second computation of them (S2-09a): what is
  // read out here is what the platform charged. A sale with no quoted figures —
  // seeded history, a deployment with no ledger — is totalled from its lines by
  // the engine (`ticketTotals`, SCRUM-271), as the prototype's arithmetic did.
  const taxRows =
    sale.quoted?.taxRows ??
    taxRowsOf(ticketTotals(sale.lines, sale.discounts ?? [], sale.manualDiscounts).taxBreakdown);

  // The receipt's CONTENT follows the active receipt template. Routing is
  // unchanged. With no template configured, default to showing the breakdown.
  const receiptTpl = getPrintTemplate('receipt');
  const showTaxBreakdown = receiptTpl ? !!receiptTpl.fields.taxServiceBreakdown : true;
  const showCreditInfo = receiptTpl ? !!receiptTpl.fields.voucherInfo : true;
  /**
   * SCRUM-208 — the "Credit Grants to Print" block is shown only once the
   * platform reports a credit-voucher printout for this sale. Nothing prints
   * F&B credit or item grants until the wallets ticket (S2-14a), so until then
   * the block promised paper no printer produced; it stays hidden until the
   * read carries such a job.
   */
  const platformPrintsCredit = reportsCreditVoucher(issue.printJobs ?? []);
  /** The i-th grant row's place among the F&B-credit rows — the platform's person order. */
  const creditIndexOf = (i: number): number =>
    sale.creditGrants.slice(0, i).filter((g) => g.type === 'fnb_credit').length;

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
            {taxRows.map((r) => `${r.label} ฿${shownBaht(r.amount)}`).join(' · ')}
          </p>
        )}
        {note && <div className="mt-2">{note}</div>}
        {receiptTpl?.footerText && (
          <p className="text-muted-foreground/70 mt-1 text-xs italic">
            {receiptTpl.footerText}
          </p>
        )}
      </div>

      <div className={cn('flex-1 grid gap-6 overflow-hidden', platformPrintsCredit ? 'grid-cols-2' : 'grid-cols-1')}>
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
          <ScrollArea className={ROWS_SCROLL}>
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
                  <div className={ROW_TEXT}>
                    <div className="text-lg font-bold">
                      {row.count}× {row.kind === 'child' ? 'Child' : 'Adult'} bracelet{row.count > 1 ? 's' : ''}
                    </div>
                    <div className="text-sm text-muted-foreground truncate" title={`${row.duration} • ${row.ticket}`}>
                      {row.duration} • {row.ticket}
                    </div>
                    <BandCodes bands={bandsOnRow(row.lineId, row.kind)} />
                  </div>
                  <div
                    className={cn(
                      DURATION_BADGE,
                      row.kind === 'child' ? 'bg-primary/15 text-primary' : 'bg-sky-500/15 text-sky-400'
                    )}
                  >
                    {row.duration}
                  </div>
                </div>
              ))}
              {leftover.length > 0 && (
                <div className="bg-background border rounded-xl p-4 shrink-0">
                  <div className="text-sm font-semibold text-muted-foreground">Band codes</div>
                  <BandCodes bands={leftover} />
                </div>
              )}
              {issue.bands !== null && issue.bands.length === 0 && totalBracelets > 0 && (
                <p className="text-sm text-muted-foreground px-1">
                  No band codes came back for this sale. Reprint its bands from History to issue them.
                </p>
              )}
            </div>
          </ScrollArea>
        </Card>

        {platformPrintsCredit && (
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
              <ScrollArea className={ROWS_SCROLL}>
                <div className="space-y-3">
                  {sale.creditGrants.map((v, i) => (
                    <CreditGrantRow
                      key={v.id}
                      voucher={v}
                      index={i}
                      qrCode={v.type === 'fnb_credit' ? walletQrFor(issue.grants, creditIndexOf(i)) : null}
                    />
                  ))}
                </div>
              </ScrollArea>
            )}
          </Card>
        )}
      </div>

      <div className="mt-6">
        <Button size="lg" className="w-full h-20 text-2xl font-bold" onClick={onNewSale}>
          Start New Sale
        </Button>
      </div>
    </div>
  );
}
