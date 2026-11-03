import { PaymentExpiry, PaymentQr } from '@/components/till/PaymentQr';
import { QrCode as QrCodeIcon, Loader2 } from 'lucide-react';

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
}

export function PromptPayCustomerScreen({ amount, qrPayload, qrImageUrl, expiresAt, note }: PromptPayCustomerScreenProps) {
  const hasCode = Boolean(qrPayload || qrImageUrl);
  return (
    <div className="h-full w-full bg-[image:var(--cd-gradient)] text-foreground flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
        <div className="inline-flex items-center gap-2 text-(--cd-violet) mb-4">
          <QrCodeIcon className="w-6 h-6" />
          <span className="uppercase tracking-widest text-sm font-bold">Thai QR · PromptPay</span>
        </div>
        <h2 className="text-4xl font-black mb-6">Scan to Pay</h2>
        <div className="bg-white rounded-3xl p-6 shadow-2xl shadow-violet-500/20">
          <PaymentQr payload={qrPayload ?? null} imageUrl={qrImageUrl ?? null} className="w-64 h-64" />
        </div>
        <div className="text-6xl font-black text-(--cd-violet) mt-8 tabular-nums">฿{amount}</div>
        {note && <p className="text-lg text-foreground/60 mt-3">{note}</p>}
        {expiresAt && (
          <p className="text-lg text-foreground/60 mt-3">
            <PaymentExpiry expiresAt={expiresAt} />
          </p>
        )}
        {hasCode ? (
          <>
            <p className="text-xl text-foreground/60 mt-4 max-w-md">
              Open your banking app and scan to complete the payment.
            </p>
            <div className="flex items-center gap-3 mt-6 text-foreground/50 text-lg">
              <Loader2 className="w-5 h-5 animate-spin" />
              Waiting for payment confirmation…
            </div>
          </>
        ) : (
          <p className="text-xl text-foreground/60 mt-4 max-w-md">Your payment code will appear here.</p>
        )}
      </div>
    </div>
  );
}
