import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  branch,
  member,
  modifierGroup,
  modifierOption,
  product,
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
 *   Grip Socks       ฿120 of merchandise, under Apparel
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

  it('writes the size a merch line sold, and books it as merchandise', async () => {
    const saleId = newId();
    const res = await commit({
      id: saleId,
      items: [
        itemLine('MR-SOCKS', 1, { variant: { variantId: 'size-m', variantLabel: 'M' } }),
      ],
    });
    expect(res.statusCode).toBe(200);

    const lines = await linesOf(saleId);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.kind).toBe('merch_item');
    expect(line.label).toBe('Grip Socks');
    expect(line.unitSatang).toBe(b(120));
    expect(line.taxableCategory).toBe('merch');
    expect(line.payload).toMatchObject({ variant: { variantId: 'size-m', variantLabel: 'M' } });
    // Merchandise is handed over at the till and prints no prep ticket at all.
    expect((line.payload as { prepStation?: string }).prepStation).toBeUndefined();
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
      items: [itemLine('MR-SOCKS', 1, { lineTotalSatang: b(1) })],
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
    await commit({ id: saleId, items: [itemLine('MR-SOCKS', 1)] });
    const closed = await finalise(saleId, { method: 'cash' });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().pickupCode).toBeNull();
  });
});
