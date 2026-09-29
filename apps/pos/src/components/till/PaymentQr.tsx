import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function PaymentQr({ payload, imageUrl, className }: { payload?: string | null; imageUrl?: string | null; className?: string }) {
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
  return src ? <img src={src} alt="Payment QR" className={className} data-testid="payment-qr" />
    : <div className={className} role="status" aria-label="Waiting for payment QR" data-testid="payment-qr-waiting" />;
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
