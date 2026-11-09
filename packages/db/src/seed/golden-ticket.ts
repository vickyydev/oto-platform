/**
 * SCRUM-798 — THE GOLDEN TICKET, laid for every operator by `platformSync`.
 *
 * The owner's definition (9 November 2026): a 1,500 THB gift voucher for
 * full-day entry for one child, with free socks if needed; the parent free if
 * they stay, or a free drop-off for a child aged 5 or over; no food voucher.
 * The item is already sold at both parks as a shop item (`CF-TK-GOLDEN` and
 * `RC-TK-GOLDEN`), so the sale is recorded; this lays the two things that make
 * the sale issue a voucher and the voucher redeem:
 *
 *   1. the voucher type `golden-ticket` — kind `free_ticket`, offer
 *      `gift_day`, admitting to the operator's Full Day Pass (a package is
 *      matched by name at the redeeming park, `packageAtBranch`). Insert-if-
 *      absent: an administrator's later edit (its words, its expiry, switching
 *      it off) is never undone by a sync.
 *   2. a `promo.voucher_sale_item` row for each Golden Ticket item the
 *      operator sells, so its sale mints one voucher per unit. Also insert-if-
 *      absent, and only for a live item: an item archived or not there yet is
 *      linked by the sync that runs after it is created.
 *
 * Staging and production both run `platform:sync` as their pre-deploy step,
 * so the type and the links land with the deploy and nobody types them in.
 *
 * What it does NOT decide, and leaves at the platform's defaults for the owner
 * to change in the Console: how long a Golden Ticket lasts (null: it never
 * expires), what it costs the park when redeemed (0: not costed yet). It is
 * redeemed online only (`offline_policy` refuse): a 1,500 THB voucher is not
 * honoured on the strength of the paper.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  GOLDEN_TICKET_DEFINITION_CODE,
  GOLDEN_TICKET_PACKAGE_NAME,
  GOLDEN_TICKET_PRODUCT_CODES,
  newId,
} from '@oto/shared';
import type { Db } from '../index';
import * as s from '../schema/index';

/** What one run did, for the sync's log line. */
export interface GoldenTicketSync {
  definitionsCreated: number;
  itemsLinked: number;
}

/** The Golden Ticket type as the sync first writes it. */
export const GOLDEN_TICKET_DEFINITION = {
  code: GOLDEN_TICKET_DEFINITION_CODE,
  nameEn: 'Golden Ticket',
  kind: 'free_ticket' as const,
  valueType: 'item' as const,
  ticketOffer: 'gift_day' as const,
  offlinePolicy: 'refuse' as const,
  singleUse: true,
  costSatang: 0,
  expiryDays: null,
  titleEn: 'Golden Ticket',
  instructionEn:
    'Full-day entry for one child, with free socks if needed. The parent enters free, or a child aged 5 or over may be dropped off free. Show this code at OTO Reception.',
  termsEn: 'One child, one use. No food credit. No cash value.',
};

export async function syncGoldenTicket(db: Db): Promise<GoldenTicketSync> {
  const result: GoldenTicketSync = { definitionsCreated: 0, itemsLinked: 0 };
  const operators = await db
    .select({ id: s.operator.id })
    .from(s.operator)
    .where(isNull(s.operator.archivedAt));
  for (const { id: operatorId } of operators) {
    const [existing] = await db
      .select({ id: s.voucherDefinition.id })
      .from(s.voucherDefinition)
      .where(
        and(
          eq(s.voucherDefinition.operatorId, operatorId),
          eq(s.voucherDefinition.code, GOLDEN_TICKET_DEFINITION_CODE),
        ),
      )
      .limit(1);
    let definitionId = existing?.id ?? null;
    if (!definitionId) {
      // Any park's live Full Day Pass names the package; each park redeems
      // against its own package of the same name.
      const [fullDay] = await db
        .select({ id: s.ticketPackage.id })
        .from(s.ticketPackage)
        .where(
          and(
            eq(s.ticketPackage.operatorId, operatorId),
            eq(s.ticketPackage.name, GOLDEN_TICKET_PACKAGE_NAME),
            eq(s.ticketPackage.active, true),
            isNull(s.ticketPackage.archivedAt),
          ),
        )
        .orderBy(asc(s.ticketPackage.createdAt), asc(s.ticketPackage.id))
        .limit(1);
      // An operator with no Full Day Pass has nothing a Golden Ticket admits to.
      if (!fullDay) continue;
      definitionId = newId();
      const inserted = await db
        .insert(s.voucherDefinition)
        .values({
          id: definitionId,
          operatorId,
          ticketPackageId: fullDay.id,
          ...GOLDEN_TICKET_DEFINITION,
        })
        .onConflictDoNothing({ target: [s.voucherDefinition.operatorId, s.voucherDefinition.code] })
        .returning({ id: s.voucherDefinition.id });
      if (inserted.length > 0) {
        result.definitionsCreated += 1;
      } else {
        const [raced] = await db
          .select({ id: s.voucherDefinition.id })
          .from(s.voucherDefinition)
          .where(
            and(
              eq(s.voucherDefinition.operatorId, operatorId),
              eq(s.voucherDefinition.code, GOLDEN_TICKET_DEFINITION_CODE),
            ),
          )
          .limit(1);
        definitionId = raced?.id ?? null;
        if (!definitionId) continue;
      }
    }

    const items = await db
      .select({ id: s.product.id })
      .from(s.product)
      .where(
        and(
          eq(s.product.operatorId, operatorId),
          inArray(s.product.code, [...GOLDEN_TICKET_PRODUCT_CODES]),
          isNull(s.product.archivedAt),
        ),
      );
    for (const item of items) {
      const linked = await db
        .insert(s.voucherSaleItem)
        .values({ id: newId(), operatorId, voucherDefinitionId: definitionId, productId: item.id })
        .onConflictDoNothing({ target: s.voucherSaleItem.productId })
        .returning({ id: s.voucherSaleItem.id });
      result.itemsLinked += linked.length;
    }
  }
  return result;
}
