import { ApiError, NetworkError, isMissingRoute } from '@/api/client';
import {
  bookingsApi,
  redemptionFromConflict,
  type BookingRedeemResult,
  type RedeemOutcome,
} from '@/api/bookings';
import type { ApiSalePrintJob } from '@/api/history';
import { dispatchPlatformPrinting } from '@/lib/printRouting';
import { toast } from '@/hooks/use-toast';

/**
 * CONFIRM & ISSUE FOR A BOOKING — ONE PATH FOR EVERY TILL (SCRUM-494).
 *
 * The counter till (`pages/Till.tsx`) and the phone till
 * (`components/mobile/MobileTill.tsx`) both hand a paid booking to the
 * platform's redemption (`POST /bookings/:id/redeem`, or the counter's box with
 * the link down) and then act on its answer. The platform claims the booking,
 * records the sale, mints the bands and queues the paper in one transaction;
 * the till only says what happened. Nothing here records a sale, mints a band
 * or builds a print job in the browser.
 */

/** A failed redemption, in the shape the redeem dialog reads. */
export type RedeemRefusal = Extract<RedeemOutcome, { ok: false }>;

/**
 * One idempotency key per booking per open dialog: a retry after a dropped
 * answer replays the platform's stored redemption instead of being told the
 * booking was already redeemed by this very press. The holder is the till's
 * ref, cleared when the dialog closes.
 */
export interface RedeemKeyHolder {
  current: { bookingId: string; key: string } | null;
}

export function redeemKeyFor(holder: RedeemKeyHolder, bookingId: string): string {
  if (holder.current?.bookingId !== bookingId) {
    holder.current = { bookingId, key: bookingsApi.newRedeemKey() };
  }
  return holder.current.key;
}

/**
 * Ask the platform to redeem the booking once, under the dialog's key.
 *
 * Only a lost answer keeps the key for the next press; a definite refusal
 * clears it, so the next press asks again fresh.
 */
export async function redeemBookingOnPlatform(
  bookingId: string,
  body: { stationId?: string; visitId?: string },
  keys: RedeemKeyHolder,
): Promise<{ ok: true; redeemed: BookingRedeemResult } | RedeemRefusal> {
  try {
    const redeemed = await bookingsApi.redeem(
      bookingId,
      { ...(body.stationId ? { stationId: body.stationId } : {}), ...(body.visitId ? { visitId: body.visitId } : {}) },
      redeemKeyFor(keys, bookingId),
    );
    return { ok: true, redeemed };
  } catch (err) {
    if (!(err instanceof NetworkError)) keys.current = null;
    const first = redemptionFromConflict(err);
    if (first) return { ok: false, redemption: first };
    if (err instanceof NetworkError) {
      return {
        ok: false,
        message: 'No connection to the platform, so this booking cannot be redeemed here. Nothing has been issued.',
      };
    }
    if (isMissingRoute(err)) {
      return {
        ok: false,
        message: 'This deployment cannot record a booking redemption yet (SCRUM-234). Nothing has been issued.',
      };
    }
    return {
      ok: false,
      message: err instanceof ApiError ? err.message : 'The booking could not be redeemed. Nothing has been issued.',
    };
  }
}

/**
 * Say what the redemption put on paper and how many bands it minted.
 *
 * Online, the platform printed the sale when it closed it — the receipt and the
 * signed bands — so this announces what was queued and where, and what was not
 * printed, as a walk-in sale's announcement does. Redeemed by the counter's box
 * with the link down, the box printed from its own queue, so only what did not
 * print is said.
 */
export function announceBookingRedemption(reference: string, redeemed: BookingRedeemResult): void {
  const printing = redeemed.printing;
  if (printing) {
    dispatchPlatformPrinting(
      printing.jobs.filter((job) => job.reprintOf === null),
      printing.failed ? [...printing.notes, printing.failed.message] : printing.notes,
    );
  }
  for (const note of redeemed.box?.notes ?? []) {
    toast({ title: 'Not printed', description: note, variant: 'destructive' });
  }
  toast({
    title: redeemed.box ? 'Booking redeemed offline' : 'Booking redeemed',
    // A deployment from before round 3 answers the claim alone, with no bands.
    description: `${reference} — ${(redeemed.bands ?? []).length} wristband(s) issued.`,
  });
  announceEventPassCheckins(redeemed);
}

/**
 * S2-20 E5 — THE BOOKING'S EVENT PASSES, checked in by the platform's own
 * redemption (the prototype's Till.tsx 437-462 did it in the browser, from the
 * mock's copy of the event): their bracelets' paper is dispatched as the board's
 * check-in dispatches it, the count is said in the prototype's words, and a pass
 * that was not checked in is said with why — a child already in is skipped
 * silently, as `checkInSoldPass` returned null for one.
 */
function announceEventPassCheckins(redeemed: BookingRedeemResult): void {
  const passes = redeemed.eventPasses ?? [];
  if (passes.length === 0) return;
  const checkedIn = passes.filter((p) => p.outcome === 'checked_in');
  const jobs = checkedIn.flatMap((p) => p.printJobs) as unknown as ApiSalePrintJob[];
  const notes = checkedIn.flatMap((p) => p.notes);
  if (jobs.length > 0 || notes.length > 0) dispatchPlatformPrinting(jobs, notes);
  if (checkedIn.length > 0) {
    toast({
      title: 'Event passes checked in',
      description: `${checkedIn.length} attendee(s) checked into their event — bracelets printed.`,
    });
  }
  for (const p of passes) {
    if (p.outcome === 'checked_in' || p.outcome === 'already_in') continue;
    toast({
      title: `${p.attendeeName} — not checked in`,
      description: `${p.eventTitle}: ${p.message ?? 'not checked in here'}`,
      variant: p.outcome === 'not_today' ? 'default' : 'destructive',
    });
  }
}

/**
 * What the dialog is told after a redemption that landed. On the box lane it
 * stays open on the codes, for reading aloud should a band not print — as an
 * offline sale's confirmation does; online it just closes.
 */
export function redeemedOutcome(redeemed: BookingRedeemResult): RedeemOutcome {
  return redeemed.box
    ? {
        ok: true,
        issued: {
          receiptNumber: redeemed.sale?.receiptNumber ?? null,
          bands: redeemed.bands ?? [],
          notes: redeemed.box.notes,
        },
      }
    : { ok: true };
}
