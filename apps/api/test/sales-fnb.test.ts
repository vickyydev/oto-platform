import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  branch,
  discountDefinition,
  member,
  modifierGroup,
  modifierOption,
  product,
  productCategory,
  sale,
  saleLine,
  station,
} from '@oto/db';
import { newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-09b (SCRUM-204) — the ledger side of an F&B line and a shop line, driven
 * through the REAL routes with a REAL reception session, asserting the rows
 * that land in Postgres.
 *
 * WHY IT IS WRITTEN THAT WAY: the same reason `sales.test.ts` says. A service
 * with no caller and a test that mirrors one side of the seam fails nothing
 * when the two halves stop meeting, so every case below goes in through
 * `app.inject` on the route the till calls and then reads the database.
 *
 * THE FIXTURES are the seeded menu, which is the prototype's own demo
 * catalogue (`packages/db/src/seed/menu.ts`), so the numbers are the park's:
 *   Soft Drink       ฿45, one REQUIRED single-choice group "Ice" (all free)
 *   French Fries     ฿90, "Sauces" multi, max 2 — Cheese sauce is +฿25
 *   Iced Latte       ฿95, filed under Coffee, a sub-category of Drinks that
 *                    sets NEITHER a prep station NOR a taxable area
 *   Grip Socks       ฿120 of merchandise, under Apparel, in sizes S, M and L
 *   VAT              7 %, inclusive, on every category; no service charge
 * Not one seeded item sets a weekend price, so every figure below holds on a
 * Tuesday and on a Sunday alike.
 */

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let jamesId: string;
/** The seeded booth — a station kind that is not a till (SCRUM-343). */
let boothStationId: string;
/** A till configured to sell tickets and NOT food (SCRUM-343). */
let ticketsOnlyStationId: string;

/** Satang from baht, so the fixtures read like the price list. */
const b = (baht: number): number => Math.round(baht * 100);

interface Catalogued {
  id: string;
  name: string;
  groups: Map<string, { id: string; options: Map<string, string> }>;
}

/** Everything a test needs to name one seeded item and its answers, by name. */
const items = new Map<string, Catalogued>();

const itemLine = (
  code: string,
  quantity = 1,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: newId(),
  productId: items.get(code)!.id,
  quantity,
  ...extra,
});

/**
 * The socks as the shop screen sends them: in a size. They come in S, M and L,
 * and a line on them that names no size is refused (the owner's decision of
 * 2026-09-24, pinned in "what the line records"), so every case here that is
 * about something else sells the M.
 */
const socksLine = (quantity = 1, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  itemLine('MR-SOCKS', quantity, { variant: { variantId: 'm', variantLabel: 'M' }, ...extra });

/** The group id and one of its option ids, by the names the seed gives them. */
const choose = (code: string, groupName: string, ...optionNames: string[]) => {
  const group = items.get(code)!.groups.get(groupName)!;
  return {
    groupId: group.id,
    optionIds: optionNames.map((name) => group.options.get(name)!),
  };
};

async function commit(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: { stationId, ...payload },
  });
}

async function finalise(saleId: string, payload?: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
}

async function linesOf(saleId: string) {
  return ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central') ?? branches[0]!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;

  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;

  // SCRUM-343's two counter-examples. The booth is seeded (a kind that is not a
  // till at all); a till that sells tickets and NOT food is not, because the
  // only seeded one belongs to the tenancy fixture's foreign operator and this
  // session could never reach it.
  const [booth] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'booth')));
  boothStationId = booth!.id;

  ticketsOnlyStationId = newId();
  await ctx.db.insert(station).values({
    id: ticketsOnlyStationId,
    operatorId,
    branchId,
    name: 'Tickets Only Till',
    kind: 'till',
    codePrefix: 'TQ',
    capabilities: ['tickets'],
    accessScope: 'all_staff',
  });

  const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
  jamesId = members.find((m) => m.phone === '+66822222222')!.id;

  // The seeded menu, indexed by the code the seed keys its rows on, with each
  // item's INLINE groups and their options.
  const rows = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), isNull(product.archivedAt)));
  const groups = await ctx.db
    .select()
    .from(modifierGroup)
    .where(eq(modifierGroup.operatorId, operatorId));
  const options = await ctx.db
    .select()
    .from(modifierOption)
    .where(
      inArray(
        modifierOption.modifierGroupId,
        groups.map((g) => g.id),
      ),
    );
  for (const row of rows) {
    if (!row.code) continue;
    items.set(row.code, {
      id: row.id,
      name: row.name,
      groups: new Map(
        groups
          .filter((g) => g.productId === row.id)
          .map((g) => [
            g.name,
            {
              id: g.id,
              options: new Map(
                options.filter((o) => o.modifierGroupId === g.id).map((o) => [o.name, o.id]),
              ),
            },
          ]),
      ),
    });
  }
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the menu’s own rules decide what may be ordered', () => {
  it('refuses an item whose required single-choice question was never answered, and names it', async () => {
    // "Ice" is required on the Soft Drink. The prototype greys out "Add to
    // order" until it is answered; a disabled button is not a rule.
    const res = await commit({ items: [itemLine('FB-SODA')] });
    expect(res.statusCode).toBe(400);
    const error = res.json().error;
    expect(error.message).toContain('Ice');
    expect(error.message).toContain('Soft Drink');
    expect(error.details).toMatchObject({ modifierGroupName: 'Ice', required: true });
    expect(await ctx.db.select().from(sale).where(eq(sale.stationId, stationId))).toHaveLength(0);
  });

  it('prices the item plus the chosen option’s delta once the question is answered', async () => {
    const saleId = newId();
    const res = await commit({
      id: saleId,
      items: [
        itemLine('FB-FRIES', 2, { modifiers: [choose('FB-FRIES', 'Sauces', 'Cheese sauce')] }),
      ],
    });
    expect(res.statusCode).toBe(200);

    // ฿90 of chips plus ฿25 of cheese sauce, twice.
    const unit = b(90) + b(25);
    expect(res.json().sale.totals.grossSatang).toBe(2 * unit);

    const lines = await linesOf(saleId);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.kind).toBe('fnb_item');
    expect(line.productId).toBe(items.get('FB-FRIES')!.id);
    expect(line.quantity).toBe(2);
    expect(line.unitSatang).toBe(unit);
    expect(line.baseSatang).toBe(2 * unit);
    expect(line.taxableCategory).toBe('fnb');
    // 7 % INSIDE the price, as on every other line the ledger writes.
    expect(line.taxSatang).toBe(Math.round((2 * unit * 7) / 107));
    // The option is itemised beside the price it added, so the receipt can
    // print it and a re-price later cannot rewrite it.
    expect(line.payload).toMatchObject({
      modifiers: [{ groupName: 'Sauces', optionName: 'Cheese sauce', unitSatang: b(25) }],
    });
  });

  it('quotes public base and modifier prices even when changed prices keep the same total', async () => {
    const fries = items.get('FB-FRIES')!;
    const optionId = fries.groups.get('Sauces')!.options.get('Cheese sauce')!;
    const [beforeItem] = await ctx.db.select().from(product).where(eq(product.id, fries.id));
    const [beforeOption] = await ctx.db.select().from(modifierOption).where(eq(modifierOption.id, optionId));
    const row = itemLine('FB-FRIES', 2, { modifiers: [choose('FB-FRIES', 'Sauces', 'Cheese sauce')] });
    const ask = () => ctx.app.inject({ method: 'POST', url: '/sales/quote', headers: { cookie },
      payload: { stationId, items: [row] } });
    const first = await ask();
    expect(first.statusCode).toBe(200);
    expect(first.json().quote.itemPresentation[row.id as string]).toEqual({
      name: 'French Fries', basePriceSatang: b(90),
      modifiers: [{ groupName: 'Sauces', optionName: 'Cheese sauce', priceSatang: b(25) }],
    });
    try {
      await ctx.db.update(product).set({ priceSatang: b(95), priceWeekendSatang: b(95) }).where(eq(product.id, fries.id));
      await ctx.db.update(modifierOption).set({ priceSatang: b(20), priceWeekendSatang: b(20) }).where(eq(modifierOption.id, optionId));
      const changed = await ask();
      expect(changed.statusCode).toBe(200);
      expect(changed.json().quote.lineTotals).toEqual(first.json().quote.lineTotals);
      expect(changed.json().quote.itemPresentation[row.id as string]).toEqual({
        name: 'French Fries', basePriceSatang: b(95),
        modifiers: [{ groupName: 'Sauces', optionName: 'Cheese sauce', priceSatang: b(20) }],
      });
      expect(changed.json().itemPresentation).toEqual(changed.json().quote.itemPresentation);
      expect(JSON.stringify(changed.json().quote.itemPresentation)).not.toMatch(/cost|operatorId|optionId|productId|prepStation|payload/);
    } finally {
      await ctx.db.update(product).set({ priceSatang: beforeItem!.priceSatang,
        priceWeekendSatang: beforeItem!.priceWeekendSatang }).where(eq(product.id, fries.id));
      await ctx.db.update(modifierOption).set({ priceSatang: beforeOption!.priceSatang,
        priceWeekendSatang: beforeOption!.priceWeekendSatang }).where(eq(modifierOption.id, optionId));
    }
  });

  it('refuses an option that is not one of that question’s answers', async () => {
    const strayOption = items.get('FB-PIZZA')!.groups.get('Extra toppings')!.options.get('Ham')!;
    const res = await commit({
      items: [
        itemLine('FB-FRIES', 1, {
          modifiers: [{ groupId: items.get('FB-FRIES')!.groups.get('Sauces')!.id, optionIds: [strayOption] }],
        }),
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Sauces');
    expect(res.json().error.details).toMatchObject({ modifierOptionId: strayOption });
  });

  it('refuses a question the item does not ask', async () => {
    const res = await commit({
      items: [
        itemLine('FB-FRIES', 1, {
          modifiers: [choose('FB-PIZZA', 'Extra toppings', 'Ham')],
        }),
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('French Fries');
  });

  it('refuses more answers than a multi-choice question allows', async () => {
    // "Sauces" is capped at two.
    const res = await commit({
      items: [
        itemLine('FB-FRIES', 1, {
          modifiers: [choose('FB-FRIES', 'Sauces', 'Ketchup', 'Mayo', 'Cheese sauce')],
        }),
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toMatchObject({ maxSelect: 2, chosenCount: 3 });
  });
});

describe('what the line records', () => {
  it('keeps two lines of the same item apart when their notes differ', async () => {
    const saleId = newId();
    const ice = [choose('FB-SODA', 'Ice', 'No ice')];
    const res = await commit({
      id: saleId,
      items: [
        itemLine('FB-SODA', 1, { modifiers: ice, note: 'in a paper cup' }),
        itemLine('FB-SODA', 1, { modifiers: ice, note: 'no straw' }),
      ],
    });
    expect(res.statusCode).toBe(200);

    // The platform records what it is sent: merging identical lines is the
    // till's decision (`pages/OrderStation.tsx:236-243`), and these are not
    // identical — each note has to reach the bar as its own line.
    const lines = (await linesOf(saleId)).sort((a, x) => a.lineNo - x.lineNo);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => (l.payload as { note?: string } | null)?.note)).toEqual([
      'in a paper cup',
      'no straw',
    ]);
    expect(new Set(lines.map((l) => l.cartLineId)).size).toBe(2);
  });

  it('writes the size a merch line sold, names it on the line, and books it as merchandise', async () => {
    const saleId = newId();
    const res = await commit({
      id: saleId,
      items: [
        // The label is what the till's screen said; the one recorded is the
        // catalogue's, because the till only picks the size.
        itemLine('MR-SOCKS', 1, { variant: { variantId: 'm', variantLabel: 'Medium?' } }),
      ],
    });
    expect(res.statusCode, res.body).toBe(200);

    const lines = await linesOf(saleId);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.kind).toBe('merch_item');
    expect(line.label).toBe('Grip Socks — M');
    // No size carries a price of its own: the M is the item's ฿120.
    expect(line.unitSatang).toBe(b(120));
    expect(line.taxableCategory).toBe('merch');
    expect(line.payload).toMatchObject({ variant: { variantId: 'm', variantLabel: 'M' } });
    // Merchandise is handed over at the till and prints no prep ticket at all.
    expect((line.payload as { prepStation?: string }).prepStation).toBeUndefined();

    // And the Sale detail reads the same line back.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/sales/${saleId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    const shown = (
      detail.json() as { lines: Array<{ label: string; variant: unknown }> }
    ).lines[0]!;
    expect(shown.label).toBe('Grip Socks — M');
    expect(shown.variant).toEqual({ variantId: 'm', variantLabel: 'M' });
  });

  /**
   * THE BAD SIZE — the plant for this one removes the check in
   * `resolveLineVariant`; the line is then written with a size the socks do not
   * come in, and this test goes red on the status.
   */
  it('PLANT — refuses a size the item does not come in, names the sizes it does, and writes nothing', async () => {
    const saleId = newId();
    const line = itemLine('MR-SOCKS', 1, { variant: { variantId: 'xl', variantLabel: 'XL' } });
    const res = await commit({ id: saleId, items: [line] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'BAD_REQUEST',
      message: '"Grip Socks" has no size "xl" — it comes in S, M, L',
      details: { cartLineId: line.id, productId: items.get('MR-SOCKS')!.id, variantId: 'xl' },
    });
    expect(await linesOf(saleId)).toEqual([]);

    // The quote the till asks first says the same, so the charge button is off
    // before anybody presses it.
    const quote = await ctx.app.inject({
      method: 'POST',
      url: '/sales/quote',
      headers: { cookie },
      payload: { stationId, items: [line] },
    });
    expect(quote.statusCode).toBe(400);
    expect(quote.json().error.message).toBe('"Grip Socks" has no size "xl" — it comes in S, M, L');
  });

  it('refuses a size on an item that comes in one size', async () => {
    const res = await commit({
      id: newId(),
      items: [itemLine('MR-TSHIRT', 1, { variant: { variantId: 'm', variantLabel: 'M' } })],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(
      '"Oto T-Shirt" does not come in sizes, so a size cannot be sold on it',
    );
  });

  /**
   * A SIZED ITEM SOLD WITH NO SIZE — refused, the owner's decision of
   * 2026-09-24. The socks come in S, M and L; a line that names none is not a
   * pair anybody could hand over, and the shop screen asks before it adds one.
   * The plant for this one takes the refusal out of `resolveLineVariant`; the
   * line is then written as the item alone, and this test goes red on the
   * status.
   */
  it('PLANT — refuses a line with no size on an item sold in sizes, names the sizes, and writes nothing', async () => {
    const saleId = newId();
    const line = itemLine('MR-SOCKS', 1);
    const res = await commit({ id: saleId, items: [line] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'A size has to be chosen before "Grip Socks" can be sold — it comes in S, M, L',
      details: { cartLineId: line.id, productId: items.get('MR-SOCKS')!.id, required: true },
    });
    expect(await linesOf(saleId)).toEqual([]);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toEqual([]);

    // The quote the till asks first refuses it in the same words, so the
    // charge button is off before anybody presses it.
    const quote = await ctx.app.inject({
      method: 'POST',
      url: '/sales/quote',
      headers: { cookie },
      payload: { stationId, items: [line] },
    });
    expect(quote.statusCode).toBe(400);
    expect(quote.json().error.message).toBe(
      'A size has to be chosen before "Grip Socks" can be sold — it comes in S, M, L',
    );
  });

  it('sells an item in one size, or in none, with no size named — as before sizes existed', async () => {
    // An item defined with a single size has nothing to choose between. It is
    // inserted rather than posted because this file's session is reception's,
    // which does not write the menu.
    const [socks] = await ctx.db
      .select()
      .from(product)
      .where(eq(product.id, items.get('MR-SOCKS')!.id));
    const oneSizeId = newId();
    await ctx.db.insert(product).values({
      id: oneSizeId,
      operatorId,
      branchId,
      categoryId: socks!.categoryId,
      kind: 'merch',
      code: 'T-ONE-SIZE',
      name: 'One-size Tote',
      priceSatang: b(200),
      variants: [{ id: 'one', label: 'One size' }],
    });

    const saleId = newId();
    const res = await commit({
      id: saleId,
      items: [
        { id: newId(), productId: oneSizeId, quantity: 1 },
        // ...and the T-shirt, which comes in no sizes at all.
        itemLine('MR-TSHIRT', 1),
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const lines = await linesOf(saleId);
    expect(lines.map((l) => l.label).sort()).toEqual(['One-size Tote', 'Oto T-Shirt']);
    for (const l of lines) {
      expect((l.payload as { variant?: unknown } | null)?.variant).toBeUndefined();
    }

    // A size it does not have is still refused, one size or not.
    const bad = await commit({
      id: newId(),
      items: [
        {
          id: newId(),
          productId: oneSizeId,
          quantity: 1,
          variant: { variantId: 'xl', variantLabel: 'XL' },
        },
      ],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe('"One-size Tote" has no size "xl" — it comes in One size');
  });

  it('routes a sub-category item with no override to its parent’s prep station', async () => {
    // Iced Latte is filed under Coffee, which sets no station; Coffee's parent
    // Drinks sets `bar`. A raw read of the item's own category answers nothing
    // and the ticket would print in the kitchen.
    const saleId = newId();
    const res = await commit({
      id: saleId,
      items: [itemLine('FB-LATTE', 1, { modifiers: [choose('FB-LATTE', 'Ice', 'Less ice')] })],
    });
    expect(res.statusCode).toBe(200);

    const [line] = await linesOf(saleId);
    expect((line!.payload as { prepStation?: string }).prepStation).toBe('bar');
    // The taxable area inherits by the same walk: Coffee sets none, Drinks says fnb.
    expect(line!.taxableCategory).toBe('fnb');
  });

  it('charges a member the same for food as a walk-in — a tier prices tickets, not lunch', async () => {
    // James is the seeded expat, and the expat rate takes 30 % off admission.
    const walkIn = await commit({ items: [itemLine('FB-LATTE', 1, { modifiers: [choose('FB-LATTE', 'Ice', 'No ice')] })] });
    const expat = await commit({
      memberId: jamesId,
      items: [itemLine('FB-LATTE', 1, { modifiers: [choose('FB-LATTE', 'Ice', 'No ice')] })],
    });
    expect(walkIn.json().sale.totals.grossSatang).toBe(b(95));
    expect(expat.json().sale.customerTier).toBe('expat');
    expect(expat.json().sale.totals.grossSatang).toBe(b(95));
  });

  it('ignores a line total the till sends, and refuses the sale when it disagrees', async () => {
    const res = await commit({
      items: [socksLine(1, { lineTotalSatang: b(1) })],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SALE_LINE_PRICE_MISMATCH');
    expect(res.json().error.details).toMatchObject({
      tillLineTotalSatang: b(1),
      platformLineTotalSatang: b(120),
    });
  });
});

describe('an order with food on it is not closed without a pick-up code', () => {
  it('refuses the tender, takes no money, and says which is missing', async () => {
    const saleId = newId();
    const committed = await commit({
      id: saleId,
      items: [itemLine('FB-FRIES', 1, { modifiers: [choose('FB-FRIES', 'Sauces', 'Ketchup')] })],
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json().pickupCode).toBeNull();

    const refused = await finalise(saleId, { method: 'cash' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('PICKUP_CODE_REQUIRED');

    // Refused BEFORE the tender: nothing was taken and the sale is still open.
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).toBe('tendering');
    expect(row!.receiptNumber).toBeNull();

    // The same call with the code closes it, and the code is on the sale.
    const closed = await finalise(saleId, { method: 'cash', pickupCode: '42' });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().pickupCode).toBe('42');
    expect(closed.json().sale.receiptNumber).toMatch(/^T1-\d{6}$/);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/sales/${saleId}`,
      headers: { cookie },
    });
    expect(detail.json().pickupCode).toBe('42');
    const lines = await linesOf(saleId);
    expect((lines[0]!.payload as { pickupCode?: string }).pickupCode).toBe('42');
  });

  it('closes an order whose cart carried the code, with nothing typed at the cash step', async () => {
    const saleId = newId();
    const committed = await commit({
      id: saleId,
      pickupCode: '117',
      items: [itemLine('FB-SODA', 1, { modifiers: [choose('FB-SODA', 'Ice', 'Normal ice')] })],
    });
    expect(committed.json().pickupCode).toBe('117');

    const closed = await finalise(saleId);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().pickupCode).toBe('117');
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).toBe('finalised');
  });

  it('asks nothing of a shop order — merchandise is handed over at the till', async () => {
    const saleId = newId();
    await commit({ id: saleId, items: [socksLine()] });
    const closed = await finalise(saleId, { method: 'cash' });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().pickupCode).toBeNull();
  });
});

/**
 * SCRUM-343 — which lane of the till the sale is filed under.
 *
 * `pos.sale.sales_channel` is what reporting by station type (SCRUM-216) will
 * group on. Until this ticket the cart declared no channel, so every F&B and
 * shop order written since S2-09b landed as `till` and a day's food takings
 * were filed under the ticket counter.
 */
describe('the cart names its lane and the platform checks it', () => {
  const channelOf = async (saleId: string) => {
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    return row!.salesChannel;
  };

  it('files a food order under fnb', async () => {
    const saleId = newId();
    const res = await commit({
      id: saleId,
      channel: 'fnb',
      items: [itemLine('FB-LATTE', 1, { modifiers: [choose('FB-LATTE', 'Ice', 'No ice')] })],
    });
    expect(res.statusCode).toBe(200);
    expect(await channelOf(saleId)).toBe('fnb');
    // And it is on the read, so the till and the reports see the same word.
    expect(res.json().sale.salesChannel).toBe('fnb');
  });

  it('files a shop order under shop', async () => {
    const saleId = newId();
    const res = await commit({ id: saleId, channel: 'shop', items: [socksLine()] });
    expect(res.statusCode).toBe(200);
    expect(await channelOf(saleId)).toBe('shop');
  });

  it('files a cart that claims the ticket counter under till', async () => {
    const saleId = newId();
    const res = await commit({ id: saleId, channel: 'till', items: [socksLine()] });
    expect(res.statusCode).toBe(200);
    expect(await channelOf(saleId)).toBe('till');
  });

  it('leaves a cart that claims nothing exactly where it landed before — till', async () => {
    // The pre-change behaviour, kept deliberately: an older till that has not
    // been updated goes on writing what it always wrote rather than being
    // refused, and there is no backfill of what it already wrote.
    const saleId = newId();
    const res = await commit({
      id: saleId,
      items: [itemLine('FB-SODA', 1, { modifiers: [choose('FB-SODA', 'Ice', 'Normal ice')] })],
    });
    expect(res.statusCode).toBe(200);
    expect(await channelOf(saleId)).toBe('till');
  });

  it('refuses a claim the station KIND cannot make', async () => {
    // A booth's channel is its kind; no screen on it is the F&B counter.
    const res = await commit({
      stationId: boothStationId,
      channel: 'fnb',
      items: [socksLine()],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SALE_CHANNEL_MISMATCH');
    expect(res.json().error.details).toMatchObject({
      stationKind: 'booth',
      claimedChannel: 'fnb',
      allowedChannels: ['booth'],
    });
  });

  it('records a booth own channel when it claims nothing', async () => {
    const saleId = newId();
    const res = await commit({
      id: saleId,
      stationId: boothStationId,
      items: [socksLine()],
    });
    expect(res.statusCode).toBe(200);
    expect(await channelOf(saleId)).toBe('booth');
  });

  it('refuses a food claim from a till that is not set up to sell food', async () => {
    // The one thing in the fleet model that bounds a till's claim: what it is
    // configured to sell. A misconfigured or mis-built till is a thing to fix
    // at the counter, not a line to file under the wrong heading.
    const res = await commit({
      stationId: ticketsOnlyStationId,
      channel: 'fnb',
      items: [socksLine()],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SALE_CHANNEL_MISMATCH');
    expect(res.json().error.message).toContain('Tickets Only Till');
    expect(res.json().error.details).toMatchObject({ capabilities: ['tickets'] });
  });

  it('refuses before it writes anything at all', async () => {
    const saleId = newId();
    const res = await commit({
      id: saleId,
      stationId: ticketsOnlyStationId,
      channel: 'fnb',
      items: [itemLine('FB-LATTE', 1, { modifiers: [choose('FB-LATTE', 'Ice', 'No ice')] })],
    });
    expect(res.statusCode).toBe(409);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(0);
  });

  it('identifies the sales written before this change, which are NOT backfilled', async () => {
    // The query the ticket comment carries, run here so it cannot rot: a sale
    // filed under `till` whose lines are ALL food or merchandise was written by
    // a station that had no channel to send. The line kinds are what tell them
    // apart — nothing else on the row does.
    const found = await ctx.db.execute(sql`
      select s.id
        from pos.sale s
       where s.sales_channel = 'till'
         and exists (select 1 from pos.sale_line l
                      where l.sale_id = s.id and l.kind in ('fnb_item', 'merch_item'))
         and not exists (select 1 from pos.sale_line l
                          where l.sale_id = s.id and l.kind not in ('fnb_item', 'merch_item'))
    `);
    const ids = new Set((found.rows as { id: string }[]).map((r) => r.id));
    // Every channel-less food order above is in it...
    const legacy = await ctx.db
      .select()
      .from(sale)
      .where(and(eq(sale.stationId, stationId), eq(sale.salesChannel, 'till')));
    expect(legacy.length).toBeGreaterThan(0);
    for (const row of legacy) expect(ids.has(row.id)).toBe(true);
    // ...and nothing the new carts filed correctly is.
    const filed = await ctx.db
      .select()
      .from(sale)
      .where(inArray(sale.salesChannel, ['fnb', 'shop']));
    expect(filed.length).toBeGreaterThan(0);
    for (const row of filed) expect(ids.has(row.id)).toBe(false);
  });
});

/**
 * SCRUM-344 — a promo code scoped to food comes off the food.
 *
 * SCRUM-401 prices every code from the park's own definition, so each scope is
 * a code defined in `pos.discount_definition`. The cart still sends the till's
 * own description beside the code, the shape `buildItemCartPayload` sends, and
 * it moves no money. What is being proved is the ENGINE'S reach through the
 * real route: which lines the definition's scope found, in satang, on rows the
 * platform priced itself.
 */
describe('a promo scope reaches the right item lines', () => {
  const lattePlusSocks = () => [
    itemLine('FB-LATTE', 1, { modifiers: [choose('FB-LATTE', 'Ice', 'No ice')] }),
    socksLine(),
  ];
  /** One 10 % code per scope, as the Discounts panel saves one. */
  const CODE_BY_SCOPE = new Map<string, string>();
  beforeAll(async () => {
    const [drinks] = await ctx.db
      .select()
      .from(productCategory)
      .where(and(eq(productCategory.operatorId, operatorId), eq(productCategory.name, 'Drinks')));
    const scopes: [string, Record<string, unknown>][] = [
      ['fnb', { kind: 'fnb' }],
      ['merch', { kind: 'merch' }],
      ['fnbCategory', { kind: 'fnbCategory', category: drinks!.id }],
      ['menuItems', { kind: 'menuItems', menuItemIds: [items.get('FB-LATTE')!.id] }],
      ['addOns', { kind: 'addOns' }],
    ];
    for (const [scope, target] of scopes) {
      const code = `TENOFF-${scope.toUpperCase()}`;
      CODE_BY_SCOPE.set(scope, code);
      await ctx.db.insert(discountDefinition).values({
        id: newId(),
        operatorId,
        code,
        label: '10% off',
        kind: 'percent',
        valueBp: 1000,
        target,
      });
    }
  });
  /** The scope's code, with the till's own description of it beside the code. */
  const promo = (target: { kind: string; [detail: string]: unknown }) => ({
    code: CODE_BY_SCOPE.get(target.kind)!,
    label: '10% off',
    type: 'percent' as const,
    value: 10,
    target,
  });
  /** The discount each line took, by the kind of line it is. */
  const discountByKind = async (saleId: string) => {
    const lines = await linesOf(saleId);
    return Object.fromEntries(lines.map((l) => [l.kind, l.discountSatang]));
  };

  it('takes a food-scoped code off the latte and not off the socks', async () => {
    const saleId = newId();
    const res = await commit({
      id: saleId,
      channel: 'fnb',
      items: lattePlusSocks(),
      promos: [promo({ kind: 'fnb' })],
    });
    expect(res.statusCode).toBe(200);
    // 10 % of the 95 baht latte, and nothing of the 120 baht socks.
    expect(res.json().sale.totals.promoDiscountSatang).toBe(b(9.5));
    expect(await discountByKind(saleId)).toEqual({ fnb_item: b(9.5), merch_item: 0 });
  });

  it('takes a shop-scoped code off the socks and not off the latte', async () => {
    const saleId = newId();
    const res = await commit({
      id: saleId,
      channel: 'shop',
      items: lattePlusSocks(),
      promos: [promo({ kind: 'merch' })],
    });
    expect(res.statusCode).toBe(200);
    expect(await discountByKind(saleId)).toEqual({ fnb_item: 0, merch_item: b(12) });
  });

  it('reaches a latte through its category PARENT', async () => {
    // Iced Latte is filed under Coffee, a sub-category of Drinks. A code scoped
    // to Drinks has to reach it, which is the walk resolveItemLines loads.
    const [drinks] = await ctx.db
      .select()
      .from(productCategory)
      .where(and(eq(productCategory.operatorId, operatorId), eq(productCategory.name, 'Drinks')));
    const saleId = newId();
    const res = await commit({
      id: saleId,
      channel: 'fnb',
      items: lattePlusSocks(),
      promos: [promo({ kind: 'fnbCategory', category: drinks!.id })],
    });
    expect(res.statusCode).toBe(200);
    expect(await discountByKind(saleId)).toEqual({ fnb_item: b(9.5), merch_item: 0 });
  });

  it('names one menu item by id and leaves the rest of the order alone', async () => {
    const saleId = newId();
    const res = await commit({
      id: saleId,
      channel: 'fnb',
      items: lattePlusSocks(),
      promos: [promo({ kind: 'menuItems', menuItemIds: [items.get('FB-LATTE')!.id] })],
    });
    expect(res.statusCode).toBe(200);
    expect(await discountByKind(saleId)).toEqual({ fnb_item: b(9.5), merch_item: 0 });
  });

  it('lets an add-ons code reach NEITHER — a latte is not a ticket add-on', async () => {
    // The other half of the old bug: an item line borrows the `addon` kind, so
    // a code for ticket add-ons used to discount lunch.
    const saleId = newId();
    const res = await commit({
      id: saleId,
      channel: 'fnb',
      items: lattePlusSocks(),
      promos: [promo({ kind: 'addOns' })],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sale.totals.promoDiscountSatang).toBe(0);
    expect(await discountByKind(saleId)).toEqual({ fnb_item: 0, merch_item: 0 });
    // Nothing was taken off the bill either.
    expect(res.json().sale.totals.grossSatang).toBe(b(95) + b(120));
  });
});
