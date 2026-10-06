import { useState } from 'react';
import { CreditCard, QrCode as QrCodeIcon, ArrowLeft, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/i18n/LanguageContext';

type Method = 'card' | 'promptpay';

interface BookPaymentProps {
  total: number;
  onBack: () => void;
  onPay: (method: Method) => void;
}

/**
 * The pay step (S2-12, SCRUM-209). Both methods now go to the payment
 * partner's hosted page, restricted to the one the guest chose — card or
 * PromptPay — and the booking is confirmed only when the partner tells the
 * platform the money arrived.
 *
 * The prototype's second PromptPay view is gone: it drew a PromptPay QR to the
 * park's own account and then took the guest's word for it ("I've completed
 * payment"), which is exactly what a real booking may no longer rest on. The
 * selection screen above it is unchanged; its footnote now says where the
 * guest will pay instead of calling the payment a mock.
 */
export function BookPayment({ total, onBack, onPay }: BookPaymentProps) {
  const { t } = useLanguage();
  const [method, setMethod] = useState<Method | null>(null);

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
            if (method) onPay(method);
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
        <p className="text-center text-xs text-slate-400 mt-2">{t('book.payment.securePageNote')}</p>
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
