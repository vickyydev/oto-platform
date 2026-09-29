import type { Wristband } from '@/types';
import type { PaymentSettlement, usePaymentStage } from '@/lib/usePaymentStage';
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

/** Legacy receipt totals come only from settled, deduplicated platform tenders. */
export function fnbPaymentResult(settlements: readonly PaymentSettlement[]): FnbPaymentResult {
  const amount = (kind: string) => settlements
    .filter((part) => part.kind === kind)
    .reduce((sum, part) => sum + part.amountSatang, 0) / 100;
  return { creditUsed: 0, cash: amount('cash'), card: amount('card'), promptpay: amount('qr'), tenders: settlements };
}

interface FnbPaymentProps {
  total: number;
  wristband: Wristband | null;
  pickupCode: string;
  stage: ReturnType<typeof usePaymentStage>;
  onBack: () => void;
  creditLabel?: string;
  creditBalanceOverride?: number;
}

export function FnbPayment({ total, wristband, pickupCode, stage, onBack, creditLabel = 'Credit', creditBalanceOverride }: FnbPaymentProps) {
  const methods = getEnabledPaymentMethods().filter((method) => ['cash', 'card', 'qr'].includes(method.kind));
  const balance = creditBalanceOverride ?? wristband?.creditBalanceTHB ?? 0;
  const outstandingSatang = stage.state.outstandingSatang;
  const free = total === 0 && outstandingSatang === 0;
  const amountDue = (outstandingSatang / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

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
          {free ? (
            <Card className="p-6 border-primary/40 bg-primary/5">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/20 text-primary flex items-center justify-center shrink-0"><CheckCircle2 className="w-6 h-6" /></div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-lg">No payment needed</div>
                  <div className="text-sm text-muted-foreground">This order is fully covered — nothing to collect.</div>
                </div>
              </div>
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
                      {method.kind === 'cash' ? 'Collect cash, with the amount handed over and change.' : method.kind === 'card' ? 'Take card through this station’s payment route.' : 'Show the payment QR and wait for the payment result.'}
                    </div>
                  </div>
                  {selected && <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0"><Check className="w-5 h-5" /></div>}
                </div>
              </Card>
            );
          })}
          {!free && methods.length === 0 && <p role="alert" className="text-sm text-destructive">No enabled payment method is available.</p>}
          {balance > 0 && (
            <Card className="p-4 bg-muted/30">
              <div className="flex items-center gap-3 text-muted-foreground"><Wallet className="w-5 h-5" /><span>{creditLabel} balance ฿{balance}</span></div>
              <p className="mt-1 text-sm text-muted-foreground">Credit payments are not available at this station.</p>
            </Card>
          )}
        </div>

        <div className="mt-6"><PaymentTenderPanel stage={stage} /></div>
        <div className="mt-4">
          <Button variant="outline" size="lg" className="h-16 px-6 gap-2" disabled={!stage.canBack} onClick={onBack}><ArrowLeft className="w-5 h-5" />Back</Button>
        </div>
      </div>
    </div>
  );
}
