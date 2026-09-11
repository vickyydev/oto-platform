import { useEffect, useMemo, useState } from 'react';
import { PartyBooking, PartyPaymentMethod } from '@/types';
import {
  computePartyOutstanding,
  partyExtraChargesTotal,
  partyPaymentsTotal,
  computePartyTotal,
} from '@/lib/party';
import {
  getEnabledPaymentMethods,
  paymentMethodLabel,
  paymentMethodIcon,
  paymentMethodKind,
} from '@/lib/payments';
import { PartySettlementCustomerScreen } from '@/components/parties/PartySettlementCustomerScreen';
import { HandToCustomer } from '@/components/mobile/HandToCustomer';
import { useLanguage } from '@/i18n/LanguageContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ArrowLeft, Check, Wallet } from 'lucide-react';

type Step = 'pick' | 'bill-review' | 'collect' | 'done';

const collectHint = (method: PartyPaymentMethod): string => {
  switch (paymentMethodKind(method)) {
    case 'cash':
      return 'Collect the cash from the customer, then confirm.';
    case 'card':
      return "Run the customer's card for the amount, then confirm.";
    case 'qr':
      return 'The customer scans the QR on their display. Confirm once the money lands in your PromptPay app.';
    default:
      return `Collect the ${paymentMethodLabel(method)} payment, then confirm.`;
  }
};

interface MobilePartyPaymentProps {
  party: PartyBooking;
  operatorName: string;
  onConfirm: (amount: number, method: PartyPaymentMethod) => void;
  onBack: () => void;
}

export function MobilePartyPayment({
  party,
  operatorName,
  onConfirm,
  onBack,
}: MobilePartyPaymentProps) {
  const { t } = useLanguage();
  const total = computePartyTotal(party);
  const outstanding = computePartyOutstanding(party);
  const extras = partyExtraChargesTotal(party);
  const paid = partyPaymentsTotal(party);

  const methods = getEnabledPaymentMethods();

  const [step, setStep] = useState<Step>('pick');
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [partialText, setPartialText] = useState('');
  const [method, setMethod] = useState<PartyPaymentMethod | ''>('');
  const [collectAmount, setCollectAmount] = useState(0);
  const [collectMethod, setCollectMethod] = useState<PartyPaymentMethod>('cash');

  useEffect(() => {
    setStep('pick');
    setMode('full');
    setPartialText('');
    setMethod('');
    setCollectAmount(0);
    setCollectMethod('cash');
  }, [party.id]);

  const amount = useMemo(() => {
    if (mode === 'full') return outstanding;
    const n = Math.floor(Number(partialText));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, outstanding);
  }, [mode, partialText, outstanding]);

  const canContinue = !!method && amount > 0 && outstanding > 0;

  const handleContinue = () => {
    if (!method || amount <= 0) return;
    setCollectAmount(amount);
    setCollectMethod(method);
    setStep('bill-review');
  };

  const handleBillReviewDone = () => {
    setStep('collect');
  };

  const handleReceived = () => {
    if (collectAmount <= 0) return;
    onConfirm(collectAmount, collectMethod);
    setStep('done');
  };

  const customerStage =
    step === 'bill-review' ? 'review' : step === 'collect' ? 'payment' : 'thankyou';

  if (step === 'bill-review') {
    return (
      <HandToCustomer
        title={t('handToCustomer.showBillTitle')}
        subtitle={t('handToCustomer.showBillSubtitle')}
        handBackLabel={t('handToCustomer.customerReviewedContinue')}
        onDone={handleBillReviewDone}
        onCancel={() => setStep('pick')}
      >
        <PartySettlementCustomerScreen
          stage={customerStage}
          party={party}
          amount={collectAmount}
          method={collectMethod}
        />
      </HandToCustomer>
    );
  }

  if (step === 'collect') {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="shrink-0 px-4 pt-4 pb-3 border-b flex items-center gap-3">
          <button
            type="button"
            onClick={() => setStep('pick')}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h2 className="font-bold">Collect payment</h2>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <div className="w-20 h-20 rounded-full bg-violet-500/15 text-violet-400 flex items-center justify-center mb-6">
            {(() => {
              const Icon = paymentMethodIcon(paymentMethodKind(collectMethod));
              return <Icon className="w-10 h-10" />;
            })()}
          </div>
          <h2 className="text-2xl font-bold mb-1">{paymentMethodLabel(collectMethod)}</h2>
          <p className="text-muted-foreground mb-4">{party.title}</p>
          <div className="text-5xl font-black tabular-nums mb-4">฿{collectAmount}</div>
          <p className="text-muted-foreground max-w-xs text-sm mb-8">
            {collectHint(collectMethod)}
          </p>
        </div>

        <div className="shrink-0 p-4 space-y-3 border-t">
          <Button
            size="lg"
            className="w-full h-14 text-lg gap-2"
            onClick={handleReceived}
          >
            <Check className="w-5 h-5" />
            Payment received
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="w-full h-10 text-muted-foreground"
            onClick={() => setStep('pick')}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (step === 'done') {
    const newOutstanding = computePartyOutstanding(party);
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <div className="w-20 h-20 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center mb-6">
            <Check className="w-10 h-10" />
          </div>
          <h2 className="text-2xl font-bold mb-1">Payment recorded</h2>
          <p className="text-muted-foreground mb-6">{party.title}</p>
          <div className="rounded-lg border p-4 w-full max-w-sm space-y-2 text-sm mb-8">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Collected</span>
              <span className="tabular-nums font-semibold text-emerald-500">฿{collectAmount}</span>
            </div>
            <div className="flex items-center justify-between border-t pt-2 mt-1 font-bold">
              <span>Outstanding</span>
              <span
                className={`tabular-nums ${
                  newOutstanding > 0 ? 'text-amber-500' : 'text-emerald-500'
                }`}
              >
                ฿{newOutstanding}
              </span>
            </div>
          </div>
        </div>
        <div className="shrink-0 p-4 border-t">
          <Button size="lg" className="w-full h-14 text-lg" onClick={onBack}>
            Back to party
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="font-bold">Take payment</h2>
          <p className="text-xs text-muted-foreground truncate">{party.title} · by {operatorName}</p>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
          {/* Bill summary */}
          <div className="rounded-lg border p-4 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Package total</span>
              <span className="tabular-nums">฿{total - extras}</span>
            </div>
            {extras > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Extra F&amp;B charges</span>
                <span className="tabular-nums">+฿{extras}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Deposit paid</span>
              <span className="tabular-nums">−฿{party.deposit}</span>
            </div>
            {paid > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Payments taken</span>
                <span className="tabular-nums">−฿{paid}</span>
              </div>
            )}
            <div className="flex items-center justify-between border-t pt-2 mt-1 font-bold">
              <span>Outstanding</span>
              <span className="text-2xl tabular-nums">฿{outstanding}</span>
            </div>
          </div>

          {outstanding <= 0 ? (
            <div className="rounded-lg bg-emerald-500/10 text-emerald-500 p-4 text-center font-semibold">
              This party is fully paid.
            </div>
          ) : (
            <>
              {/* Amount */}
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">How much to collect?</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={mode === 'full' ? 'default' : 'outline'}
                    className="h-14"
                    onClick={() => setMode('full')}
                  >
                    Full ฿{outstanding}
                  </Button>
                  <Button
                    type="button"
                    variant={mode === 'partial' ? 'default' : 'outline'}
                    className="h-14"
                    onClick={() => setMode('partial')}
                  >
                    Partial amount
                  </Button>
                </div>
                {mode === 'partial' && (
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={outstanding}
                    autoFocus
                    placeholder={`Up to ฿${outstanding}`}
                    value={partialText}
                    onChange={(e) => setPartialText(e.target.value)}
                    className="h-14 text-lg tabular-nums"
                  />
                )}
              </div>

              {/* Payment method */}
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">
                  Payment method <span className="text-destructive">*</span>
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {methods.map((m) => {
                    const Icon = paymentMethodIcon(m.kind);
                    return (
                      <Button
                        key={m.id}
                        type="button"
                        variant={method === m.id ? 'default' : 'outline'}
                        className="h-14 flex-col gap-1"
                        onClick={() => setMethod(m.id)}
                      >
                        <Icon className="w-5 h-5" />
                        <span className="text-xs">{m.label}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>

              {/* Summary */}
              <div className="rounded-lg bg-muted p-4 flex items-center justify-between">
                <span className="text-muted-foreground text-sm">Amount to collect</span>
                <span className="text-2xl font-black tabular-nums">฿{amount}</span>
              </div>
            </>
          )}
        </div>
      </ScrollArea>

      {/* CTA */}
      {outstanding > 0 && (
        <div className="shrink-0 p-4 border-t">
          <Button
            className="w-full h-14 text-lg gap-2"
            disabled={!canContinue}
            onClick={handleContinue}
          >
            <Wallet className="w-5 h-5" />
            {!method
              ? 'Choose a payment method'
              : amount <= 0
                ? 'Enter an amount'
                : `Show bill · ฿${amount} by ${paymentMethodLabel(method)}`}
          </Button>
        </div>
      )}
    </div>
  );
}
