import { QrCode } from '@/components/till/QrCode';
import { QrCode as QrCodeIcon, Loader2 } from 'lucide-react';

// Customer-facing "Scan to Pay" Thai QR / PromptPay screen. Mirrors the
// promptpay stage of the in-venue F&B customer display so every surface that
// takes a Thai QR payment shows the customer the same thing.
interface PromptPayCustomerScreenProps {
  amount: number;
  // Seed for the visual QR matrix (the in-venue displays use a seeded
  // placeholder, not a live EMVCo payload — the public /book flow is the one
  // that issues a genuinely scannable code).
  seed: string;
  note?: string;
}

export function PromptPayCustomerScreen({ amount, seed, note }: PromptPayCustomerScreenProps) {
  return (
    <div className="h-full w-full bg-[image:var(--cd-gradient)] text-foreground flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center text-center px-10 animate-in fade-in zoom-in-95 duration-500">
        <div className="inline-flex items-center gap-2 text-(--cd-violet) mb-4">
          <QrCodeIcon className="w-6 h-6" />
          <span className="uppercase tracking-widest text-sm font-bold">Thai QR · PromptPay</span>
        </div>
        <h2 className="text-4xl font-black mb-6">Scan to Pay</h2>
        <div className="bg-white rounded-3xl p-6 shadow-2xl shadow-violet-500/20">
          <QrCode seed={seed} className="w-64 h-64" />
        </div>
        <div className="text-6xl font-black text-(--cd-violet) mt-8 tabular-nums">฿{amount}</div>
        {note && <p className="text-lg text-foreground/60 mt-3">{note}</p>}
        <p className="text-xl text-foreground/60 mt-4 max-w-md">
          Open your banking app and scan to complete the payment.
        </p>
        <div className="flex items-center gap-3 mt-6 text-foreground/50 text-lg">
          <Loader2 className="w-5 h-5 animate-spin" />
          Waiting for payment confirmation…
        </div>
      </div>
    </div>
  );
}
