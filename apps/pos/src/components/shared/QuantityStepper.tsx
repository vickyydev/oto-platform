import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QuantityStepperProps {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}

export function QuantityStepper({
  value,
  onChange,
  min = 0,
  max = 99,
  size = 'md',
  ariaLabel = 'quantity',
}: QuantityStepperProps) {
  const btn =
    size === 'sm'
      ? 'w-8 h-8 rounded-md'
      : 'w-11 h-11 rounded-lg';
  const valueBox = size === 'sm' ? 'w-7 text-lg' : 'w-10 text-2xl';

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label={`Remove one ${ariaLabel}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className={cn(
          btn,
          'border bg-background flex items-center justify-center transition-transform hover:bg-muted active:scale-90 disabled:opacity-30 disabled:pointer-events-none'
        )}
      >
        <Minus className={size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'} />
      </button>
      <span className={cn(valueBox, 'text-center font-bold tabular-nums')}>{value}</span>
      <button
        type="button"
        aria-label={`Add one ${ariaLabel}`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        className={cn(
          btn,
          'bg-primary text-primary-foreground flex items-center justify-center transition-transform hover:bg-primary/90 active:scale-90 disabled:opacity-30 disabled:pointer-events-none'
        )}
      >
        <Plus className={size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'} />
      </button>
    </div>
  );
}
