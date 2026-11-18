import { priceCart } from "./sale";
import { resolveItemTaxCategories } from "./menu";
import { itemTaxCategory, type TaxableCategory } from "@oto/shared";
import type { Exec } from "./tx";
import { and, eq, isNull, or } from 'drizzle-orm';
import { branch, partyAdditionalBill, partyCharge, partySettlement, product, type Db } from '@oto/db';
import { deriveId, type BeoAdditionalChargesBody, type BeoBilledLine } from '@oto/shared';
import { errors } from '../lib/errors';
import { getEventAtBranches } from './otoapp-events';
import { seamRead } from './parties';
import { lockParty, partyLedgersOf, type PartyLedgers } from './party-tab';
import { billForNewCharge } from './party-additional-bills';
import { audit } from './audit';
import { withTx, type OpContext } from './tx';

type Source = { lineId: string; quantity: number; unitSatang: number; productCode: string | null; area: "food" | "bar"; name: string };
const sources = (items: unknown): Source[] => Array.isArray(items) ? items.flatMap((item: { beo?: Source }) => item?.beo ? [item.beo] : []) : [];

/** The BEO sources the additional bills of one main settlement hold, each with its bill. */
async function billedBeoSourcesOf(db: Exec, operatorId: string, eventId: string, mainSettlementId: string): Promise<{ billId: string | null; source: Source }[]> {
  const stored = await db.select({ items: partyCharge.items, billId: partyCharge.additionalBillId }).from(partyCharge).innerJoin(partyAdditionalBill, eq(partyAdditionalBill.id, partyCharge.additionalBillId)).where(and(eq(partyCharge.operatorId, operatorId), eq(partyCharge.otoappEventId, eventId), eq(partyAdditionalBill.mainSettlementId, mainSettlementId)));
  return stored.flatMap((row) => sources(row.items).map((source) => ({ billId: row.billId, source })));
}

/** The main receipt's count of each BEO line, as the settlement recorded it. */
async function settledBeoQuantitiesOf(db: Exec, mainSettlementId: string): Promise<Record<string, number>> {
  const [settlement] = await db.select({ plan: partySettlement.plan }).from(partySettlement).where(eq(partySettlement.id, mainSettlementId));
  return (settlement?.plan as { beoLineQuantities?: Record<string, number> } | null)?.beoLineQuantities ?? {};
}

/**
 * SCRUM-1002 ruling 3 (the owner, 18 November 2026: a billed and paid item can be neither reduced
 * nor removed). Each BEO line billed since the party was settled, read from the same records the
 * additional bill is made from: the main receipt's count at settlement (paid, the settlement being
 * settled) plus every additional bill's, and how many of those are paid. Before settlement, none.
 */
export async function beoBilledLinesOf(db: Exec, operatorId: string, eventId: string, ledger: PartyLedgers): Promise<BeoBilledLine[]> {
  const main = ledger.settlement;
  if (main?.state !== 'settled') return [];
  const paidBills = new Set((ledger.additionalBills ?? []).filter((bill) => bill.mainSettlementId === main.id && bill.state === 'paid').map((bill) => bill.id));
  const lines = new Map<string, { billed: number; paid: number }>();
  const add = (lineId: string, quantity: number, paid: boolean) => {
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const held = lines.get(lineId) ?? { billed: 0, paid: 0 };
    lines.set(lineId, { billed: held.billed + quantity, paid: held.paid + (paid ? quantity : 0) });
  };
  for (const [lineId, quantity] of Object.entries(await settledBeoQuantitiesOf(db, main.id))) add(lineId, Number(quantity), true);
  for (const { billId, source } of await billedBeoSourcesOf(db, operatorId, eventId, main.id)) add(source.lineId, source.quantity, !!billId && paidBills.has(billId));
  return [...lines].map(([lineId, held]) => ({ lineId, billedQuantity: held.billed, paidQuantity: held.paid }));
}
/** Same party-add-on engine path as settlement, preserving VAT/service and entered-price semantics. */
export async function priceBeoAddition(db: Exec, operatorId: string, branchId: string, eventId: string, line: BeoAdditionalChargesBody['lines'][number], quantity: number, unitSatang: number, id: string, now: Date) {
  let taxCategory: TaxableCategory = line.area === 'bar' ? 'bar' : 'fnb';
  if (line.productCode) {
    const [held] = await db.select().from(product).where(and(eq(product.operatorId, operatorId), or(eq(product.branchId, branchId), isNull(product.branchId)), eq(product.code, line.productCode), isNull(product.archivedAt)));
    if (!held) throw errors.conflict('BEO_PRODUCT_UNRESOLVED', 'This new BEO item is no longer available at this park. Choose it again before billing.');
    const areas = await resolveItemTaxCategories(db, [held]);
    taxCategory = itemTaxCategory(held.kind === 'merch' ? 'merch' : 'menu', areas.get(held.id));
  }
  const componentKey = `beo-addition:${id}`;
  const cartLineId = deriveId(id, 'beo-addition-cart-line');
  const priced = await priceCart(db, { accountId: null, operatorId, branchId }, { branchId,
    partySettlement: { eventId, settlementId: id, hours: null, lines: [{ id: cartLineId, role: 'add_on', ticket: false, kids: 0, kidUnitSatang: 0, adults: 0, adultsFree: 0, adultUnitSatang: 0, socks: 0, freeSocks: 0,
      addOns: [{ id: componentKey, name: line.name, quantity, unitSatang, taxCategory, role: 'add_on' }] }] },
  }, now, { mode: 'quote', stationId: null });
  const source = priced.lines.filter((row) => row.cartLineId === cartLineId && row.componentKey === componentKey);
  if (source.length === 0) throw errors.conflict('BEO_PRICE_UNRESOLVED', 'The till could not price this new BEO item.');
  return source.reduce((sum, row) => sum + row.grossSatang, 0);
}

/** Staff Save reconciles only newly approved lines. Legacy unmarked lines never arrive here. */
export async function syncBeoAdditionalCharges(db: Db, ctx: OpContext, operatorId: string, eventId: string, body: BeoAdditionalChargesBody, now = new Date()) {
  const parks = await db.select({ id: branch.id }).from(branch).where(eq(branch.operatorId, operatorId));
  const event = await seamRead(() => getEventAtBranches(db, { branchIds: parks.map((park) => park.id), eventId }));
  if (!event || event.type !== 'party' || event.archived) throw errors.notFound('Party not found');
  if (new Set(body.lines.map((line) => line.lineId)).size !== body.lines.length) throw errors.badRequest('A BEO line appears twice');
  return withTx(db, ctx, 'party.beo_additions', async (tx) => {
    await lockParty(tx, event.id);
    let ledger = (await partyLedgersOf(tx, { branchId: event.branchId, eventIds: [event.id] })).get(event.id)!;
    if (ledger.settlement?.state !== 'settled') return { status: 'plan_only' as const, added: 0, billIds: [] };
    const mainSettlementId = ledger.settlement.id;
    const baseline = await settledBeoQuantitiesOf(tx, mainSettlementId);
    const billed = (await billedBeoSourcesOf(tx, operatorId, event.id, mainSettlementId)).map((row) => row.source);
    const billIds = new Set<string>();
    let added = 0;
    for (const line of body.lines) {
      const previous = billed.filter((source) => source.lineId === line.lineId);
      const quantityBefore = (baseline[line.lineId] ?? 0) + previous.reduce((sum, source) => sum + source.quantity, 0);
      if (line.quantity < quantityBefore) throw errors.conflict('BEO_BILLED_QUANTITY_CHANGED', 'This BEO line was already billed. Reducing it needs a separate bill adjustment; the original receipt stays unchanged.');
      if (line.quantity === quantityBefore && previous.length === 0) continue;
      const unitSatang = line.included ? 0 : line.unitSatang;
      if (unitSatang === null) throw errors.conflict('BEO_PRICE_UNRESOLVED', 'A new BEO item has no confirmed selling price. Set its price or mark it included before saving again.');
      if (previous.some((source) => source.unitSatang !== unitSatang || source.productCode !== line.productCode || source.area !== line.area || source.name !== line.name)) throw errors.conflict('BEO_BILLED_PRICE_CHANGED', 'This BEO line was already billed at another price. Add a separate new line instead of repricing the old bill.');
      if (line.quantity === quantityBefore) continue;
      if (unitSatang === 0) continue;
      const quantity = line.quantity - quantityBefore;
      const id = deriveId(event.id, `beo-addition:${mainSettlementId}:${line.lineId}:${line.quantity}:${unitSatang}`);
      const totalSatang = await priceBeoAddition(tx, operatorId, event.branchId, event.id, line, quantity, unitSatang, id, now);
      const billId = await billForNewCharge(tx, { operatorId, branchId: event.branchId, eventId: event.id, mainSettlementId, chargeId: id, bills: ledger.additionalBills ?? [], now });
      await tx.insert(partyCharge).values({ id, operatorId, branchId: event.branchId, otoappEventId: event.id, additionalBillId: billId, kind: 'fnb', items: [{ name: line.name, qty: quantity, lineTotalSatang: totalSatang, beo: { lineId: line.lineId, quantity, unitSatang, productCode: line.productCode, area: line.area, name: line.name } }], totalSatang, chargedAt: now, createdAt: now, updatedAt: now });
      await audit.record(tx, { actorAccountId: null, operatorId, branchId: event.branchId, action: 'party.beo_addition', entityType: 'party_charge', entityId: id, after: { eventId: event.id, lineId: line.lineId, quantity, billId, actorAppUserId: body.actorAppUserId } });
      added += 1;
      billIds.add(billId);
      ledger = (await partyLedgersOf(tx, { branchId: event.branchId, eventIds: [event.id] })).get(event.id)!;
    }
    return { status: 'synced' as const, added, billIds: [...billIds] };
  });
}
