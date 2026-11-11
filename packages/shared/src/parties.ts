import { z } from 'zod';
import { isIsoDate } from './dates';
import { PARTY_PLAN_STATUSES, PartyPlanSchema } from './party-settlement';
import {
  EventDetailAnswerSchema,
  EventViewSchema,
  OTO_EVENT_STATUSES,
  PARTY_CHARGE_KINDS,
  PartyChargeItemSchema,
  PartyChargeViewSchema,
  PartyPaymentViewSchema,
} from './events';

/**
 * S2-20 E4 (SCRUM-217) — THE PARTY TAB: what the till sends and is answered
 * when it edits a party, charges its tab and takes its balance (plan
 * docs/progress/plans/events-kiosk/PLAN.md §3, §8, the E4 row of §9, and Q3's
 * default).
 *
 * The prototype's rules, ported (`mockApi.ts` 3874-3966, `lib/party.ts`):
 *
 *   - `updateParty` — the till may edit a party's own fields; identity, the
 *     branch and the two POS ledgers (charges, payments) are protected: never
 *     part of a patch, and ignored when one carries them (H12). The edit is
 *     stamped with who and when;
 *   - `addPartyExtraCharge` — a LEDGER entry, kind `ticket` or `fnb`, its items
 *     and a total that is never negative. Not a sale: no kitchen ticket, no
 *     stock, no bands for extra tickets (Q3);
 *   - `addPartyPayment` — whole baht, capped at the outstanding balance,
 *     refused at ฿0, any enabled tender. Recorded through the tender machine as
 *     real money, never as a sale of goods (Q3), and counted by End of Day on
 *     the `party_prepay` line, on the day it is taken, for that day's party.
 */

/** A real day of the calendar, as the OTO App's directory checks it (`isRealDate`). */
const isCalendarDate = (value: string): boolean => {
  if (!isIsoDate(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDate, 'Not a calendar date');

/** "HH:mm", as the party's times are typed (`<input type="time">`). */
const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

/** Money the OTO App keeps in whole baht: satang, a multiple of 100. */
const WholeBahtSatang = z
  .number()
  .int()
  .min(0)
  .max(10_000_000_000)
  .refine((v) => v % 100 === 0, 'Whole baht only — the OTO App keeps this amount in baht');

const OptionalText = (max: number) => z.string().trim().max(max).nullable();

/**
 * The party fields a till may change, as far as the OTO App holds them — the
 * fields of `PartyEditPatch` that the app's own record carries. The rest of
 * the prototype's edit form (the kitchen and bar plan, the run of show, the
 * hosts, the package name and line items, the notes) has no home in the
 * OTO App's event yet and is not written from the till (QUESTIONS, E4).
 */
export const PartyEditFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    status: z.enum(OTO_EVENT_STATUSES),
    date: IsoDate,
    startTime: ClockTime,
    endTime: ClockTime.nullable(),
    location: OptionalText(300),
    expectedKids: z.number().int().min(0).max(10_000),
    expectedAdults: z.number().int().min(0).max(10_000),
    childName: OptionalText(200),
    kidAge: z.number().int().min(0).max(30).nullable(),
    parentName: OptionalText(200),
    /** The parent's WhatsApp, normalised to E.164 by the platform. */
    whatsapp: OptionalText(50),
    decoration: OptionalText(2000),
    activities: OptionalText(2000),
    /** The party's base price — the OTO App's bill total. */
    basePriceSatang: WholeBahtSatang,
    depositSatang: WholeBahtSatang,
    depositDate: IsoDate.nullable(),
  })
  .partial();
export type PartyEditFields = z.infer<typeof PartyEditFieldsSchema>;

/** Every field a PATCH may change, in the order the edit form shows them. */
export const PARTY_EDITABLE_FIELDS = Object.keys(PartyEditFieldsSchema.shape) as Array<keyof PartyEditFields>;

/**
 * SCRUM-825 — an edit that reports a FACT rather than a till's change: a
 * deposit the family paid through the gateway. The OTO App records a fact
 * whatever it changed since (a BEO save after the payment cannot refuse it as
 * superseded, the way SCRUM-803's settlement sale is taken), so the marker is
 * only ever set by the platform's own writers, never from a PATCH.
 */
export const PARTY_EDIT_FACTS = ['gateway_deposit'] as const;
export type PartyEditFact = (typeof PARTY_EDIT_FACTS)[number];

/**
 * SCRUM-804 — what a stored edit may carry beyond a till's own fields: the
 * settlement sale's id, which the PLATFORM writes back when a party's
 * settlement closes (`beo_event_billing.pos_order_ref` in the OTO App), and
 * (SCRUM-825) the fact marker above. Never a till's to send: a PATCH naming
 * either has it ignored, as any protected field.
 */
export type PartyStoredEditFields = PartyEditFields & { posSaleId?: string; fact?: PartyEditFact };

/** The keys of a PATCH body that address the request rather than the party. */
export const PARTY_PATCH_ENVELOPE = ['branchId', 'editId', 'stationId', 'actionId'] as const;

/**
 * `PATCH /parties/:id` — `updateParty`'s patch. Anything that is not an
 * editable field or the envelope — `id`, `branchId` of the party, the charges,
 * the payments, the stamp, or a field the OTO App has no home for — is not
 * saved, and the answer names it (`edit.ignored`).
 */
export const PartyPatchBodySchema = PartyEditFieldsSchema.extend({
  /** The branch the till is at: the permission's target, never a field of the party. */
  branchId: z.string().uuid(),
  /** The edit's id, minted by the till: the same id again is the same edit. */
  editId: z.string().uuid(),
  stationId: z.string().uuid().optional(),
  actionId: z.string().min(1).max(200).optional(),
}).passthrough();
export type PartyPatchBody = z.infer<typeof PartyPatchBodySchema>;

/** `POST /parties/:id/charges` — `addPartyExtraCharge`. */
export const PartyChargeBodySchema = z.object({
  branchId: z.string().uuid(),
  /** The charge's id, minted by the till: the same id again is the same charge. */
  chargeId: z.string().uuid(),
  kind: z.enum(PARTY_CHARGE_KINDS),
  items: z.array(PartyChargeItemSchema).min(1).max(200),
  /** What is owed for it, after any discount — clamped at ฿0, never negative. */
  totalSatang: z.number().int().max(10_000_000_000),
  stationId: z.string().uuid().optional(),
  actionId: z.string().min(1).max(200).optional(),
});
export type PartyChargeBody = z.infer<typeof PartyChargeBodySchema>;

/** The tender a party payment is taken with — the till's "Payment received". */
export const PartyPaymentTenderSchema = z.object({
  /** The payment method's token, as configured for the branch. */
  method: z.string().min(1).max(40),
  kind: z.string().max(20).optional(),
  /** Cash only: what was handed over. */
  tenderedSatang: z.number().int().min(0).optional(),
  reference: z.string().max(120).optional(),
  /**
   * A card taken on a terminal the platform cannot reach: the approval code and
   * TID off its slip. Without them a card goes by `/payments/tender`, because
   * this route's call counts as confirmation that the money was taken.
   */
  approvalCode: z.string().trim().min(1).max(12).optional(),
  tid: z.string().trim().max(32).optional(),
  last4: z.string().regex(/^\d{4}$/).optional(),
});

/** `POST /parties/:id/payments` — `addPartyPayment`. */
export const PartyPaymentBodySchema = z.object({
  branchId: z.string().uuid(),
  /** The payment's id, minted by the till: the same id again is the same payment. */
  paymentId: z.string().uuid(),
  /** Money is taken at a counter. */
  stationId: z.string().uuid(),
  /** Floored to whole baht and capped at the outstanding balance, as the prototype does. */
  amountSatang: z.number().int().min(1).max(10_000_000_000),
  tender: PartyPaymentTenderSchema,
  /**
   * The outstanding balance the till showed. Compared, never charged: a
   * balance that moved under the till (another till took a payment, a charge
   * was added) is refused with nothing taken.
   */
  expectedOutstandingSatang: z.number().int().min(0).optional(),
  actionId: z.string().min(1).max(200).optional(),
});
export type PartyPaymentBody = z.infer<typeof PartyPaymentBodySchema>;

/**
 * `POST /parties/:id/payments/tender` — money against the balance through a
 * tender that answers later (SCRUM-732): the station's terminal or the QR
 * gateway, as a sale's tender is routed. It counts on the bill only once the
 * attempt has really been paid; the till then reads the party with the same
 * payment id on `/payments`, which answers what it took.
 */
export const PartyTenderBodySchema = z.object({
  branchId: z.string().uuid(),
  /** The payment's id, minted by the till: the same id again is the same tender. */
  paymentId: z.string().uuid(),
  stationId: z.string().uuid(),
  /** Floored to whole baht and capped at the outstanding balance, as the prototype does. */
  amountSatang: z.number().int().min(1).max(10_000_000_000),
  tender: z.object({
    method: z.string().min(1).max(40),
    kind: z.string().max(20).optional(),
  }),
  /** The balance the till showed. Compared, never charged. */
  expectedOutstandingSatang: z.number().int().min(0).optional(),
  qrDirection: z.enum(['show', 'scan']).optional(),
  requestQrPayload: z.boolean().optional(),
  actionId: z.string().min(1).max(200).optional(),
});
export type PartyTenderBody = z.infer<typeof PartyTenderBodySchema>;

/** Refused on `POST /parties/:id/payments`: QR, and a card with no slip, go by `/payments/tender`. */
export const PARTY_TENDER_ROUTED = {
  code: 'PARTY_TENDER_ROUTED',
  message: 'A card or QR payment is taken on the terminal or through the gateway, so nothing was recorded here',
} as const;

/** `POST /parties/:id/payments` naming a tender that has not been paid. */
export const PARTY_PAYMENT_NOT_TAKEN = {
  code: 'PARTY_PAYMENT_NOT_TAKEN',
  message: 'That payment has not been taken, so nothing was recorded',
} as const;

export const PartyEditSyncStates = ['synced', 'pending', 'failed'] as const;

/** What a party write is answered with: the party as it now stands, and what this request made. */
export const PartyWriteAnswerSchema = z.object({
  /** The same id was sent before: this is what that request made. */
  replayed: z.boolean(),
  /** The party, its bill and ledgers after the write. */
  party: EventViewSchema,
  charge: PartyChargeViewSchema.optional(),
  payment: PartyPaymentViewSchema.optional(),
  edit: z
    .object({
      id: z.string(),
      /** Whether the OTO App has taken the edit. */
      syncState: z.enum(PartyEditSyncStates),
      syncError: z.string().nullable(),
      /** The body's keys that were not saved: protected, or with no home in the OTO App. */
      ignored: z.array(z.string()),
    })
    .optional(),
});
export type PartyWriteAnswer = z.infer<typeof PartyWriteAnswerSchema>;

/** `GET /parties/:id` — the branch is the permission's target, as on every events read. */
export const PartyQuerySchema = z.object({
  branchId: z.string().uuid(),
  date: IsoDate.optional(),
});

/**
 * SCRUM-804 — `GET /parties/:id`: the party as every events read answers it,
 * with the plan the OTO App published for it (`otoapp_v.event_packages`) — the
 * package with its limits and prices, the counts, the add-ons, the
 * entertainment, the set menu, the food times and the deposit — or null and
 * the reason there is none. Optional in the shape so an answer from before it
 * still reads.
 */
export const PartyDetailAnswerSchema = EventDetailAnswerSchema.extend({
  plan: PartyPlanSchema.nullable().optional(),
  planStatus: z.enum(PARTY_PLAN_STATUSES).optional(),
});
export type PartyDetailAnswer = z.infer<typeof PartyDetailAnswerSchema>;
