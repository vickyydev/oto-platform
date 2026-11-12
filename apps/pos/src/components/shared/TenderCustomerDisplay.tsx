import type { DisplayPayment, DisplayTenderCart } from '@oto/shared';
import { useLanguage } from '@/i18n/LanguageContext';
import { PaymentStageLayout } from './PaymentStageLayout';
import { PromptPayCustomerScreen } from './PromptPayCustomerScreen';
import { TenderLines, TenderTotal } from './TenderLines';
import { bahtText } from '@/lib/bahtText';

export function TenderCustomerDisplay({ cart, payment }: { cart: DisplayTenderCart; payment: DisplayPayment }) {
  const { t } = useLanguage();
  const subject = t(cart.subject === 'event_pass' ? 'book.eventPasses.eventPass'
    : cart.subject === 'extra_hour' ? 'display.tender.extraHour' : 'display.tender.partyBalance');
  const waiting = payment.online && !payment.offline && payment.status === 'pending';
  const note = payment.status === 'paid' ? t('display.tender.confirmed')
    : payment.status === 'blocked' || payment.status === 'failed' || !payment.online || payment.offline
      ? t('display.idle.followStaff') : t('till.payment.waitingConfirmation');
  const amount = payment.amountSatang / 100;
  const lines = cart.lines ?? [];
  // SCRUM-859 — a tender that names its lines draws them beside the amount in
  // the shared payment-stage frame; one that names none (the party balance, a
  // till built before this) keeps the amount-only screen as it was.
  if (lines.length > 0) {
    return <div className="h-full flex flex-col bg-[image:var(--cd-gradient)] text-foreground" data-testid="display-tender">
      <h1 className="shrink-0 text-center text-xl font-bold p-3">{subject}</h1>
      <PaymentStageLayout lines={<TenderLines lines={lines} />} summary={<TenderTotal amount={amount} />}>
        {cart.method === 'qr' ? <PromptPayCustomerScreen amount={amount} embedded
          qrPayload={waiting ? payment.qrPayload : null} qrImageUrl={waiting ? payment.qrImageUrl : null}
          expiresAt={waiting ? payment.expiresAt : null} note={note} />
          : <div className="flex flex-col items-center gap-5 text-center">
            <h2 className="text-3xl font-bold">{t('display.tender.payByCard')}</h2>
            <p className="text-5xl font-bold">฿{bahtText(amount)}</p>
            <p className="text-xl">{note}</p>
          </div>}
      </PaymentStageLayout>
    </div>;
  }
  return <div className="h-full flex flex-col" data-testid="display-tender">
    <h1 className="shrink-0 text-center text-xl font-bold p-3">{subject}</h1>
    {cart.method === 'qr' ? <div className="flex-1 min-h-0">
      <PromptPayCustomerScreen amount={amount}
        qrPayload={waiting ? payment.qrPayload : null} qrImageUrl={waiting ? payment.qrImageUrl : null}
        expiresAt={waiting ? payment.expiresAt : null} note={note} />
    </div> : <main className="flex-1 flex flex-col items-center justify-center gap-5 p-8 text-center">
      <h2 className="text-3xl font-bold">{t('display.tender.payByCard')}</h2>
      <p className="text-5xl font-bold">฿{bahtText(amount)}</p>
      <p className="text-xl">{note}</p>
    </main>}
  </div>;
}
