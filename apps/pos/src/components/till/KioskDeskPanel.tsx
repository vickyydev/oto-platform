import { useEffect, useState } from 'react';
import { Baby, ClipboardCheck, QrCode, ScanLine } from 'lucide-react';
import type { KioskDeskEntry } from '@oto/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { kioskDeskApi } from '@/api/kioskDesk';
import { deskReasonOf } from '@/lib/kiosk';

/** How often the till asks whether a kiosk has sent anybody over. */
const DESK_POLL_MS = 20_000;

/**
 * S2-20 K2 (SCRUM-217) — SENT FROM THE KIOSK: the families a self-service
 * kiosk sent to this desk today, so a guest who walks over is met with their
 * booking already on screen.
 *
 * A UI addition on the till's Membership Check step, in that step's own
 * language (the "Event Passes" heading, its cards and its outline buttons).
 * Two things the desk can do, each the till's existing path:
 *
 *   - "Open booking": the redeem dialog opens straight on that booking, as a
 *     scanned QR opens it (`RedeemBookingModal`, `scannedBooking`), and
 *     Confirm & Issue redeems it here — a printer fault at the kiosk, a box
 *     offline, a drop-off-only booking;
 *   - "Check-in board": the kiosk printed the regular bands and left the
 *     drop-off or nanny children booked; they are checked in on the board,
 *     where their band prints at this till (K1).
 *
 * Only what is left to do is drawn; a family the desk has finished with drops
 * off the list on the next read. Nothing is drawn at all when no kiosk has
 * sent anybody, or the deployment has no kiosk route.
 */
export function KioskDeskPanel({
  branchId,
  onOpenBooking,
  onOpenCheckIn,
}: {
  branchId: string | null;
  onOpenBooking: (bookingId: string) => void;
  onOpenCheckIn: () => void;
}) {
  const [entries, setEntries] = useState<KioskDeskEntry[]>([]);

  useEffect(() => {
    if (!branchId) {
      setEntries([]);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const answer = await kioskDeskApi.list(branchId);
        if (!stopped) setEntries(answer.entries);
      } catch {
        // A desk list that cannot be read is no list: the till carries on as before.
        if (!stopped) setEntries([]);
      }
      if (!stopped) timer = setTimeout(() => void tick(), DESK_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [branchId]);

  const waiting = entries.filter((e) => e.state !== 'done');
  if (waiting.length === 0) return null;

  return (
    <div className="mb-4" data-testid="kiosk-desk">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <ScanLine className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Sent from the kiosk</h3>
        <span className="text-xs text-muted-foreground/70">
          {waiting.length === 1 ? 'A family is on their way to you' : `${waiting.length} families are on their way to you`}
        </span>
      </div>
      <div className="space-y-2">
        {waiting.map((entry) => (
          <Card
            key={entry.sessionId}
            className="p-4 flex flex-wrap items-center gap-4 border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20"
          >
            <div className="w-12 h-12 rounded-xl bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center text-amber-600 dark:text-amber-400 shrink-0">
              {entry.state === 'to_check_in' ? <Baby className="w-6 h-6" /> : <QrCode className="w-6 h-6" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono font-bold">{entry.booking.reference}</span>
                <span className="text-sm text-muted-foreground">
                  {entry.booking.kids} child{entry.booking.kids === 1 ? '' : 'ren'} · {entry.booking.adults} adult
                  {entry.booking.adults === 1 ? '' : 's'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {entry.stationName} · {new Date(entry.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">{deskReasonOf(entry)}</p>
            </div>
            {entry.state === 'to_check_in' ? (
              <Button
                variant="outline"
                className="h-11 gap-2 border-primary/40 text-primary hover:bg-primary/5 hover:text-primary"
                onClick={onOpenCheckIn}
              >
                <ClipboardCheck className="w-4 h-4" />
                Check-in board
              </Button>
            ) : (
              <Button
                variant="outline"
                className="h-11 gap-2 border-primary/40 text-primary hover:bg-primary/5 hover:text-primary"
                onClick={() => onOpenBooking(entry.booking.id)}
              >
                <QrCode className="w-4 h-4" />
                Open booking
              </Button>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
