import type { DisplayPayment, DisplayTenderCart, DisplayTenderLine } from '@oto/shared';
import { useLanguage } from '@/i18n/LanguageContext';
import { PaymentStageLayout } from './PaymentStageLayout';
import { PromptPayCustomerScreen } from './PromptPayCustomerScreen';

/**
 * SCRUM-859 — what the tender is for, as the shop's line card draws a line:
 * the count, the label, the price each where one is known, and the line's
 * figure. The amount under it is the payment's own, never a sum made here.
 */
function TenderLines({ lines }: { lines: readonly DisplayTenderLine[] }) {
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
      <PaymentStageLayout lines={<TenderLines lines={lines} />}
        summary={<div className="flex items-center justify-between"><span className="text-2xl text-foreground/70">{t('common.total')}</span>
          <span className="text-5xl font-black text-primary tabular-nums">฿{amount}</span></div>}>
        {cart.method === 'qr' ? <PromptPayCustomerScreen amount={amount} embedded
          qrPayload={waiting ? payment.qrPayload : null} qrImageUrl={waiting ? payment.qrImageUrl : null}
          expiresAt={waiting ? payment.expiresAt : null} note={note} />
          : <div className="flex flex-col items-center gap-5 text-center">
            <h2 className="text-3xl font-bold">{t('display.tender.payByCard')}</h2>
            <p className="text-5xl font-bold">฿{amount}</p>
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
      <p className="text-5xl font-bold">฿{amount}</p>
      <p className="text-xl">{note}</p>
    </main>}
  </div>;
}
