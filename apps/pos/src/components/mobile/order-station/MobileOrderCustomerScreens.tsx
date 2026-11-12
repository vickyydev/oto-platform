import { CheckCircle2, Hash, StickyNote, Wallet } from 'lucide-react';
import { PaymentExpiry, PaymentQr } from '@/components/till/PaymentQr';
import { useLanguage } from '@/i18n/LanguageContext';
import { resolveName } from '@/i18n/resolveTranslation';
import type { PaymentDisplayState } from '@/lib/usePaymentStage';
import type { FnbOrderLine } from '@/types';
import { bahtText, satangText } from '@/lib/bahtText';

/**
 * What the customer holds when the phone is handed over at the order station,
 * inside HandToCustomer. They read the device's language (SCRUM-729), as the
 * hand-over's own title and buttons do; the staff screens around them stay in
 * English. No allergy information, ever.
 */
export function MobileOrderReviewScreen({
  pickupCode,
  lines,
  creditBalance,
  total,
}: {
  pickupCode: string;
  lines: readonly FnbOrderLine[];
  creditBalance: number;
  total: number;
}) {
  const { t, lang } = useLanguage();
  return (
    <div className="min-h-full flex flex-col bg-slate-950 text-white p-6">
      <div className="flex flex-col items-center text-center mb-6">
        <div className="w-16 h-16 rounded-full bg-primary/20 text-primary flex items-center justify-center mb-3">
          <CheckCircle2 className="w-9 h-9" />
        </div>
        <h2 className="text-2xl font-black tracking-tight">{t('fnb.header.yourOrder')}</h2>
        <p className="text-muted-foreground text-sm mt-1">
          {t('display.order.reviewBelow')}
        </p>
      </div>

      {pickupCode && (
        <div className="flex items-center justify-center gap-2 mb-5 px-4 py-2 rounded-full border border-white/20 bg-white/10 self-center">
          <Hash className="w-4 h-4 text-white/70" />
          <span className="text-sm text-white/70">{t('display.order.pickupCode')}</span>
          <span className="font-black text-white tracking-widest">{pickupCode}</span>
        </div>
      )}

      <div className="flex-1 space-y-2 mb-4">
        {lines.map((line) => (
          <div key={line.id} className="flex items-center justify-between gap-3 py-2 border-b border-white/10">
            <div className="min-w-0 flex-1">
              <span className="font-bold tabular-nums mr-1">{line.qty}×</span>
              <span className="font-medium">{resolveName(line.menuItem, lang)}</span>
              {line.note && (
                <div className="flex items-start gap-1 mt-0.5 text-xs text-amber-300">
                  <StickyNote className="w-3 h-3 mt-px shrink-0" />
                  {line.note}
                </div>
              )}
            </div>
            <span className="font-bold tabular-nums shrink-0">฿{bahtText(line.lineTotal)}</span>
          </div>
        ))}
      </div>

      {creditBalance > 0 && (
        <div className="flex items-center justify-between py-2 text-sm text-white/70 border-t border-white/10">
          <span className="flex items-center gap-1.5">
            <Wallet className="w-4 h-4" />
            {t('display.grant.credit')}
          </span>
          <span className="tabular-nums">{t('display.credit.available', { amount: bahtText(creditBalance) })}</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-3 border-t border-white/20">
        <span className="text-xl font-black">{t('common.total')}</span>
        <span className="text-3xl font-black tabular-nums text-primary">฿{bahtText(total)}</span>
      </div>
    </div>
  );
}

export function MobileOrderQrScreen({
  pickupCode,
  payment,
  showCode,
}: {
  pickupCode: string;
  payment: PaymentDisplayState;
  /** A live gateway attempt with a code to scan. */
  showCode: boolean;
}) {
  const { t } = useLanguage();
  return (
    <div className="min-h-full flex flex-col items-center justify-center bg-slate-950 text-white p-8">
      <div className="text-center mb-6">
        <p className="text-muted-foreground text-sm mb-1">{t('display.order.scanToPay')}</p>
        <div className="text-4xl font-black tabular-nums text-primary">
          ฿{satangText(payment.amountSatang)}
        </div>
        {pickupCode && (
          <div className="inline-flex items-center gap-1.5 mt-3 px-3 py-1 rounded-full border border-white/20 bg-white/10 text-sm text-white/70">
            <Hash className="w-3.5 h-3.5" />
            {t('display.order.pickupCode')}{' '}
            <span className="font-black text-white tracking-widest">{pickupCode}</span>
          </div>
        )}
      </div>
      {showCode && <div className="rounded-2xl bg-white p-4 mb-6 shadow-xl">
        <PaymentQr payload={payment.qrPayload} imageUrl={payment.qrImageUrl} className="h-56 w-56" label={t('display.qr.ready')} waitingLabel={t('display.qr.waiting')} />
      </div>}
      {showCode && <PaymentExpiry expiresAt={payment.expiresAt} />}
      <p className="text-center text-sm text-muted-foreground max-w-xs">
        {!payment.online ? t('till.payment.reconnect') : payment.status === 'paid' ? t('till.payment.received') : payment.status === 'pending' ? t('fnb.payment.waiting') : t('till.payment.checking')}
      </p>
    </div>
  );
}
