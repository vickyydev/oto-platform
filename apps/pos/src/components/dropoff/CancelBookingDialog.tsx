import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CANCEL_REASON_MAX_LENGTH } from '@oto/shared';
import type { CheckIn } from '@/types';
import { toast } from '@/hooks/use-toast';
import { checkinApi } from '@/api/checkin';

/**
 * One waiting booking a "Cancel booking" press names: the till's Add drop-off
 * picker (SCRUM-862) and the Check-in board's family card (SCRUM-886) both
 * hand this over.
 */
export interface CancellableBooking {
  registrationId: string;
  parentName: string;
  /** The booking's waiting children. */
  children: CheckIn[];
  /**
   * SCRUM-862 — the names of children on this booking already checked in or
   * collected: the platform refuses a cancel while one is, so the till says so.
   */
  checkedIn?: readonly string[];
}

/**
 * SCRUM-862 — why a family's "Cancel booking" is not offered right now, or
 * null when it is. A child already on this sale is cancelled by taking them
 * off the sale first (the platform refuses a sale under a cancelled stay); a
 * booking with ANY child paid for or already checked in is handled through its
 * sale: the platform refuses the whole press then (CHECKIN_CANCEL_PAID,
 * CHECKIN_CANCEL_CHECKED_IN), so the till never offers a press that can only
 * be refused. The board has no sale: it passes an empty `attached`.
 */
export function cancelBookingBlockedBy(
  group: Pick<CancellableBooking, 'children' | 'checkedIn'>,
  attached: ReadonlySet<string>,
): string | null {
  const chargeable = group.children.filter((c) => !c.paidOnline && !c.paidAtTill);
  if (group.children.length > 0 && chargeable.length === 0) return 'A paid booking is handled through its sale.';
  if (chargeable.some((c) => attached.has(c.id))) return 'Take the children off this sale first.';
  const settled = group.checkedIn?.[0];
  if (settled) return `${settled} is already checked in — a checked-in booking is handled through its sale.`;
  const paid = group.children.find((c) => c.paidOnline || c.paidAtTill);
  if (paid) return `${paid.childName} is paid for — a paid booking is handled through its sale.`;
  return null;
}

/**
 * SCRUM-886 — the Check-in board's family as a cancellable booking: its
 * waiting children, and the names of any already in the park or collected.
 * Null when the family has no child waiting (nothing to cancel) or every
 * waiting child is paid for (that is the sale's refund or void path, so the
 * press is not offered at all, as on the picker).
 */
export function boardBookingOf(family: readonly CheckIn[]): CancellableBooking | null {
  const waiting = family.filter((c) => c.status === 'registered');
  if (waiting.length === 0 || family.some((c) => c.status === 'in_park')) return null;
  if (waiting.every((c) => c.paidOnline || c.paidAtTill)) return null;
  return {
    registrationId: waiting[0]!.registrationId,
    parentName: waiting[0]!.parentName,
    children: waiting,
    checkedIn: family.filter((c) => c.status === 'out').map((c) => c.childName),
  };
}

/** SCRUM-886 — "Booked for 5 Oct": the other day(s) a waiting family is for, or null when it is today's. */
export function bookedForLabel(family: readonly CheckIn[], now: Date = new Date()): string | null {
  const days = [...new Set(family.filter((c) => c.status === 'registered' && c.bookedForDate).map((c) => c.bookedForDate!))].sort();
  if (days.length === 0) return null;
  const thisYear = now.getFullYear();
  const label = (d: string) => {
    const at = new Date(`${d}T00:00:00Z`);
    if (Number.isNaN(at.getTime())) return d;
    return at.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(at.getUTCFullYear() !== thisYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  };
  return `Booked for ${days.map(label).join(', ')}`;
}

/**
 * SCRUM-862 — "Cancel booking": one confirm with a reason, as the till's Void
 * asks (HeldSales). The platform cancels every waiting, unpaid child on the
 * booking and keeps the signed form; a paid or checked-in child refuses the
 * whole press, and the refusal is shown in its own words. On the box lane the
 * call is refused in the counter's words (`checkinApi.cancelRegistration`).
 * SCRUM-886 — one dialog for the picker and the board: `onCancelled` re-reads
 * the list the press came from.
 */
export function CancelBookingDialog({
  booking,
  onClose,
  onCancelled,
}: {
  booking: CancellableBooking | null;
  onClose: () => void;
  onCancelled: (booking: CancellableBooking) => void;
}) {
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  // A fresh reason each time the confirm opens, as the picker's did.
  useEffect(() => {
    if (!booking) setCancelReason('');
  }, [booking]);
  const handleCancelBooking = async () => {
    const group = booking;
    const reason = cancelReason.trim();
    if (!group || !reason || cancelBusy) return;
    setCancelBusy(true);
    try {
      await checkinApi.cancelRegistration(group.registrationId, reason);
      onClose();
      onCancelled(group);
    } catch (err) {
      toast({
        title: "Couldn't cancel this booking",
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setCancelBusy(false);
    }
  };

  return (
    <Dialog
      open={booking !== null}
      onOpenChange={(next) => {
        if (!next && !cancelBusy) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel this waiting booking</DialogTitle>
          <DialogDescription>
            {booking
              ? `${booking.parentName || 'Booking'}'s booking: ${booking.children.map((c) => c.childName).join(', ')} ` +
                "leave the waiting list and can't be added to a sale. The signed form stays on record."
              : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="cancel-booking-reason">Reason</Label>
          <Input
            id="cancel-booking-reason"
            value={cancelReason}
            maxLength={CANCEL_REASON_MAX_LENGTH}
            onChange={(e) => setCancelReason(e.target.value)}
            autoFocus
          />
          {cancelReason.trim() === '' && <p className="text-xs text-muted-foreground">A reason is required.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={cancelBusy} onClick={onClose}>
            Back
          </Button>
          <Button
            variant="destructive"
            disabled={cancelReason.trim() === '' || cancelBusy}
            onClick={() => void handleCancelBooking()}
          >
            {cancelBusy ? 'Cancelling…' : cancelReason.trim() ? 'Cancel the booking' : 'Give a reason to cancel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
