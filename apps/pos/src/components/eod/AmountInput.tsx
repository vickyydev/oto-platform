import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Touch-sized numeric field used everywhere staff enter a counted figure on the
 * End-of-Day screen (terminal actuals, cash counted/float, voucher counts). Empty
 * means "not entered yet" → null; otherwise a non-negative whole number. Reused so
 * every input behaves and looks identical (no per-field markup duplication).
 */
export function AmountInput({
  value,
  onChange,
  disabled,
  prefix = '฿',
  className,
  ariaLabel,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  /** Leading glyph (e.g. ฿). Pass '' for plain counts. */
  prefix?: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      {prefix && (
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
          {prefix}
        </span>
      )}
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        aria-label={ariaLabel}
        disabled={disabled}
        value={value ?? ''}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') return onChange(null);
          const n = Math.max(0, Math.floor(Number(raw)));
          onChange(Number.isFinite(n) ? n : null);
        }}
        className={cn('h-11 text-right text-base tabular-nums [color-scheme:dark]', prefix && 'pl-8')}
      />
    </div>
  );
}
