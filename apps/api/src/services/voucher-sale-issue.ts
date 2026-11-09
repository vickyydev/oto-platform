import { randomInt } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  saleDiscount,
  saleLine,
  station,
  voucher,
  voucherDefinition,
  voucherRedemption,
  voucherSaleItem,
  type sale,
} from '@oto/db';
import { BOOTH_CODE_MINT_ATTEMPTS, isBoothCodePrefix, mintBoothCode, newId } from '@oto/shared';
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
