import type { DisplayTenderLine } from '@oto/shared';
import { useLanguage } from '@/i18n/LanguageContext';

/**
 * SCRUM-859 — what the tender is for, as the shop's line card draws a line:
 * the count, the label, the price each where one is known, and the line's
 * figure. The amount under it is the payment's own, never a sum made here.
 *
 * Shared by the two surfaces of one tender: the paired tender display and the
 * event pass's split-view customer half, so the family reads the same card on
 * either.
 */
export function TenderLines({ lines }: { lines: readonly DisplayTenderLine[] }) {
  const { t } = useLanguage();
  return <div className="space-y-3">{lines.map((line, index) => <div key={index} data-testid="tender-display-line"
    className="bg-foreground/5 rounded-2xl px-5 py-4 border border-foreground/10">
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-4 min-w-0">
        <span className="w-10 h-10 rounded-xl bg-primary/15 text-primary font-black text-lg flex items-center justify-center shrink-0 tabular-nums">{line.qty}</span>
        <div className="min-w-0">
          <div className="text-xl font-bold leading-tight">{line.label}</div>
          {line.unitPrice !== undefined && <div className="text-foreground/40 text-sm tabular-nums">{t('display.price.each', { price: line.unitPrice })}</div>}
        </div>
      </div>
      <div className="text-2xl font-bold tabular-nums shrink-0">฿{line.lineTotal}</div>
    </div>
  </div>)}</div>;
}

/** The Total row under the tender's lines: the payment's own amount, in baht. */
export function TenderTotal({ amount }: { amount: number }) {
  const { t } = useLanguage();
  return <div className="flex items-center justify-between"><span className="text-2xl text-foreground/70">{t('common.total')}</span>
    <span className="text-5xl font-black text-primary tabular-nums">฿{amount}</span></div>;
}
