import { useEffect, useRef } from 'react';
import type { Wristband } from '@/types';
import { isCreditSettlement, type PaymentSettlement, type usePaymentStage } from '@/lib/usePaymentStage';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PaymentTenderPanel } from '@/components/till/PaymentTenderPanel';
import { cn } from '@/lib/utils';
import { getEnabledPaymentMethods, paymentMethodIcon } from '@/lib/payments';
import { ArrowLeft, Check, CheckCircle2, Hash, Wallet } from 'lucide-react';

export interface FnbPaymentResult {
  creditUsed: number;
  cash: number;
  card: number;
  promptpay: number;
  /** The configured tokens and actual amounts remain on the local receipt record. */
  tenders: readonly PaymentSettlement[];
}

/**
 * Legacy receipt totals come only from settled, deduplicated platform tenders.
 * S2-14a round 2 — the credit the platform took is its own figure
 * (`creditUsed`), never cash, card or QR.
 */
export function fnbPaymentResult(settlements: readonly PaymentSettlement[]): FnbPaymentResult {
  const amount = (kind: string) => settlements
    .filter((part) => part.kind === kind && !isCreditSettlement(part))
    .reduce((sum, part) => sum + part.amountSatang, 0) / 100;
  const creditUsed = settlements.filter(isCreditSettlement).reduce((sum, part) => sum + part.amountSatang, 0) / 100;
  return { creditUsed, cash: amount('cash'), card: amount('card'), promptpay: amount('qr'), tenders: settlements };
}

/** S2-14a — what the wallet held after this order's credit, the platform's figure; null with no credit. */
export function walletBalanceAfter(settlements: readonly PaymentSettlement[]): number | null {
  const credit = [...settlements].reverse().find((part) => isCreditSettlement(part) && part.walletBalanceAfterSatang !== undefined);
  return credit?.walletBalanceAfterSatang !== undefined ? credit.walletBalanceAfterSatang / 100 : null;
}

interface FnbPaymentProps {
  total: number;
  wristband: Wristband | null;
  pickupCode: string;
  stage: ReturnType<typeof usePaymentStage>;
  onBack: () => void;
  creditLabel?: string;
  creditBalanceOverride?: number;
  /**
   * S2-14a round 2 — whether this order spends the scanned wallet. Preselected
   * by the station when the balance is above zero (the prototype's tender
   * card); without a handler the station cannot take credit and says so.
   */
  useCredit?: boolean;
  onUseCreditChange?: (useCredit: boolean) => void;
}

export function FnbPayment({ total, wristband, pickupCode, stage, onBack, creditLabel = 'Credit', creditBalanceOverride, useCredit = false, onUseCreditChange }: FnbPaymentProps) {
  const methods = getEnabledPaymentMethods().filter((method) => ['cash', 'card', 'qr'].includes(method.kind));
  const balance = creditBalanceOverride ?? wristband?.creditBalanceTHB ?? 0;
  const outstandingSatang = stage.state.outstandingSatang;
  const free = total === 0 && outstandingSatang === 0;
  const amountDue = (outstandingSatang / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

  // The prototype's credit card (`FnbPayment.tsx`, credit first), on the platform's figures.
  const canTakeCredit = Boolean(onUseCreditChange) && balance > 0;
  const creditApplied = stage.state.creditSatang > 0;
  const creditPending = stage.creditPendingSatang;
  const creditSelected = canTakeCredit && useCredit && !creditApplied;
  const creditUsedSatang = creditApplied ? stage.state.creditSatang : creditPending;
  const remainderSatang = creditSelected ? Math.max(0, outstandingSatang - creditPending) : outstandingSatang;
  const creditCoversAll = creditSelected && stage.creditCoversAll;
  const baht = (satang: number) => (satang / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const defaultRemainder = methods.find((method) => method.kind === 'card');
  const wasCreditSelected = useRef(false);

  /**
   * The approved design preselects card for the part credit did not cover;
   * with no card tender configured nothing is preselected and staff choose.
   * Choosing a button after that stays the staff member's choice; only the
   * transition into credit selection applies the default.
   */
  useEffect(() => {
    if (!creditSelected) { wasCreditSelected.current = false; return; }
    if (stage.locked) return;
    if (!wasCreditSelected.current && remainderSatang > 0 && defaultRemainder) stage.selectMethod(defaultRemainder.id);
    wasCreditSelected.current = true;
    if (stage.state.amountSatang !== remainderSatang) stage.setAmountSatang(remainderSatang);
    // The stage's own setters read current refs; the figures are the triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditSelected, remainderSatang, stage.state.amountSatang, stage.locked, defaultRemainder?.id]);

  /**
   * S2-14a round 2 — CREDIT REFUSED ON THE BOX LANE: the stage said so before
   * any call (`creditRefusal`, in the lane's own words). The toggle comes off
   * so the next press takes the money, the whole amount is owed, and the words
   * stay on the card; staff may put the toggle back, and the press refuses
   * again rather than calling anything.
   *
   * S2-14a round 3 — THE PLATFORM'S REFUSALS TOO (`WALLET_EMPTY`,
   * `WALLET_INSUFFICIENT`, `WALLET_EXPIRED`): nothing was taken, so the toggle
   * comes off exactly as it does for the lane, with the platform's words on
   * the card. Every refusal counts (`creditRefusalSeq`), so staff who put the
   * toggle back and are refused again in the same words see it come off again.
   */
  const creditRefusal = stage.creditRefusal;
  const refusalSeq = stage.state.creditRefusalSeq ?? 0;
  useEffect(() => {
    if (!creditRefusal || !useCredit || !onUseCreditChange) return;
    onUseCreditChange(false);
    stage.setAmountSatang(outstandingSatang);
    // The refusal is the trigger; the setters read current refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditRefusal, refusalSeq]);

  const toggleCredit = () => {
    if (!onUseCreditChange || stage.locked || creditApplied) return;
    const next = !useCredit;
    onUseCreditChange(next);
    if (!next) stage.setAmountSatang(outstandingSatang);
  };

  return (
    <div className="h-full flex flex-col items-center justify-center p-6 animate-in fade-in duration-300">
      <div className="w-full max-w-xl">
        <div className="text-center mb-6">
          <div className="text-muted-foreground">Amount due</div>
          <div className="text-5xl font-bold tabular-nums">฿{amountDue}</div>
          {outstandingSatang !== Math.round(total * 100) && outstandingSatang > 0 && (
            <div className="mt-2 text-sm text-muted-foreground">Order total ฿{total}; the amount above is still unpaid.</div>
          )}
          {pickupCode && (
            <div className="inline-flex items-center gap-1.5 mt-3 px-3 py-1 rounded-full border bg-card text-sm text-muted-foreground">
              <Hash className="w-3.5 h-3.5" />Pick-up code
              <span className="font-bold text-foreground tabular-nums tracking-widest">{pickupCode}</span>
            </div>
          )}
        </div>

        <div className="space-y-3">
          {canTakeCredit && !free && (
            <Card
              role="button"
              tabIndex={stage.locked || creditApplied ? -1 : 0}
              aria-disabled={stage.locked || creditApplied}
              aria-pressed={creditSelected || creditApplied}
              onClick={toggleCredit}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggleCredit();
                }
              }}
              className={cn(
                'p-5 select-none transition-all',
                stage.locked || creditApplied ? 'cursor-default' : 'cursor-pointer active:scale-[0.99]',
                creditSelected || creditApplied ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'hover:border-primary/50',
              )}
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/20 text-primary flex items-center justify-center shrink-0">
                  <Wallet className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-lg">{creditLabel}</div>
                  <div className="text-sm text-muted-foreground tabular-nums">
                    {creditApplied
                      ? `฿${baht(stage.state.creditSatang)} taken from credit`
                      : creditRefusal
                        ? `Balance ฿${balance} — ${creditRefusal}`
                        : `Balance ฿${balance}${creditCoversAll ? ' — covers full order' : ` — applies ฿${baht(creditPending || Math.min(balance * 100, outstandingSatang))}`}`}
                  </div>
                </div>
                {(creditSelected || creditApplied) && (
                  <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                    <Check className="w-5 h-5" />
                  </div>
                )}
              </div>
              {creditSelected && remainderSatang > 0 && (
                <div className="mt-4 border-t pt-4">
                  <div className="mb-3 text-sm text-muted-foreground">Credit covers ฿{baht(creditUsedSatang)}. Collect remaining{' '}
                    <span className="font-bold text-foreground tabular-nums">฿{baht(remainderSatang)}</span> by:</div>
                  <div className="grid grid-cols-3 gap-3">
                    {methods.map((method) => {
                      const Icon = paymentMethodIcon(method.kind);
                      return <button key={method.id} type="button" disabled={stage.locked}
                        onClick={(event) => { event.stopPropagation(); stage.selectMethod(method.id); }}
                        className={cn('flex h-12 items-center justify-center gap-2 rounded-xl border font-bold transition-all active:scale-95',
                          stage.state.method === method.id ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:border-primary/50')}
                      ><Icon className="h-5 w-5" />{method.label}</button>;
                    })}
                  </div>
                </div>
              )}
            </Card>
          )}
          {/*
            Staging F3 — a tab the counter's box answered with no credit it can
            take here (the day's offline cap reached, the credit expired, no copy
            of the wallet): the box's words on the credit card, nothing to press.
          */}
          {!canTakeCredit && !free && balance === 0 && wristband?.creditNote && (
            <Card className="p-5 bg-muted/30" data-testid="credit-note">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-muted text-muted-foreground flex items-center justify-center shrink-0">
                  <Wallet className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-lg">{creditLabel}</div>
                  <div className="text-sm text-muted-foreground">{wristband.creditNote}</div>
                </div>
              </div>
            </Card>
          )}
          {free || creditCoversAll ? (
            <Card className="p-6 border-primary/40 bg-primary/5">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/20 text-primary flex items-center justify-center shrink-0"><CheckCircle2 className="w-6 h-6" /></div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-lg">No payment needed</div>
                  <div className="text-sm text-muted-foreground">This order is fully covered — nothing to collect. Tap below to send it to the kitchen.</div>
                </div>
              </div>
              <Button className="mt-4 w-full" size="lg" disabled={!stage.canSubmit} onClick={() => void stage.submit()}>Complete Order</Button>
            </Card>
          ) : methods.map((method) => {
            const Icon = paymentMethodIcon(method.kind);
            const selected = stage.state.method === method.id;
            return (
              <Card
                key={method.id}
                role="button"
                tabIndex={stage.locked ? -1 : 0}
                aria-disabled={stage.locked}
                onClick={() => { if (!stage.locked) stage.selectMethod(method.id); }}
                onKeyDown={(event) => {
                  if (!stage.locked && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    stage.selectMethod(method.id);
                  }
                }}
                className={cn('p-5 select-none transition-all', stage.locked ? 'cursor-default' : 'cursor-pointer active:scale-[0.99]', selected ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'hover:border-primary/50')}
              >
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-muted text-muted-foreground flex items-center justify-center shrink-0"><Icon className="w-6 h-6" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-lg">{method.label}</div>
                    <div className="text-sm text-muted-foreground">
                      {method.kind === 'cash' ? `Collect ฿${baht(remainderSatang)} in cash` : method.kind === 'card' ? `Charge ฿${baht(remainderSatang)} to card` : `Customer scans to pay ฿${baht(remainderSatang)}`}
                    </div>
                  </div>
                  {selected && <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0"><Check className="w-5 h-5" /></div>}
                </div>
              </Card>
            );
          })}
          {!free && !creditCoversAll && methods.length === 0 && <p role="alert" className="text-sm text-destructive">No enabled payment method is available.</p>}
          {balance > 0 && !canTakeCredit && (
            <Card className="p-4 bg-muted/30">
              <div className="flex items-center gap-3 text-muted-foreground"><Wallet className="w-5 h-5" /><span>{creditLabel} balance ฿{balance}</span></div>
              <p className="mt-1 text-sm text-muted-foreground">Credit payments are not available at this station.</p>
            </Card>
          )}
        </div>

        <div className="mt-6"><PaymentTenderPanel stage={stage} showSubmit={!free && !creditCoversAll} /></div>
        <div className="mt-4">
          <Button variant="outline" size="lg" className="h-16 px-6 gap-2" disabled={!stage.canBack} onClick={onBack}><ArrowLeft className="w-5 h-5" />Back</Button>
        </div>
      </div>
    </div>
  );
}
