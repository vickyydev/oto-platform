import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { account, employee, partyCharge, partyEdit, partyPayment, paymentAttempt } from '@oto/db';
import {
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  PartyChargeItemSchema,
  partyBillOf,
  type PartyBill,
  type PartyChargeItem,
  type PartyChargeView,
  type PartyEditFields,
  type PartyEditState,
  type PartyPaymentView,
} from '@oto/shared';
import type { SeamEvent } from './otoapp-events';
import type { Exec, Tx } from './tx';

/**
 * S2-20 E4 — THE PARTY TAB, READ (SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md §3, §8 and the E4 row of §9).
 *
 * A party's bill is two halves (`PartyBooking`, types.ts:1344):
 *
 *   - the OTO App's — the booking, its base price and its deposit — read
 *     through the seam (`otoapp-events.ts`), never copied here;
 *   - the POS's own — the charges and payments the till added, and the edits a
 *     till made that the OTO App has not taken yet — read from `pos`.
 *
 * This file puts the two together: the till's pending edits laid over the
 * app's event (`overlayPartyEdits`), the POS's ledgers as the prototype's
 * `PartyExtraCharge` and `PartyPayment` rows, and the bill worked out as
 * `lib/party.ts` works it out (`partyBillOf`). It names no OTO App table and
 * no view (H1): the event arrives from the seam.
 */

type EditRow = typeof partyEdit.$inferSelect;

/** A till's edit, with the name of whoever made it. */
export type PartyEditWithStaff = EditRow & { staffName: string | null };

/** The POS's half of one party. */
export interface PartyLedgers {
  charges: PartyChargeView[];
  payments: PartyPaymentView[];
  /** Every edit a till made, oldest first, whatever the OTO App made of it. */
  edits: PartyEditWithStaff[];
}

/** What the park calls a member of staff: their nickname, then their name. */
const nameOf = (r: { name: string | null; nickname: string | null }): string | null =>
  r.nickname?.trim() || r.name?.trim() || null;

/** A stored breakdown, read defensively: the column is checked to be an array, its lines are not. */
function itemsOf(value: unknown): PartyChargeItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = PartyChargeItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** One transaction at a time per party: a charge, a payment and an edit of the same party queue. */
export async function lockParty(tx: Tx, eventId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`party-tab:${eventId.toLowerCase()}`}, 0))`);
}

/**
 * The POS's half of some parties, in three reads for all of them — never a
 * round per party. Every party asked about has an entry, empty when the till
 * has done nothing to it.
 */
export async function partyLedgersOf(
  db: Exec,
  q: { branchId: string; eventIds: readonly string[] },
): Promise<Map<string, PartyLedgers>> {
  const out = new Map<string, PartyLedgers>();
  for (const id of q.eventIds) out.set(id, { charges: [], payments: [], edits: [] });
  if (q.eventIds.length === 0) return out;
  const ids = [...q.eventIds];

  const charges = await db
    .select({ row: partyCharge, name: employee.name, nickname: employee.nickname })
    .from(partyCharge)
    .leftJoin(account, eq(account.id, partyCharge.accountId))
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(and(eq(partyCharge.branchId, q.branchId), inArray(partyCharge.otoappEventId, ids)))
    .orderBy(asc(partyCharge.chargedAt), asc(partyCharge.id));
  for (const c of charges) {
    out.get(c.row.otoappEventId)?.charges.push({
      id: c.row.id,
      kind: c.row.kind,
      items: itemsOf(c.row.items),
      totalSatang: c.row.totalSatang,
      chargedBy: nameOf(c),
      chargedById: c.row.accountId,
      chargedAt: c.row.chargedAt.toISOString(),
    });
  }

  const payments = await db
    .select({
      row: partyPayment,
      amountSatang: paymentAttempt.amountSatang,
      method: paymentAttempt.method,
      methodCode: paymentAttempt.methodCode,
      businessDate: paymentAttempt.businessDate,
      paidAt: paymentAttempt.paidAt,
      createdAt: paymentAttempt.createdAt,
      name: employee.name,
      nickname: employee.nickname,
    })
    .from(partyPayment)
    .innerJoin(paymentAttempt, eq(paymentAttempt.id, partyPayment.paymentAttemptId))
    .leftJoin(account, eq(account.id, partyPayment.accountId))
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(
      and(
        eq(partyPayment.branchId, q.branchId),
        inArray(partyPayment.otoappEventId, ids),
        // The money that was taken. Every party payment is settled as it is
        // recorded today; a tender that is reversed one day stops counting here.
        inArray(paymentAttempt.status, [...PAYMENT_ATTEMPT_TAKEN_STATUSES]),
      ),
    )
    .orderBy(asc(partyPayment.createdAt), asc(partyPayment.id));
  for (const p of payments) {
    out.get(p.row.otoappEventId)?.payments.push({
      id: p.row.id,
      amountSatang: p.amountSatang,
      method: p.methodCode ?? p.method,
      kind: p.method,
      takenBy: nameOf(p),
      takenById: p.row.accountId,
      takenAt: (p.paidAt ?? p.createdAt).toISOString(),
      businessDate: p.businessDate,
      attemptId: p.row.paymentAttemptId,
    });
  }

  const edits = await db
    .select({ row: partyEdit, name: employee.name, nickname: employee.nickname })
    .from(partyEdit)
    .leftJoin(account, eq(account.id, partyEdit.accountId))
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(and(eq(partyEdit.branchId, q.branchId), inArray(partyEdit.otoappEventId, ids)))
    .orderBy(asc(partyEdit.createdAt), asc(partyEdit.id));
  for (const e of edits) {
    out.get(e.row.otoappEventId)?.edits.push({ ...e.row, staffName: nameOf(e) });
  }
  return out;
}

/** A party's own fields, in the words a till's edit uses — the "before" of an edit. */
export function partyFieldsOf(e: SeamEvent): Required<PartyEditFields> {
  return {
    title: e.title,
    status: e.status as Required<PartyEditFields>['status'],
    date: e.startDate,
    startTime: e.startTime,
    endTime: e.endTime,
    location: e.location,
    expectedKids: e.expectedKids ?? 0,
    expectedAdults: e.expectedAdults ?? 0,
    childName: e.childName,
    kidAge: e.kidTurningAge,
    parentName: e.parentName,
    whatsapp: e.parentPhone,
    decoration: e.decoration,
    activities: e.activities,
    basePriceSatang: e.totalValueSatang ?? 0,
    depositSatang: e.depositSatang ?? 0,
    depositDate: e.depositDate,
  };
}

/** One till edit, laid over the event as the OTO App will hold it once it takes it. */
export function applyPartyFields(e: SeamEvent, f: PartyEditFields): SeamEvent {
  const out: SeamEvent = { ...e };
  if (f.title !== undefined) out.title = f.title;
  if (f.status !== undefined) out.status = f.status;
  if (f.date !== undefined) {
    out.startDate = f.date;
    // A party is one day: the view gives it its own date as its last.
    if (out.type !== 'camp') out.endDate = f.date;
  }
  if (f.startTime !== undefined) out.startTime = f.startTime;
  if (f.endTime !== undefined) out.endTime = f.endTime;
  if (f.location !== undefined) out.location = f.location;
  if (f.expectedKids !== undefined) out.expectedKids = f.expectedKids;
  if (f.expectedAdults !== undefined) out.expectedAdults = f.expectedAdults;
  if (f.childName !== undefined) out.childName = f.childName;
  if (f.kidAge !== undefined) out.kidTurningAge = f.kidAge;
  if (f.parentName !== undefined) out.parentName = f.parentName;
  if (f.whatsapp !== undefined) out.parentPhone = f.whatsapp;
  if (f.decoration !== undefined) out.decoration = f.decoration;
  if (f.activities !== undefined) out.activities = f.activities;
  if (f.basePriceSatang !== undefined) out.totalValueSatang = f.basePriceSatang;
  if (f.depositSatang !== undefined) out.depositSatang = f.depositSatang;
  if (f.depositDate !== undefined) out.depositDate = f.depositDate;
  return out;
}

/**
 * Whether a till's edit is still to be shown over the event: the OTO App has
 * not taken it yet (`pending`), and has not changed the event since it was
 * made — an edit older than the app's own latest change is refused by the
 * app when it arrives (`edit_superseded`), so it is not shown over it either.
 * A refused edit (`failed`) is never shown: the app said no.
 */
export function editStillShown(edit: Pick<EditRow, 'syncState' | 'createdAt'>, e: Pick<SeamEvent, 'updatedAt'>): boolean {
  if (edit.syncState !== 'pending') return false;
  return !e.updatedAt || edit.createdAt.getTime() >= e.updatedAt.getTime();
}

/** The event with every till edit the OTO App has not taken yet laid over it, oldest first. */
export function overlayPartyEdits(e: SeamEvent, edits: readonly EditRow[]): SeamEvent {
  let out = e;
  for (const edit of edits) {
    if (editStillShown(edit, e)) out = applyPartyFields(out, edit.fields as PartyEditFields);
  }
  return out;
}

/** The newest edit the OTO App has not taken, as the party screen marks it; null when there is none. */
export function editSyncOf(edits: readonly EditRow[]): PartyEditState | null {
  const waiting = edits.filter((e) => e.syncState !== 'synced');
  const newest = waiting[waiting.length - 1];
  if (!newest) return null;
  return {
    editId: newest.id,
    state: newest.syncState === 'failed' ? 'failed' : 'pending',
    error: newest.syncError,
    at: newest.createdAt.toISOString(),
  };
}

/** The `updateParty` stamp: the newest edit a till made that the OTO App did not refuse. */
export function lastEditedOf(edits: readonly PartyEditWithStaff[]): { by: string | null; byId: string | null; at: string } | null {
  const taken = edits.filter((e) => e.syncState !== 'failed');
  const newest = taken[taken.length - 1];
  return newest ? { by: newest.staffName, byId: newest.accountId, at: newest.createdAt.toISOString() } : null;
}

/**
 * The party's bill (`computePartyTotal`, `computePartyOutstanding`): the OTO
 * App's bill total as the base (its line items are inside it), the walk-ups and
 * the till's charges on top, less the deposit and the payments taken.
 */
export function billOfParty(e: SeamEvent, walkUpsSatang: number, ledgers: Pick<PartyLedgers, 'charges' | 'payments'>): PartyBill {
  return partyBillOf({
    baseSatang: e.totalValueSatang ?? 0,
    chargesSatang: walkUpsSatang + ledgers.charges.reduce((sum, c) => sum + c.totalSatang, 0),
    depositSatang: e.depositSatang ?? 0,
    paidSatang: ledgers.payments.reduce((sum, p) => sum + p.amountSatang, 0),
  });
}
