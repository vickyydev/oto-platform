import { and, eq, inArray } from 'drizzle-orm';
import { paymentAttempt, product, sale } from '@oto/db';
import { WALLET_SPENT_FACT, formatTHB } from '@oto/shared';
import type { Exec } from './tx';

/**
 * SCRUM-486 — A PAID SALE ON A REPLACED JOURNAL EPOCH.
 *
 * Every event sealed on an epoch the platform has replaced is set aside as
 * `epoch_regressed` (`pushEvents` in `sync.ts`): quarantined with an anomaly
 * and an alert, never applied. Replay cannot apply it either — the epoch is
 * checked again — so a person settles it by hand and then discards the row.
 * For most facts that is a nuisance. For a fact that CLOSES A SALE it is money
 * that is not in the ledger, and — for the sale itself — goods that left the
 * shelf at the counter but were never taken off the platform's stock level,
 * which the `stock_oversold` check never sees because it runs only on an
 * applied sale.
 *
 * So the quarantine row for such a fact SAYS SO, in words a person at the
 * Failures tab can act on: which sale, how much money and how it was taken,
 * and which goods, by name and quantity, are still counted on the shelf. The
 * row keeps the whole envelope as well; this is the reading of it.
 *
 * Read off the envelope as it arrived, without its handler's schema: an event
 * set aside for its epoch is never parsed, and a note that refused to be
 * written because a field was odd would hide the one thing it is for. Every
 * field is read defensively and a fact that names no sale gets no note.
 */

/** The facts that carry a sale's money: the sale, a later tender, a wallet's spend. */
const PAID_FACTS: ReadonlySet<string> = new Set(['sale.finalised', 'payment.recorded', WALLET_SPENT_FACT]);

export interface RegressedUnit {
  /** What the till called it: a product's name, an add-on's, the socks' label. Not `name`, which the anomaly's scrubber redacts. */
  item: string;
  quantity: number;
  productId?: string;
  addOnId?: string;
  variantLabel?: string;
}

export interface RegressedPaidFact {
  /** Appended to the quarantine row's message. */
  message: string;
  /** Carried on the anomaly, and counted by the alert. */
  detail: {
    type: string;
    saleId: string;
    receiptNumber: string | null;
    takenSatang: number;
    tenders: Array<{ methodCode: string; amountSatang: number }>;
    units: RegressedUnit[];
    /**
     * The ledger already holds it: the sale is closed (for `sale.finalised`)
     * and every tender it carries is a recorded payment. A fact the platform
     * applied and the box re-sent across a reset because the answer was lost.
     * Nothing to record by hand, so not counted as money out of the ledger.
     */
    inLedger: boolean;
  };
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tenderOf(raw: unknown): { methodCode: string; amountSatang: number } | null {
  const t = obj(raw);
  const amountSatang = count(t?.amountSatang);
  if (!t || amountSatang === 0) return null;
  return { methodCode: str(t.methodCode) ?? str(t.kind) ?? 'tender', amountSatang };
}

/** The goods a `sale.finalised` cart sold, as the till rang them up; tickets are not stock. */
function unitsOf(cart: Record<string, unknown> | null): RegressedUnit[] {
  if (!cart) return [];
  const units: RegressedUnit[] = [];
  for (const raw of arr(cart.items)) {
    const item = obj(raw);
    const productId = str(item?.productId);
    const quantity = count(item?.quantity);
    if (!productId || quantity === 0) continue;
    const variantLabel = str(obj(item?.variant)?.variantLabel);
    units.push({ item: productId, productId, quantity, ...(variantLabel ? { variantLabel } : {}) });
  }
  const socksLabel = str(obj(cart.socks)?.label) ?? 'Socks';
  let socks = 0;
  for (const raw of arr(cart.lines)) {
    const line = obj(raw);
    socks += count(line?.socks);
    for (const rawAddOn of arr(line?.addOns)) {
      const addOn = obj(rawAddOn);
      const addOnId = str(addOn?.id);
      const quantity = count(addOn?.quantity);
      if (!addOnId || quantity === 0) continue;
      const name = str(addOn?.name) ?? addOnId;
      const sizes = arr(addOn?.variantBreakdown)
        .map(obj)
        .filter((s): s is Record<string, unknown> => s !== null && count(s.quantity) > 0);
      if (sizes.length > 0) {
        for (const size of sizes) {
          const variantLabel = str(size.variantLabel);
          units.push({ item: name, addOnId, quantity: count(size.quantity), ...(variantLabel ? { variantLabel } : {}) });
        }
      } else {
        units.push({ item: name, addOnId, quantity });
      }
    }
  }
  if (socks > 0) units.push({ item: socksLabel, quantity: socks });
  return units;
}

/** Names for the products a cart names by id, from this operator's catalogue. */
async function nameProducts(db: Exec, operatorId: string, units: RegressedUnit[]): Promise<void> {
  const ids = [...new Set(units.map((u) => u.productId).filter((id): id is string => !!id && UUID.test(id)))];
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: product.id, name: product.name })
    .from(product)
    .where(and(eq(product.operatorId, operatorId), inArray(product.id, ids)));
  const names = new Map(rows.map((r) => [r.id, r.name]));
  for (const unit of units) {
    if (unit.productId) unit.item = names.get(unit.productId) ?? `product ${unit.productId}`;
  }
}

function unitText(u: RegressedUnit): string {
  return `${u.item}${u.variantLabel ? ` (${u.variantLabel})` : ''} × ${u.quantity}`;
}

/** The sale statuses that mean the ledger closed it: what `sale.finalised` writes, or what became of it since. */
const CLOSED_SALE: ReadonlySet<string> = new Set(['finalised', 'refunded', 'voided']);

/** The press of a tender, which is what `payment_attempt_action_unique` keys the payment on. */
const pressOf = (raw: unknown): string | null => str(obj(raw)?.actionId);

/**
 * SCRUM-486 — whether the ledger already holds this fact's sale and money.
 *
 * A fact the platform applied whose answer was lost comes back from the box,
 * and if a reset ran in between it comes back on the replaced epoch. The push
 * answers it `duplicate` when its own `sync_event` row is still there
 * (`appliedOnItsOwnEpoch` in `sync.ts`); this is the reading for when that row
 * is gone (swept) or the fact came back under another envelope. Asked of the
 * ledger itself — the sale row, and a payment for every tender by its press —
 * so that a row telling staff to record a sale by hand is never written about
 * one the ledger holds, which they would then record twice.
 */
async function heldInLedger(
  db: Exec,
  operatorId: string,
  type: string,
  saleId: string,
  presses: Array<string | null>,
): Promise<boolean> {
  // A tender with no press cannot be found in the ledger, so it cannot be shown to be there.
  if (presses.some((p) => p === null)) return false;
  if (type === 'sale.finalised') {
    if (!UUID.test(saleId)) return false;
    const [row] = await db
      .select({ status: sale.status })
      .from(sale)
      .where(and(eq(sale.id, saleId), eq(sale.operatorId, operatorId)))
      .limit(1);
    if (!row || !CLOSED_SALE.has(row.status)) return false;
  } else if (presses.length === 0) {
    // A later tender or a spend with no press to look it up by cannot be shown to be there.
    return false;
  }
  const wanted = [...new Set(presses.filter((p): p is string => p !== null))];
  if (wanted.length === 0) return true;
  const rows = await db
    .select({ actionId: paymentAttempt.actionId })
    .from(paymentAttempt)
    .where(and(eq(paymentAttempt.operatorId, operatorId), inArray(paymentAttempt.actionId, wanted)));
  const found = new Set(rows.map((r) => r.actionId));
  return wanted.every((id) => found.has(id));
}

/**
 * What a paid fact set aside for its epoch means, or null for a fact that
 * carries no sale's money. `envelope` is the event exactly as it arrived.
 */
export async function describeRegressedPaidFact(
  db: Exec,
  operatorId: string,
  type: string | null,
  envelope: unknown,
): Promise<RegressedPaidFact | null> {
  if (!type || !PAID_FACTS.has(type)) return null;
  const payload = obj(obj(envelope)?.payload);
  const saleId = str(payload?.saleId);
  if (!payload || !saleId) return null;

  const receiptNumber = str(obj(payload.receipt)?.number);
  let tenders: Array<{ methodCode: string; amountSatang: number }> = [];
  let units: RegressedUnit[] = [];
  /** Each tender's press, for the ledger lookup; null where the envelope names none. */
  let presses: Array<string | null> = [];
  if (type === 'sale.finalised') {
    const taken = arr(payload.tenders).filter((t) => tenderOf(t) !== null);
    tenders = taken.map(tenderOf).filter((t): t is NonNullable<typeof t> => t !== null);
    presses = taken.map(pressOf);
    units = unitsOf(obj(payload.cart));
    await nameProducts(db, operatorId, units);
  } else if (type === 'payment.recorded') {
    const tender = tenderOf(payload.tender);
    tenders = tender ? [tender] : [];
    presses = [pressOf(payload.tender)];
  } else {
    const amountSatang = count(payload.amountSatang);
    tenders = amountSatang > 0 ? [{ methodCode: 'wallet', amountSatang }] : [];
    // The spend is filed as a payment under its own press (`applyWalletSpent`).
    presses = [str(payload.actionId)];
  }
  const takenSatang = tenders.reduce((sum, t) => sum + t.amountSatang, 0);

  const saleName = `sale ${saleId}${receiptNumber ? ` (receipt ${receiptNumber})` : ''}`;
  const money =
    tenders.length > 0
      ? `${formatTHB(takenSatang)} taken (${tenders.map((t) => `${t.methodCode} ${formatTHB(t.amountSatang)}`).join(', ')})`
      : 'no money taken (a ฿0 sale)';

  if (await heldInLedger(db, operatorId, type, saleId, presses)) {
    const what =
      type === 'sale.finalised' ? 'the sale and its money are' : type === 'payment.recorded' ? 'that tender is' : 'that spend is';
    return {
      message:
        `Already in the ledger: ${saleName}, ${money} — ${what} recorded, so there is nothing to record by hand and nothing to take off the stock level. ` +
        'The box re-sent, on the journal epoch a reset replaced, a fact the platform had already applied. Discard this row.',
      detail: { type, saleId, receiptNumber, takenSatang, tenders, units, inLedger: true },
    };
  }

  const parts = [
    type === 'sale.finalised'
      ? `PAID SALE set aside: ${saleName}, ${money}. The sale and its money are NOT in the ledger.`
      : type === 'payment.recorded'
        ? `PAID TENDER set aside: a later tender for ${saleName}, ${money}. That money is NOT in the ledger; if it was the tender that closed the sale, the sale's goods were not taken off the stock level either.`
        : `WALLET SPEND set aside: for ${saleName}, ${money}. The spend is NOT in the ledger and the wallet still holds that credit; if it closed the sale, the sale's goods were not taken off the stock level either.`,
  ];
  if (units.length > 0) {
    parts.push(
      `Its goods left the shelf at the counter but were NOT taken off the platform's stock level: ${units.map(unitText).join(', ')}. ` +
        'Take them off the stock level by hand (a stock adjustment naming this sale); the stock_oversold check has not seen them, because it runs only on a sale that was applied.',
    );
  }
  parts.push(
    'Replay will refuse it again (its journal epoch was replaced): record it by hand, then discard this row with a note saying where it was recorded.',
  );
  return {
    message: parts.join(' '),
    detail: { type, saleId, receiptNumber, takenSatang, tenders, units, inLedger: false },
  };
}
