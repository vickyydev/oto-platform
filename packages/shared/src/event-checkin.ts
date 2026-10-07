import { z } from 'zod';
import { bandShortCode } from './band-code';
import type { EventsCacheItem } from './events';

/**
 * S2-20 E3 (SCRUM-217) — CHECKING A CHILD IN AT AN EVENT, CHECKING THEM OUT,
 * AND REPRINTING THEIR BANDS (plan docs/progress/plans/events-kiosk/PLAN.md
 * §3, §4, §8 and the E3 row of §9).
 *
 * The prototype's rules, ported (`checkInEventAttendee` and
 * `checkOutEventAttendee`, mockApi.ts:3785-3870; DropOff.tsx's Events tab):
 *
 *   - one check-in per child per day: a second is refused "Already checked in"
 *     / "This child is already checked in for today." — a child checked in and
 *     out again included;
 *   - a camp child not registered for the day is not checked in: "Not
 *     registered for today" — on the platform as well as on the button (H5);
 *   - a kid band always, and a parent band when the parent is attending; the
 *     kid band never opens the gate, the parent band does, and the two share a
 *     group (the check-in) so the kid follows the parent in the occupancy count;
 *     event bands carry no F&B credit and `mayOrderFood=false`, and the kid band
 *     carries the allergy and diet lines;
 *   - a reprint uses the stored bands and never touches the check-in, and only
 *     while the child is checked in and not out;
 *   - a check-out is refused unless the child is checked in and not yet out;
 *   - NO supervision gate: events are not drop-off (R-97).
 *
 * This file is the wire the api, the till and the box share: the bodies, the
 * answers, the refusals in the counter's words, the band's paper, and the
 * intents and facts of the box lane.
 */

const Uuid = z.string().uuid();
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IsoDateTime = z.string().datetime({ offset: true });

// --- The refusals, in the counter's words ---------------------------------------------

export const EVENT_CHECKIN_REFUSALS = {
  /** DropOff.tsx 155-158, word for word. */
  alreadyIn: {
    code: 'EVENT_ALREADY_CHECKED_IN',
    title: 'Already checked in',
    message: 'This child is already checked in for today.',
  },
  /** EventAttendeeList 273-290: the row's words, now also the platform's (H5). */
  notRegistered: {
    code: 'EVENT_NOT_REGISTERED_TODAY',
    title: 'Not registered for today',
    message: 'Not registered for today',
  },
  notIn: {
    code: 'EVENT_NOT_CHECKED_IN',
    title: 'Not checked in',
    message: 'This child is not checked in for today.',
  },
  alreadyOut: {
    code: 'EVENT_ALREADY_CHECKED_OUT',
    title: 'Already checked out',
    message: 'This child has already been checked out for today.',
  },
  notToday: {
    code: 'EVENT_NOT_TODAY',
    title: 'Not on today',
    message: 'This event is not on today, so nobody can be checked in to it.',
  },
  attendeeUnknown: {
    code: 'EVENT_ATTENDEE_NOT_FOUND',
    title: 'Not on this event',
    message: 'That child is not on this event.',
  },
  checkinIdInUse: {
    code: 'EVENT_CHECKIN_ID_IN_USE',
    title: 'Check-in not saved',
    message: 'That check-in id already belongs to another child or day — try again.',
  },
  /**
   * S2-20 E5 (closing audit, a) — a press answered again after the OTO App took
   * its check-in back (its own "Undo check-in") and the child was checked in
   * since: that check-in no longer stands and its bands were revoked, so the
   * press is not answered "checked in" with codes the gate now refuses.
   */
  takenBack: {
    code: 'EVENT_CHECKIN_TAKEN_BACK',
    title: 'Check-in taken back',
    message:
      'This check-in was undone in the OTO App and its bands no longer work. Check the child in again if they are here.',
  },
  /** The box lane: no copy of today's events on this counter's box. */
  notOnBox: {
    code: 'EVENTS_NOT_ON_BOX',
    title: 'No connection',
    message:
      "This counter is offline and has no copy of today's events yet. Check the child in at another counter, or wait for the connection.",
  },
  /** The box lane: the box cannot mint a band without its key or its station code. */
  noBandOffline: {
    code: 'EVENT_BAND_NOT_ON_BOX',
    title: 'Not checked in',
    message:
      'No band can be issued at this counter while it is offline, so the child was not checked in — try again when the connection is back.',
  },
  /** The box lane: a reprint of a band this box has no copy of. */
  reprintNotOnBox: {
    code: 'EVENT_BAND_REPRINT_NOT_ON_BOX',
    title: 'Band not reprinted',
    message: 'This counter is offline and has no copy of that band — reprint it when the connection is back.',
  },
} as const;

export type EventCheckinRefusal = (typeof EVENT_CHECKIN_REFUSALS)[keyof typeof EVENT_CHECKIN_REFUSALS];

// --- The bodies (what the till sends) ---------------------------------------------------

/** `POST /events/:id/attendees/:attendeeId/checkin` — today, at this branch. */
export const EventCheckinBodySchema = z
  .object({
    branchId: Uuid,
    /**
     * The check-in's id, minted by the till (UUIDv7). The OTO App keeps the
     * check-in under it, so a retry — the till's, or the Failures page's — is a
     * replay there and here, never a second band.
     */
    checkinId: Uuid,
    /** The station the bands print at; a device that is no station checks in and prints nothing. */
    stationId: Uuid.optional(),
    actionId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type EventCheckinBody = z.infer<typeof EventCheckinBodySchema>;

/** `POST /events/:id/attendees/:attendeeId/checkout` — today's check-in, at this branch. */
export const EventCheckoutBodySchema = z
  .object({
    branchId: Uuid,
    stationId: Uuid.optional(),
    actionId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type EventCheckoutBody = z.infer<typeof EventCheckoutBodySchema>;

/** `POST /events/:id/attendees/:attendeeId/reprint` — today's bands, fresh paper. */
export const EventReprintBodySchema = z
  .object({
    branchId: Uuid,
    stationId: Uuid,
    reason: z.string().trim().max(200).optional(),
    actionId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type EventReprintBody = z.infer<typeof EventReprintBodySchema>;

export const EventCheckinParamsSchema = z.object({ id: Uuid, attendeeId: Uuid });

// --- The answers ------------------------------------------------------------------------

export const EVENT_CHECKIN_SYNC_STATES = ['synced', 'pending', 'failed'] as const;
export type EventCheckinSyncState = (typeof EVENT_CHECKIN_SYNC_STATES)[number];

/** Where a check-in was made: a till online, a box with the link down, or the OTO App itself. */
export const EVENT_CHECKIN_ORIGINS = ['till', 'box', 'otoapp'] as const;
export type EventCheckinOrigin = (typeof EVENT_CHECKIN_ORIGINS)[number];

/** A band an event check-in printed, as the till may see it: the short code, never the credential. */
export const EventBandViewSchema = z.object({
  id: z.string(),
  kind: z.enum(['kid', 'adult']),
  shortCode: z.string().nullable(),
});
export type EventBandView = z.infer<typeof EventBandViewSchema>;

/** One child's day at an event, as the POS keeps it. */
export const EventCheckinRecordViewSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  attendeeId: z.string(),
  date: IsoDate,
  status: z.enum(['checked_in', 'checked_out']),
  checkedInAt: z.string(),
  checkedInBy: z.string().nullable(),
  checkedOutAt: z.string().nullable(),
  checkedOutBy: z.string().nullable(),
  kidBand: EventBandViewSchema.nullable(),
  parentBand: EventBandViewSchema.nullable(),
  origin: z.enum(EVENT_CHECKIN_ORIGINS),
  /** Whether the OTO App has the check-in yet; `synced` for one the app made itself. */
  syncState: z.enum(EVENT_CHECKIN_SYNC_STATES),
  syncError: z.string().nullable(),
  /**
   * S2-20 E5 (closing audit, a) — when the OTO App took this check-in back and
   * it was set aside; its bands are then never shown (they were revoked).
   * Absent or null on a check-in that stands.
   */
  undoneAt: z.string().nullable().optional(),
});
export type EventCheckinRecordView = z.infer<typeof EventCheckinRecordViewSchema>;

/** A print job the check-in or the reprint queued, as the till's toast reads it (`dispatchPlatformPrinting`). */
export const EventPrintJobViewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  role: z.string().nullable(),
  status: z.string(),
  stationId: z.string().nullable(),
  deviceId: z.string().nullable(),
  deviceLabel: z.string().nullable(),
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  reprintOf: z.string().nullable(),
  reprintReason: z.string().nullable(),
  requestedByName: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  queuedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type EventPrintJobView = z.infer<typeof EventPrintJobViewSchema>;

export const EventCheckinAnswerSchema = z.object({
  checkin: EventCheckinRecordViewSchema,
  /** The same check-in id was sent before; this is what that request made. */
  replayed: z.boolean(),
  printJobs: z.array(EventPrintJobViewSchema),
  /** What did not reach paper, in the till's words; empty when everything was queued. */
  notes: z.array(z.string()),
});
export type EventCheckinAnswer = z.infer<typeof EventCheckinAnswerSchema>;

// --- The band's paper -------------------------------------------------------------------

/**
 * What an event band prints (`eventBraceletPrintJobs`, lib/printRouting.tsx;
 * `dispatchEventBracelets`, lib/eventPass.ts): the event's title, its date and
 * its times, the child's name, and — on the kid band only, and only when there
 * is any — the diet and the allergy line; the parent's name on the parent band.
 * The band template's own field names (`BandData` in `@oto/print`), so the
 * platform and a box with no internet print the same paper.
 */
export interface EventBandDocument {
  holderName?: string;
  /** e.g. "09:00 – 15:00". */
  startEndTime?: string;
  /** The day the band is for, `yyyy-mm-dd`, as the prototype's label printed it. */
  duration?: string;
  /** The event's title, on the band's party-name line. */
  partyName?: string;
  dietaryRequirement?: string;
  allergy?: string;
  bandCode?: string;
  shortCode?: string;
}

export interface EventBandFacts {
  kind: 'kid' | 'adult';
  code: string;
  eventTitle: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  childName: string;
  parentName: string | null;
  allergy: string | null;
  dietary: string | null;
}

export function eventBandDocument(f: EventBandFacts): EventBandDocument {
  const start = f.startTime?.trim() || '';
  const end = f.endTime?.trim() || '';
  const timeLine = start && end ? `${start} – ${end}` : start;
  const kid = f.kind === 'kid';
  const holder = kid ? f.childName.trim() : f.parentName?.trim() || `${f.childName.trim()} (parent)`;
  return {
    holderName: holder || undefined,
    startEndTime: timeLine || undefined,
    duration: f.date,
    partyName: f.eventTitle.trim() || undefined,
    ...(kid && f.dietary?.trim() ? { dietaryRequirement: f.dietary.trim() } : {}),
    ...(kid && f.allergy?.trim() ? { allergy: f.allergy.trim() } : {}),
    bandCode: f.code,
    shortCode: bandShortCode(f.code) ?? undefined,
  };
}

// --- The box lane -----------------------------------------------------------------------

/**
 * The intents a till sends its box with the link down (`events-desk.ts` in
 * `@oto/box-agent`). Each write is ONE store transaction on the box: the bands
 * minted with the park's key, their paper queued, the fact on the outbox and
 * the overlay row — under the till's own check-in id, so a retry meets itself.
 */
export const BRIDGE_EVENT_INTENTS = {
  /** Today's events from the box's copy, with what this counter recorded laid over it. */
  day: 'events.day',
  checkin: 'event.checkin',
  checkout: 'event.checkout',
  reprint: 'event.reprint',
} as const;
export const BRIDGE_EVENT_INTENT_TYPES: ReadonlySet<string> = new Set(Object.values(BRIDGE_EVENT_INTENTS));

/** The facts a box queues for the platform (`sync-events.ts`). */
export const EVENT_FACTS = {
  checkedIn: 'event.checked_in',
  checkedOut: 'event.checked_out',
} as const;

export const BridgeEventCheckinSchema = z
  .object({
    eventId: Uuid,
    attendeeId: Uuid,
    checkinId: Uuid,
    /** Printed nowhere; the box keeps it for the counter's own record. */
    staffName: z.string().max(120).nullish(),
  })
  .strict();
export type BridgeEventCheckin = z.infer<typeof BridgeEventCheckinSchema>;

export const BridgeEventCheckoutSchema = z
  .object({
    eventId: Uuid,
    attendeeId: Uuid,
    staffName: z.string().max(120).nullish(),
  })
  .strict();
export type BridgeEventCheckout = z.infer<typeof BridgeEventCheckoutSchema>;

export const BridgeEventReprintSchema = z
  .object({
    eventId: Uuid,
    attendeeId: Uuid,
    reason: z.string().trim().max(200).nullish(),
  })
  .strict();
export type BridgeEventReprint = z.infer<typeof BridgeEventReprintSchema>;

const OfflineEventBandSchema = z.object({
  id: Uuid,
  code: z.string().min(8).max(200),
});

/**
 * `event.checked_in` — a child checked in at an event with the link down. The
 * bands are the ones the box minted and printed (OD-13): the platform records
 * them as they are, once, or — when the platform already has the child in for
 * the day — records nothing and says so (H4).
 */
export const OfflineEventCheckedInSchema = z.object({
  checkinId: Uuid,
  eventId: Uuid,
  attendeeId: Uuid,
  eventType: z.enum(['party', 'camp', 'event']),
  date: IsoDate,
  /** When the counter did it, by the box's clock. */
  at: IsoDateTime,
  /** What the band printed, as the box's copy had it. */
  childName: z.string().trim().min(1).max(200),
  parentName: z.string().max(200).nullish(),
  parentAttending: z.boolean(),
  allergy: z.string().max(4000).nullish(),
  dietary: z.string().max(4000).nullish(),
  eventTitle: z.string().max(300),
  startTime: z.string().max(20).nullish(),
  endTime: z.string().max(20).nullish(),
  kidBand: OfflineEventBandSchema.nullish(),
  parentBand: OfflineEventBandSchema.nullish(),
  offlineFresh: z.boolean().optional(),
});
export type OfflineEventCheckedIn = z.infer<typeof OfflineEventCheckedInSchema>;

/** `event.checked_out` — a child checked out with the link down. */
export const OfflineEventCheckedOutSchema = z.object({
  /** The box's check-in this ends; for a child checked in elsewhere, a fresh id the box minted. */
  checkinId: Uuid,
  eventId: Uuid,
  attendeeId: Uuid,
  date: IsoDate,
  at: IsoDateTime,
  offlineFresh: z.boolean().optional(),
});
export type OfflineEventCheckedOut = z.infer<typeof OfflineEventCheckedOutSchema>;

/**
 * What a counter's box records for an event check-in it made, as an overlay
 * row (kind `checkin`, the event's id in `member_id`, `domain: 'event'` to tell
 * it from a drop-off stay): the day as this counter now knows it. The band
 * codes are kept so a reprint and a food counter's scan work before the copy
 * of today's events catches up.
 */
export interface EventCheckinOverlayRecord {
  domain: 'event';
  checkinId: string;
  eventId: string;
  attendeeId: string;
  date: string;
  status: 'checked_in' | 'checked_out';
  checkedInAt: string | null;
  checkedOutAt: string | null;
  childName: string;
  parentName: string | null;
  allergy: string | null;
  dietary: string | null;
  kidBand: { id: string; code: string } | null;
  parentBand: { id: string; code: string } | null;
}

/** What the box answers `events.day` with: its copy of today's events, this counter's day laid over it. */
export interface BridgeEventsDayAnswer extends Record<string, unknown> {
  item: EventsCacheItem | null;
  cacheAppliedAt: string | null;
}

/** The short code under a band's QR, for the till's toast: never the code itself. */
export function eventBandShortCode(code: string | null | undefined): string | null {
  return code ? bandShortCode(code) : null;
}
