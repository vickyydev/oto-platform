import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getEnabledPaymentMethods, paymentMethodIcon, paymentMethodKind } from '@/lib/payments';
import type { PaymentMethodKind } from '@/types';

interface StepPaymentProps {
  total: number;
  selectedMethod: string | null;
  onSelectMethod: (method: string) => void;
  onComplete: () => void;
  onBack: () => void;
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

export function StepPayment({ total, selectedMethod, onSelectMethod, onComplete, onBack }: StepPaymentProps) {
  const methods = getEnabledPaymentMethods();
  const isQrPending = !!selectedMethod && paymentMethodKind(selectedMethod) === 'qr';

  return (
    <div className="flex flex-col h-full animate-in fade-in slide-in-from-right-4 duration-300">
      <div className="mb-8 text-center">
        <h2 className="text-4xl font-bold tracking-tight mb-2">Amount Due</h2>
        <div className="text-6xl font-black text-primary">฿{total}</div>
      </div>

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
              onClick={() => onSelectMethod(m.id)}
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

      {isQrPending && (
        <div className="mt-6 rounded-xl border border-violet-500/30 bg-violet-500/10 p-4 text-sm text-muted-foreground">
          <span className="font-bold text-foreground">QR shown to customer.</span> Confirm once the
          gateway reports the payment as received.
        </div>
      )}

      <div className="mt-auto pt-6 flex items-center justify-between gap-4">
        <Button variant="outline" size="lg" className="w-32 h-16" onClick={onBack}>
          Back
        </Button>
        <Button
          size="lg"
          className="flex-1 h-16 text-xl font-bold"
          disabled={!selectedMethod}
          onClick={onComplete}
        >
          Confirm Payment Received
        </Button>
      </div>
    </div>
  );
}
