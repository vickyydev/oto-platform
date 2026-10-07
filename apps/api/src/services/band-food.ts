import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { auditLog, band, checkin, child, eventCheckin, sale, saleLine, syncEvent, walletKey } from '@oto/db';
import {
  BAND_FOOD_REFUSALS,
  allergiesMedicalOf,
  bandNotInParkRefusal,
  bandOtherParkRefusal,
  normaliseBandCode,
  prepaidHeldRefusal,
  prepaidNotEntitledRefusal,
  prepaidRemainingOf,
  prepaidStayClosedRefusal,
  prepaidUsedUpRefusal,
  redeemPrepaid,
  type BandStayView,
  type CartBandHolderInput,
  type CartPrepaidInput,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { findBandsByCode } from './bands';
import type { Exec, Tx } from './tx';

/**
 * SCRUM-494 (food) — THE BAND AT THE F&B AND SHOP COUNTERS.
 *
 * Two things the design keeps on the band (`types.ts:Wristband`) and the
 * platform keeps on the child's stay (`pos.checkin`):
 *
 *   1. THE SAFETY DATA. A scanned band resolves to its child's stay at this
 *      park, in the park, and the counter is told the child's allergies and
 *      medical notes, food restrictions, whether the parent authorised food
 *      (`mayOrderFood`) and the food they prepaid (`foodProvision`). The F&B
 *      order taken against the band names the stay (`bandHolder`), and the
 *      prep ticket prints that child's own allergy line.
 *   2. THE PREPAID MEAL ENTITLEMENTS (`prepaid_items`), persisted on the stay
 *      at registration (`food_provision.items`). A line served from them is
 *      an ordinary F&B line priced at ฿0 (the design's `isPrepaid` line), so
 *      it reaches the kitchen ticket and the stock count like any line, and
 *      the stay's `redeemedQty` goes up when the order is confirmed
 *      (`redeemSalePrepaid`) — the design's `redeemPrepaidItem`, which runs at
 *      confirmation and never at add-time, and never passes what was paid for.
 *      The release reads the same `redeemedQty`, so only what was not served
 *      is settled under the branch's policy.
 */

type CheckinRow = typeof checkin.$inferSelect;
type SaleRow = typeof sale.$inferSelect;
type StoredItem = NonNullable<NonNullable<CheckinRow['foodProvision']>['items']>[number];

// --- The scan -------------------------------------------------------------------------

/**
 * The stay a scanned key belongs to, at this park and in the park: by the band
 * the key names (a band's code or short code), by the band keys of the wallet
 * the key found (a voucher QR), or by the child that wallet belongs to. Null
 * when the key names no child in the park here.
 */
export async function stayForKey(
  db: Exec,
  operatorId: string,
  branchId: string,
  key: string,
  walletId: string | null,
): Promise<CheckinRow | null> {
  const bandIds = (await findBandsByCode(db, operatorId, key)).map((b) => b.id);
  const childIds: string[] = [];
  if (walletId) {
    const keys = await db
      .select({ kind: walletKey.kind, value: walletKey.value })
      .from(walletKey)
      .where(and(eq(walletKey.operatorId, operatorId), eq(walletKey.walletId, walletId)));
    const codes = keys.filter((k) => k.kind === 'band').map((k) => normaliseBandCode(k.value));
    if (codes.length > 0) {
      const rows = await db
        .select({ id: band.id })
        .from(band)
        .where(and(eq(band.operatorId, operatorId), inArray(band.code, codes)));
      bandIds.push(...rows.map((r) => r.id));
    }
    childIds.push(...keys.filter((k) => k.kind === 'child').map((k) => k.value));
  }
  const by: SQL[] = [];
  if (bandIds.length > 0) by.push(inArray(checkin.bandId, [...new Set(bandIds)]));
  if (childIds.length > 0) by.push(inArray(checkin.childId, [...new Set(childIds)]));
  if (by.length === 0) return null;
  const [row] = await db
    .select()
    .from(checkin)
    .where(
      and(
        eq(checkin.operatorId, operatorId),
        eq(checkin.branchId, branchId),
        eq(checkin.status, 'in_park'),
        by.length === 1 ? by[0]! : or(...by)!,
      ),
    )
    .orderBy(desc(checkin.checkedInAt))
    .limit(1);
  return row ?? null;
}

/**
 * S2-20 E3 — THE EVENT CHILD A SCANNED BAND BELONGS TO, at this park, checked
 * in and not out: a kid band an event check-in issued resolves to that child's
 * allergy and diet lines the way a drop-off band resolves to its stay — the
 * OTO App's any-text rule (Q13), frozen on the check-in when the band printed
 * — with `mayOrderFood=false` and no prepaid food (`checkInEventAttendee`,
 * mockApi.ts:3818-3826). The KID band only: the parent band is the parent's
 * own (mockApi.ts:3829-3838 — the parent's name and no allergy line), as a
 * drop-off guardian's band resolves to no stay. Null when the key names no such
 * band.
 */
export async function eventBandStayForKey(
  db: Exec,
  operatorId: string,
  branchId: string,
  key: string,
): Promise<BandStayView | null> {
  const bandIds = (await findBandsByCode(db, operatorId, key))
    .filter((b) => b.eventCheckinId && b.kind === 'kid')
    .map((b) => b.id);
  if (bandIds.length === 0) return null;
  const [row] = await db
    .select({ c: eventCheckin })
    .from(band)
    .innerJoin(eventCheckin, eq(eventCheckin.id, band.eventCheckinId))
    .where(
      and(
        inArray(band.id, bandIds),
        eq(band.operatorId, operatorId),
        eq(band.kind, 'kid'),
        eq(band.status, 'active'),
        eq(eventCheckin.branchId, branchId),
        isNull(eventCheckin.checkedOutAt),
        isNull(eventCheckin.undoneAt),
      ),
    )
    .orderBy(desc(eventCheckin.checkedInAt))
    .limit(1);
  return row ? eventBandStayViewOf(row.c) : null;
}

/** An event check-in of this operator: a food order's band holder (S2-20 E3). */
async function eventHolderOf(
  db: Exec,
  operatorId: string,
  checkinId: string,
): Promise<typeof eventCheckin.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(eventCheckin)
    .where(and(eq(eventCheckin.id, checkinId), eq(eventCheckin.operatorId, operatorId)))
    .limit(1);
  // The park is the caller's to judge: a till at another park is told so.
  return row ?? null;
}

/** An event check-in as the food counter reads it. */
export function eventBandStayViewOf(row: typeof eventCheckin.$inferSelect): BandStayView {
  return {
    checkinId: row.id,
    branchId: row.branchId,
    childName: row.childName,
    allergiesMedical: row.allergy?.trim() || null,
    foodRestrictions: row.dietary?.trim() || null,
    mayOrderFood: false,
    foodProvision: null,
    source: 'event',
  };
}

/** The stay as the counter reads it: the snapshot the guardian gave, the saved record behind it. */
export async function bandStayViewOf(db: Exec, stay: CheckinRow): Promise<BandStayView> {
  const [saved] = stay.childId
    ? await db
        .select({ allergies: child.allergies, medicalNotes: child.medicalNotes, dietary: child.dietary })
        .from(child)
        .where(eq(child.id, stay.childId))
        .limit(1)
    : [];
  const fp = stay.foodProvision;
  return {
    checkinId: stay.id,
    branchId: stay.branchId,
    childName: stay.childName,
    allergiesMedical: allergiesMedicalOf(stay.allergies?.trim() || saved?.allergies, saved?.medicalNotes),
    foodRestrictions: stay.foodRestrictions?.trim() || saved?.dietary?.trim() || null,
    mayOrderFood: stay.mayOrderFood,
    foodProvision: fp
      ? {
          mode: fp.mode,
          paidSatang: fp.paidSatang,
          creditSatang: fp.creditSatang ?? null,
          items: (fp.items ?? []).map((it) => ({
            menuItemId: it.menuItemId,
            menuItemName: it.menuItemName,
            unitSatang: it.unitSatang,
            qty: it.qty,
            redeemedQty: it.redeemedQty ?? 0,
          })),
        }
      : null,
  };
}

// --- The cart -------------------------------------------------------------------------

/** What `priceCart` needs to know about the band an F&B order was taken against. */
export interface CartBandFood {
  /** The stay the order names as its band holder, checked. */
  holder: { checkinId: string; foodOverride: boolean; mayOrderFood: boolean; childName: string } | null;
  /**
   * The item lines served from prepaid entitlements, by cart line id.
   * `matched` is false only on an offline replay whose line names no stay of
   * this park: the line is filed at ฿0 as the box served it, and nothing is
   * redeemed or printed from the stay it names. `settledAtPickup` only on an
   * offline replay whose stay was released before the replay arrived: the
   * pickup settled that food as unused, so the line is filed at ฿0 and is not
   * served (no redemption, no prep ticket, no stock).
   */
  prepaid: Map<string, { checkinId: string; matched: boolean; settledAtPickup?: boolean }>;
}

/** Where the cart is being priced: a quote reads, a commit holds the stays it serves from. */
export interface CartBandFoodScope {
  /** The sale being committed — its own lines are not "another open order". Null on a quote. */
  saleId: string | null;
  /** Lock the stays served from until the commit (a commit's transaction). */
  lock: boolean;
}

/**
 * Prepaid units already on OPEN orders (committed, not yet paid or cancelled)
 * at this park, by `<checkinId>|<menuItemId>`. Such an order holds its prepaid
 * lines until it closes, the platform's counterpart of the design's add-time
 * guard counting the cart (`OrderStation.tsx:192-195`): a second counter is
 * told the item is on an open order rather than serving it twice.
 */
export async function prepaidHeldOnOpenOrders(
  db: Exec,
  operatorId: string,
  branchId: string,
  checkinIds: readonly string[],
  exceptSaleId: string | null,
): Promise<Map<string, { qty: number; saleIds: string[] }>> {
  const held = new Map<string, { qty: number; saleIds: string[] }>();
  if (checkinIds.length === 0) return held;
  const conds: SQL[] = [
    eq(sale.operatorId, operatorId),
    eq(sale.branchId, branchId),
    inArray(sale.status, ['tendering', 'paid']),
    eq(saleLine.kind, 'fnb_item'),
    inArray(sql`(${saleLine.payload} -> 'prepaid' ->> 'checkinId')`, [...checkinIds]),
  ];
  if (exceptSaleId) conds.push(ne(sale.id, exceptSaleId));
  const rows = await db
    .select({ saleId: saleLine.saleId, quantity: saleLine.quantity, payload: saleLine.payload, productId: saleLine.productId })
    .from(saleLine)
    .innerJoin(sale, eq(sale.id, saleLine.saleId))
    .where(and(...conds));
  for (const row of rows) {
    const p = (row.payload as BandFoodPayload | null)?.prepaid;
    if (!p || p.unmatched || p.settledAtPickup || row.quantity <= 0) continue;
    const key = `${p.checkinId}|${p.menuItemId ?? row.productId ?? ''}`;
    const entry = held.get(key) ?? { qty: 0, saleIds: [] };
    entry.qty += row.quantity;
    if (!entry.saleIds.includes(row.saleId)) entry.saleIds.push(row.saleId);
    held.set(key, entry);
  }
  return held;
}

export interface CartBandFoodInput {
  bandHolder?: CartBandHolderInput | null;
  items?: { id: string; productId: string; quantity: number; modifiers?: { groupId: string; optionIds: string[] }[]; prepaid?: CartPrepaidInput | null }[];
}

/**
 * Check the band holder and the prepaid lines a cart names, before anything is
 * priced.
 *
 * `strict` (a till ringing the order up now): the stay must be at this park
 * and in the park, every prepaid line must be one of the holder's prepaid
 * items, served as it was paid for (no options), and the cart may not serve
 * more of an item than is left once the units already on other open orders
 * are counted. On a commit the stays served from are locked until the commit,
 * so two counters serving the same entitlement decide one after the other.
 * `file` (an offline sale replayed later): the money is already taken and the
 * tray already served, so nothing is refused here; a stay that is not this
 * park's is never taken as the holder and never served from, a stay already
 * released is settled at pickup (its line is not served), and the redemption
 * at finalise takes off what is left and no more. On a commit the stays are
 * locked here too, so a release cannot land between this read and the close.
 */
export async function resolveCartBandFood(
  db: Exec,
  operatorId: string,
  branchId: string,
  input: CartBandFoodInput,
  mode: 'strict' | 'file',
  productName: (productId: string) => string,
  scope: CartBandFoodScope = { saleId: null, lock: false },
): Promise<CartBandFood> {
  const prepaidLines = (input.items ?? []).filter((l) => !!l.prepaid);
  const holderId = input.bandHolder?.checkinId ?? null;
  if (!holderId && prepaidLines.length === 0) return { holder: null, prepaid: new Map() };

  const ids = [...new Set([holderId, ...prepaidLines.map((l) => l.prepaid!.checkinId)].filter((v): v is string => !!v))].sort();
  const locking = scope.lock && prepaidLines.length > 0;
  const query = db
    .select()
    .from(checkin)
    .where(and(eq(checkin.operatorId, operatorId), inArray(checkin.id, ids)))
    .orderBy(checkin.id);
  // One order of locks for every caller (by id), the same order `redeemSalePrepaid` takes them in.
  const stays = locking ? await query.for('update') : await query;
  const byId = new Map(stays.map((s) => [s.id, s]));
  const held =
    mode === 'strict' && prepaidLines.length > 0
      ? await prepaidHeldOnOpenOrders(db, operatorId, branchId, ids, scope.saleId)
      : new Map<string, { qty: number; saleIds: string[] }>();

  const checkStay = (id: string): CheckinRow | null => {
    const stay = byId.get(id) ?? null;
    if (mode === 'file') return stay && stay.branchId === branchId ? stay : null;
    if (!stay) throw new AppError(404, 'BAND_STAY_NOT_FOUND', BAND_FOOD_REFUSALS.STAY_NOT_FOUND);
    if (stay.branchId !== branchId) {
      throw errors.conflict('BAND_OTHER_PARK', bandOtherParkRefusal(stay.childName), { checkinId: stay.id });
    }
    if (stay.status !== 'in_park') {
      throw errors.conflict('BAND_NOT_IN_PARK', bandNotInParkRefusal(stay.childName), { checkinId: stay.id });
    }
    return stay;
  };

  let holder: CartBandFood['holder'] = null;
  // S2-20 E3 — an event child's kid band names their event check-in: the
  // holder of an order the counter took against it, food not authorised
  // (`mayOrderFood=false`) unless staff override, as the design's event band.
  const eventHolder = holderId && !byId.has(holderId) ? await eventHolderOf(db, operatorId, holderId) : null;
  if (holderId && eventHolder) {
    // A check-in the OTO App took back (`undone_at`) holds nobody in the park.
    const gone = !!eventHolder.checkedOutAt || !!eventHolder.undoneAt;
    const usable = eventHolder.branchId === branchId && !gone;
    if (mode === 'strict' && eventHolder.branchId !== branchId) {
      throw errors.conflict('BAND_OTHER_PARK', bandOtherParkRefusal(eventHolder.childName), { checkinId: eventHolder.id });
    }
    if (mode === 'strict' && gone) {
      throw errors.conflict('BAND_NOT_IN_PARK', bandNotInParkRefusal(eventHolder.childName), { checkinId: eventHolder.id });
    }
    if (usable) {
      holder = {
        checkinId: eventHolder.id,
        foodOverride: input.bandHolder?.foodOverride === true,
        mayOrderFood: false,
        childName: eventHolder.childName,
      };
    }
  } else if (holderId) {
    const stay = checkStay(holderId);
    if (stay) {
      holder = {
        checkinId: stay.id,
        foodOverride: input.bandHolder?.foodOverride === true,
        mayOrderFood: stay.mayOrderFood,
        childName: stay.childName,
      };
    }
  }

  const prepaid: CartBandFood['prepaid'] = new Map();
  const wanted = new Map<string, number>();
  for (const line of prepaidLines) {
    const checkinId = line.prepaid!.checkinId;
    if (mode === 'file') {
      const stay = checkStay(checkinId);
      prepaid.set(line.id, {
        checkinId,
        matched: stay !== null,
        ...(stay?.status === 'out' ? { settledAtPickup: true } : {}),
      });
      continue;
    }
    if (checkinId !== holderId) {
      throw errors.conflict('PREPAID_NEEDS_BAND', BAND_FOOD_REFUSALS.PREPAID_NEEDS_BAND, { cartLineId: line.id });
    }
    const stay = checkStay(checkinId)!;
    const items = stay.foodProvision?.mode === 'prepaid_items' ? (stay.foodProvision.items ?? []) : [];
    const name = productName(line.productId);
    if (!items.some((it) => it.menuItemId === line.productId)) {
      throw errors.conflict('PREPAID_NOT_ENTITLED', prepaidNotEntitledRefusal(name, stay.childName), {
        cartLineId: line.id,
        productId: line.productId,
      });
    }
    if ((line.modifiers ?? []).some((m) => m.optionIds.length > 0)) {
      throw errors.badRequest(BAND_FOOD_REFUSALS.PREPAID_NO_OPTIONS, { cartLineId: line.id });
    }
    const key = `${checkinId}|${line.productId}`;
    const total = (wanted.get(key) ?? 0) + line.quantity;
    wanted.set(key, total);
    const remaining = prepaidRemainingOf(items.map(entitlementOf), line.productId);
    const onOpen = held.get(key) ?? { qty: 0, saleIds: [] };
    const left = Math.max(0, remaining - onOpen.qty);
    if (total > left) {
      const message =
        total <= remaining && onOpen.qty > 0
          ? prepaidHeldRefusal(name, stay.childName)
          : prepaidUsedUpRefusal(name, stay.childName, left);
      throw errors.conflict('PREPAID_USED_UP', message, {
        cartLineId: line.id,
        productId: line.productId,
        remaining: left,
        heldOnOpenOrders: onOpen.qty,
        openSaleIds: onOpen.saleIds,
      });
    }
    prepaid.set(line.id, { checkinId, matched: true });
  }
  return { holder, prepaid };
}

function entitlementOf(it: StoredItem): { menuItemId: string; qty: number; redeemedQty: number } {
  return { menuItemId: it.menuItemId, qty: it.qty, redeemedQty: it.redeemedQty ?? 0 };
}

// --- What a box handed over offline (SCRUM-498) ----------------------------------------

/**
 * A box completed this sale offline: one of its `sale.finalised` facts for
 * the sale was filed (the `sale.offline_replay` row that fact wrote names it).
 * A box queues that fact only for a sale it closed, its paper printed and its
 * food handed over, so this — not the sale's origin — is the record that its
 * prepaid lines left the counter. `boxId` narrows it to one box.
 */
export function boxCompletedSaleCondition(saleIdText: SQL, boxId?: string): SQL {
  return sql`exists (
    select 1 from ${auditLog}
    join ${syncEvent} on ${syncEvent.eventId} = ${auditLog.sourceEventId}
    where ${auditLog.entityType} = 'sale'
      and ${auditLog.entityId} = ${saleIdText}
      and ${auditLog.action} = 'sale.offline_replay'
      and ${syncEvent.type} = 'sale.finalised'
      ${boxId ? sql`and ${syncEvent.boxId} = ${boxId}` : sql``}
  )`;
}

/** Whether a box completed this sale offline (`boxCompletedSaleCondition`). */
export async function boxCompletedSale(db: Exec, saleId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sale.id })
    .from(sale)
    .where(and(eq(sale.id, saleId), boxCompletedSaleCondition(sql`${sale.id}::text`)))
    .limit(1);
  return !!row;
}

/**
 * THE PREPAID UNITS ONE BOX HAS SERVED THAT THE PLATFORM HAS FILED, per stay
 * and menu item: every prepaid line of a sale that box completed offline, at
 * the quantity the box served (`orderedQty` when the line was set aside), so
 * the box's own all-days count and this agree. The box's `checkin` copy
 * carries it; the box counts what is left as the copy less what it served and
 * this does not yet hold.
 */
export async function boxPrepaidFiled(
  db: Exec,
  operatorId: string,
  branchId: string,
  boxId: string,
  checkinIds: readonly string[],
): Promise<Map<string, Array<{ menuItemId: string; qty: number }>>> {
  const out = new Map<string, Array<{ menuItemId: string; qty: number }>>();
  if (checkinIds.length === 0) return out;
  const stayOf = sql<string>`(${saleLine.payload} -> 'prepaid' ->> 'checkinId')`;
  const itemOf = sql<string>`coalesce(${saleLine.payload} -> 'prepaid' ->> 'menuItemId', ${saleLine.productId}::text)`;
  const rows = await db
    .select({
      checkinId: stayOf,
      menuItemId: itemOf,
      qty: sql<number>`coalesce(sum(coalesce((${saleLine.payload} -> 'prepaid' ->> 'orderedQty')::int, ${saleLine.quantity})), 0)`,
    })
    .from(saleLine)
    .innerJoin(sale, eq(sale.id, saleLine.saleId))
    .where(
      and(
        eq(sale.operatorId, operatorId),
        eq(sale.branchId, branchId),
        eq(saleLine.kind, 'fnb_item'),
        inArray(stayOf, [...checkinIds]),
        boxCompletedSaleCondition(sql`${sale.id}::text`, boxId),
      ),
    )
    .groupBy(stayOf, itemOf);
  for (const row of rows) {
    const qty = Number(row.qty);
    if (!row.checkinId || !row.menuItemId || qty <= 0) continue;
    out.set(row.checkinId, [...(out.get(row.checkinId) ?? []), { menuItemId: row.menuItemId, qty }]);
  }
  return out;
}

// --- The confirmation -----------------------------------------------------------------

/** What a line's payload says about prepaid food and the band holder. */
interface BandFoodPayload {
  prepaid?: {
    checkinId: string;
    menuItemId: string;
    unmatched?: boolean;
    settledAtPickup?: boolean;
    /** Set aside at a close: fewer were left for the child than the line serves. */
    usedUp?: boolean;
    orderedQty?: number;
  };
  holder?: { checkinId: string };
}

/**
 * A prepaid line a close set aside unserved — settled at pickup, or beyond
 * what was left for the child — so nothing prints, is taken from stock or is
 * redeemed for it.
 */
export function isPrepaidSetAside(line: { kind?: string; payload: unknown }): boolean {
  if (line.kind !== undefined && line.kind !== 'fnb_item') return false;
  const p = (line.payload as BandFoodPayload | null)?.prepaid;
  return p?.settledAtPickup === true || p?.usedUp === true;
}

/**
 * A prepaid line whose stay was released before the order closed: the pickup
 * settled that food as unused (refunded or forfeited by the branch's policy),
 * so the line stays on the sale at ฿0 with nothing served — quantity 0, the
 * quantity ordered kept as `orderedQty` — and is never redeemed, printed or
 * taken from stock.
 */
export function isPrepaidSettledAtPickup(line: { kind?: string; payload: unknown }): boolean {
  if (line.kind !== undefined && line.kind !== 'fnb_item') return false;
  return (line.payload as BandFoodPayload | null)?.prepaid?.settledAtPickup === true;
}

/** The payload of a prepaid line that is not served: marked settled at pickup, with the quantity ordered. */
export function settledAtPickupPayload<T extends object>(payload: T | null | undefined, orderedQty: number): T {
  const p = (payload ?? {}) as T & BandFoodPayload;
  return {
    ...p,
    ...(p.prepaid ? { prepaid: { ...p.prepaid, settledAtPickup: true, orderedQty } } : {}),
  } as T;
}

export interface PrepaidRedemption {
  checkinId: string;
  saleLineId: string;
  menuItemId: string;
  qty: number;
  /** What was actually taken off — less than `qty` when fewer were left. */
  applied: number;
}

/**
 * How a close treats a prepaid line it cannot serve. `refuse`: a counter is
 * confirming the order now with no money taken for it yet, and is told before
 * anything is recorded (the child was collected while the order was open, or
 * the item was served since). `file`: money was taken already (an offline
 * replay, a paid QR settling on its own, a booking's redemption, a card
 * approved before the counter confirms) — the close stands; a line whose stay
 * was released is set aside unserved (the pickup settled it); at a counter's
 * close a line beyond what is left for the child is set aside unserved too
 * (`prepaidUsedUpAtClose`); on a box's replay, where the food was handed over
 * offline, such a line takes off what is left and no more, the audit row
 * saying what could not.
 */
export type PrepaidGate = 'refuse' | 'file';

type PrepaidLine = { id: string; productId: string | null; quantity: number; payload: unknown };

async function prepaidLinesOfSale(
  tx: Tx,
  saleId: string,
): Promise<{ byStay: Map<string, PrepaidLine[]>; unmatched: PrepaidLine[] }> {
  const lines = await tx
    .select({ id: saleLine.id, productId: saleLine.productId, quantity: saleLine.quantity, payload: saleLine.payload })
    .from(saleLine)
    .where(and(eq(saleLine.saleId, saleId), eq(saleLine.kind, 'fnb_item')));
  const byStay = new Map<string, PrepaidLine[]>();
  const unmatched: PrepaidLine[] = [];
  for (const line of lines) {
    const p = (line.payload as BandFoodPayload | null)?.prepaid;
    if (!p || p.settledAtPickup || p.usedUp || line.quantity <= 0) continue;
    if (p.unmatched) {
      unmatched.push(line);
      continue;
    }
    byStay.set(p.checkinId, [...(byStay.get(p.checkinId) ?? []), line]);
  }
  return { byStay, unmatched };
}

function menuItemOf(line: PrepaidLine): string {
  return (line.payload as BandFoodPayload).prepaid!.menuItemId ?? line.productId ?? '';
}

/** The stay a sale's prepaid lines are served from, locked: this operator's and the sale's park only. */
async function lockStayOfSale(tx: Tx, saleRow: SaleRow, checkinId: string): Promise<CheckinRow | null> {
  const [stay] = await tx
    .select()
    .from(checkin)
    .where(
      and(eq(checkin.id, checkinId), eq(checkin.operatorId, saleRow.operatorId), eq(checkin.branchId, saleRow.branchId)),
    )
    .for('update')
    .limit(1);
  return stay ?? null;
}

async function alreadyServed(tx: Tx, stayId: string, saleId: string): Promise<boolean> {
  const [served] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'checkin.prepaid_redeem'),
        eq(auditLog.entityType, 'checkin'),
        eq(auditLog.entityId, stayId),
        sql`${auditLog.after}->>'saleId' = ${saleId}`,
      ),
    )
    .limit(1);
  return !!served;
}

/**
 * Refuse, in the counter's words, a prepaid line this stay can no longer
 * serve: the stay is no longer in the park (its prepaid food was settled at
 * pickup), or fewer are left than the order serves.
 */
function assertServable(stay: CheckinRow, lines: readonly PrepaidLine[]): void {
  if (stay.status !== 'in_park') {
    throw errors.conflict('PREPAID_STAY_CLOSED', prepaidStayClosedRefusal(stay.childName), { checkinId: stay.id });
  }
  const stored = stay.foodProvision?.items ?? [];
  let items = stored.map(entitlementOf);
  for (const line of lines) {
    const menuItemId = menuItemOf(line);
    const left = prepaidRemainingOf(items, menuItemId);
    const result = redeemPrepaid(items, menuItemId, line.quantity);
    if (result.applied < line.quantity) {
      const name = stored.find((it) => it.menuItemId === menuItemId)?.menuItemName ?? 'That item';
      throw errors.conflict('PREPAID_USED_UP', prepaidUsedUpRefusal(name, stay.childName, left), {
        checkinId: stay.id,
        saleLineId: line.id,
        productId: menuItemId,
        remaining: left,
      });
    }
    items = result.items;
  }
}

/**
 * Before a counter takes money for an order with prepaid lines: lock the
 * stays they are served from and refuse when one cannot be served any more.
 * The locks are held to the end of the transaction, so the redemption that
 * follows in it reads what this read.
 */
export async function assertSalePrepaidServable(tx: Tx, saleRow: SaleRow): Promise<void> {
  const { byStay } = await prepaidLinesOfSale(tx, saleRow.id);
  for (const checkinId of [...byStay.keys()].sort()) {
    const stay = await lockStayOfSale(tx, saleRow, checkinId);
    if (!stay) throw new AppError(404, 'BAND_STAY_NOT_FOUND', BAND_FOOD_REFUSALS.STAY_NOT_FOUND);
    if (await alreadyServed(tx, stay.id, saleRow.id)) continue;
    assertServable(stay, byStay.get(checkinId)!);
  }
}

/** A prepaid line a close sets aside: its stay was released while the order was open. */
export interface SettledPrepaidLine {
  saleLineId: string;
  checkinId: string;
  menuItemId: string;
  qty: number;
}

/**
 * Before a close that cannot be refused (the `file` gate: a paid QR settling,
 * a box's replay, a booking's redemption, a counter confirming after money was
 * taken): lock the stays the sale's prepaid lines are served from, and name the
 * lines whose stay has been released. The locks are held to the end of the
 * transaction, so nothing changes between this read and the close that sets
 * the lines aside (`setAsideSettledPrepaid`).
 */
export async function prepaidSettledAtPickup(tx: Tx, saleRow: SaleRow): Promise<SettledPrepaidLine[]> {
  const { byStay } = await prepaidLinesOfSale(tx, saleRow.id);
  const out: SettledPrepaidLine[] = [];
  for (const checkinId of [...byStay.keys()].sort()) {
    const stay = await lockStayOfSale(tx, saleRow, checkinId);
    if (!stay || stay.status !== 'out') continue;
    if (await alreadyServed(tx, stay.id, saleRow.id)) continue;
    for (const line of byStay.get(checkinId)!) {
      out.push({ saleLineId: line.id, checkinId, menuItemId: menuItemOf(line), qty: line.quantity });
    }
  }
  return out;
}

/**
 * Set aside, on the sale that is closing (still open, so its lines can be
 * written), the prepaid lines `prepaidSettledAtPickup` named: each is marked
 * settled at pickup and its quantity goes to 0 (nothing served, so nothing for
 * the stock decrement, the prep ticket or a redemption to read), then the
 * audit row names them. The line's money is ฿0 either way.
 */
export async function setAsideSettledPrepaid(
  tx: Tx,
  saleRow: SaleRow,
  lines: readonly SettledPrepaidLine[],
  actor: { accountId: string | null; requestId?: string | null; actionId?: string | null },
  receiptNumber: string | null,
): Promise<void> {
  if (lines.length === 0) return;
  const ids = lines.map((l) => l.saleLineId);
  const rows = await tx
    .select({ id: saleLine.id, quantity: saleLine.quantity, payload: saleLine.payload })
    .from(saleLine)
    .where(and(eq(saleLine.saleId, saleRow.id), inArray(saleLine.id, ids)));
  for (const row of rows) {
    await tx
      .update(saleLine)
      .set({ quantity: 0, payload: settledAtPickupPayload(row.payload as Record<string, unknown> | null, row.quantity) })
      .where(eq(saleLine.id, row.id));
  }
  await auditSettledAtPickup(tx, { ...saleRow, receiptNumber }, actor);
}

/** A prepaid line a close sets aside: fewer are left for the child than it serves. */
export interface UsedUpPrepaidLine {
  saleLineId: string;
  checkinId: string;
  menuItemId: string;
  qty: number;
  /** What was left for the child when the line was read. */
  remaining: number;
}

/**
 * Before a counter's close that cannot be refused (money already taken: a card
 * approved before the confirm, a paid QR settling, a booking's redemption):
 * name the prepaid lines beyond what is left for the child, read in line order
 * against the stay's entitlements. Such a line is set aside unserved
 * (`setAsideUsedUpPrepaid`), never served short. Stays released meanwhile are
 * `prepaidSettledAtPickup`'s; a box's replay does not call this — the food was
 * already handed over offline, and its redemption files the shortfall.
 */
export async function prepaidUsedUpAtClose(tx: Tx, saleRow: SaleRow): Promise<UsedUpPrepaidLine[]> {
  const { byStay } = await prepaidLinesOfSale(tx, saleRow.id);
  const out: UsedUpPrepaidLine[] = [];
  for (const checkinId of [...byStay.keys()].sort()) {
    const stay = await lockStayOfSale(tx, saleRow, checkinId);
    if (!stay || stay.status === 'out') continue;
    if (await alreadyServed(tx, stay.id, saleRow.id)) continue;
    let items = (stay.foodProvision?.items ?? []).map(entitlementOf);
    for (const line of byStay.get(checkinId)!) {
      const menuItemId = menuItemOf(line);
      const remaining = prepaidRemainingOf(items, menuItemId);
      if (remaining < line.quantity) {
        out.push({ saleLineId: line.id, checkinId, menuItemId, qty: line.quantity, remaining });
        continue;
      }
      items = redeemPrepaid(items, menuItemId, line.quantity).items;
    }
  }
  return out;
}

/**
 * Set aside, on the sale that is closing (still open, so its lines can be
 * written), the prepaid lines `prepaidUsedUpAtClose` named: quantity 0 with the
 * quantity ordered kept as `orderedQty`, marked `usedUp`, and one audit row
 * naming them. The line's money is ฿0 either way.
 */
export async function setAsideUsedUpPrepaid(
  tx: Tx,
  saleRow: SaleRow,
  lines: readonly UsedUpPrepaidLine[],
  actor: { accountId: string | null; requestId?: string | null; actionId?: string | null },
  receiptNumber: string | null,
): Promise<void> {
  if (lines.length === 0) return;
  const rows = await tx
    .select({ id: saleLine.id, quantity: saleLine.quantity, payload: saleLine.payload })
    .from(saleLine)
    .where(and(eq(saleLine.saleId, saleRow.id), inArray(saleLine.id, lines.map((l) => l.saleLineId))));
  for (const row of rows) {
    const p = (row.payload ?? {}) as Record<string, unknown> & BandFoodPayload;
    await tx
      .update(saleLine)
      .set({
        quantity: 0,
        payload: { ...p, ...(p.prepaid ? { prepaid: { ...p.prepaid, usedUp: true, orderedQty: row.quantity } } : {}) },
      })
      .where(eq(saleLine.id, row.id));
  }
  const stays = await tx
    .select({ id: checkin.id, childName: checkin.childName, status: checkin.status })
    .from(checkin)
    .where(and(eq(checkin.operatorId, saleRow.operatorId), inArray(checkin.id, [...new Set(lines.map((l) => l.checkinId))])));
  const byId = new Map(stays.map((s) => [s.id, s]));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: saleRow.operatorId,
    branchId: saleRow.branchId,
    action: 'sale.prepaid_used_up_set_aside',
    entityType: 'sale',
    entityId: saleRow.id,
    requestId: actor.requestId ?? null,
    actionId: actor.actionId ?? null,
    after: {
      receiptNumber,
      stationId: saleRow.stationId,
      // Not served: fewer were left for the child than these lines serve.
      served: false,
      lines: lines.map((l) => {
        const stay = byId.get(l.checkinId);
        return {
          saleLineId: l.saleLineId,
          checkinId: l.checkinId,
          childName: stay?.childName ?? null,
          stayStatus: stay?.status ?? null,
          menuItemId: l.menuItemId,
          orderedQty: l.qty,
          remaining: l.remaining,
          servedQty: 0,
          usedUp: true,
        };
      }),
    },
  });
}

/**
 * The audit row for a sale's prepaid lines settled at pickup: which lines,
 * whose stay, which item and how many — read from the lines as written, so a
 * commit that wrote them marked (a box's replay) and a close that set them
 * aside record the same row.
 */
export async function auditSettledAtPickup(
  tx: Tx,
  saleRow: Pick<SaleRow, 'id' | 'operatorId' | 'branchId' | 'stationId' | 'receiptNumber'>,
  actor: { accountId: string | null; requestId?: string | null; actionId?: string | null },
): Promise<void> {
  const rows = await tx
    .select({ id: saleLine.id, kind: saleLine.kind, quantity: saleLine.quantity, payload: saleLine.payload })
    .from(saleLine)
    .where(and(eq(saleLine.saleId, saleRow.id), eq(saleLine.kind, 'fnb_item')));
  const settled = rows.filter((r) => isPrepaidSettledAtPickup(r));
  if (settled.length === 0) return;
  const stayIds = [...new Set(settled.map((r) => (r.payload as BandFoodPayload).prepaid!.checkinId))];
  const stays = await tx
    .select({ id: checkin.id, childName: checkin.childName, status: checkin.status })
    .from(checkin)
    .where(and(eq(checkin.operatorId, saleRow.operatorId), inArray(checkin.id, stayIds)));
  const byId = new Map(stays.map((s) => [s.id, s]));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: saleRow.operatorId,
    branchId: saleRow.branchId,
    action: 'sale.prepaid_settled_at_pickup',
    entityType: 'sale',
    entityId: saleRow.id,
    requestId: actor.requestId ?? null,
    actionId: actor.actionId ?? null,
    after: {
      receiptNumber: saleRow.receiptNumber,
      stationId: saleRow.stationId,
      // Not served: the pickup settled this food as unused, and that settlement stands.
      served: false,
      lines: settled.map((r) => {
        const p = (r.payload as BandFoodPayload).prepaid!;
        const stay = byId.get(p.checkinId);
        return {
          saleLineId: r.id,
          checkinId: p.checkinId,
          childName: stay?.childName ?? null,
          stayStatus: stay?.status ?? null,
          menuItemId: p.menuItemId,
          orderedQty: p.orderedQty ?? r.quantity,
          servedQty: 0,
          settledAtPickup: true,
        };
      }),
    },
  });
}

/**
 * SERVE THE PREPAID LINES OF A SALE THAT HAS JUST CLOSED — the design's
 * `redeemPrepaidItem` for each prepaid line, at confirmation (`OrderStation`'s
 * `handleConfirmPayment`). Called inside the transaction that moves the sale to
 * `finalised`, at both points that do (`finaliseSale`, and `commitSale`'s ฿0
 * close), so a prepaid-only order closes through the no-tender path and is
 * served in the same commit.
 *
 * Each stay is locked (this operator's, at the sale's park), its entitlements
 * raised, and one audit row written per stay naming the sale. A sale already
 * served for a stay (its audit row is there) is not served twice. Under
 * `refuse` a line that cannot be served refuses the close (`assertServable`).
 * Under `file` `redeemedQty` never passes `qty`: a line that asks for more
 * than is left takes what is left, and the shortfall is on the audit row; a
 * line naming no stay of this park is recorded on the sale and serves nothing;
 * a line settled at pickup (its stay released while the order was open) is
 * not read here at all — the close set it aside first.
 */
export async function redeemSalePrepaid(
  tx: Tx,
  saleRow: SaleRow,
  actor: { accountId: string | null; requestId?: string | null; actionId?: string | null },
  now: Date,
  gate: PrepaidGate = 'file',
): Promise<PrepaidRedemption[]> {
  const { byStay, unmatched } = await prepaidLinesOfSale(tx, saleRow.id);
  if (byStay.size === 0 && unmatched.length === 0) return [];

  const out: PrepaidRedemption[] = [];
  // One order of locks for every caller, so two closes never wait on each other crosswise.
  for (const checkinId of [...byStay.keys()].sort()) {
    const lines = byStay.get(checkinId)!;
    const stay = await lockStayOfSale(tx, saleRow, checkinId);
    if (!stay) {
      if (gate === 'refuse') throw new AppError(404, 'BAND_STAY_NOT_FOUND', BAND_FOOD_REFUSALS.STAY_NOT_FOUND);
      unmatched.push(...lines);
      continue;
    }
    if (await alreadyServed(tx, stay.id, saleRow.id)) continue;
    if (gate === 'refuse') assertServable(stay, lines);
    const fp = stay.foodProvision;
    const before = (fp?.items ?? []).map((it) => ({ ...it, redeemedQty: it.redeemedQty ?? 0 }));
    let items = before;
    const done: PrepaidRedemption[] = [];
    for (const line of lines) {
      const menuItemId = menuItemOf(line);
      const result = redeemPrepaid(items, menuItemId, line.quantity);
      items = result.items;
      done.push({ checkinId, saleLineId: line.id, menuItemId, qty: line.quantity, applied: result.applied });
    }
    if (fp) {
      await tx
        .update(checkin)
        .set({ foodProvision: { ...fp, items }, updatedAt: now })
        .where(eq(checkin.id, stay.id));
    }
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: saleRow.operatorId,
      branchId: stay.branchId,
      action: 'checkin.prepaid_redeem',
      entityType: 'checkin',
      entityId: stay.id,
      requestId: actor.requestId ?? null,
      actionId: actor.actionId ?? null,
      before: { items: before },
      after: {
        saleId: saleRow.id,
        receiptNumber: saleRow.receiptNumber,
        stationId: saleRow.stationId,
        redeemed: done,
        shortfall: done.some((d) => d.applied < d.qty),
        // The stay's status at the close. A released stay's lines never reach here: they are set aside.
        stayStatus: stay.status,
        items,
      },
    });
    out.push(...done);
  }

  if (unmatched.length > 0) {
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: saleRow.operatorId,
      branchId: saleRow.branchId,
      action: 'sale.prepaid_unmatched',
      entityType: 'sale',
      entityId: saleRow.id,
      requestId: actor.requestId ?? null,
      actionId: actor.actionId ?? null,
      after: {
        receiptNumber: saleRow.receiptNumber,
        stationId: saleRow.stationId,
        lines: unmatched.map((line) => ({
          saleLineId: line.id,
          checkinId: (line.payload as BandFoodPayload).prepaid!.checkinId,
          menuItemId: menuItemOf(line),
          qty: line.quantity,
        })),
      },
    });
  }
  return out;
}

// --- The prep ticket ------------------------------------------------------------------

/**
 * The band holder of a sale's F&B order, for the prep ticket: the child's name
 * and their own allergy line (the stay's snapshot, else the saved record, and
 * the saved medical notes). Null on an order taken against no band, or one
 * naming no stay of the sale's operator and park.
 */
export async function bandHolderOfSale(
  db: Exec,
  saleRow: { operatorId: string; branchId: string },
  lines: readonly { kind: string; payload: unknown }[],
): Promise<{ name: string; allergiesMedical: string | null } | null> {
  const named = lines
    .filter((l) => l.kind === 'fnb_item')
    .map((l) => {
      const p = l.payload as BandFoodPayload | null;
      return p?.holder?.checkinId ?? (p?.prepaid && !p.prepaid.unmatched ? p.prepaid.checkinId : undefined);
    })
    .find((id): id is string => !!id);
  if (!named) return null;
  // Only a stay of the sale's own operator and park is ever printed.
  const [stay] = await db
    .select()
    .from(checkin)
    .where(and(eq(checkin.id, named), eq(checkin.operatorId, saleRow.operatorId), eq(checkin.branchId, saleRow.branchId)))
    .limit(1);
  if (!stay) {
    // S2-20 E3 — an order taken against an event child's band prints their
    // own allergy line, frozen on the check-in when the band printed.
    const event = await eventHolderOf(db, saleRow.operatorId, named);
    if (!event || event.branchId !== saleRow.branchId) return null;
    return { name: event.childName, allergiesMedical: event.allergy?.trim() || null };
  }
  const view = await bandStayViewOf(db, stay);
  return { name: view.childName, allergiesMedical: view.allergiesMedical };
}
