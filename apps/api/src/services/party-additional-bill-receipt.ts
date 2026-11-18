import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { partyAdditionalBill, partyCharge, partyPayment, paymentAttempt, sale } from '@oto/db';
import {
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  deriveId,
  saleReceiptDocument,
  type PartyAdditionalBill,
  type PartyAdditionalBillReceipt,
  type TaxableCategory,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { beoAdditionKeysOf, beoTaxCategoryOf } from './beo-additional-charges';
import { lockParty, partyLedgersOf } from './party-tab';
import { commitSale, finaliseSale, type PartySettlementCartLine, type SaleActor } from './sale';
import { salePrintSnapshotOf, type SalePrintingResult } from './sale-printing';
import type { Exec, Tx } from './tx';

/**
 * SCRUM-1002 RULING 1 — AN ADDITIONAL BILL GETS ITS OWN RECEIPT (the owner,
 * 18 November 2026: "Yes, its own receipt").
 *
 * The mechanism is the main settlement's, not a second one: the bill's lines
 * become ONE SALE through the sale engine (`commitSale`, the party add-on path
 * the bill was priced on), the bill's payments are that sale's tenders, and
 * the close (`finaliseSale`) numbers the receipt in the paying station's own
 * series, writes its VAT from the branch's tax rule, and queues the paper to
 * the station's printer. History lists it and reprints it like any sale.
 *
 * WHEN: the moment the bill is paid in full — never before. A part payment
 * leaves the bill open and spends no number, as a part-paid sale does (O-5):
 * the receipt then lists every payment that paid the bill, each by its method.
 *
 * WHAT IT CARRIES: that bill's own lines and total, nothing else — never the
 * party's main bill, its package or a whole-party figure (the person paying an
 * additional bill does not see the party's main bill). The first receipt is
 * never touched: its sale, lines and payments are not read for writing here.
 *
 * ONCE: the sale's id is derived from the bill's, so however often this is
 * reached — the cash press, its retry, the QR's answer and the till's record
 * of it — one sale and one number exist for one bill.
 *
 * NEVER UNDOES THE MONEY: everything here runs under a savepoint. A bill whose
 * lines do not price to what was billed (a till charge taken with a discount,
 * a tax rule changed since), a station with no receipt prefix: the payment
 * stands, the bill stays paid without a receipt, and the audit row says why.
 */

/** The receipt sale's id: one per bill, for ever. */
export const additionalBillReceiptSaleId = (billId: string): string => deriveId(billId, 'party-additional-bill-receipt');

/** The bill's receipt as the tills show it: the paper exactly as the printer gets it. */
export async function receiptsOfBills(db: Exec, billIds: readonly string[]): Promise<Map<string, PartyAdditionalBillReceipt>> {
  const out = new Map<string, PartyAdditionalBillReceipt>();
  if (billIds.length === 0) return out;
  const billOf = new Map(billIds.map((id) => [additionalBillReceiptSaleId(id), id] as const));
  const rows = await db.select().from(sale).where(inArray(sale.id, [...billOf.keys()]));
  for (const row of rows) {
    if (row.status !== 'finalised' && row.status !== 'refunded') continue;
    const paper = saleReceiptDocument(await salePrintSnapshotOf(db, row));
    out.set(billOf.get(row.id)!, {
      saleId: row.id,
      receiptNumber: row.receiptNumber,
      saleStatus: row.status,
      document: {
        title: paper.title,
        ...(paper.taxInvoiceLines ? { taxInvoiceLines: paper.taxInvoiceLines } : {}),
        ...(paper.receiptNumber ? { receiptNumber: paper.receiptNumber } : {}),
        ...(paper.dateTime ? { dateTime: paper.dateTime } : {}),
        ...(paper.staffName ? { staffName: paper.staffName } : {}),
        lines: paper.lines.map((l) => ({ qty: l.qty, name: l.name, ...(l.price ? { price: l.price } : {}), ...(l.note ? { note: l.note } : {}) })),
        ...(paper.subtotal ? { subtotal: paper.subtotal } : {}),
        ...(paper.service ? { service: paper.service } : {}),
        ...(paper.vat ? { vat: paper.vat } : {}),
        total: paper.total,
        ...(paper.tenders ? { tenders: paper.tenders } : {}),
        ...(paper.taxRows ? { taxRows: paper.taxRows } : {}),
      },
    });
  }
  return out;
}

type BeoSource = { lineId: string; quantity: number; unitSatang: number; productCode: string | null; area: 'food' | 'bar'; name: string };
type StoredItem = { name?: unknown; qty?: unknown; lineTotalSatang?: unknown; beo?: BeoSource };

const blank = { kids: 0, kidUnitSatang: 0, adults: 0, adultsFree: 0, adultUnitSatang: 0, socks: 0, freeSocks: 0 };

/**
 * The bill's lines as the sale engine prices them. A BEO line billed after
 * settlement is priced again exactly as it was billed (`priceBeoAddition`: the
 * same cart line, add-on, unit price, quantity and tax category); a charge the
 * till added is its lines at their own totals, taxed as tickets or F&B by the
 * charge's kind. The engine's gross must equal what the bill charged, or no
 * receipt is issued (the commit's `expectedTotalSatang`).
 */
async function receiptLinesOf(
  db: Exec,
  operatorId: string,
  branchId: string,
  charges: readonly (typeof partyCharge.$inferSelect)[],
): Promise<PartySettlementCartLine[]> {
  const lines: PartySettlementCartLine[] = [];
  for (const charge of charges) {
    const items: StoredItem[] = Array.isArray(charge.items) ? (charge.items as StoredItem[]) : [];
    const beo = items.length === 1 ? items[0]?.beo : undefined;
    if (beo) {
      const { componentKey, cartLineId } = beoAdditionKeysOf(charge.id);
      const taxCategory = await beoTaxCategoryOf(db, operatorId, branchId, beo, 'area');
      lines.push({ ...blank, id: cartLineId, role: 'add_on', ticket: false,
        addOns: [{ id: componentKey, name: beo.name, quantity: beo.quantity, unitSatang: beo.unitSatang, taxCategory, role: 'add_on' }] });
      continue;
    }
    const taxCategory: TaxableCategory = charge.kind === 'ticket' ? 'tickets' : 'fnb';
    const addOns = items.flatMap((item, at) => {
      const name = typeof item.name === 'string' ? item.name : '';
      const qty = typeof item.qty === 'number' ? item.qty : 0;
      const total = typeof item.lineTotalSatang === 'number' ? item.lineTotalSatang : 0;
      if (!name || qty <= 0) return [];
      // A line whose total does not divide by its count is one line of its total, its count in its name.
      const even = total % qty === 0;
      return [{ id: `party-charge:${charge.id}:${at}`, name: even ? name : `${qty} x ${name}`, quantity: even ? qty : 1,
        unitSatang: even ? total / qty : total, taxCategory, role: 'add_on' as const }];
    });
    if (addOns.length > 0) lines.push({ ...blank, id: deriveId(charge.id, 'additional-bill-receipt-line'), role: 'add_on', ticket: false, addOns });
  }
  return lines;
}

export interface AdditionalBillReceiptOutcome {
  /** `issued` now or before; `not_due` while the bill is open; `failed` when the payment stands with no receipt. */
  status: 'issued' | 'not_due' | 'failed';
  saleId: string | null;
  receiptNumber: string | null;
  /** True when this call wrote nothing because the receipt already existed. */
  replayed: boolean;
  /** What the close put on paper, and why a receipt was not issued: for the till to say. */
  notes: string[];
  printing: SalePrintingResult | null;
}

const notDue = (): AdditionalBillReceiptOutcome => ({ status: 'not_due', saleId: null, receiptNumber: null, replayed: false, notes: [], printing: null });

/**
 * Issue the bill's receipt if it is now paid in full and has none: the sale,
 * the bill's payments made its tenders, the close that numbers and prints it.
 * Called inside the caller's transaction, under the party's lock; never throws.
 */
export async function issueAdditionalBillReceipt(
  tx: Tx,
  q: {
    operatorId: string;
    branchId: string;
    eventId: string;
    billId: string;
    /** Who took the payment that paid it off: the receipt's member of staff. */
    accountId: string;
    /** Where it was paid off: the receipt's series and printer. */
    stationId: string;
    title?: string | null;
    requestId?: string;
    now: Date;
  },
): Promise<AdditionalBillReceiptOutcome> {
  const actor: SaleActor = { accountId: q.accountId, operatorId: q.operatorId, branchId: q.branchId, ...(q.requestId ? { requestId: q.requestId } : {}) };
  const saleId = additionalBillReceiptSaleId(q.billId);
  let name = 'this additional bill';
  let totalSatang: number | null = null;
  try {
    // Everything, the reads included, under one savepoint: whatever goes wrong here leaves the payment as it was.
    return await tx.transaction(async (sp): Promise<AdditionalBillReceiptOutcome> => {
      const ledgers = (await partyLedgersOf(sp, { branchId: q.branchId, eventIds: [q.eventId] })).get(q.eventId);
      const bills = ledgers?.additionalBills ?? [];
      const at = bills.findIndex((b) => b.id === q.billId);
      const bill: PartyAdditionalBill | undefined = bills[at];
      // Open, or a bill nothing was paid on (a ฿0 charge): nothing to receipt.
      if (!bill || bill.state !== 'paid' || bill.paidSatang <= 0 || bill.payments.length === 0) return notDue();
      name = `Additional bill ${at + 1}`;
      totalSatang = bill.totalSatang;
      const [held] = await sp.select().from(sale).where(eq(sale.id, saleId)).limit(1);
      if (held && held.status !== 'tendering') {
        return { status: 'issued', saleId, receiptNumber: held.receiptNumber, replayed: true, notes: [], printing: null };
      }
      if (!held) {
        const charges = await sp.select().from(partyCharge)
          .where(and(eq(partyCharge.operatorId, q.operatorId), eq(partyCharge.additionalBillId, bill.id)))
          .orderBy(asc(partyCharge.chargedAt), asc(partyCharge.id));
        const lines = await receiptLinesOf(sp, q.operatorId, q.branchId, charges);
        if (lines.length === 0) throw new AppError(409, 'ADDITIONAL_BILL_NO_LINES', 'the bill has no lines a receipt can name');
        await commitSale(sp, actor, {
          id: saleId,
          branchId: q.branchId,
          stationId: q.stationId,
          partySettlement: { eventId: q.eventId, settlementId: bill.id, hours: null, lines },
          note: q.title ? `Party: ${q.title} · ${name}` : `Party ${name.toLowerCase()}`,
          // What the bill charged and what was paid: a receipt for any other figure is not this bill's.
          expectedTotalSatang: bill.totalSatang,
        }, q.now);
      }
      // The bill's payments are the receipt's tenders: each by its own method, each on its own day.
      const attemptIds = bill.payments.map((p) => p.attemptId);
      await sp.update(paymentAttempt).set({ saleId, updatedAt: q.now })
        .where(and(inArray(paymentAttempt.id, attemptIds), isNull(paymentAttempt.saleId)));
      const tendered = await sp.select({ amountSatang: paymentAttempt.amountSatang, status: paymentAttempt.status })
        .from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
      const takenSatang = tendered.filter((a) => PAYMENT_ATTEMPT_TAKEN_STATUSES.includes(a.status)).reduce((sum, a) => sum + a.amountSatang, 0);
      if (takenSatang !== bill.totalSatang) {
        throw new AppError(409, 'ADDITIONAL_BILL_TENDERS_DIFFER', `its payments come to ${takenSatang} satang, not the ${bill.totalSatang} it charged`);
      }
      const result = await finaliseSale(sp, actor, saleId, { actionId: `party-additional-bill:${bill.id}:receipt` }, q.now);
      if (!result.finalised) throw new AppError(409, 'ADDITIONAL_BILL_NOT_CLOSED', 'the receipt sale did not close');
      await audit.record(sp, {
        actorAccountId: q.accountId,
        operatorId: q.operatorId,
        branchId: q.branchId,
        action: 'party.additional_bill_receipt',
        entityType: 'party_additional_bill',
        entityId: bill.id,
        requestId: q.requestId,
        after: {
          eventId: q.eventId,
          mainSettlementId: bill.mainSettlementId,
          saleId,
          receiptNumber: result.sale.receiptNumber,
          totalSatang: bill.totalSatang,
          attemptIds,
          stationId: q.stationId,
        },
      });
      return {
        status: 'issued',
        saleId,
        receiptNumber: result.sale.receiptNumber,
        replayed: false,
        notes: result.printing?.notes ?? [],
        printing: result.printing,
      };
    });
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'ADDITIONAL_BILL_RECEIPT_FAILED';
    // The engine's words for a total that moved are the till's; here they mean the bill's lines.
    const message = code === 'SALE_TOTAL_MISMATCH'
      ? 'its lines do not price to what it charged (a discount, or a price or tax rule changed since), so a receipt would not match the money'
      : err instanceof Error ? err.message : String(err);
    await audit.record(tx, {
      actorAccountId: q.accountId,
      operatorId: q.operatorId,
      branchId: q.branchId,
      action: 'party.additional_bill_receipt_failed',
      entityType: 'party_additional_bill',
      entityId: q.billId,
      requestId: q.requestId,
      after: { eventId: q.eventId, saleId, code, message, totalSatang, stationId: q.stationId },
    });
    return {
      status: 'failed',
      saleId: null,
      receiptNumber: null,
      replayed: false,
      notes: [`The payment is recorded, but no receipt was issued for ${name}: ${message}`],
      printing: null,
    };
  }
}

/**
 * The same, for a payment whose money landed with no till pressing anything —
 * a QR the gateway answered, a card the terminal answered, a slip a person
 * confirmed: if it paid an additional bill off, that bill's receipt is issued
 * with the money, as the gateway closes a sale with its QR. Never throws.
 */
export async function issueReceiptForPaidAttempt(tx: Tx, attemptId: string, requestId?: string | null): Promise<void> {
  try {
    await tx.transaction(async (sp) => {
      const [paid] = await sp
        .select({ row: partyPayment, billId: partyAdditionalBill.id })
        .from(partyPayment)
        .innerJoin(partyAdditionalBill, eq(partyAdditionalBill.id, partyPayment.additionalBillId))
        .where(eq(partyPayment.paymentAttemptId, attemptId))
        .limit(1);
      if (!paid || !paid.row.stationId || !paid.row.accountId) return;
      await lockParty(sp, paid.row.otoappEventId);
      await issueAdditionalBillReceipt(sp, {
        operatorId: paid.row.operatorId,
        branchId: paid.row.branchId,
        eventId: paid.row.otoappEventId,
        billId: paid.billId,
        accountId: paid.row.accountId,
        stationId: paid.row.stationId,
        ...(requestId ? { requestId } : {}),
        now: new Date(),
      });
    });
  } catch {
    // The money is the fact to keep; the till's own record of the payment issues the receipt.
  }
}
