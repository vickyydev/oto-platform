import { useState, useRef, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Booking } from '@/types';
import { getAllBookings, getBooking } from '@/mockApi';
import { QrCode, CheckCircle2, AlertTriangle, Search, Ticket, Users, Baby, CreditCard, Smartphone } from 'lucide-react';

interface RedeemBookingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when staff confirms a valid unredeemed booking — Till handles the rest. */
  onConfirm: (booking: Booking) => void;
}

type Stage = 'lookup' | 'summary' | 'already_redeemed';

function paymentMethodLabel(pm: string): string {
  if (pm === 'card') return 'Card';
  if (pm === 'promptpay') return 'PromptPay / QR';
  return pm;
}

function paymentMethodIcon(pm: string) {
  if (pm === 'promptpay') return <Smartphone className="w-4 h-4" />;
  return <CreditCard className="w-4 h-4" />;
}

export function RedeemBookingModal({ open, onOpenChange, onConfirm }: RedeemBookingModalProps) {
  const [stage, setStage] = useState<Stage>('lookup');
  const [refInput, setRefInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [foundBooking, setFoundBooking] = useState<Booking | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset when modal opens
  useEffect(() => {
    if (open) {
      setStage('lookup');
      setRefInput('');
      setError(null);
      setFoundBooking(null);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [open]);

  const unredeemedBookings = getAllBookings().filter((b) => b.status === 'paid');

  function lookup(ref: string) {
    const trimmed = ref.trim().toUpperCase();
    if (!trimmed) {
      setError('Enter or scan a booking reference.');
      return;
    }
    const booking = getBooking(trimmed);
    if (!booking) {
      setError(`No booking found for "${trimmed}".`);
      return;
    }
    setError(null);
    setFoundBooking(booking);
    if (booking.status === 'redeemed') {
      setStage('already_redeemed');
    } else {
      setStage('summary');
    }
  }

  function handleLookup() {
    lookup(refInput);
  }

  function handlePickSeeded(booking: Booking) {
    setRefInput(booking.reference);
    setFoundBooking(booking);
    if (booking.status === 'redeemed') {
      setStage('already_redeemed');
    } else {
      setStage('summary');
    }
  }

  function handleConfirm() {
    if (!foundBooking) return;
    onConfirm(foundBooking);
    onOpenChange(false);
  }

  const dropOffChildren = foundBooking
    ? foundBooking.lines.flatMap((l) => (l.dropOff ? [l.dropOff.childName] : []))
    : [];
  const regularKids = foundBooking
    ? foundBooking.lines.reduce((s, l) => (l.dropOff ? s : s + l.kids), 0)
    : 0;
  const regularAdults = foundBooking
    ? foundBooking.lines.reduce((s, l) => (l.dropOff ? s : s + l.adults), 0)
    : 0;
  const eventPasses = foundBooking?.eventPasses ?? [];

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
              />
              <Button onClick={handleLookup} className="h-12 px-5 shrink-0">
                <Search className="w-4 h-4 mr-2" />
                Look up
              </Button>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            {unredeemedBookings.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
                  Paid bookings waiting at reception
                </p>
                <div className="space-y-1.5 max-h-52 overflow-y-auto pr-0.5">
                  {unredeemedBookings.map((b) => (
                    <button
                      key={b.id}
                      onClick={() => handlePickSeeded(b)}
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
                          {b.registrationId && (
                            <>
                              <span>·</span>
                              <Baby className="w-3 h-3" />
                              <span>drop-off</span>
                            </>
                          )}
                        </div>
                      </div>
                      <Badge variant="secondary" className="shrink-0 text-xs">
                        ฿{b.total.toLocaleString()}
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {unredeemedBookings.length === 0 && (
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
                <div className="flex items-center gap-2 text-muted-foreground">
                  {paymentMethodIcon(foundBooking.paymentMethod)}
                  <span>{paymentMethodLabel(foundBooking.paymentMethod)}</span>
                </div>
                <div className="text-right font-semibold text-foreground">
                  ฿{foundBooking.total.toLocaleString()} paid
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

            <div className="flex gap-3 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setStage('lookup')}>
                Back
              </Button>
              <Button className="flex-1 h-12" onClick={handleConfirm}>
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Confirm &amp; Issue
              </Button>
            </div>
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

            {foundBooking.redeemedAt && (
              <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm space-y-1">
                <p className="text-muted-foreground">
                  Redeemed at:{' '}
                  <span className="text-foreground font-medium">
                    {new Date(foundBooking.redeemedAt).toLocaleString()}
                  </span>
                </p>
                {foundBooking.issuedWristbandCodes && foundBooking.issuedWristbandCodes.length > 0 && (
                  <p className="text-muted-foreground">
                    Wristbands issued:{' '}
                    <span className="text-foreground font-mono font-medium">
                      {foundBooking.issuedWristbandCodes.join(', ')}
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
