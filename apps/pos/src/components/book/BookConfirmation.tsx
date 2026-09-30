import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Booking } from '@/types';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Baby, User, Wallet, ScanLine, HeartHandshake, Clock, AlertTriangle, Ticket } from 'lucide-react';
import { useLanguage } from '@/i18n/LanguageContext';
import { formatVisitDate } from '@/lib/visitDate';

interface BookConfirmationProps {
  booking: Booking;
  name: string;
  /**
   * The booking QR the park SIGNED when the payment gateway confirmed the
   * money (S2-12, `@oto/shared` `booking-qr.ts`) — what reception scans and a
   * box verifies with no network. Null only where the platform could not sign
   * one; the reference below is then what reception types.
   */
  qr: string | null;
  /** The day booked, as the platform holds it (S2-12 fix round 2 — the date step). */
  visitDate?: string | null;
  /**
   * Reception has already redeemed it. The page can be reopened from its
   * return link, and once the booking has been used the platform stops
   * handing out its QR (`publicBookingStatus`).
   */
  redeemed?: boolean;
  onStartOver: () => void;
}

export function BookConfirmation({ booking, name, qr, visitDate, redeemed, onStartOver }: BookConfirmationProps) {
  const { t, lang } = useLanguage();
  // A REAL encoded QR of the signed code, drawn here in the browser — the
  // stylised pattern `lib/qr.ts` drew could not be scanned by anything.
  const [qrDataUrl, setQrDataUrl] = useState('');
  useEffect(() => {
    let active = true;
    setQrDataUrl('');
    if (!qr) return;
    QRCode.toDataURL(qr, { margin: 1, width: 448, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [qr]);
  const { childBracelets, adultBracelets, creditTotalTHB } = booking.willIssue;
  const dropOffChildren = booking.lines.filter((l) => l.dropOff).map((l) => l.dropOff!);
  const hasNanny = dropOffChildren.some((d) => d.service === 'nanny');
  const eventPasses = booking.eventPasses ?? [];

  return (
    <div className="flex-1 flex flex-col px-5 py-8 animate-in fade-in zoom-in-95 duration-400">
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-600 flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 className="w-9 h-9" />
        </div>
        <h1 className="text-3xl font-black">
          {t('book.confirmation.booked', { namePart: name ? `, ${name}` : '' })}
        </h1>
        <p className="text-slate-500 mt-2">
          {t('book.confirmation.paidSeeYou', { total: String(booking.total) })}
        </p>
        {visitDate && (
          <p className="text-slate-700 font-semibold mt-1">
            {t('book.confirmation.visitOn', { date: formatVisitDate(visitDate, lang) })}
          </p>
        )}
      </div>

      <div className="mt-7 bg-white border border-slate-200 rounded-3xl p-6 flex flex-col items-center">
        {qrDataUrl ? (
          <img src={qrDataUrl} alt="Booking QR code" className="w-56 h-56" width={448} height={448} />
        ) : (
          <div className="w-56 h-56 rounded-2xl bg-slate-100" aria-hidden />
        )}
        <div className="mt-4 text-center">
          <div className="text-xs uppercase tracking-widest text-slate-400">
            {t('book.confirmation.bookingRef')}
          </div>
          <div className="text-2xl font-black tracking-wider mt-1">{booking.reference}</div>
          {redeemed && (
            <div className="text-sm text-slate-500 mt-2">{t('book.confirmation.redeemedNote')}</div>
          )}
        </div>
      </div>

      <div className="mt-7">
        <div className="flex items-center gap-2 text-slate-700 font-semibold mb-3">
          <ScanLine className="w-5 h-5 text-primary" />
          <span>{t('book.confirmation.scanToReceive')}</span>
        </div>
        <div className="space-y-2">
          {childBracelets > 0 && (
            <IssueRow
              icon={<Baby className="w-5 h-5" />}
              label={t('book.confirmation.childBracelets')}
              value={`× ${childBracelets}`}
            />
          )}
          {adultBracelets > 0 && (
            <IssueRow
              icon={<User className="w-5 h-5" />}
              label={t('book.confirmation.adultBracelets')}
              value={`× ${adultBracelets}`}
            />
          )}
          {creditTotalTHB > 0 && (
            <IssueRow
              icon={<Wallet className="w-5 h-5" />}
              label={t('book.confirmation.credit')}
              value={`฿${creditTotalTHB}`}
            />
          )}
        </div>
        <p className="text-xs text-slate-400 mt-3">{t('book.confirmation.braceletsNote')}</p>
      </div>

      {dropOffChildren.length > 0 && (
        <div className="mt-7">
          <div className="flex items-center gap-2 text-slate-700 font-semibold mb-3">
            <HeartHandshake className="w-5 h-5 text-pink-300" />
            <span>{t('book.confirmation.supervisedBooked')}</span>
          </div>
          <div className="space-y-2">
            {dropOffChildren.map((d) => {
              const isNanny = d.service === 'nanny';
              const isNone = d.service === 'none';
              return (
                <div
                  key={d.checkInId || d.childName}
                  className="flex items-center gap-3 p-4 rounded-2xl bg-pink-500/10 border border-pink-300/20"
                >
                  <div className="w-10 h-10 rounded-xl bg-pink-500/20 text-pink-300 flex items-center justify-center shrink-0">
                    <Baby className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">{d.childName}</div>
                    <div className="text-xs text-slate-500">
                      {isNone
                        ? t('book.confirmation.noService')
                        : isNanny
                        ? t('book.confirmation.dedicatedNanny')
                        : t('book.confirmation.dropOffSupervision')}{' '}
                      · {d.hours}h
                    </div>
                    {isNanny && d.nannyStartTime && (
                      <div className="flex items-center gap-1 text-xs text-pink-300 mt-1">
                        <Clock className="w-3.5 h-3.5" />
                        <span>
                          {t('book.confirmation.coverageFrom')} <strong>{d.nannyStartTime}</strong>
                        </span>
                      </div>
                    )}
                  </div>
                  <span className="font-bold tabular-nums shrink-0">฿{d.serviceFeeTHB}</span>
                </div>
              );
            })}
          </div>
          {hasNanny && (
            <div className="flex items-start gap-2 mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-300/60 text-amber-700 text-xs">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{t('book.confirmation.nannyBillingNote')}</span>
            </div>
          )}
          <p className="text-xs text-slate-400 mt-2">{t('book.confirmation.checkInNote')}</p>
        </div>
      )}

      {eventPasses.length > 0 && (
        <div className="mt-7">
          <div className="flex items-center gap-2 text-slate-700 font-semibold mb-3">
            <Ticket className="w-5 h-5 text-violet-600" />
            <span>{t('book.confirmation.eventPassesBooked')}</span>
          </div>
          <div className="space-y-2">
            {eventPasses.map((p) => (
              <div
                key={p.attendeeId}
                className="flex items-center gap-3 p-4 rounded-2xl bg-violet-500/10 border border-violet-300/60"
              >
                <div className="w-10 h-10 rounded-xl bg-violet-500/20 text-violet-700 flex items-center justify-center shrink-0">
                  <Ticket className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{p.attendeeName}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {p.eventTitle}
                    {p.parentAttending ? ` · ${t('book.confirmation.parentBand')}` : ''}
                  </div>
                </div>
                <span className="font-bold tabular-nums shrink-0">฿{p.priceTHB}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-400 mt-2">{t('book.confirmation.scanEventNote')}</p>
        </div>
      )}

      <div className="mt-auto pt-8">
        <Button variant="secondary" className="w-full h-14" onClick={onStartOver}>
          {t('book.confirmation.makeAnother')}
        </Button>
      </div>
    </div>
  );
}

function IssueRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-2xl bg-white border border-slate-200">
      <div className="w-10 h-10 rounded-xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
        {icon}
      </div>
      <span className="flex-1 font-medium">{label}</span>
      <span className="font-bold tabular-nums">{value}</span>
    </div>
  );
}
