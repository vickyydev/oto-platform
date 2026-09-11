import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PartyBooking, PartyPaymentMethod } from '@/types';
import {
  computePartyTotal,
  computePartyOutstanding,
  partyExtraChargesTotal,
  partyExtraChargeGroups,
  partyPaymentsTotal,
} from '@/lib/party';
import { useCustomerDisplayPref } from '@/lib/customerDisplayPref';
import { useCustomerTheme } from '@/lib/themePref';
import {
  getEnabledPaymentMethods,
  paymentMethodLabel,
  paymentMethodIcon,
  paymentMethodKind,
} from '@/lib/payments';
import { PartySettlementCustomerScreen } from './PartySettlementCustomerScreen';
import {
  Wallet,
  ArrowLeft,
  Check,
  Monitor,
  PartyPopper,
} from 'lucide-react';

interface PartyBalanceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  party: PartyBooking;
  operatorName: string;
  onConfirm: (amount: number, method: PartyPaymentMethod) => void;
}

// Staff-side helper copy keyed by tender kind while waiting for the money to land.
const collectHint = (method: PartyPaymentMethod): string => {
  switch (paymentMethodKind(method)) {
    case 'cash':
      return 'Collect the cash from the customer, then confirm.';
    case 'card':
      return 'Run the customer’s card for the amount, then confirm.';
    case 'qr':
      return 'The customer scans the QR on their display. Confirm once the money lands in your PromptPay app.';
    default:
      return `Collect the ${paymentMethodLabel(method)} payment, then confirm.`;
  }
};

export function PartyBalanceModal({
  open,
  onOpenChange,
  party,
  operatorName,
  onConfirm,
}: PartyBalanceModalProps) {
  const total = computePartyTotal(party);
  const outstanding = computePartyOutstanding(party);
  const extras = partyExtraChargesTotal(party);
  const extraGroups = partyExtraChargeGroups(party);
  const paid = partyPaymentsTotal(party);

  // Tenders come from the store (admin-configurable); disabled ones never render.
  const methods = getEnabledPaymentMethods();

  // The whole settlement runs in a full-screen split harness (staff left,
  // customer display right) driven by ONE shared state — the same dual-screen
  // pattern as the till / F&B station, so the customer can review the bill
  // before paying and watch the payment + thank-you stages live.
  const [stage, setStage] = useState<'review' | 'collect' | 'done'>('review');
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const [partialText, setPartialText] = useState('');
  const [method, setMethod] = useState<PartyPaymentMethod | ''>('');
  // Frozen the moment we leave the review stage so the amount/method shown to
  // the customer and the amount we finalize can never drift from live data.
  const [collectAmount, setCollectAmount] = useState(0);
  const [collectMethod, setCollectMethod] = useState<PartyPaymentMethod>('cash');
  const [showCustomerDisplay, setShowCustomerDisplay] = useCustomerDisplayPref();
  const [customerTheme] = useCustomerTheme();

  useEffect(() => {
    if (open) {
      setStage('review');
      setMode('full');
      setPartialText('');
      setMethod('');
      setCollectAmount(0);
      setCollectMethod('cash');
    }
  }, [open]);

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
    setStage('collect');
  };

  const handleReceived = () => {
    if (collectAmount <= 0) return;
    onConfirm(collectAmount, collectMethod);
    setStage('done');
  };

  // Customer display stage derives from the staff stage — one shared source.
  const customerStage = stage === 'review' ? 'review' : stage === 'collect' ? 'payment' : 'thankyou';

  const harnessLabel =
    stage === 'review'
      ? 'Reviewing the bill'
      : stage === 'collect'
        ? `Collecting ฿${collectAmount} by ${paymentMethodLabel(collectMethod)}`
        : 'Payment recorded';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-none w-screen h-[100dvh] p-0 gap-0 border-0 rounded-none overflow-hidden flex flex-col bg-background">
        <DialogTitle className="sr-only">Take balance payment for {party.title}</DialogTitle>
        <DialogDescription className="sr-only">
          Staff settlement controls on the left and the customer-facing bill / payment display on
          the right, driven by one shared settlement state.
        </DialogDescription>

        {/* Test-harness banner — identical to the other split surfaces */}
        <div className="shrink-0 flex items-center justify-between gap-4 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <Monitor className="w-4 h-4 shrink-0" />
            <span className="truncate">
              Balance settlement for {party.title} — staff station (left) + customer display (right).
              {' '}
              {harnessLabel}. Taken by {operatorName}.
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 text-amber-300 hover:text-amber-200 hover:bg-amber-500/20"
            onClick={() => setShowCustomerDisplay((v) => !v)}
          >
            {showCustomerDisplay ? 'Hide' : 'Show'} customer display
          </Button>
        </div>

        <div className="flex-1 flex min-h-0">
          <div
            className={`${showCustomerDisplay ? 'w-1/2 border-r border-foreground/10' : 'w-full'} h-full min-w-0`}
          >
            {/* Staff station */}
            <div className="h-full overflow-y-auto bg-background text-foreground">
              <div className="mx-auto max-w-lg p-8">
                {stage === 'review' && (
                  <>
                    <div className="flex items-center gap-2 text-xl font-bold mb-1">
                      <Wallet className="w-6 h-6 text-primary" />
                      Take balance payment
                    </div>
                    <p className="text-sm text-muted-foreground mb-6">
                      {party.title} · by {operatorName}
                    </p>

                    {/* Bill summary */}
                    <div className="rounded-lg border p-4 space-y-2 text-sm mb-5">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Package total</span>
                        <span className="tabular-nums">฿{total - extras}</span>
                      </div>
                      {extraGroups.length > 0 && (
                        <div className="border-t pt-2 mt-1 space-y-2">
                          <div className="flex items-center gap-1.5 text-primary font-semibold">
                            <PartyPopper className="w-4 h-4" />
                            Added on the day
                          </div>
                          {extraGroups.map((g) => (
                            <div key={g.kind} className="flex items-center justify-between">
                              <span className="text-muted-foreground">{g.label}</span>
                              <span className="tabular-nums">+฿{g.total}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center justify-between border-t pt-2 mt-1">
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
                      <div className="space-y-5">
                        {/* Amount */}
                        <div className="space-y-2">
                          <p className="text-sm font-medium text-muted-foreground">
                            How much to collect?
                          </p>
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
                          <span className="text-muted-foreground">Amount to collect</span>
                          <span className="text-2xl font-black tabular-nums">฿{amount}</span>
                        </div>

                        <Button
                          className="w-full h-14 text-lg"
                          disabled={!canContinue}
                          onClick={handleContinue}
                        >
                          {!method
                            ? 'Choose a payment method'
                            : amount <= 0
                              ? 'Enter an amount'
                              : `Take ฿${amount} by ${paymentMethodLabel(method)}`}
                        </Button>
                      </div>
                    )}
                  </>
                )}

                {stage === 'collect' && (
                  <div className="flex flex-col items-center text-center pt-6">
                    <div className="w-20 h-20 rounded-full bg-violet-500/15 text-violet-400 flex items-center justify-center mb-6">
                      {(() => {
                        const Icon = paymentMethodIcon(paymentMethodKind(collectMethod));
                        return <Icon className="w-10 h-10" />;
                      })()}
                    </div>
                    <h2 className="text-2xl font-bold mb-1">
                      {paymentMethodLabel(collectMethod)} payment
                    </h2>
                    <p className="text-muted-foreground mb-6">{party.title}</p>
                    <div className="text-5xl font-black tabular-nums mb-6">฿{collectAmount}</div>
                    <p className="text-muted-foreground max-w-sm mb-8">
                      {collectHint(collectMethod)}
                    </p>
                    <div className="flex gap-3 w-full max-w-md">
                      <Button
                        variant="outline"
                        size="lg"
                        className="h-14 gap-2"
                        onClick={() => setStage('review')}
                      >
                        <ArrowLeft className="w-5 h-5" />
                        Back
                      </Button>
                      <Button
                        size="lg"
                        className="flex-1 h-14 text-lg gap-2"
                        onClick={handleReceived}
                      >
                        <Check className="w-5 h-5" />
                        Payment received
                      </Button>
                    </div>
                  </div>
                )}

                {stage === 'done' && (
                  <div className="flex flex-col items-center text-center pt-6">
                    <div className="w-20 h-20 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center mb-6">
                      <Check className="w-10 h-10" />
                    </div>
                    <h2 className="text-2xl font-bold mb-1">Payment recorded</h2>
                    <p className="text-muted-foreground mb-6">{party.title}</p>
                    <div className="rounded-lg border p-4 w-full max-w-sm space-y-2 text-sm mb-8">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Collected now</span>
                        <span className="tabular-nums font-semibold text-emerald-500">
                          ฿{collectAmount}
                        </span>
                      </div>
                      <div className="flex items-center justify-between border-t pt-2 mt-1 font-bold">
                        <span>Outstanding</span>
                        <span
                          className={`tabular-nums ${
                            outstanding > 0 ? 'text-amber-500' : 'text-emerald-500'
                          }`}
                        >
                          ฿{outstanding}
                        </span>
                      </div>
                    </div>
                    <Button
                      size="lg"
                      className="w-full max-w-md h-14 text-lg"
                      onClick={() => onOpenChange(false)}
                    >
                      Done
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {showCustomerDisplay && (
            <div className={`w-1/2 h-full min-w-0 ${customerTheme === 'dark' ? 'dark' : 'light'}`}>
              <PartySettlementCustomerScreen
                stage={customerStage}
                party={party}
                amount={stage === 'review' ? amount : collectAmount}
                method={stage === 'review' ? (method || undefined) : collectMethod}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
