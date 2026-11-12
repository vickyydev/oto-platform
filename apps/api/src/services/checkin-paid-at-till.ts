import { and, asc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { checkin, paymentAttempt, sale, saleHold, saleLine } from '@oto/db';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import type { Exec } from './tx';

/**
 * SCRUM-740 — THE TILL SALE THAT ALREADY PAID FOR A STAY.
 *
 * A child registered for drop-off is put on a sale under the stay's own id
 * (`sale_line.cart_line_id = checkin.id`, `services/checkin.ts` `loadChoice`
 * reads the same link back). Once the sale is paid the counter chooses "Check
 * in now" or "Leave as booked"; either one files the sale on the stay. Until
 * the child is checked in they still wait on the board and in the till's Add
 * drop-off picker, and nothing stopped a second sale from taking the money
 * again: only Check in refused afterwards, with "was paid for on another sale".
 *
 * Two ways a waiting child is already on a till sale:
 *
 *   - LINKED: the stay names its sale ("Leave as booked"). Whatever became of
 *     that sale since, `loadChoice` refuses any other sale for this child, so
 *     a second charge is refused for the same reason before money is taken.
 *   - PAID, NOT YET LINKED: a paid or finalised sale carries the stay's kids
 *     line, and the choice after payment was never made (the screen was
 *     reloaded, or both presses failed). The child is paid for all the same.
 *
 * Only a paid or finalised sale counts as paid for the views: a voided or
 * refunded sale still linked to a stay is refused at the money press (the
 * check-in would refuse it anyway) but is not shown as paid.
 */
export interface PaidAtTill {
  saleId: string;
  receiptNumber: string | null;
}

interface TillSaleOfStay extends PaidAtTill {
  /** The sale is paid or finalised: the money is held. */
  live: boolean;
  status: string;
}

const LIVE_SALE_STATUSES = ['paid', 'finalised'] as const;
const isLive = (status: string) => (LIVE_SALE_STATUSES as readonly string[]).includes(status);

/** The till sale each of these stays is already on, by stay id. */
async function tillSalesOfStays(
  db: Exec,
  operatorId: string,
  stays: readonly { id: string; saleId: string | null }[],
): Promise<Map<string, TillSaleOfStay>> {
  const out = new Map<string, TillSaleOfStay>();
  if (stays.length === 0) return out;

  const linked = stays.filter((s): s is { id: string; saleId: string } => !!s.saleId);
  if (linked.length > 0) {
    const rows = await db
      .select({ id: sale.id, receiptNumber: sale.receiptNumber, status: sale.status })
      .from(sale)
      .where(and(eq(sale.operatorId, operatorId), inArray(sale.id, [...new Set(linked.map((s) => s.saleId))])));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const s of linked) {
      const row = byId.get(s.saleId);
      const status = row?.status ?? 'finalised';
      out.set(s.id, { saleId: s.saleId, receiptNumber: row?.receiptNumber ?? null, status, live: isLive(status) });
    }
  }

  const unlinked = stays.filter((s) => !s.saleId).map((s) => s.id);
  if (unlinked.length > 0) {
    const rows = await db
      .select({ stayId: saleLine.cartLineId, saleId: sale.id, receiptNumber: sale.receiptNumber, status: sale.status })
      .from(saleLine)
      .innerJoin(sale, eq(sale.id, saleLine.saleId))
      .where(
        and(
          inArray(saleLine.cartLineId, unlinked),
          eq(saleLine.kind, 'kids'),
          eq(sale.operatorId, operatorId),
          inArray(sale.status, [...LIVE_SALE_STATUSES]),
        ),
      )
      .orderBy(asc(sale.createdAt), asc(sale.id));
    for (const r of rows) {
      if (out.has(r.stayId)) continue;
      out.set(r.stayId, { saleId: r.saleId, receiptNumber: r.receiptNumber, status: r.status, live: true });
    }
  }
  return out;
}

/**
 * Which of these waiting stays a till sale has already paid for, by stay id —
 * answered on the board and the waiting list, so the picker never offers the
 * child as a line to charge and the board checks them in with no payment.
 */
export async function paidAtTillStaysOf(
  db: Exec,
  operatorId: string,
  stays: readonly { id: string; saleId: string | null }[],
): Promise<Map<string, PaidAtTill>> {
  const out = new Map<string, PaidAtTill>();
  for (const [id, found] of await tillSalesOfStays(db, operatorId, stays)) {
    if (found.live) out.set(id, { saleId: found.saleId, receiptNumber: found.receiptNumber });
  }
  return out;
}

export const CHECKIN_PAID_AT_TILL = 'CHECKIN_PAID_AT_TILL';
/** SCRUM-862 — a line under a stay staff cancelled: refused when written and at the money press. */
export const CHECKIN_CANCELLED = 'CHECKIN_CANCELLED';

/** The sale a money press was refused on, named on the refusal so its trail can name it. */
interface TenderedSale {
  id: string;
  branchId: string;
  stationId: string | null;
}

/**
 * Refused before anything is priced or written: no new sale may carry a line
 * under a stay a till sale already holds. `saleId` is the sale being written,
 * which a retry of the same sale may name.
 *
 * `tendered` names a sale already rung up whose money press is refused (see
 * `refuseTenderOnStaysPaidAtTill`): the sale stays as it was, and the counter
 * is told to take the child off it.
 */
export async function refusePaidAtTillStays(
  db: Exec,
  operatorId: string,
  saleId: string,
  stays: readonly { id: string; childName: string; saleId: string | null }[],
  tendered?: TenderedSale,
): Promise<void> {
  if (stays.length === 0) return;
  const found = await tillSalesOfStays(db, operatorId, stays);
  for (const s of stays) {
    const hit = found.get(s.id);
    if (!hit || hit.saleId === saleId) continue;
    const receipt = hit.receiptNumber ? ` on receipt ${hit.receiptNumber}` : '';
    const message = hit.live
      ? tendered
        ? `${s.childName} is already paid for at the till${receipt}, so this sale cannot take their money again. Cancel this sale and ring it up again without them, then check them in from the Drop-Off board. Nothing was charged.`
        : `${s.childName} is already paid for at the till${receipt}, so there is nothing to charge. Check them in from the Drop-Off board. Nothing was saved.`
      : `${s.childName} is still filed on an earlier sale${receipt}, which was ${hit.status === 'refunded' ? 'refunded' : 'cancelled'}, so they cannot go on a second sale. Ask a manager. ${tendered ? 'Nothing was charged.' : 'Nothing was saved.'}`;
    throw errors.conflict(
      CHECKIN_PAID_AT_TILL,
      message,
      {
        checkinId: s.id,
        saleId: hit.saleId,
        receiptNumber: hit.receiptNumber,
        ...(tendered ? { tenderedSale: tendered } : {}),
      },
    );
  }
}

/**
 * THE MONEY PRESS ON A SALE ALREADY RUNG UP.
 *
 * The refusal above runs when a sale is first written. A sale rung up earlier
 * can still reach its money press after another sale paid for the same child:
 * a sale parked in Held sales and resumed (SCRUM-774), two tills that rang the
 * family up at the same time, a screen left open. So the counter's own money
 * presses ask again — the cash confirm (`finaliseSale`), a card sent to the
 * terminal (`startTerminalTender`) and a QR shown to the guest
 * (`openQrAttempt`) — and only while no money has been taken on this sale, the
 * same rule SCRUM-514 keeps for a promo code's last use: a part payment
 * already in is not left on a sale that cannot close. A box's replay, a paid
 * QR's settlement and a booking's redemption are not asked. SCRUM-862 — the
 * same presses refuse a child whose booking was cancelled since
 * (CHECKIN_CANCELLED); a sale that already took or asked for money is never
 * met here, as the cancel itself is refused while one carries the child
 * (`openTillSalesOfStays`).
 */
export async function refuseTenderOnStaysPaidAtTill(
  db: Exec,
  tendered: { id: string; operatorId: string; branchId: string; stationId: string | null },
): Promise<void> {
  const lines = await db
    .selectDistinct({ stayId: saleLine.cartLineId })
    .from(saleLine)
    .where(and(eq(saleLine.saleId, tendered.id), eq(saleLine.kind, 'kids')));
  if (lines.length === 0) return;
  const stays = await db
    .select({ id: checkin.id, childName: checkin.childName, saleId: checkin.saleId, status: checkin.status })
    .from(checkin)
    .where(
      and(
        inArray(
          checkin.id,
          lines.map((l) => l.stayId),
        ),
        eq(checkin.operatorId, tendered.operatorId),
      ),
    );
  // SCRUM-862 — nor is money taken for a child whose booking staff cancelled
  // since this sale was rung up (a sale held and resumed, or rung up at a
  // second till): the stay can never be checked in, so the family would pay
  // for nothing.
  const cancelled = stays.find((s) => s.status === 'cancelled');
  if (cancelled) {
    throw errors.conflict(
      CHECKIN_CANCELLED,
      `${cancelled.childName}'s drop-off booking was cancelled, so it can't be sold — cancel this sale and ring it up again without them, or register them again if they are staying. Nothing was charged.`,
      { checkinId: cancelled.id, saleId: tendered.id },
    );
  }
  await refusePaidAtTillStays(
    db,
    tendered.operatorId,
    tendered.id,
    stays.filter((s) => s.status === 'registered'),
    { id: tendered.id, branchId: tendered.branchId, stationId: tendered.stationId },
  );
}

/**
 * The refusal above is thrown inside the sale's transaction, which takes back
 * everything written in it, so its trail is written here, after the rollback:
 * one row on the stay the second charge was refused for.
 */
export async function recordPaidAtTillRefusal(
  db: Exec,
  actor: { accountId: string | null; operatorId: string; branchId: string | null; requestId?: string | null },
  err: unknown,
  attempted: { saleId: string | null; stationId: string | null },
): Promise<void> {
  if (!(err instanceof AppError) || err.code !== CHECKIN_PAID_AT_TILL) return;
  const details = (err.details ?? {}) as {
    checkinId?: string;
    saleId?: string;
    receiptNumber?: string | null;
    tenderedSale?: TenderedSale;
  };
  if (!details.checkinId) return;
  // A money press names the sale it was refused on; a new sale is the caller's.
  const refused = details.tenderedSale ?? null;
  await audit.record(db, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: refused?.branchId ?? actor.branchId,
    action: 'checkin.second_charge_refused',
    entityType: 'checkin',
    entityId: details.checkinId,
    requestId: actor.requestId ?? null,
    after: {
      code: err.code,
      paidOnSaleId: details.saleId ?? null,
      receiptNumber: details.receiptNumber ?? null,
      refusedSaleId: refused?.id ?? attempted.saleId,
      stationId: refused?.stationId ?? attempted.stationId,
      ...(refused ? { at: 'tender' } : {}),
    },
  });
}

/**
 * SCRUM-862 — AN OPEN TILL SALE A CANCEL MUST NOT PULL A STAY FROM UNDER.
 *
 * A waiting child rung up on a sale still `tendering` is cancellable as long
 * as nothing on that sale can go on without the counter seeing the refusal:
 * the money presses refuse a cancelled stay (`refuseTenderOnStaysPaidAtTill`).
 * Two such sales are not like that, and a cancel is refused while a child is
 * on one:
 *
 *   - HELD: parked in Held sales (SCRUM-774). It comes back to Pay exactly as
 *     it was rung up, so the child cannot be taken off it; it is voided from
 *     the Held sales list.
 *   - MONEY TAKEN OR ASKED FOR: a payment approved, a card at the terminal, a
 *     QR shown. A part payment closes the sale without the money presses
 *     asking again, and a QR or a card may settle on its own.
 *
 * Any other open sale — rung up and left, superseded by an edited cart — is
 * not counted: refusing over it would leave a booking nobody can clear.
 */
export interface OpenSaleOfStay {
  saleId: string;
  /** The name the sale is parked under in Held sales, when it is held. */
  heldAs: string | null;
}

const ATTEMPT_STATUSES_NOTHING_ASKED = ['declined', 'cancelled', 'not_found'] as const;

export async function openTillSalesOfStays(
  db: Exec,
  operatorId: string,
  stayIds: readonly string[],
): Promise<Map<string, OpenSaleOfStay>> {
  const out = new Map<string, OpenSaleOfStay>();
  if (stayIds.length === 0) return out;
  const lines = await db
    .selectDistinct({ stayId: saleLine.cartLineId, saleId: sale.id })
    .from(saleLine)
    .innerJoin(sale, eq(sale.id, saleLine.saleId))
    .where(
      and(
        inArray(saleLine.cartLineId, [...stayIds]),
        eq(saleLine.kind, 'kids'),
        eq(sale.operatorId, operatorId),
        eq(sale.status, 'tendering'),
      ),
    );
  if (lines.length === 0) return out;
  const saleIds = [...new Set(lines.map((l) => l.saleId))];
  const holds = await db
    .select({ saleId: saleHold.saleId, label: saleHold.label })
    .from(saleHold)
    .where(and(inArray(saleHold.saleId, saleIds), isNull(saleHold.releasedAt)));
  const asked = await db
    .selectDistinct({ saleId: paymentAttempt.saleId })
    .from(paymentAttempt)
    .where(and(inArray(paymentAttempt.saleId, saleIds), notInArray(paymentAttempt.status, [...ATTEMPT_STATUSES_NOTHING_ASKED])));
  const heldAs = new Map(holds.map((h) => [h.saleId, h.label]));
  const moneyAsked = new Set(asked.map((a) => a.saleId));
  for (const l of lines) {
    if (out.has(l.stayId)) continue;
    const label = heldAs.get(l.saleId);
    if (label === undefined && !moneyAsked.has(l.saleId)) continue;
    out.set(l.stayId, { saleId: l.saleId, heldAs: label ?? null });
  }
  return out;
}
