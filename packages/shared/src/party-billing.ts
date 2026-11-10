import { z } from 'zod';
import {
  PARTY_LINE_ROLES,
  PARTY_SETTLEMENT_STATES,
  PartySettleQuoteSchema,
  partySocksIncludedFor,
  type PartyPlan,
} from './party-settlement';

/**
 * SCRUM-822 — ONE PLACE FOR A PARTY'S MONEY: the till's payments are the
 * ledger, and the OTO App reads its figures from there.
 *
 * The OTO App plans the party (its BEO) and the till settles it as one sale
 * (SCRUM-804). Before this the app worked its own totals out of what staff
 * typed — Party Details' base price and extras, the billing module's invoice
 * rows, a package snapshot's satang read as baht (SCRUM-833) — and the figures
 * the family was told could differ from what the till charged. Now the app's
 * server asks the platform (its provisioning key, `GET
 * /otoapp/parties/:eventId/billing`), and the platform answers from the same
 * code the till uses:
 *
 *   - before the party is settled, the QUOTE: what the till's Settle form
 *     would show today, priced by the sale engine exactly as the settlement
 *     will be (`quotePartySettlement` in the api's `party-settlement.ts`) — the
 *     package at the party's day price, the extras, the add-ons and
 *     entertainment, the items the BEO added, the free lines at 0, the deposit
 *     recorded as paid in advance and the balance;
 *   - once a settlement sale holds the party (open or paid), the SALE: its
 *     receipt number, its lines, the payments taken on it (the deposit among
 *     them), its totals, when it was settled and at which till.
 *
 * The app shows these figures and computes none; it never types them twice.
 * The deposit stays the app's one figure (SCRUM-813): the BEO's billing writes
 * it, the till's plan reads it, and the quote shows what the till read.
 *
 * Money is satang throughout.
 */

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The counts the till's Settle form opens with (`PartySettleModal`): the
 * plan's expected children and adults, else the party's own, at least one
 * child; the package's free socks for that many children; every add-on the
 * plan bought (a quantity above 0) and every entertainment line kept. The
 * quote the OTO App reads is priced on exactly these, so it is what the form
 * would show today.
 */
export function partySettleFormDefaults(
  plan: Pick<PartyPlan, 'counts' | 'package' | 'addOns' | 'entertainment'>,
  party: { expectedKids?: number | null; expectedAdults?: number | null },
): { kids: number; adults: number; socksGiven: number; addOnIds: string[]; entertainmentIds: string[] } {
  const kids = Math.max(1, plan.counts.kidsExpected ?? party.expectedKids ?? 1);
  return {
    kids,
    adults: Math.max(0, plan.counts.adultsExpected ?? party.expectedAdults ?? 0),
    socksGiven: partySocksIncludedFor(plan.package, kids),
    addOnIds: plan.addOns.filter((a) => a.qty > 0).map((a) => a.id),
    entertainmentIds: plan.entertainment.map((e) => e.id),
  };
}

/** `quote` before the party is settled; `sale` once a settlement sale holds it; `no_quote` when the till cannot price it. */
export const PARTY_BILLING_STATES = ['quote', 'sale', 'no_quote'] as const;
export type PartyBillingState = (typeof PARTY_BILLING_STATES)[number];

/** One line of the settlement sale, as its receipt lists it. `role` is null for a line that is not one of the party's. */
export const PartyBillingSaleLineSchema = z.object({
  role: z.enum(PARTY_LINE_ROLES).nullable(),
  label: z.string(),
  quantity: z.number().int(),
  unitSatang: z.number().int(),
  totalSatang: z.number().int(),
});
export type PartyBillingSaleLine = z.infer<typeof PartyBillingSaleLineSchema>;

/** One payment taken on the settlement sale: the deposit paid in advance, then what the till took. */
export const PartyBillingPaymentSchema = z.object({
  id: z.string(),
  /** As the receipt words it: "Deposit paid in advance", "Cash", "Card •••• 4242". */
  label: z.string(),
  methodCode: z.string().nullable(),
  amountSatang: z.number().int(),
  /** The party's deposit, recorded on the sale as paid in advance (SCRUM-804). */
  deposit: z.boolean(),
  /** When it was taken; null when the record names no time. */
  paidAt: z.string().nullable(),
});
export type PartyBillingPayment = z.infer<typeof PartyBillingPaymentSchema>;

/** The settlement sale, read live. */
export const PartyBillingSaleSchema = z.object({
  saleId: z.string(),
  settlementId: z.string(),
  /** `open` while the balance is still to take; `settled` once it is paid and closed. */
  state: z.enum(PARTY_SETTLEMENT_STATES),
  receiptNumber: z.string().nullable(),
  lines: z.array(PartyBillingSaleLineSchema),
  payments: z.array(PartyBillingPaymentSchema),
  grossSatang: z.number().int(),
  /** Taken on the sale so far, the deposit included. */
  paidSatang: z.number().int(),
  depositSatang: z.number().int(),
  outstandingSatang: z.number().int(),
  kids: z.number().int(),
  adults: z.number().int(),
  createdAt: z.string(),
  settledAt: z.string().nullable(),
  /** The till it was settled at. */
  stationName: z.string().nullable(),
});
export type PartyBillingSale = z.infer<typeof PartyBillingSaleSchema>;

/** `GET /otoapp/parties/:eventId/billing` — the party's money as the till holds it. */
export const PartyBillingAnswerSchema = z.object({
  eventId: z.string(),
  state: z.enum(PARTY_BILLING_STATES),
  /** The park: the operator's name, the branch's, and the branch's address. */
  park: z.object({ name: z.string(), branchName: z.string(), address: z.string().nullable() }),
  /** The party: its day and times, and the counts the figures are for (the quote's, or the sale's). */
  party: z.object({
    title: z.string(),
    date: IsoDate,
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
    packageName: z.string().nullable(),
    kids: z.number().int().nullable(),
    adults: z.number().int().nullable(),
  }),
  /** Before settlement: what the Settle form would show today. Null otherwise. */
  quote: PartySettleQuoteSchema.nullable(),
  /** After settlement: the sale. Null otherwise. */
  sale: PartyBillingSaleSchema.nullable(),
  /** Why there is no quote: no package in the OTO App, or counts the package cannot price — the till's own refusal. */
  noQuote: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type PartyBillingAnswer = z.infer<typeof PartyBillingAnswerSchema>;

export const PartyBillingParamsSchema = z.object({ eventId: z.string().uuid() });
