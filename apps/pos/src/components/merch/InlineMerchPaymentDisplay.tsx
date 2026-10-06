import type { DisplayPayment } from '@oto/shared';
import { Banknote, Loader2, QrCode, Wallet } from 'lucide-react';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { PaymentExpiry, PaymentQr } from '@/components/till/PaymentQr';
import { useLanguage } from '@/i18n/LanguageContext';
import { creditCoversOrder, guestLeftToPaySatang } from '@/lib/guestPayment';

/** The in-till guest display uses the same payment frame as the separate screen. */
export function InlineMerchPaymentDisplay({ payment, totalSatang }: { payment: DisplayPayment; totalSatang: number }) {
  const { t } = useLanguage();
  const creditUsed = (payment.creditSatang ?? 0) / 100;
  const leftToPay = guestLeftToPaySatang(payment, totalSatang) / 100;
  const coveredByCredit = creditCoversOrder(payment, totalSatang);
  const qrDue = payment.online && payment.status === 'pending' && (payment.qrPayload || payment.qrImageUrl);

  return <div className="relative flex h-full w-full flex-col bg-[image:var(--cd-gradient)] text-foreground">
    <div className="absolute right-4 top-4 z-40"><LanguageSwitcher variant="dark" /></div>
    {qrDue ? <div className="flex flex-1 flex-col items-center justify-center px-10 text-center animate-in fade-in zoom-in-95 duration-500">
      <div className="mb-4 inline-flex items-center gap-2 text-(--cd-violet)"><QrCode className="h-6 w-6" />
        <span className="text-sm font-bold uppercase tracking-widest">{t('merch.payment.thaiQrPromptpay')}</span></div>
      <h2 className="mb-6 text-4xl font-black">{t('merch.payment.scanToPay')}</h2>
      <div className="rounded-3xl bg-white p-6 shadow-2xl shadow-violet-500/20">
        <PaymentQr payload={payment.qrPayload} imageUrl={payment.qrImageUrl} className="h-64 w-64" /></div>
      <div className="mt-8 text-6xl font-black tabular-nums text-(--cd-violet)">฿{leftToPay}</div>
      {creditUsed > 0 && <p className="mt-3 text-lg text-foreground/60">{t('merch.payment.paidFromCredit', { amount: String(creditUsed) })}</p>}
      <PaymentExpiry expiresAt={payment.expiresAt} />
      <p className="mt-4 max-w-md text-xl text-foreground/60">{t('merch.payment.openBankingApp')}</p>
      <div className="mt-6 flex items-center gap-3 text-lg text-foreground/50"><Loader2 className="h-5 w-5 animate-spin" />{t('merch.payment.waiting')}</div>
    </div> : <div className="flex flex-1 flex-col items-center justify-center px-10 text-center animate-in fade-in zoom-in-95 duration-500">
      <div className="mb-8 flex h-24 w-24 items-center justify-center rounded-full bg-primary/15 text-primary"><Wallet className="h-12 w-12" /></div>
      <p className="mb-6 text-2xl text-foreground/70">{t('merch.payment.amountToPay')}</p>
      <div className="w-full max-w-md space-y-3">
        {creditUsed > 0 && <div className="flex items-center justify-between rounded-2xl border border-foreground/10 bg-foreground/5 px-6 py-4">
          <span className="flex items-center gap-3 text-xl text-foreground/80"><Wallet className="h-6 w-6 text-primary" />{t('merch.payment.fromCredit')}</span>
          <span className="text-2xl font-black tabular-nums text-primary">฿{creditUsed}</span></div>}
        <div className="flex items-center justify-between rounded-2xl border border-foreground/10 bg-foreground/5 px-6 py-4">
          <span className="flex items-center gap-3 text-xl text-foreground/80"><Banknote className="h-6 w-6 text-foreground/60" />
            {creditUsed > 0 ? t('merch.payment.leftToPay') : t('merch.payment.toPay')}</span>
          <span className="text-4xl font-black tabular-nums">฿{leftToPay}</span></div>
      </div>
      <p className="mt-8 text-xl text-foreground/60">{!payment.online ? t('till.payment.reconnect') : payment.offline ? t('till.payment.offlineRecorded')
        : payment.status === 'pending' ? t('merch.payment.waiting') : payment.status === 'paid' ? t('till.payment.received')
          : payment.status === 'blocked' || payment.status === 'failed' ? t('till.payment.checking')
            : coveredByCredit ? t('merch.payment.coveredByCredit') : t('merch.payment.confirmWithStaff')}</p>
    </div>}
  </div>;
}
