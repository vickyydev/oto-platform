import { useEffect, useRef, useState } from 'react';
import { Loader2, XCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/i18n/LanguageContext';
import { publicApi, type PublicBookingStatus } from '@/api/platform';
import { ApiError } from '@/api/client';

/**
 * "CHECKING YOUR PAYMENT" — where the payment partner's page sends the guest
 * back (S2-12, SCRUM-209; `PAYMENT_GATEWAY.md` §3.10).
 *
 * The return itself proves nothing and this page treats it that way: it asks
 * the platform for the booking's state until the gateway's own confirmation
 * has made it `paid` (the signed QR arrives with that answer), or until the
 * platform says it failed or ran out. Nothing here, and nothing in the URL the
 * guest came back on, can make a booking paid.
 *
 * A UI addition in the booking site's own design language — the confirmation
 * page's centred icon, heading and muted line, and its full-width secondary
 * button — because the prototype confirmed a booking the instant "Pay" was
 * pressed and had no page for waiting on a bank.
 */

/** Every two seconds for the first minute, then every five, then the guest asks. */
const FAST_MS = 2_000;
const SLOW_MS = 5_000;
const FAST_FOR_MS = 60_000;
const GIVE_UP_MS = 180_000;

interface BookCheckingPaymentProps {
  bookingId: string;
  /**
   * What the payment page said on the way back, verified by the platform and
   * read as WORDS ONLY (`/public/bookings/return`). A failed payment on a page
   * that is still open leaves the booking `pending` (SCRUM-209 fix round 2:
   * the gateway may let the guest try again inside the same page), so without
   * this the page would say "checking" until the hold ran out. It never makes
   * anything paid, and the page keeps asking: a payment that does arrive
   * still shows the confirmation.
   */
  hint?: 'completed' | 'failed' | 'unknown';
  onPaid: (status: PublicBookingStatus) => void;
  onStartOver: () => void;
}

type View =
  | { kind: 'waiting'; slow: boolean }
  | { kind: 'closed'; status: 'cancelled' | 'expired'; reference: string }
  | { kind: 'missing' };

export function BookCheckingPayment({ bookingId, hint, onPaid, onStartOver }: BookCheckingPaymentProps) {
  const { t } = useLanguage();
  const [view, setView] = useState<View>({ kind: 'waiting', slow: false });
  const [round, setRound] = useState(0);
  const paidRef = useRef(onPaid);
  paidRef.current = onPaid;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setView({ kind: 'waiting', slow: false });

    const ask = async () => {
      try {
        const status = await publicApi.bookingStatus(bookingId);
        if (!active) return;
        if (status.status === 'paid' || status.status === 'redeemed') {
          paidRef.current(status);
          return;
        }
        if (status.status === 'cancelled' || status.status === 'expired') {
          setView({ kind: 'closed', status: status.status, reference: status.reference });
          return;
        }
        if (hint === 'failed') {
          // Still pending: said as failed, and still watched.
          setView({ kind: 'closed', status: 'cancelled', reference: status.reference });
        }
      } catch (err) {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) {
          setView({ kind: 'missing' });
          return;
        }
        // A dropped connection is not an answer: keep asking.
      }
      const elapsed = Date.now() - started;
      if (elapsed >= GIVE_UP_MS) {
        setView((current) => (current.kind === 'closed' ? current : { kind: 'waiting', slow: true }));
        return;
      }
      timer = setTimeout(() => void ask(), elapsed < FAST_FOR_MS ? FAST_MS : SLOW_MS);
    };
    void ask();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [bookingId, hint, round]);

  if (view.kind === 'waiting') {
    return (
      <div className="flex-1 flex flex-col px-5 py-8 animate-in fade-in duration-300">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-primary/15 text-primary flex items-center justify-center mx-auto mb-4">
            <Loader2 className="w-9 h-9 animate-spin" />
          </div>
          <h1 className="text-3xl font-black">{t('book.checking.title')}</h1>
          <p className="text-slate-500 mt-2">
            {view.slow ? t('book.checking.slow') : t('book.checking.subtitle')}
          </p>
        </div>
        {view.slow && (
          <div className="mt-auto pt-8">
            <Button variant="secondary" className="w-full h-14 gap-2" onClick={() => setRound((n) => n + 1)}>
              <RefreshCw className="w-4 h-4" />
              {t('book.checking.checkAgain')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col px-5 py-8 animate-in fade-in zoom-in-95 duration-400">
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-rose-500/15 text-rose-600 flex items-center justify-center mx-auto mb-4">
          <XCircle className="w-9 h-9" />
        </div>
        <h1 className="text-3xl font-black">
          {view.kind === 'missing' ? t('book.checking.notFound') : t('book.checking.failedTitle')}
        </h1>
        {view.kind === 'closed' && (
          <p className="text-slate-500 mt-2">
            {view.status === 'expired'
              ? t('book.checking.expiredBody', { ref: view.reference })
              : t('book.checking.failedBody', { ref: view.reference })}
          </p>
        )}
      </div>
      <div className="mt-auto pt-8">
        <Button variant="secondary" className="w-full h-14" onClick={onStartOver}>
          {t('book.checking.startOver')}
        </Button>
      </div>
    </div>
  );
}
