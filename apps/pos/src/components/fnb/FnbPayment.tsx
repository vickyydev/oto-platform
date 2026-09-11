import { Wristband } from '@/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { getEnabledPaymentMethods } from '@/lib/payments';
import {
  Wallet,
  Banknote,
  CreditCard,
  ArrowLeft,
  Check,
  Hash,
  QrCode as QrCodeIcon,
  CheckCircle2,
} from 'lucide-react';

export type FnbMethod = 'credit' | 'cash' | 'card' | 'promptpay';
export type FnbRemainder = 'cash' | 'card' | 'promptpay';

export interface FnbPaymentResult {
  creditUsed: number;
  cash: number;
  card: number;
  promptpay: number;
}

interface FnbPaymentProps {
  total: number;
  wristband: Wristband | null;
  pickupCode: string;
  method: FnbMethod | null;
  remainder: FnbRemainder;
  onMethodChange: (m: FnbMethod) => void;
  onRemainderChange: (r: FnbRemainder) => void;
  onConfirm: (payment: FnbPaymentResult) => void;
  onBack: () => void;
  // Label for the credit tender card. The same two-step payment is reused by the
  // merch lane with its own label.
  creditLabel?: string;
  // The credit balance the tender spends. Defaults to the wristband's
  // creditBalanceTHB — one universal wallet pool shared by the F&B and merch
  // lanes. Passed explicitly by callers that already have the band in hand.
  creditBalanceOverride?: number;
}

export function FnbPayment({
  total,
  wristband,
  pickupCode,
  method,
  remainder,
  onMethodChange,
  onRemainderChange,
  onConfirm,
  onBack,
  creditLabel = 'Credit',
  creditBalanceOverride,
}: FnbPaymentProps) {
  // F&B tenders into fixed cash/card/promptpay buckets, so we surface enabled
  // store methods by KIND (label from the store; 'other'-kind methods have no
  // F&B bucket and are intentionally not offered here). CreditGrant stays special.
  const methods = getEnabledPaymentMethods();
  const cashM = methods.find((m) => m.kind === 'cash');
  const cardM = methods.find((m) => m.kind === 'card');
  const qrM = methods.find((m) => m.kind === 'qr');
  const remainderOptions = [
    cashM && { value: 'cash' as FnbRemainder, label: cashM.label, icon: Banknote },
    cardM && { value: 'card' as FnbRemainder, label: cardM.label, icon: CreditCard },
    qrM && { value: 'promptpay' as FnbRemainder, label: qrM.label, icon: QrCodeIcon },
  ].filter(Boolean) as { value: FnbRemainder; label: string; icon: typeof Wallet }[];

  const balance = creditBalanceOverride ?? wristband?.creditBalanceTHB ?? 0;
  const creditAvailable = balance > 0;
  const creditUsed = Math.min(balance, total);
  const remainderDue = total - creditUsed;
  const creditCoversAll = creditAvailable && remainderDue === 0;

  const needsSplit = method === 'credit' && remainderDue > 0;
  // The remainder tender must be one that's currently offered — guard against a
  // stale default (e.g. card) that an admin has since disabled, so we never
  // record an order against a hidden tender.
  const remainderValid = remainderOptions.some((o) => o.value === remainder);

  const canConfirm = method !== null && (!needsSplit || remainderValid);

  const handleConfirm = () => {
    if (method === 'credit') {
      if (needsSplit && !remainderValid) return;
      onConfirm({
        creditUsed,
        cash: remainderDue > 0 && remainder === 'cash' ? remainderDue : 0,
        card: remainderDue > 0 && remainder === 'card' ? remainderDue : 0,
        promptpay: remainderDue > 0 && remainder === 'promptpay' ? remainderDue : 0,
      });
    } else if (method === 'cash') {
      onConfirm({ creditUsed: 0, cash: total, card: 0, promptpay: 0 });
    } else if (method === 'card') {
      onConfirm({ creditUsed: 0, cash: 0, card: total, promptpay: 0 });
    } else if (method === 'promptpay') {
      onConfirm({ creditUsed: 0, cash: 0, card: 0, promptpay: total });
    }
  };

  // Fully prepaid / nothing to collect — skip tender selection entirely. Picking
  // a payment method for a ฿0 order is meaningless friction, so we surface a
  // single "Complete Order" action that records an all-zero payment.
  if (total === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 animate-in fade-in duration-300">
        <div className="w-full max-w-xl">
          <div className="text-center mb-6">
            <div className="text-muted-foreground">Amount due</div>
            <div className="text-5xl font-bold tabular-nums">฿0</div>
            {pickupCode && (
              <div className="inline-flex items-center gap-1.5 mt-3 px-3 py-1 rounded-full border bg-card text-sm text-muted-foreground">
                <Hash className="w-3.5 h-3.5" />
                Pick-up code
                <span className="font-bold text-foreground tabular-nums tracking-widest">{pickupCode}</span>
              </div>
            )}
          </div>

          <Card className="p-6 border-primary/40 bg-primary/5">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-primary/20 text-primary flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-lg">No payment needed</div>
                <div className="text-sm text-muted-foreground">
                  This order is fully covered — nothing to collect. Tap below to send it to the kitchen.
                </div>
              </div>
            </div>
          </Card>

          <div className="flex gap-3 mt-8">
            <Button variant="outline" size="lg" className="h-16 px-6 gap-2" onClick={onBack}>
              <ArrowLeft className="w-5 h-5" />
              Back
            </Button>
            <Button
              size="lg"
              className="flex-1 h-16 text-xl font-bold"
              onClick={() => onConfirm({ creditUsed: 0, cash: 0, card: 0, promptpay: 0 })}
            >
              Complete Order
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col items-center justify-center p-6 animate-in fade-in duration-300">
      <div className="w-full max-w-xl">
        <div className="text-center mb-6">
          <div className="text-muted-foreground">Amount due</div>
          <div className="text-5xl font-bold tabular-nums">฿{total}</div>
          {pickupCode && (
            <div className="inline-flex items-center gap-1.5 mt-3 px-3 py-1 rounded-full border bg-card text-sm text-muted-foreground">
              <Hash className="w-3.5 h-3.5" />
              Pick-up code
              <span className="font-bold text-foreground tabular-nums tracking-widest">{pickupCode}</span>
            </div>
          )}
        </div>

        <div className="space-y-3">
          {creditAvailable && (
            <Card
              role="button"
              tabIndex={0}
              onClick={() => onMethodChange('credit')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onMethodChange('credit');
                }
              }}
              className={cn(
                'p-5 cursor-pointer select-none transition-all active:scale-[0.99]',
                method === 'credit' ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'hover:border-primary/50'
              )}
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/20 text-primary flex items-center justify-center shrink-0">
                  <Wallet className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-lg">{creditLabel}</div>
                  <div className="text-sm text-muted-foreground tabular-nums">
                    Balance ฿{balance}
                    {creditCoversAll ? ' — covers full order' : ` — applies ฿${creditUsed}`}
                  </div>
                </div>
                {method === 'credit' && (
                  <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                    <Check className="w-5 h-5" />
                  </div>
                )}
              </div>

              {needsSplit && (
                <div className="mt-4 pt-4 border-t">
                  <div className="text-sm text-muted-foreground mb-3">
                    Credit covers ฿{creditUsed}. Collect remaining{' '}
                    <span className="font-bold text-foreground tabular-nums">฿{remainderDue}</span> by:
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {remainderOptions.map(({ value, label, icon: Icon }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemainderChange(value);
                        }}
                        className={cn(
                          'flex items-center justify-center gap-2 h-12 rounded-xl border font-bold transition-all active:scale-95',
                          remainder === value
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'bg-background hover:border-primary/50'
                        )}
                      >
                        <Icon className="w-5 h-5" />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          )}

          {cashM && (
            <PayMethodRow
              label={cashM.label}
              description={`Collect ฿${total} in cash`}
              icon={Banknote}
              active={method === 'cash'}
              onSelect={() => onMethodChange('cash')}
            />
          )}
          {cardM && (
            <PayMethodRow
              label={cardM.label}
              description={`Charge ฿${total} to card`}
              icon={CreditCard}
              active={method === 'card'}
              onSelect={() => onMethodChange('card')}
            />
          )}
          {qrM && (
            <PayMethodRow
              label={qrM.label}
              description={`Customer scans to pay ฿${total}`}
              icon={QrCodeIcon}
              active={method === 'promptpay'}
              onSelect={() => onMethodChange('promptpay')}
            />
          )}
        </div>

        <div className="flex gap-3 mt-8">
          <Button variant="outline" size="lg" className="h-16 px-6 gap-2" onClick={onBack}>
            <ArrowLeft className="w-5 h-5" />
            Back
          </Button>
          <Button
            size="lg"
            className="flex-1 h-16 text-xl font-bold"
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            Confirm Payment
          </Button>
        </div>
      </div>
    </div>
  );
}

function PayMethodRow({
  label,
  description,
  icon: Icon,
  active,
  onSelect,
}: {
  label: string;
  description: string;
  icon: typeof Wallet;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'p-5 cursor-pointer select-none transition-all active:scale-[0.99]',
        active ? 'border-primary bg-primary/10 ring-1 ring-primary' : 'hover:border-primary/50'
      )}
    >
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-muted text-muted-foreground flex items-center justify-center shrink-0">
          <Icon className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-bold text-lg">{label}</div>
          <div className="text-sm text-muted-foreground">{description}</div>
        </div>
        {active && (
          <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
            <Check className="w-5 h-5" />
          </div>
        )}
      </div>
    </Card>
  );
}
