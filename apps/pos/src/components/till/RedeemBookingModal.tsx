import { useState, useRef, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Booking } from '@/types';
import { ApiError, NetworkError, isMissingRoute } from '@/api/client';
import {
  BOOKING_QR_SIGNATURE_INVALID,
  bookingsApi,
  describeRedemption,
  fetchScannedBooking,
  typedBookingQr,
  type ScannedBooking,
  toPosBooking,
  type PlatformBooking,
  type PlatformRedemption,
  type RedeemOutcome,
  type RedeemedBand,
  type UnmappedLine,
} from '@/api/bookings';
import { QrCode, CheckCircle2, AlertTriangle, Search, Ticket, Users, Baby, CreditCard, Smartphone, Loader2 } from 'lucide-react';

interface RedeemBookingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The branch this till is on, as the platform knows it. Null when unresolved. */
  branchId: string | null;
  /**
   * Called when staff confirms a valid unredeemed booking — Till claims it on
   * the platform, then records the sale, mints and prints. Its answer decides
   * whether this dialog closes, shows who redeemed the booking first, or stays
   * put with the reason nothing was issued.
   */
  onConfirm: (booking: Booking, platform: PlatformBooking) => Promise<RedeemOutcome>;
  /**
   * S2-12 round 3 — the booking a scanned QR named: the id the box vouched
   * for after checking the signature, or the raw code a scanner on this
   * device read, which the platform checks before anything opens. When set as
   * the dialog opens, it goes straight to that booking's summary instead of
   * waiting for a typed reference.
   */
  scannedBooking?: ScannedBooking | null;
}

type Stage = 'lookup' | 'summary' | 'already_redeemed' | 'issued';

/** What the counter's box issued for a booking it redeemed offline (S2-12 round 5). */
interface Issued {
  receiptNumber: string | null;
  bands: RedeemedBand[];
  notes: string[];
}

function paymentMethodLabel(pm: string): string {
  if (pm === 'card') return 'Card';
  if (pm === 'promptpay') return 'PromptPay / QR';
  return pm;
}

function paymentMethodIcon(pm: string) {
  if (pm === 'promptpay') return <Smartphone className="w-4 h-4" />;
  return <CreditCard className="w-4 h-4" />;
}

/**
 * REDEEMING A BOOKING MADE ONLINE — SCRUM-234.
 *
 * The design is the prototype's unchanged: type or scan a reference, a summary
 * of what the family paid for, Confirm & Issue, and an already-redeemed panel.
 * What changed is where it reads: `mockApi.getAllBookings` / `getBooking` lived
 * in the browser tab that made the booking, so a family who booked on their
 * phone was unknown at the counter. Both reads are now `GET /bookings` and
 * `GET /bookings/by-reference/:reference` (`api/bookings.ts`).
 *
 * THERE IS NO MOCK FALLBACK. A reference reception reads out and issues bands
 * against has to be the row that took the money. Where the platform cannot
 * answer, the panel says which of the three things happened — no connection, no
 * such route on this deployment, or the lookup failed — and nothing is issued.
 */
export function RedeemBookingModal({
  open,
  onOpenChange,
  branchId,
  onConfirm,
  scannedBooking = null,
}: RedeemBookingModalProps) {
  const [stage, setStage] = useState<Stage>('lookup');
  const [refInput, setRefInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [foundBooking, setFoundBooking] = useState<Booking | null>(null);
  const [foundPlatform, setFoundPlatform] = useState<PlatformBooking | null>(null);
  const [unmapped, setUnmapped] = useState<UnmappedLine[]>([]);
  // S2-12 — why nothing can be issued against the booking found (not paid), or null.
  const [notPaid, setNotPaid] = useState<string | null>(null);
  const [redemption, setRedemption] = useState<PlatformRedemption | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [waiting, setWaiting] = useState<PlatformBooking[]>([]);
  const [waitingState, setWaitingState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [waitingNote, setWaitingNote] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /** One sentence a person on reception can act on, for each way the platform can fail. */
  const readFailure = useCallback((err: unknown, subject: string): string => {
    if (err instanceof NetworkError) {
      return `No connection to the platform, so ${subject} cannot be checked. Nothing has been issued.`;
    }
    if (isMissingRoute(err)) {
      return `This deployment has no booking lookup yet (SCRUM-234), so ${subject} cannot be checked here.`;
    }
    if (err instanceof ApiError) return err.message;
    return `${subject} could not be checked.`;
  }, []);

  const show = useCallback((p: PlatformBooking) => {
    const mapped = toPosBooking(p);
    setFoundPlatform(p);
    setFoundBooking(mapped.booking);
    setUnmapped(mapped.unmapped);
    setNotPaid(mapped.notPaidReason);
    setRedemption(p.redemption);
    setStage(p.redemption ? 'already_redeemed' : 'summary');
  }, []);

  // Reset and reload the waiting list each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setStage('lookup');
    setRefInput('');
    setError(null);
    setFoundBooking(null);
    setFoundPlatform(null);
    setUnmapped([]);
    setNotPaid(null);
    setRedemption(null);
    setIssued(null);
    setLookingUp(false);
    setTimeout(() => inputRef.current?.focus(), 80);

    if (!branchId) {
      setWaiting([]);
      setWaitingState('unavailable');
      setWaitingNote('This till is not linked to a branch on the platform, so today’s bookings cannot be listed.');
      return;
    }
    let live = true;
    setWaitingState('loading');
    setWaitingNote(null);
    void bookingsApi
      .waiting(branchId)
      .then((res) => {
        if (!live) return;
        setWaiting(res.bookings);
        setWaitingState('ready');
      })
      .catch((err: unknown) => {
        if (!live) return;
        setWaiting([]);
        setWaitingState('unavailable');
        setWaitingNote(readFailure(err, 'the bookings waiting at reception'));
      });
    return () => {
      live = false;
    };
  }, [open, branchId, readFailure]);

  async function lookup(ref: string) {
    const trimmed = ref.trim().toUpperCase();
    if (!trimmed) {
      setError('Enter or scan a booking reference.');
      return;
    }
    setLookingUp(true);
    setError(null);
    try {
      // A booking QR read into this field by a scanner goes to the platform
      // whole, which checks its signature; anything else is the reference
      // printed beside it.
      const qr = typedBookingQr(trimmed);
      const p = qr ? await bookingsApi.byQr(qr) : await bookingsApi.byReference(trimmed, branchId ?? undefined);
      show(p);
    } catch (err) {
      if (err instanceof ApiError && err.code === BOOKING_QR_SIGNATURE_INVALID) {
        setError(err.message);
      } else if (err instanceof ApiError && err.status === 404 && !isMissingRoute(err)) {
        setError(`No booking found for "${trimmed}".`);
      } else {
        setError(readFailure(err, `"${trimmed}"`));
      }
    } finally {
      setLookingUp(false);
    }
  }

  // A scanned QR opened this dialog: go straight to that booking.
  useEffect(() => {
    if (!open || !scannedBooking) return;
    let live = true;
    setLookingUp(true);
    setError(null);
    void fetchScannedBooking(scannedBooking)
      .then((p) => {
        if (!live) return;
        setRefInput(p.reference);
        show(p);
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.code === BOOKING_QR_SIGNATURE_INVALID) {
          setError(err.message);
        } else if (err instanceof ApiError && err.status === 404 && !isMissingRoute(err)) {
          setError('No booking found for the scanned QR.');
        } else {
          setError(readFailure(err, 'the scanned booking'));
        }
      })
      .finally(() => {
        if (live) setLookingUp(false);
      });
    return () => {
      live = false;
    };
  }, [open, scannedBooking, show, readFailure]);

  function handleLookup() {
    void lookup(refInput);
  }

  function handlePickWaiting(p: PlatformBooking) {
    setRefInput(p.reference);
    setError(null);
    show(p);
  }

  async function handleConfirm() {
    if (!foundBooking || !foundPlatform || confirming || notPaid) return;
    setConfirming(true);
    setError(null);
    try {
      const outcome = await onConfirm(foundBooking, foundPlatform);
      if (outcome.ok) {
        // Redeemed by the counter's box with the link down: stay on the codes,
        // for reading aloud should a band not print.
        if (outcome.issued) {
          setIssued(outcome.issued);
          setStage('issued');
          return;
        }
        onOpenChange(false);
        return;
      }
      if ('redemption' in outcome) {
        setRedemption(outcome.redemption);
        setStage('already_redeemed');
        return;
      }
      setError(outcome.message);
    } finally {
      setConfirming(false);
    }
  }

  // Drop-off children and event passes are not columns on `pos.booking` and are
  // not priced by `POST /public/bookings`, so these are empty until S2-13 and
  // S2-20 put them on the row. The panels below are the prototype's, unchanged,
  // and light up when the booking carries them.
  const dropOffChildren = foundBooking
    ? foundBooking.lines.flatMap((l) => (l.dropOff ? [l.dropOff.childName] : []))
    : [];
  const eventPasses = foundBooking?.eventPasses ?? [];
  const regularKids = foundBooking
    ? foundBooking.lines.reduce((s, l) => (l.dropOff ? s : s + l.kids), 0)
    : 0;
  const regularAdults = foundBooking
    ? foundBooking.lines.reduce((s, l) => (l.dropOff ? s : s + l.adults), 0)
    : 0;
  // S2-12 — the socks and extras paid for online, summed by name across lines,
  // so reception hands them over with the wristbands.
  const paidExtras = foundBooking
    ? [...foundBooking.lines
        .flatMap((l) => l.addOns)
        .reduce((byName, a) => byName.set(a.name, (byName.get(a.name) ?? 0) + a.quantity), new Map<string, number>())
        .entries()]
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <QrCode className="w-5 h-5 text-primary" />
            Redeem Online Booking
          </DialogTitle>
          <DialogDescription>
            Scan or type the booking reference from the customer's QR code.
          </DialogDescription>
        </DialogHeader>

        {stage === 'lookup' && (
          <div className="space-y-5 pt-1">
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                value={refInput}
                onChange={(e) => {
                  setRefInput(e.target.value.toUpperCase());
                  setError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
                placeholder="OTO-XXXX-XXXX"
                className="font-mono text-base uppercase h-12"
                spellCheck={false}
                autoComplete="off"
                disabled={lookingUp}
              />
              <Button onClick={handleLookup} className="h-12 px-5 shrink-0" disabled={lookingUp}>
                {lookingUp ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Search className="w-4 h-4 mr-2" />
                )}
                Look up
              </Button>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            {waitingState === 'loading' && (
              <p className="text-sm text-muted-foreground text-center py-4 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading bookings waiting at reception…
              </p>
            )}

            {waitingState === 'unavailable' && waitingNote && (
              <div className="flex items-start gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{waitingNote}</span>
              </div>
            )}

            {waitingState === 'ready' && waiting.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
                  Paid bookings waiting at reception
                </p>
                <div className="space-y-1.5 max-h-52 overflow-y-auto pr-0.5">
                  {waiting.map((b) => (
                    <button
                      key={b.id}
                      onClick={() => handlePickWaiting(b)}
                      className="w-full text-left rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 px-4 py-3 transition-colors flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="font-mono font-semibold text-sm">{b.reference}</div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                          <span className="capitalize">{b.tier}</span>
                          <span>·</span>
                          <span>
                            {b.lines.reduce((s, l) => s + l.kids + l.adults, 0)} guests
                          </span>
                          {b.parentName && (
                            <>
                              <span>·</span>
                              <span className="truncate">{b.parentName}</span>
                            </>
                          )}
                          {/* The prototype showed a drop-off marker here; drop-off on a
                              booking is S2-13 and the row does not carry one yet. */}
                        </div>
                      </div>
                      <Badge variant="secondary" className="shrink-0 text-xs">
                        ฿{(b.totalSatang / 100).toLocaleString()}
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {waitingState === 'ready' && waiting.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                No unredeemed bookings on file — enter the reference above.
              </p>
            )}
          </div>
        )}

        {stage === 'summary' && foundBooking && (
          <div className="space-y-5 pt-1">
            <div className="rounded-xl border border-primary/30 bg-primary/5 px-5 py-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono font-bold text-lg tracking-wide">{foundBooking.reference}</span>
                <Badge className="capitalize">{foundBooking.tier}</Badge>
              </div>

              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                {regularAdults > 0 && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Users className="w-4 h-4 shrink-0" />
                    <span>{regularAdults} adult{regularAdults !== 1 ? 's' : ''}</span>
                  </div>
                )}
                {regularKids > 0 && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Ticket className="w-4 h-4 shrink-0" />
                    <span>{regularKids} child{regularKids !== 1 ? 'ren' : ''}</span>
                  </div>
                )}
                {dropOffChildren.length > 0 && (
                  <div className="flex items-center gap-2 text-muted-foreground col-span-2">
                    <Baby className="w-4 h-4 shrink-0" />
                    <span>Drop-off: {dropOffChildren.join(', ')}</span>
                  </div>
                )}
                {eventPasses.length > 0 && (
                  <div className="flex items-center gap-2 text-muted-foreground col-span-2">
                    <Ticket className="w-4 h-4 shrink-0" />
                    <span>
                      Event pass{eventPasses.length !== 1 ? 'es' : ''}:{' '}
                      {eventPasses.map((p) => p.attendeeName).join(', ')}
                    </span>
                  </div>
                )}
                {foundBooking.paymentMethod && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    {paymentMethodIcon(foundBooking.paymentMethod)}
                    <span>{paymentMethodLabel(foundBooking.paymentMethod)}</span>
                  </div>
                )}
                <div className="text-right font-semibold text-foreground">
                  ฿{foundBooking.total.toLocaleString()} {notPaid ? 'not paid' : 'paid'}
                </div>
              </div>
            </div>

            <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm space-y-1">
              <p className="font-medium">Will issue at the door:</p>
              <ul className="text-muted-foreground space-y-0.5 ml-1">
                {foundBooking.willIssue.childBracelets > 0 && (
                  <li>• {foundBooking.willIssue.childBracelets} child wristband{foundBooking.willIssue.childBracelets !== 1 ? 's' : ''}</li>
                )}
                {foundBooking.willIssue.adultBracelets > 0 && (
                  <li>• {foundBooking.willIssue.adultBracelets} adult wristband{foundBooking.willIssue.adultBracelets !== 1 ? 's' : ''}</li>
                )}
                {foundBooking.willIssue.creditTotalTHB > 0 && (
                  <li>• ฿{foundBooking.willIssue.creditTotalTHB.toLocaleString()} credit</li>
                )}
                {paidExtras.map(([name, quantity]) => (
                  <li key={name}>• {quantity} × {name}</li>
                ))}
                {dropOffChildren.length > 0 && (
                  <li>• Drop-off check-in for {dropOffChildren.join(', ')}</li>
                )}
                {eventPasses.length > 0 && (
                  <li>• Event check-in for {eventPasses.map((p) => p.attendeeName).join(', ')}</li>
                )}
              </ul>
            </div>

            {dropOffChildren.length > 0 && (
              <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                <Baby className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>After confirming, you'll be prompted to check in the drop-off child{dropOffChildren.length > 1 ? 'ren' : ''} via the registration flow.</span>
              </div>
            )}

            {eventPasses.length > 0 && (
              <div className="flex items-start gap-2 text-xs text-violet-600 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 rounded-lg px-3 py-2">
                <Ticket className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  Confirming checks {eventPasses.length > 1 ? 'these attendees' : 'this attendee'} into
                  the event and prints bracelets — already paid online, no further charge.
                </span>
              </div>
            )}

            {unmapped.length > 0 && (
              <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  {unmapped.map((u) => `${u.name} (${u.kids + u.adults} guest${u.kids + u.adults !== 1 ? 's' : ''})`).join(', ')}{' '}
                  {unmapped.length === 1 ? 'is' : 'are'} not in this branch's catalogue any more, so
                  no wristband will be issued for {unmapped.length === 1 ? 'it' : 'them'}. Check with a
                  manager before confirming.
                </span>
              </div>
            )}

            {notPaid && (
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                {notPaid}
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setStage('lookup')} disabled={confirming}>
                Back
              </Button>
              <Button
                className="flex-1 h-12"
                onClick={() => void handleConfirm()}
                disabled={confirming || foundBooking.lines.length === 0 || notPaid !== null}
              >
                {confirming ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                )}
                Confirm &amp; Issue
              </Button>
            </div>
          </div>
        )}

        {stage === 'issued' && foundBooking && issued && (
          <div className="space-y-5 pt-1">
            <div className="flex flex-col items-center text-center gap-3 py-4">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <CheckCircle2 className="w-8 h-8 text-primary" />
              </div>
              <div>
                <p className="font-semibold text-lg">Redeemed on this counter's box</p>
                <p className="font-mono text-muted-foreground mt-0.5">{foundBooking.reference}</p>
                {issued.receiptNumber && (
                  <p className="text-sm text-muted-foreground mt-0.5">Receipt {issued.receiptNumber}</p>
                )}
              </div>
            </div>

            {issued.bands.length > 0 && (
              <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm space-y-1">
                <p className="text-muted-foreground">
                  Wristband codes — read them out if a band did not print:
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5" data-testid="band-codes">
                  {issued.bands.map((band) => (
                    <span key={band.id} className="whitespace-nowrap">
                      <span className="font-mono font-semibold text-foreground">{band.shortCode ?? 'No code'}</span>
                      {band.childName && <span className="text-muted-foreground"> {band.childName}</span>}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {issued.notes.length > 0 && (
              <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{issued.notes.join(' · ')}</span>
              </div>
            )}

            <Button className="w-full h-12" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        )}

        {stage === 'already_redeemed' && foundBooking && (
          <div className="space-y-5 pt-1">
            <div className="flex flex-col items-center text-center gap-3 py-4">
              <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center">
                <AlertTriangle className="w-8 h-8 text-amber-500" />
              </div>
              <div>
                <p className="font-semibold text-lg">Already redeemed</p>
                <p className="font-mono text-muted-foreground mt-0.5">{foundBooking.reference}</p>
              </div>
            </div>

            {redemption && (
              <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm space-y-1">
                <p className="text-muted-foreground">
                  Redeemed{' '}
                  <span className="text-foreground font-medium">{describeRedemption(redemption)}</span>
                </p>
                {redemption.bandCodes.length > 0 && (
                  <p className="text-muted-foreground">
                    Wristbands issued:{' '}
                    <span className="text-foreground font-mono font-medium">
                      {redemption.bandCodes.join(', ')}
                    </span>
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setStage('lookup')}>
                Look up another
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
