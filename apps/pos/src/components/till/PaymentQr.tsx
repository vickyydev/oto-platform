import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** `label` and `waitingLabel` name the code on a customer's screen. Left out, English: the staff panel. */
export function PaymentQr({ payload, imageUrl, className, label = 'Payment QR', waitingLabel = 'Waiting for payment QR' }: { payload?: string | null; imageUrl?: string | null; className?: string; label?: string; waitingLabel?: string }) {
  const [encoded, setEncoded] = useState<{ payload: string; url: string } | null>(null);
  useEffect(() => {
    let current = true;
    if (payload) {
      void QRCode.toDataURL(payload, { margin: 2, width: 512, errorCorrectionLevel: 'M' })
        .then((url) => { if (current) setEncoded({ payload, url }); })
        .catch(() => { if (current) setEncoded(null); });
    }
    return () => { current = false; };
  }, [payload]);
  const src = payload ? encoded?.payload === payload ? encoded.url : null : imageUrl;
  return src ? <img src={src} alt={label} className={className} data-testid="payment-qr" />
    : <div className={className} role="status" aria-label={waitingLabel} data-testid="payment-qr-waiting" />;
}

export function PaymentExpiry({ expiresAt }: { expiresAt: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return <span data-testid="payment-qr-countdown">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>;
}
