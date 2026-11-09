import { randomInt } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  sale,
  saleDiscount,
  saleLine,
  station,
  voucher,
  voucherDefinition,
  voucherRedemption,
  voucherSaleItem,
} from '@oto/db';
import { BOOTH_CODE_MINT_ATTEMPTS, isBoothCodePrefix, mintBoothCode, newId } from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import type { Exec, Tx } from './tx';

/**
 * SCRUM-798 — A VOUCHER SOLD AS A SHOP ITEM: the Golden Ticket.
 *
 * The owner's definition (9 November 2026): "Gift voucher for full-day entry
 * for one child, with free socks if needed …". The park already sells it at
 * both parks as a shop item (`CF-TK-GOLDEN`, `RC-TK-GOLDEN`), so its sale is
 * recorded, priced and taxed like any shop item; what nothing did was give the
 * family something to redeem. This is that:
 *
 *   - WHEN THE SALE CLOSES (`finaliseSale`, and `commitSale`'s ฿0 close), each
 *     unit of an item linked to a voucher type (`promo.voucher_sale_item`, laid
 *     by platform-sync) mints one single-use voucher of that type, tied to the
 *     sale (`voucher.issued_sale_id`), issued by the person who closed it, at
 *     the sale's park. Minted in the close's own transaction: a sale that rolls
 *     back sells no voucher, and a sale that closes has its codes.
 *   - ONCE PER UNIT, however often the close runs: a replayed close counts the
 *     vouchers it already minted for the sale under the sale's row lock and
 *     mints only the shortfall, so a retry, a box's offline sale landing, or a
 *     webhook finishing a QR never sells a second code.
 *   - THE CODE is the till's own scheme (`mintBoothCode` on the station's
 *     prefix, as a voucher issued at the till is minted), so every till
 *     classifies it as it classifies any other voucher, and it is redeemed
 *     through the voucher routes with every rule they hold: online only, one
 *     use, the same refusals.
 *   - IT IS ON THE RECEIPT (`salePrintSnapshotOf` puts each code under its
 *     item's line) and on the till's confirmation (`issuedVouchers` on the
 *     close's answer and on `GET /sales/:id`), the whole code: it is the thing
 *     the family bought. A wallet's voucher QR is answered the same way.
 *   - A REFUND THAT PAYS IT BACK TAKES IT BACK (`voidSoldVouchersForRefund`):
 *     the code goes void in the refund's transaction, or the refund is refused
 *     once the code has been used or is on a sale.
 */

type SaleRow = typeof sale.$inferSelect;

/** A voucher a sale issued, as the till's confirmation and the receipt show it. */
export interface IssuedSaleVoucher {
  id: string;
  code: string;
  definitionCode: string;
  nameEn: string;
  /** The sale line whose item issued it, so the receipt can print the code under it. */
  productId: string | null;
  status: string;
  issuedAt: string;
  expiresAt: string | null;
}

/** A till's prefix for the codes it prints — its own receipt prefix, else `TV`. */
async function prefixOf(db: Exec, stationId: string): Promise<string> {
  const [row] = await db
    .select({ codePrefix: station.codePrefix })
    .from(station)
    .where(eq(station.id, stationId))
    .limit(1);
  const prefix = (row?.codePrefix ?? '').toUpperCase();
  return isBoothCodePrefix(prefix) ? prefix : 'TV';
}

/**
 * Mint the vouchers this closing sale sold. Returns every voucher the sale has
 * issued, the ones minted by an earlier run of the close included.
 */
export async function issueSaleVouchers(
  tx: Tx,
  saleRow: SaleRow,
  actor: { accountId: string | null; requestId?: string | null },
  now: Date,
): Promise<IssuedSaleVoucher[]> {
  const sold = await tx
    .select({
      productId: saleLine.productId,
      quantity: saleLine.quantity,
      definitionId: voucherSaleItem.voucherDefinitionId,
    })
    .from(saleLine)
    .innerJoin(voucherSaleItem, eq(voucherSaleItem.productId, saleLine.productId))
    .where(and(eq(saleLine.saleId, saleRow.id), eq(voucherSaleItem.operatorId, saleRow.operatorId)))
    .orderBy(asc(saleLine.lineNo));
  if (sold.length === 0) return issuedVouchersOfSale(tx, saleRow.id);

  /** Units sold per voucher type, and the item each unit came from, in line order. */
  const wanted = new Map<string, (string | null)[]>();
  for (const line of sold) {
    const units = wanted.get(line.definitionId) ?? [];
    for (let i = 0; i < Math.max(0, line.quantity); i += 1) units.push(line.productId);
    wanted.set(line.definitionId, units);
  }
  const defs = await tx
    .select()
    .from(voucherDefinition)
    .where(inArray(voucherDefinition.id, [...wanted.keys()]));
  const already = await tx
    .select({ definitionId: voucher.voucherDefinitionId })
    .from(voucher)
    .where(eq(voucher.issuedSaleId, saleRow.id));
  const prefix = await prefixOf(tx, saleRow.stationId);

  for (const def of defs) {
    const units = wanted.get(def.id) ?? [];
    const have = already.filter((row) => row.definitionId === def.id).length;
    const expiresAt = def.expiryDays ? new Date(now.getTime() + def.expiryDays * 86_400_000) : null;
    for (let unit = have; unit < units.length; unit += 1) {
      const id = newId();
      let code: string | null = null;
      for (let attempt = 0; attempt < BOOTH_CODE_MINT_ATTEMPTS && !code; attempt += 1) {
        const candidate = mintBoothCode(prefix, (max) => randomInt(max));
        const [row] = await tx
          .insert(voucher)
          .values({
            id,
            operatorId: saleRow.operatorId,
            branchId: saleRow.branchId,
            voucherDefinitionId: def.id,
            code: candidate,
            source: 'manual',
            status: 'issued',
            costSatang: def.costSatang,
            issuedByAccountId: actor.accountId,
            issuedAt: now,
            expiresAt,
            memberId: saleRow.memberId,
            issuedSaleId: saleRow.id,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: [voucher.operatorId, voucher.code] })
          .returning({ code: voucher.code });
        if (row) code = row.code;
      }
      if (!code) {
        throw new Error(`${BOOTH_CODE_MINT_ATTEMPTS} codes in a row collided — the random source is not random`);
      }
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: saleRow.operatorId,
        branchId: saleRow.branchId,
        action: 'voucher.issue',
        entityType: 'voucher',
        entityId: id,
        requestId: actor.requestId ?? null,
        // The code is a bearer credential: its last four only, as every sale shows it.
        after: {
          definitionId: def.id,
          definitionCode: def.code,
          source: 'manual',
          issuedSaleId: saleRow.id,
          productId: units[unit] ?? null,
          stationId: saleRow.stationId,
          codeLast4: code.slice(-4),
          memberId: saleRow.memberId,
          expiresAt: expiresAt?.toISOString() ?? null,
        },
      });
    }
  }
  return issuedVouchersOfSale(tx, saleRow.id);
}

/** The vouchers a sale issued, oldest first, each with the item that sold it. */
export async function issuedVouchersOfSale(db: Exec, saleId: string): Promise<IssuedSaleVoucher[]> {
  const rows = await db
    .select({ v: voucher, def: voucherDefinition })
    .from(voucher)
    .innerJoin(voucherDefinition, eq(voucherDefinition.id, voucher.voucherDefinitionId))
    .where(eq(voucher.issuedSaleId, saleId))
    .orderBy(asc(voucher.issuedAt), asc(voucher.id));
  if (rows.length === 0) return [];
  const items = await db
    .select({ productId: voucherSaleItem.productId, definitionId: voucherSaleItem.voucherDefinitionId })
    .from(saleLine)
    .innerJoin(voucherSaleItem, eq(voucherSaleItem.productId, saleLine.productId))
    .where(eq(saleLine.saleId, saleId))
    .orderBy(asc(saleLine.lineNo));
  return rows.map(({ v, def }) => ({
    id: v.id,
    code: v.code,
    definitionCode: def.code,
    nameEn: def.nameEn,
    productId: items.find((item) => item.definitionId === def.id)?.productId ?? null,
    status: v.status,
    issuedAt: v.issuedAt.toISOString(),
    expiresAt: v.expiresAt?.toISOString() ?? null,
  }));
}

/** A gift voucher a refund took back, as the refund's audit row names it. */
export interface VoidedSaleVoucher {
  id: string;
  codeLast4: string;
}

/**
 * SCRUM-798 — A REFUND THAT PAYS A GOLDEN TICKET BACK TAKES ITS CODE BACK, in
 * the refund's own transaction (`refundSale`), as a refunded prepaid-food line
 * takes its credit back (`takeBackPrepaidForRefund`, SCRUM-481): the family
 * cannot have both the money and a working gift day.
 *
 *   - `lines` are the sale lines whose money the refund carries (the whole
 *     sale, the lines an items refund names, or every line still unrefunded
 *     when the refund empties the sale). Each unit of an item linked to a
 *     voucher type takes one of the codes this sale issued of that type: an
 *     unused one goes `void`, audited `voucher.void` with its last four.
 *   - Once a code the refund would take back has been USED, or is ON A SALE
 *     at a till right now, the refund is REFUSED by name, having written
 *     nothing (the throw rolls the refund back). A unit whose code has expired
 *     unused is taken back with nothing to write.
 *   - A sale closed before its item issued codes (the Golden Ticket sold
 *     before SCRUM-798) has none to take back and refunds as before.
 *
 * The codes are locked first, so a till scanning one waits for the refund and
 * then finds it void (`VOUCHER_VOID`).
 */
export async function voidSoldVouchersForRefund(
  tx: Tx,
  actor: { accountId: string | null; requestId?: string | null },
  input: {
    saleRow: SaleRow;
    refundId: string;
    reason: string;
    lines: readonly { id: string; productId: string | null; quantity: number }[];
    now: Date;
  },
): Promise<VoidedSaleVoucher[]> {
  const { saleRow, now } = input;
  const productIds = [...new Set(input.lines.map((l) => l.productId).filter((id): id is string => !!id))];
  if (productIds.length === 0) return [];
  const links = await tx
    .select({ productId: voucherSaleItem.productId, definitionId: voucherSaleItem.voucherDefinitionId })
    .from(voucherSaleItem)
    .where(and(eq(voucherSaleItem.operatorId, saleRow.operatorId), inArray(voucherSaleItem.productId, productIds)));
  if (links.length === 0) return [];
  const definitionOf = new Map(links.map((l) => [l.productId, l.definitionId]));
  /** Units the refund pays back, per voucher type. */
  const units = new Map<string, number>();
  for (const line of input.lines) {
    const definitionId = line.productId ? definitionOf.get(line.productId) : undefined;
    if (definitionId) units.set(definitionId, (units.get(definitionId) ?? 0) + Math.max(0, line.quantity));
  }

  const sold = await tx
    .select()
    .from(voucher)
    .where(and(eq(voucher.issuedSaleId, saleRow.id), eq(voucher.operatorId, saleRow.operatorId)))
    .orderBy(asc(voucher.issuedAt), asc(voucher.id))
    .for('update');
  if (sold.length === 0) return [];
  const names = new Map(
    (
      await tx
        .select({ id: voucherDefinition.id, nameEn: voucherDefinition.nameEn })
        .from(voucherDefinition)
        .where(inArray(voucherDefinition.id, [...units.keys()]))
    ).map((d) => [d.id, d.nameEn]),
  );

  const toVoid: (typeof voucher.$inferSelect)[] = [];
  for (const [definitionId, needed] of units) {
    const ofType = sold.filter((v) => v.voucherDefinitionId === definitionId);
    if (ofType.length === 0 || needed <= 0) continue;
    const unused = ofType.filter((v) => v.status === 'issued' && !v.heldSaleId);
    const lapsed = ofType.filter((v) => v.status === 'expired');
    const pool = [...unused, ...lapsed];
    if (pool.length < needed) {
      const blocking = ofType.find((v) => v.status === 'redeemed' || (v.status === 'issued' && v.heldSaleId));
      if (blocking) {
        throw await soldVoucherRefusal(tx, blocking, names.get(definitionId) ?? 'voucher');
      }
    }
    toVoid.push(...pool.slice(0, needed).filter((v) => v.status === 'issued'));
  }
  if (toVoid.length === 0) return [];

  await tx
    .update(voucher)
    .set({ status: 'void', updatedAt: now })
    .where(
      and(
        inArray(
          voucher.id,
          toVoid.map((v) => v.id),
        ),
        eq(voucher.status, 'issued'),
        isNull(voucher.heldSaleId),
      ),
    );
  for (const v of toVoid) {
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: saleRow.operatorId,
      branchId: saleRow.branchId,
      action: 'voucher.void',
      entityType: 'voucher',
      entityId: v.id,
      requestId: actor.requestId ?? null,
      // The code is a bearer credential: its last four only.
      before: { status: v.status, codeLast4: v.code.slice(-4) },
      after: {
        status: 'void',
        codeLast4: v.code.slice(-4),
        definitionId: v.voucherDefinitionId,
        issuedSaleId: saleRow.id,
        refundId: input.refundId,
        reason: input.reason,
      },
    });
  }
  return toVoid.map((v) => ({ id: v.id, codeLast4: v.code.slice(-4) }));
}

/** Why a refund cannot take a sold code back: it was used, or a till has it on a sale. */
async function soldVoucherRefusal(db: Exec, v: typeof voucher.$inferSelect, name: string) {
  const last4 = v.code.slice(-4);
  if (v.status === 'redeemed') {
    const [usedOn] = v.saleId
      ? await db.select({ receiptNumber: sale.receiptNumber }).from(sale).where(eq(sale.id, v.saleId)).limit(1)
      : [];
    const receipt = usedOn?.receiptNumber ? ` (receipt ${usedOn.receiptNumber})` : '';
    return errors.conflict(
      'SOLD_VOUCHER_USED',
      `The ${name} sold on this sale (code ending ${last4}) has already been used${receipt}, so it cannot be refunded.`,
      { voucherId: v.id, codeLast4: last4, usedOnSaleId: v.saleId, receiptNumber: usedOn?.receiptNumber ?? null },
    );
  }
  const [till] = v.heldStationId
    ? await db.select({ name: station.name }).from(station).where(eq(station.id, v.heldStationId)).limit(1)
    : [];
  return errors.conflict(
    'SOLD_VOUCHER_HELD',
    `The ${name} sold on this sale (code ending ${last4}) is on a sale at ${till?.name ?? 'another till'} right now, so it cannot be refunded — finish or cancel that sale first.`,
    { voucherId: v.id, codeLast4: last4, heldSaleId: v.heldSaleId, heldStationId: v.heldStationId },
  );
}

/**
 * SCRUM-798 — THE CART LINES A GIFT TICKET ADMITTED on this sale: the line each
 * applied Golden Ticket's discount row was aimed at. The owner's "no food
 * voucher" is read here: on these lines the credit a sale grants
 * (`grantSaleCredit`) passes over the gift's child and the parent who stayed
 * with them, whatever the package's credit rule pays an adult. Anyone else on
 * the line paid for their ticket and earns as usual.
 */
export async function giftTicketLinesOfSale(
  db: Exec,
  operatorId: string,
  saleId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ lineId: saleDiscount.targetLineId })
    .from(voucherRedemption)
    .innerJoin(voucher, eq(voucher.id, voucherRedemption.voucherId))
    .innerJoin(voucherDefinition, eq(voucherDefinition.id, voucher.voucherDefinitionId))
    .innerJoin(
      saleDiscount,
      and(eq(saleDiscount.saleId, voucherRedemption.saleId), eq(saleDiscount.code, voucher.code)),
    )
    .where(
      and(
        eq(voucherRedemption.saleId, saleId),
        eq(voucherRedemption.operatorId, operatorId),
        eq(voucherRedemption.kind, 'applied'),
        eq(voucherDefinition.kind, 'free_ticket'),
        eq(voucherDefinition.ticketOffer, 'gift_day'),
      ),
    );
  return new Set(rows.map((r) => r.lineId).filter((id): id is string => !!id));
}
