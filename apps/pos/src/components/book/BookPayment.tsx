import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { CreditCard, QrCode as QrCodeIcon, ArrowLeft, Lock, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getVenuePromptPayId } from '@/mockApi';
import { buildPromptPayPayload } from '@/lib/promptpay';
import { useLanguage } from '@/i18n/LanguageContext';

type Method = 'card' | 'promptpay';

interface BookPaymentProps {
  total: number;
  onBack: () => void;
  onPay: (method: Method) => void;
}

export function BookPayment({ total, onBack, onPay }: BookPaymentProps) {
  const { t } = useLanguage();
  const [method, setMethod] = useState<Method | null>(null);
  const [view, setView] = useState<'select' | 'promptpay'>('select');

  // A PromptPay payment reference shown to the customer for their records.
  const payRef = useMemo(
    () => `PP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    []
  );

  // Real, scannable EMVCo PromptPay payload -> rendered to a PNG data URL so the
  // customer can scan it on screen OR save it and upload it in their banking app.
  const payload = useMemo(
    () => buildPromptPayPayload(getVenuePromptPayId(), total),
    [total]
  );
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  useEffect(() => {
    let active = true;
    setQrDataUrl('');
    QRCode.toDataURL(payload, { margin: 2, width: 512, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [payload]);

  const handleSaveQr = () => {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = `oto-promptpay-${payRef}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (view === 'promptpay') {
    return (
      <div className="flex-1 flex flex-col px-5 py-6 animate-in fade-in slide-in-from-right-4 duration-300">
        <button
          type="button"
          onClick={() => setView('select')}
          className="inline-flex items-center gap-2 text-slate-500 mb-5"
        >
          <ArrowLeft className="w-5 h-5" /> {t('book.payment.paymentOptions')}
        </button>

        <h2 className="text-3xl font-black leading-tight">{t('book.payment.payWithPromptpay')}</h2>
        <p className="text-slate-500 mt-1">{t('book.payment.saveScanInstructions')}</p>

        <div className="mt-6 bg-white border border-slate-200 rounded-3xl p-6 flex flex-col items-center">
          <div className="bg-white rounded-2xl p-3 w-60 h-60 flex items-center justify-center">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="PromptPay QR code"
                className="w-full h-full"
                width={512}
                height={512}
              />
            ) : (
              <div className="text-slate-400 text-sm">{t('book.payment.generatingQr')}</div>
            )}
          </div>
          <div className="mt-4 text-center">
            <div className="text-xs uppercase tracking-widest text-slate-400">{t('book.payment.amount')}</div>
            <div className="text-3xl font-black text-primary tabular-nums mt-0.5">฿{total}</div>
            <div className="text-xs text-slate-400 mt-2">{t('book.payment.ref', { ref: payRef })}</div>
          </div>
          <Button
            variant="secondary"
            className="w-full h-12 gap-2 mt-5"
            disabled={!qrDataUrl}
            onClick={handleSaveQr}
          >
            <Download className="w-4 h-4" />
            {t('book.payment.saveQrImage')}
          </Button>
        </div>

        <ol className="mt-6 space-y-2 text-sm text-slate-500">
          <li>1. {t('book.payment.step1')}</li>
          <li>2. {t('book.payment.step2')}</li>
          <li>3. {t('book.payment.step3', { total: String(total) })}</li>
        </ol>

        <div className="sticky bottom-0 mt-auto pt-6 pb-2 bg-gradient-to-t from-sky-50 via-sky-50 to-transparent">
          <Button
            size="lg"
            className="w-full h-16 text-lg font-bold"
            onClick={() => onPay('promptpay')}
          >
            {t('book.payment.completedPayment')}
          </Button>
          <p className="text-center text-xs text-slate-400 mt-2">{t('book.payment.mockNote')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col px-5 py-6 animate-in fade-in slide-in-from-right-4 duration-300">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-2 text-slate-500 mb-5"
      >
        <ArrowLeft className="w-5 h-5" /> {t('common.back')}
      </button>

      <h2 className="text-3xl font-black leading-tight">{t('book.payment.title')}</h2>
      <p className="text-slate-500 mt-1">{t('book.payment.subtitle')}</p>

      <div className="mt-6 p-5 rounded-2xl bg-white border border-slate-200 flex items-baseline justify-between">
        <span className="text-slate-500">{t('book.payment.amountDue')}</span>
        <span className="text-4xl font-black text-primary tabular-nums">฿{total}</span>
      </div>

      <h3 className="text-lg font-semibold mt-7 mb-3">{t('book.payment.chooseHow')}</h3>
      <div className="space-y-3">
        <MethodButton
          active={method === 'card'}
          icon={<CreditCard className="w-6 h-6" />}
          title={t('book.payment.cardTitle')}
          subtitle={t('book.payment.cardSubtitle')}
          onClick={() => setMethod('card')}
        />
        <MethodButton
          active={method === 'promptpay'}
          icon={<QrCodeIcon className="w-6 h-6" />}
          title={t('book.payment.promptpayTitle')}
          subtitle={t('book.payment.promptpaySubtitle')}
          onClick={() => setMethod('promptpay')}
        />
      </div>

      <div className="sticky bottom-0 mt-auto pt-6 pb-2 bg-gradient-to-t from-sky-50 via-sky-50 to-transparent">
        <Button
          size="lg"
          disabled={!method}
          className="w-full h-16 text-lg font-bold gap-2"
          onClick={() => {
            if (method === 'promptpay') setView('promptpay');
            else if (method === 'card') onPay('card');
          }}
        >
          {method === 'promptpay' ? (
            <>
              <QrCodeIcon className="w-4 h-4" />
              {t('book.payment.continuePromptpay')}
            </>
          ) : (
            <>
              <Lock className="w-4 h-4" />
              {t('book.payment.payAmount', { total: String(total) })}
            </>
          )}
        </Button>
        <p className="text-center text-xs text-slate-400 mt-2">{t('book.payment.mockNote')}</p>
      </div>
    </div>
  );
}

function MethodButton({
  active,
  icon,
  title,
  subtitle,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-4 p-4 rounded-2xl border text-left transition-all active:scale-[0.98] ${
        active ? 'bg-primary/15 border-primary' : 'border-slate-200 hover:border-primary/40'
      }`}
    >
      <div
        className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
          active ? 'bg-primary/20 text-primary' : 'bg-white text-slate-500'
        }`}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-bold">{title}</div>
        <div className="text-sm text-slate-500">{subtitle}</div>
      </div>
      <div
        className={`w-6 h-6 rounded-full border flex items-center justify-center shrink-0 ${
          active ? 'bg-primary border-primary' : 'border-slate-300'
        }`}
      >
        {active && <div className="w-2.5 h-2.5 rounded-full bg-primary-foreground" />}
      </div>
    </button>
  );
}
