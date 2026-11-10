import { eq } from "drizzle-orm";
import { beoEventBilling, coreEvents } from "@shared/schema";
import type { DbExecutor } from "./packageSnapshot";

/**
 * ONE DEPOSIT (SCRUM-813).
 *
 * A party's received deposit was kept in three places, each written by its
 * own screen and read by its own reader:
 *   - the event's own Prepayment (`core_events.prepayment_amount` and
 *     `prepayment_date`): the Events page's form, a till's party edit through
 *     the directory API, and what `otoapp_v.event_packages` handed the till;
 *   - the BEO billing's deposit paid (`beo_event_billing.deposit_paid`,
 *     `deposit_paid_amount`, `deposit_paid_at`): the billing route;
 *   - the BEO's Party Details "Prepayment received" and its date
 *     (`beo_event_billing.add_ons.partyDetails.prepaymentReceived`,
 *     `depositDate`): the BEO editor, its badge and outstanding balance, the
 *     day-of view, the view-only page and the PDF.
 * A deposit typed in the BEO never reached the till's party page.
 *
 * From here every writer of a received deposit writes the SAME figure to all
 * three (`writePartyDeposit`): the BEO's billing route, the BEO's Save, the AI
 * fill's approval, the Events page's Prepayment and a till's party edit
 * (server/directory/eventWrites.ts, in its own SQL). So there is no second
 * home: whichever screen is used last, every reader shows its figure. The
 * view reads the BEO's figure first, then the event's (migration 0045), so a
 * party saved before this rule still reads what staff entered in the BEO.
 *
 * Money is WHOLE BAHT in all three, as the columns hold it; the view turns
 * it into satang. A deposit of 0 is no deposit: the event's prepayment is
 * then empty (null), the BEO's deposit is not paid, Party Details reads 0.
 */

/** A received deposit: whole baht (0 for none) and its day, YYYY-MM-DD, when known. */
export interface PartyDeposit {
  amountThb: number;
  date: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Whole baht from what a screen sent: a number or a numeric string; anything else is 0. */
export function wholeBahtOf(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** A day from a date, a timestamp or a YYYY-MM-DD string; null otherwise. */
export function dayOf(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v !== "string") return null;
  const head = v.trim().slice(0, 10);
  return DAY.test(head) ? head : null;
}

/** The deposit Party Details holds (the BEO editor's "Prepayment received"). */
export function depositOfPartyDetails(partyDetails: unknown): PartyDeposit {
  const pd = asRecord(partyDetails);
  return { amountThb: wholeBahtOf(pd.prepaymentReceived), date: dayOf(pd.depositDate) };
}

/** The deposit the billing route holds (deposit paid): its amount only when it says paid. */
export function depositOfBillingColumns(billing: { depositPaid?: unknown; depositPaidAmount?: unknown; depositPaidAt?: unknown }): PartyDeposit {
  return { amountThb: billing.depositPaid === true ? wholeBahtOf(billing.depositPaidAmount) : 0, date: dayOf(billing.depositPaidAt) };
}

export const sameDeposit = (a: PartyDeposit, b: PartyDeposit) => a.amountThb === b.amountThb && (a.date ?? null) === (b.date ?? null);

/**
 * The party's one deposit as the app reads it, in the order migration 0045's
 * view reads it: the BEO billing's deposit paid, else Party Details'
 * prepayment received, else the event's own prepayment; none is 0.
 */
export function currentDeposit(
  billing: { depositPaid?: unknown; depositPaidAmount?: unknown; depositPaidAt?: unknown; addOns?: unknown } | null | undefined,
  event: { prepaymentAmount?: unknown; prepaymentDate?: unknown } | null | undefined,
): PartyDeposit {
  const partyDetails = asRecord(asRecord(billing?.addOns).partyDetails);
  const candidates = [
    billing ? depositOfBillingColumns(billing) : null,
    depositOfPartyDetails(partyDetails),
    event ? { amountThb: wholeBahtOf(event.prepaymentAmount), date: dayOf(event.prepaymentDate) } : null,
  ];
  const found = candidates.find((d): d is PartyDeposit => !!d && d.amountThb > 0);
  if (!found) return { amountThb: 0, date: null };
  // A deposit whose own place keeps no day takes the day another place keeps.
  return found.date ? found : { ...found, date: dayOf(partyDetails.depositDate) ?? (event ? dayOf(event.prepaymentDate) : null) };
}

/**
 * Writes one received deposit to every place the app keeps it: the event's
 * prepayment and its date, and the BEO billing's deposit paid and Party
 * Details' prepayment received (Party Details' other keys kept). The billing
 * row is made when the party has none, unless `billing` is "existing" (the
 * Events page's Prepayment on an event the BEO never opened: the view reads
 * the event's own then).
 */
export async function writePartyDeposit(
  tx: DbExecutor,
  input: {
    eventId: string;
    deposit: PartyDeposit;
    now: Date;
    userId?: string | null;
    /** Whether the event's own prepayment is written here (false when the caller just wrote it). */
    event?: boolean;
    billing?: "upsert" | "existing";
  },
): Promise<void> {
  const { eventId, deposit, now } = input;
  const amount = deposit.amountThb > 0 ? Math.round(deposit.amountThb) : 0;
  const date = amount > 0 && deposit.date && DAY.test(deposit.date) ? deposit.date : null;
  if (input.event !== false) {
    await tx
      .update(coreEvents)
      .set({
        prepaymentAmount: amount > 0 ? amount : null,
        prepaymentDate: date,
        updatedAt: now,
        ...(input.userId !== undefined ? { updatedByUserId: input.userId } : {}),
      })
      .where(eq(coreEvents.id, eventId));
  }
  const [billing] = await tx
    .select({ id: beoEventBilling.id, addOns: beoEventBilling.addOns })
    .from(beoEventBilling)
    .where(eq(beoEventBilling.eventId, eventId));
  if (!billing && input.billing === "existing") return;
  const addOns = asRecord(billing?.addOns);
  const { depositDate: _was, ...partyDetails } = asRecord(addOns.partyDetails);
  const values = {
    depositPaid: amount > 0,
    depositPaidAmount: amount > 0 ? amount : null,
    depositPaidAt: date ? new Date(`${date}T00:00:00.000Z`) : null,
    addOns: { ...addOns, partyDetails: { ...partyDetails, prepaymentReceived: amount, ...(date ? { depositDate: date } : {}) } },
    updatedAt: now,
  };
  if (billing) await tx.update(beoEventBilling).set(values).where(eq(beoEventBilling.id, billing.id));
  else await tx.insert(beoEventBilling).values({ eventId, ...values });
}
