import type { DisplayPayment, DisplayTenderCart } from '@oto/shared';
import { PromptPayCustomerScreen } from './PromptPayCustomerScreen';

export function TenderCustomerDisplay({ cart, payment }: { cart: DisplayTenderCart; payment: DisplayPayment }) {
  const subject = cart.subject === 'event_pass' ? 'Event pass' : 'Party balance';
  const waiting = payment.online && !payment.offline && payment.status === 'pending';
  const note = payment.status === 'paid' ? 'Payment confirmed. Please wait for the team.'
    : payment.status === 'blocked' || payment.status === 'failed' || !payment.online || payment.offline
      ? 'Please follow the staff screen.' : 'Waiting for payment confirmation.';
  return <div className="h-full flex flex-col" data-testid="display-tender">
    <h1 className="shrink-0 text-center text-xl font-bold p-3">{subject}</h1>
    {cart.method === 'qr' ? <div className="flex-1 min-h-0">
      <PromptPayCustomerScreen amount={payment.amountSatang / 100}
        qrPayload={waiting ? payment.qrPayload : null} qrImageUrl={waiting ? payment.qrImageUrl : null}
        expiresAt={waiting ? payment.expiresAt : null} note={note} />
    </div> : <main className="flex-1 flex flex-col items-center justify-center gap-5 p-8 text-center">
      <h2 className="text-3xl font-bold">Pay by card</h2>
      <p className="text-5xl font-bold">฿{payment.amountSatang / 100}</p>
      <p className="text-xl">{note}</p>
    </main>}
  </div>;
}
