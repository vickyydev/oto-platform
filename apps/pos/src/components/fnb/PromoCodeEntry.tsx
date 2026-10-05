import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tag, Trash2 } from 'lucide-react';

/**
 * THE PROMO CODE ENTRY AT AN ITEM COUNTER — SCRUM-362.
 *
 * The design is the ticket till's, row for row: the applied codes as emerald
 * rows carrying the code's label, the code itself and what it took off, then
 * the uppercase code field with an Apply beside it and the refusal beneath
 * (`components/till/OrderSummary.tsx`). The prototype's F&B and shop screens
 * have no code entry of their own to copy, so the till's is the design.
 *
 * IT IS A COPY RATHER THAN A SHARED COMPONENT because the till's entry is
 * inline markup inside `OrderSummary`, a component that also draws ticket
 * lines, participant steppers and the tier note; there is nothing importable in
 * it. Extracting it would edit the till's panel, which belongs to another slice
 * in flight. Lifting both into one component is the tidy-up that follows.
 *
 * WHAT IT DOES NOT DECIDE: whether a code is any good. The station validates it
 * against the branch's discount definitions and hands back either an applied
 * code or a refusal to show (`lib/itemPromo.ts`).
 */

/** One applied code, as the quote reports it. */
export interface PromoCodeRow {
  code: string;
  label: string;
  amount: number;
  /** Set when the code found nothing left in its own scope, in the engine's words. */
  exhaustedReason?: string;
}

interface PromoCodeEntryProps {
  applied: PromoCodeRow[];
  /** The refusal for the last code entered, shown beneath the field. */
  error?: string;
  /** No code can be applied to an empty order. */
  disabled?: boolean;
  onApply: (code: string) => void;
  onRemove: (code: string) => void;
}

export function PromoCodeEntry({ applied, error, disabled, onApply, onRemove }: PromoCodeEntryProps) {
  const [input, setInput] = useState('');

  const apply = () => {
    const code = input.trim();
    if (!code) return;
    onApply(code);
  };

  return (
    <div className="space-y-2">
      {applied.map((promo) => (
        <div
          key={promo.code}
          className="flex justify-between items-center text-emerald-500 bg-emerald-500/10 p-3 rounded-lg"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Tag className="w-4 h-4 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium leading-tight truncate">{promo.label}</div>
              <div className="text-xs text-emerald-500/70 font-mono">{promo.code}</div>
              {promo.exhaustedReason && (
                <div className="text-xs text-amber-400 leading-snug">{promo.exhaustedReason}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="font-bold tabular-nums">-฿{promo.amount.toFixed(0)}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-emerald-500 hover:bg-emerald-500/20 hover:text-emerald-600"
              onClick={() => onRemove(promo.code)}
              aria-label={`Remove ${promo.code}`}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      ))}

      <div className="space-y-1.5">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply();
            }}
            placeholder="Promo code…"
            aria-label="Promo code"
            className="flex-1 h-9 rounded-xl border border-foreground/10 bg-black/20 px-3 text-sm font-mono uppercase tracking-wide placeholder:normal-case placeholder:tracking-normal text-foreground placeholder:text-foreground/30 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-colors"
            disabled={disabled}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-9 px-3 shrink-0"
            disabled={disabled || !input.trim()}
            onClick={apply}
          >
            Apply
          </Button>
        </div>
        {error && <p className="text-xs text-rose-400 px-1">{error}</p>}
      </div>
    </div>
  );
}
