import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Check, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getEnabledPaymentMethods, paymentMethodIcon, paymentMethodKind } from '@/lib/payments';
import type { PaymentMethodKind } from '@/types';
import type { PaymentStageController } from '@/lib/usePaymentStage';
import { PaymentTenderPanel, paymentSubmitLabel } from './PaymentTenderPanel';

interface StepPaymentProps {
  total: number;
  selectedMethod: string | null;
  onSelectMethod: (method: string) => void;
  onComplete: () => void;
  onBack: () => void;
  /**
   * S2-09a: what the platform said about writing this sale — the "saving…" line
   * and, when it fails, the panel that says so and offers Try again. It is
   * rendered inside the step rather than beside it so the approved layout keeps
   * its scroll and its footer.
   */
  notice?: ReactNode;
  /** A write is in flight: the confirm button must not start a second attempt. */
  busy?: boolean;
  /** What the button says while busy. Defaults to the sale being saved. */
  busyLabel?: string;
  /**
   * A line in this cart is priced at a tier nobody has set a price for, so
   * `total` is the ฿0 that stands in for the missing price (SCRUM-316).
   *
   * The staff half of the same moment the customer display guards: "Amount Due
   * ฿0" beside a panel that says no price is set. Dashed while it holds, and
   * Confirm shut with it.
   *
   * Like the display's, a second lock rather than the first: three routes set
   * this step without passing the order panel's Pay button and none of them
   * asks whether the cart is priced, but `TicketCard` refuses a tier it cannot
   * price, so no such line reaches the cart today. Callers that price their own
   * carts (the party tab) leave it unset and nothing changes for them.
   */
  unpriced?: boolean;
  /**
   * THE SALE OWES NOTHING (L38) — a voucher took it to ฿0, or it is a hand-over
   * prize or a free item on its own. There is no tender to choose, so the
   * method grid gives way to "No payment needed" and the button closes the sale
   * without one: the restaurant till's rule for a ฿0 order (`FnbPayment`).
   * Set by the ticket till from the platform's figure; callers that leave it
   * unset keep the grid at every total.
   */
  nothingToPay?: boolean;
  paymentStage?: PaymentStageController;
}

// Visual accent per method KIND (the tender list itself is configured in Admin).
const KIND_STYLE: Record<
  PaymentMethodKind,
  { accent: string; ring: string; hover: string; iconBg: string; iconColor: string }
> = {
  cash: {
    accent: 'bg-emerald-500',
    ring: 'border-emerald-500 ring-1 ring-emerald-500 bg-emerald-500/10',
    hover: 'hover:border-emerald-500 hover:bg-emerald-500/5',
    iconBg: 'bg-emerald-500/20',
    iconColor: 'text-emerald-500',
  },
  card: {
    accent: 'bg-blue-500',
    ring: 'border-blue-500 ring-1 ring-blue-500 bg-blue-500/10',
    hover: 'hover:border-blue-500 hover:bg-blue-500/5',
    iconBg: 'bg-blue-500/20',
    iconColor: 'text-blue-500',
  },
  qr: {
    accent: 'bg-violet-500',
    ring: 'border-violet-500 ring-1 ring-violet-500 bg-violet-500/10',
    hover: 'hover:border-violet-500 hover:bg-violet-500/5',
    iconBg: 'bg-violet-500/20',
    iconColor: 'text-violet-500',
  },
  other: {
    accent: 'bg-slate-500',
    ring: 'border-slate-400 ring-1 ring-slate-400 bg-slate-400/10',
    hover: 'hover:border-slate-400 hover:bg-slate-400/5',
    iconBg: 'bg-slate-400/20',
    iconColor: 'text-slate-300',
  },
};

export function StepPayment({ total, selectedMethod, onSelectMethod, onComplete, onBack, notice, busy, busyLabel, unpriced, nothingToPay, paymentStage }: StepPaymentProps) {
  const methods = getEnabledPaymentMethods();
  if (paymentStage) {
    selectedMethod = paymentStage.state.method;
    total = paymentStage.state.outstandingSatang / 100;
    busy = busy || paymentStage.busy;
  }
  const isQrPending = !!selectedMethod && paymentMethodKind(selectedMethod) === 'qr';
  // Only a priced ฿0 owes nothing: an unpriced cart's ฿0 stands in for a
  // missing price and keeps Confirm shut.
  const free = Boolean(paymentStage ? total === 0 : nothingToPay) && !unpriced && total === 0;

  return (
    <div className="flex flex-col h-full overflow-y-auto animate-in fade-in slide-in-from-right-4 duration-300">
      <div className="mb-8 text-center">
        <h2 className="text-4xl font-bold tracking-tight mb-2">Amount Due</h2>
        <div className="text-6xl font-black text-primary">{unpriced ? '—' : `฿${total}`}</div>
      </div>

      {free ? (
        <Card className="p-6 border-primary/40 bg-primary/5" data-testid="no-payment-needed">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-full bg-primary/20 text-primary flex items-center justify-center shrink-0">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-xl font-bold">No payment needed</h3>
              <p className="text-muted-foreground">
                This sale is fully covered — nothing to collect.
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <h3 className="text-xl font-bold mb-4">Select Payment Method</h3>
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(methods.length, 4))}, minmax(0, 1fr))` }}
          >
            {methods.map((m) => {
              const Icon = paymentMethodIcon(m.kind);
              const style = KIND_STYLE[m.kind] ?? KIND_STYLE.other;
              const selected = selectedMethod === m.id;
              return (
                <Card
                  key={m.id}
                  className={cn(
                    'relative flex flex-col items-center justify-center p-6 cursor-pointer transition-all',
                    selected ? style.ring : style.hover
                  )}
                  onClick={() => { if (paymentStage?.locked) return; paymentStage?.selectMethod(m.id); onSelectMethod(m.id); }}
                  aria-disabled={paymentStage?.locked || busy}
                >
                  {selected && (
                    <div className={cn('absolute top-3 right-3 w-7 h-7 rounded-full flex items-center justify-center text-foreground', style.accent)}>
                      <Check className="w-4 h-4" />
                    </div>
                  )}
                  <div className={cn('h-20 w-20 rounded-full flex items-center justify-center mb-4', style.iconBg)}>
                    <Icon className={cn('h-10 w-10', style.iconColor)} />
                  </div>
                  <h3 className="text-2xl font-bold">{m.label}</h3>
                </Card>
              );
            })}
          </div>

          {isQrPending && !paymentStage && (
            <div className="mt-6 rounded-xl border border-violet-500/30 bg-violet-500/10 p-4 text-sm text-muted-foreground">
              <span className="font-bold text-foreground">QR shown to customer.</span> Confirm once the
              gateway reports the payment as received.
            </div>
          )}
        </>
      )}

      {notice}
      {paymentStage && !unpriced && <PaymentTenderPanel stage={paymentStage} showSubmit={false} />}

      <div className="mt-auto pt-6 flex items-center justify-between gap-4">
        <Button variant="outline" size="lg" className="w-32 h-16" onClick={onBack} disabled={busy || (paymentStage && !paymentStage.canBack)}>
          Back
        </Button>
        <Button
          size="lg"
          className="flex-1 h-16 text-xl font-bold"
          disabled={(paymentStage ? !paymentStage.canSubmit : (!selectedMethod && !free)) || busy || unpriced}
          onClick={paymentStage ? () => { void paymentStage.submit(); } : onComplete}
        >
          {paymentStage ? paymentSubmitLabel(paymentStage, 'Confirm Payment Received') : busy
            ? (busyLabel ?? 'Saving the sale…')
            : free
              ? 'Complete Sale'
              : 'Confirm Payment Received'}
        </Button>
      </div>
    </div>
  );
}
