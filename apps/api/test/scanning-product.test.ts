import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { product, productCategory, station, stationEvent } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { resolveProductBarcode } from '../src/services/scanning-product';

/**
 * S2-09b — the product barcode, from the scanner simulator to the merch row.
 *
 * The box's half — which strings are barcodes, and that a miss adds nothing —
 * is proved in `packages/box-agent/test/scan.test.ts` with the lookup stubbed.
 * What can only be proved here is the half that needs a catalogue and a
 * tenant: that `8850000000017` reaches the merch row it names **in this
 * operator's catalogue and no other**.
 *
 * That scoping is the case worth the file. `product_sku_unique` is keyed on
 * (operator, sku), so the same thirteen digits legitimately name a different
 * product at a different operator — which means a lookup that forgets the
 * operator is not merely untidy, it lets a second tenant put a line on this
 * park's till by printing a label. The fixture's second operator sells a
 * DIFFERENT product under the SAME barcode below, so a query filtering by
 * operator and a query filtering by nothing return different rows and the test
 * can tell them apart. Delete `eq(product.operatorId, …)` from
 * `resolveProductBarcode` and this file goes red.
 *
 * **Sizes (S2-09b, the owner's decision of 2026-09-24).** The seeded barcode is
 * on a SIZE: the grip socks come in S, M and L and the digits are printed on
 * the M's tag, so the answer names the item AND the size. An item's own code
 * names no size. Both are asked below.
 *
 * **What it does not prove.** Nothing here adds a line to a cart: the scan
 * answer carries the line as an INTENT on the station channel
 * (`detail.add`), and the shop screen consumes it. The intent's shape is
 * asserted, because that is the contract between the two;
 * `station-scans.test.ts` follows it onto the channel.
 */

/** The seeded barcode from the acceptance criterion. 885 is GS1 Thailand. */
const SEEDED_BARCODE = '8850000000017';
/** Thirteen digits nobody sells. Shaped like a barcode, which is the point. */
const NOBODYS_BARCODE = '0000000000000';

let ctx: TestContext;
let adminCookie: string;
let secondCookie: string;
let centralBranchId: string;
let otoOperatorId: string;
let secondOperatorId: string;
let secondBranchId: string;
let tillId: string;
let socksId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  secondCookie = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);

  otoOperatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  secondOperatorId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  centralBranchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  secondBranchId = await branchIdByCode(
    ctx.db,
    SECOND_OPERATOR_BRANCH_CODE,
    SECOND_OPERATOR_NAME,
  );

  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.operatorId, otoOperatorId), eq(station.branchId, centralBranchId)));
  tillId = stations.find((s) => s.name === 'Reception Till 1')!.id;

  /**
   * The seed carries the barcode: `packages/db/src/seed/menu.ts` holds the
   * prototype's Grip Socks (`MR-SOCKS`) in S, M and L, with `8850000000017` on
   * the M, so the acceptance criterion's "seeded barcode" is read back here
   * rather than minted. The second operator's twin below is still created
   * through the Merch panel's route, which keeps that path proven reachable
   * from the admin screen as well as from the scanner.
   */
  const [seeded] = await ctx.db
    .select({ id: product.id, variants: product.variants })
    .from(product)
    .where(and(eq(product.operatorId, otoOperatorId), eq(product.code, 'MR-SOCKS')));
  if (!seeded?.variants.some((v) => v.barcode === SEEDED_BARCODE)) {
    throw new Error(`the seed's grip socks no longer carry ${SEEDED_BARCODE} on a size`);
  }
  socksId = seeded.id;
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts: { cookie?: string; payload?: unknown; headers?: Record<string, string> } = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    payload: opts.payload as never,
  });
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

/**
 * A merch category inside one operator, created if that tenant has none.
 *
 * `product_category` is operator-wide and carries no branch, so the seed's
 * `MERCH-APPAREL` belongs to OTO and the second operator cannot name it — the
 * route answers "Menu category not found", which is SCRUM-290 working. The
 * foreign tenant gets its own.
 */
async function ensureCategory(
  cookie: string,
  operatorId: string,
  code: string,
  name: string,
): Promise<string> {
  const [held] = await ctx.db
    .select({ id: productCategory.id })
    .from(productCategory)
    .where(and(eq(productCategory.operatorId, operatorId), eq(productCategory.code, code)))
    .limit(1);
  if (held) return held.id;
  const res = await call('POST', '/menu/categories', {
    cookie,
    headers: { 'idempotency-key': `cat-${code}-${operatorId}` },
    payload: { code, name, taxableCategory: 'merch', sortOrder: 9 },
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return res.body.id as string;
}

/** A merch item through the route the admin Merch panel calls. */
async function createMerch(
  cookie: string,
  operatorId: string,
  branchId: string,
  categoryCode: string,
  body: { name: string; code: string; sku: string; priceSatang: number },
): Promise<string> {
  const categoryId = await ensureCategory(cookie, operatorId, categoryCode, 'Apparel');
  const res = await call('POST', `/branches/${branchId}/menu/products`, {
    cookie,
    headers: { 'idempotency-key': `merch-${body.code}-${branchId}` },
    payload: { ...body, kind: 'merch', categoryId, sortOrder: 0, active: true },
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return res.body.id as string;
}

/** What the Console's scanner simulator sends, at one station. */
async function simulate(code: string, cookie = adminCookie) {
  return call('POST', `/stations/${tillId}/scan/simulate`, {
    cookie,
    payload: { code, mode: 'hid' },
  });
}

describe('a scanned barcode resolves to the merch item (S2-09b)', () => {
  it('turns the seeded barcode into a shop line for the grip socks in size M', async () => {
    const res = await simulate(SEEDED_BARCODE);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.kind).toBe('product');
    expect(res.body.outcome).toBe('handled');
    expect(res.body.handler).toBe('product-barcode');
    expect(res.body.handlers).toContain('product-barcode');

    const add = (res.body.detail as { add?: Record<string, unknown> }).add!;
    expect(add.productId).toBe(socksId);
    expect(add.name).toBe('Grip Socks');
    // The answer names the size the digits are on, and says the pair in words.
    expect(add.variant).toEqual({ id: 'm', label: 'M' });
    expect(add.label).toBe('Grip Socks M');
    expect(add.sku).toBe(SEEDED_BARCODE);
    expect(add.priceSatang).toBe(12000);
    expect(add.quantity).toBe(1);
    expect(add.branchId).toBe(centralBranchId);
  });

  it('answers "unknown barcode" and adds nothing for a code nobody sells', async () => {
    const res = await simulate(NOBODYS_BARCODE);
    expect(res.statusCode).toBe(200);
    expect(res.body.kind).toBe('product');
    expect(res.body.outcome).toBe('refused');
    expect(res.body.errorCode).toBe('UNKNOWN_BARCODE');
    expect((res.body.detail as Record<string, unknown>).message).toBe('Unknown barcode');
    expect((res.body.detail as Record<string, unknown>).add).toBeUndefined();
  });

  it('treats a malformed code as no barcode at all, and adds nothing', async () => {
    const res = await simulate('NOT-A-BARCODE');
    expect(res.statusCode).toBe(200);
    expect(res.body.kind).toBe('unknown');
    expect(res.body.outcome).toBe('unhandled');
    expect(res.body.handler).toBeNull();
    expect(res.body.detail).toBeUndefined();
  });

  it('keeps the product off the tape — a fingerprint, and nothing a page can read', async () => {
    await simulate(SEEDED_BARCODE);
    const [row] = await ctx.db
      .select()
      .from(stationEvent)
      .where(and(eq(stationEvent.stationId, tillId), eq(stationEvent.kind, 'scan')))
      .orderBy(desc(stationEvent.receivedAt))
      .limit(1);
    const whole = JSON.stringify(row);
    expect(whole).not.toContain(SEEDED_BARCODE);
    expect(whole).not.toContain('Grip Socks');
    const payload = row!.payload as Record<string, unknown>;
    expect(payload.codeKind).toBe('product');
    expect(payload.outcome).toBe('handled');
    expect(payload.handler).toBe('product-barcode');
    expect(String(payload.codeFingerprint)).toHaveLength(16);
  });
});

describe('the barcode is read inside the station’s own operator, and no other', () => {
  it('finds this park’s product when a second operator sells the same barcode', async () => {
    // The foreign tenant prints the same thirteen digits on a different thing.
    const theirs = await createMerch(secondCookie, secondOperatorId, secondBranchId, 'SO-APPAREL', {
      name: 'Someone else’s socks',
      code: 'SO-SOCKS-M',
      sku: SEEDED_BARCODE,
      priceSatang: 99900,
    });
    expect(theirs).not.toBe(socksId);

    const res = await simulate(SEEDED_BARCODE);
    const add = (res.body.detail as { add?: Record<string, unknown> }).add!;
    expect(add.productId).toBe(socksId);
    expect(add.label).toBe('Grip Socks M');
    expect(add.priceSatang).toBe(12000);
  });

  it('answers unknown for a barcode only the second operator sells', async () => {
    await createMerch(secondCookie, secondOperatorId, secondBranchId, 'SO-APPAREL', {
      name: 'Their own thing',
      code: 'SO-THING',
      sku: '8851111111114',
      priceSatang: 5000,
    });
    const res = await simulate('8851111111114');
    expect(res.body.outcome).toBe('refused');
    expect(res.body.errorCode).toBe('UNKNOWN_BARCODE');
  });

  /**
   * The case that actually holds the operator clause up.
   *
   * Every product above is pinned to a branch, so the branch half of the WHERE
   * (`or(branch, null)`) already excludes the foreign tenant's rows and the
   * operator half could be deleted with every assertion still passing — which
   * is exactly what a plant showed. An operator-wide merch row is the state
   * that separates them: `product.branch_id` is nullable and null means "every
   * park of this operator", the same rule `readMenu` reads by. The foreign
   * tenant's operator-wide row passes the branch clause at OUR till, so only
   * `eq(product.operatorId, …)` keeps it out.
   *
   * It is inserted rather than posted because the item routes hang off
   * `/branches/:branchId/…` and always stamp a branch — a row with none is a
   * state the schema and the read model both allow and no route creates today.
   */
  it('keeps out a foreign operator’s branch-wide barcode, which the branch clause lets through', async () => {
    await ctx.db.insert(product).values({
      id: newId(),
      operatorId: secondOperatorId,
      branchId: null,
      categoryId: null,
      kind: 'merch',
      code: 'SO-EVERYWHERE',
      name: 'Their operator-wide socks',
      priceSatang: 77700,
      sku: '8854444444443',
    });

    const res = await simulate('8854444444443');
    expect(res.body.outcome).toBe('refused');
    expect(res.body.errorCode).toBe('UNKNOWN_BARCODE');

    // And the same question asked of the service, both ways round.
    expect(
      await resolveProductBarcode(
        ctx.db,
        { operatorId: otoOperatorId, branchId: centralBranchId },
        '8854444444443',
      ),
    ).toBeNull();
    expect(
      (
        await resolveProductBarcode(
          ctx.db,
          { operatorId: secondOperatorId, branchId: secondBranchId },
          '8854444444443',
        )
      )?.name,
    ).toBe('Their operator-wide socks');
  });

  it('resolves the same way when the service is asked directly, per operator', async () => {
    const ours = await resolveProductBarcode(
      ctx.db,
      { operatorId: otoOperatorId, branchId: centralBranchId },
      SEEDED_BARCODE,
    );
    expect(ours?.name).toBe('Grip Socks');
    expect(ours?.variant).toEqual({ id: 'm', label: 'M' });

    const theirs = await resolveProductBarcode(
      ctx.db,
      { operatorId: secondOperatorId, branchId: secondBranchId },
      SEEDED_BARCODE,
    );
    expect(theirs?.name).toBe('Someone else’s socks');

    const nobody = await resolveProductBarcode(
      ctx.db,
      { operatorId: otoOperatorId, branchId: centralBranchId },
      NOBODYS_BARCODE,
    );
    expect(nobody).toBeNull();
  });

  it('does not reach an F&B item through the scanner', async () => {
    // A plate of food is sold from a grid somebody taps, not from a label.
    const [menuRow] = await ctx.db
      .select({ id: product.id })
      .from(product)
      .where(
        and(
          eq(product.operatorId, otoOperatorId),
          eq(product.kind, 'menu'),
          isNull(product.archivedAt),
        ),
      )
      .limit(1);
    await call(`PATCH`, `/branches/${centralBranchId}/menu/products/${menuRow!.id}`, {
      cookie: adminCookie,
      payload: { sku: '8852222222227' },
    });
    const res = await simulate('8852222222227');
    expect(res.body.outcome).toBe('refused');
    expect(res.body.errorCode).toBe('UNKNOWN_BARCODE');
  });

  it('answers unknown once the item is withdrawn, freeing its code', async () => {
    const gone = await createMerch(adminCookie, otoOperatorId, centralBranchId, 'MERCH-APPAREL', {
      name: 'Discontinued cap',
      code: 'MR-CAP-OLD',
      sku: '8853333333330',
      priceSatang: 1000,
    });
    expect((await simulate('8853333333330')).body.outcome).toBe('handled');
    const archived = await call(
      'DELETE',
      `/branches/${centralBranchId}/menu/products/${gone}`,
      { cookie: adminCookie },
    );
    expect(archived.statusCode).toBe(200);
    const res = await simulate('8853333333330');
    expect(res.body.outcome).toBe('refused');
    expect(res.body.errorCode).toBe('UNKNOWN_BARCODE');
  });
});

describe('a barcode on a size names the item and the size (S2-09b)', () => {
  /** A merch item with sizes, through the route the Merch panel's form calls. */
  async function createSized(
    cookie: string,
    operatorId: string,
    branchId: string,
    categoryCode: string,
    body: {
      name: string;
      code: string;
      sku?: string;
      variants: Array<{ id: string; label: string; barcode?: string }>;
    },
    kind: 'merch' | 'menu' = 'merch',
  ): Promise<string> {
    const categoryId = await ensureCategory(cookie, operatorId, categoryCode, 'Apparel');
    const res = await call('POST', `/branches/${branchId}/menu/products`, {
      cookie,
      headers: { 'idempotency-key': `sized-${body.code}-${branchId}` },
      payload: { ...body, kind, priceSatang: 25000, categoryId, sortOrder: 0, active: true },
    });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    return res.body.id as string;
  }

  it('names no size for the item’s OWN code, even on an item that has sizes', async () => {
    // The whole item's code picks out the item; which size is still a
    // question, and the shop screen asks it exactly as a tap on the tile does.
    const id = await createSized(adminCookie, otoOperatorId, centralBranchId, 'MERCH-APPAREL', {
      name: 'Rash vest',
      code: 'MR-VEST',
      sku: '8858888888887',
      variants: [
        { id: 's', label: 'S', barcode: '8858888888801' },
        { id: 'm', label: 'M' },
      ],
    });
    const whole = await simulate('8858888888887');
    const add = (whole.body.detail as { add?: Record<string, unknown> }).add!;
    expect(add.productId).toBe(id);
    expect(add.variant).toBeNull();
    expect(add.label).toBe('Rash vest');

    const small = await simulate('8858888888801');
    const sized = (small.body.detail as { add?: Record<string, unknown> }).add!;
    expect(sized.productId).toBe(id);
    expect(sized.variant).toEqual({ id: 's', label: 'S' });
    expect(sized.label).toBe('Rash vest S');
    expect(sized.sku).toBe('8858888888801');
  });

  it('keeps a size barcode printed by another operator out of this park', async () => {
    await createSized(secondCookie, secondOperatorId, secondBranchId, 'SO-APPAREL', {
      name: 'Their sized socks',
      code: 'SO-SIZED',
      variants: [{ id: 'm', label: 'M', barcode: '8855555555500' }],
    });
    const here = await simulate('8855555555500');
    expect(here.body.outcome).toBe('refused');
    expect(here.body.errorCode).toBe('UNKNOWN_BARCODE');
    expect(
      await resolveProductBarcode(
        ctx.db,
        { operatorId: otoOperatorId, branchId: centralBranchId },
        '8855555555500',
      ),
    ).toBeNull();
    expect(
      (
        await resolveProductBarcode(
          ctx.db,
          { operatorId: secondOperatorId, branchId: secondBranchId },
          '8855555555500',
        )
      )?.variant,
    ).toEqual({ id: 'm', label: 'M' });
  });

  it('answers unknown for a size barcode once its item is withdrawn', async () => {
    const id = await createSized(adminCookie, otoOperatorId, centralBranchId, 'MERCH-APPAREL', {
      name: 'Old hoodie',
      code: 'MR-HOODIE-OLD',
      variants: [{ id: 'l', label: 'L', barcode: '8856666666600' }],
    });
    expect((await simulate('8856666666600')).body.outcome).toBe('handled');
    await call('DELETE', `/branches/${centralBranchId}/menu/products/${id}`, {
      cookie: adminCookie,
    });
    const res = await simulate('8856666666600');
    expect(res.body.outcome).toBe('refused');
    expect(res.body.errorCode).toBe('UNKNOWN_BARCODE');
  });

  it('does not reach a size on an F&B item through the scanner', async () => {
    // The route takes sizes on any item; the scanner still reads only the shop.
    await createSized(
      adminCookie,
      otoOperatorId,
      centralBranchId,
      'FOOD',
      {
        name: 'Sized fries',
        code: 'FB-SIZED',
        variants: [{ id: 'l', label: 'Large', barcode: '8857777777700' }],
      },
      'menu',
    );
    const res = await simulate('8857777777700');
    expect(res.body.outcome).toBe('refused');
    expect(res.body.errorCode).toBe('UNKNOWN_BARCODE');
  });
});
