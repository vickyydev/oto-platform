import { PaymentExpiry, PaymentQr } from '@/components/till/PaymentQr';
import { QrCode as QrCodeIcon, Loader2 } from 'lucide-react';
import { useLanguage } from '@/i18n/LanguageContext';
import { bahtText } from '@/lib/bahtText';

// Customer-facing "Scan to Pay" Thai QR / PromptPay screen. Mirrors the
// promptpay stage of the in-venue F&B customer display so every surface that
// takes a Thai QR payment shows the customer the same thing.
interface PromptPayCustomerScreenProps {
  amount: number;
  /**
   * SCRUM-732 — the code the payment route answered with: the EMVCo payload or
   * the gateway's image. Until it has answered there is nothing to scan and the
   * square stays empty, so a guest is never shown a code no bank can pay.
   */
  qrPayload?: string | null;
  qrImageUrl?: string | null;
  expiresAt?: string | null;
  note?: string;
  /**
   * SCRUM-859 — drawn inside another screen's frame (the tender display's
   * payment stage, beside the lines): the same words, code and figure without
   * the full-height shell of their own.
   */
  embedded?: boolean;
}

export function PromptPayCustomerScreen({ amount, qrPayload, qrImageUrl, expiresAt, note, embedded = false }: PromptPayCustomerScreenProps) {
  const { t } = useLanguage();
  const hasCode = Boolean(qrPayload || qrImageUrl);
  const content = (
    <>
      <div className="inline-flex items-center gap-2 text-(--cd-violet) mb-4">
        <QrCodeIcon className="w-6 h-6" />
        <span className="uppercase tracking-widest text-sm font-bold">{t('fnb.payment.thaiQrPromptpay')}</span>
      </div>
      <h2 className="text-4xl font-black mb-6">{t('till.payment.scanToPay')}</h2>
      <div className="bg-white rounded-3xl p-6 shadow-2xl shadow-violet-500/20">
        <PaymentQr payload={qrPayload ?? null} imageUrl={qrImageUrl ?? null} className="w-64 h-64" label={t('display.qr.ready')} waitingLabel={t('display.qr.waiting')} />
      </div>
      <div className="text-6xl font-black text-(--cd-violet) mt-8 tabular-nums">฿{bahtText(amount)}</div>
      {note && <p className="text-lg text-foreground/60 mt-3">{note}</p>}
      {expiresAt && (
        <p className="text-lg text-foreground/60 mt-3">
          <PaymentExpiry expiresAt={expiresAt} />
        </p>
      )}
      {hasCode ? (
        <>
          <p className="text-xl text-foreground/60 mt-4 max-w-md">
            {t('till.payment.openBankingApp')}
          </p>
          <div className="flex items-center gap-3 mt-6 text-foreground/50 text-lg">
            <Loader2 className="w-5 h-5 animate-spin" />
            {t('till.payment.waitingConfirmation')}
          </div>
        </>
      ) : (
        <p className="text-xl text-foreground/60 mt-4 max-w-md">{t('till.payment.codePending')}</p>
      )}
    </>
  );
  if (embedded) return <div className="flex flex-col items-center text-center">{content}</div>;
  return (
    <div className="h-full w-full bg-[image:var(--cd-gradient)] text-foreground flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
        {content}
      </div>
    </div>
  );
}
