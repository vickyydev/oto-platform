import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  account,
  auditLog,
  branch,
  branchHoliday,
  branchTaxConfig,
  modifierGroup,
  modifierOption,
  printTemplate,
  product,
  productCategory,
  productModifierGroup,
  sale,
  station,
  ticketPackage,
} from '@oto/db';
import { PRICING_ENGINE_VERSION, newId } from '@oto/shared';
import { branchCloneRoutes } from '../src/routes/branch-clone';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-204 — BRANCH CATALOGUE CLONE (R-03, proposal §6.4).
 *
 * **Why this file may register its own route.** `createTestContext` builds the
 * whole api from `src/app.ts`, and `app.ts` was another slice's file the day
 * this landed — the one line it needs went into the hand-over note instead. So
 * `beforeAll` looks at the route registry and registers the plugin only if
 * nothing else has: the file passes before that line lands and after it, and
 * nobody has to remember to come back and delete anything here. Everything else
 * is the real app — the session plugin, the permission guard, the idempotency
 * middleware, the same seeded database.
 */

let ctx: TestContext;
let adminCookie: string;
let receptionCookie: string;
let operatorId: string;
let centralId: string;
let chalongId: string;
let emptyBranchId: string;
let secondOperatorBranchId: string;

/** A branch with nothing in it, so a clone has somewhere to land. */
async function makeEmptyBranch(code: string, name: string): Promise<string> {
  const id = newId();
  await ctx.db.insert(branch).values({
    id,
    operatorId,
    name,
    code,
    timezone: 'Asia/Bangkok',
    country: 'TH',
  });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  // See the note at the top. Registering it twice is a Fastify error, not a
  // no-op, so the registry is asked first.
  const registered = ctx.app.routeRegistry.some((r) => r.url === '/branches/:id/clone');
  if (!registered) await ctx.app.register(branchCloneRoutes);
  await ctx.app.ready();

  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  centralId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalongId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  secondOperatorBranchId = await branchIdByCode(
    ctx.db,
    SECOND_OPERATOR_BRANCH_CODE,
    SECOND_OPERATOR_NAME,
  );
  const [centralRow] = await ctx.db.select().from(branch).where(eq(branch.id, centralId)).limit(1);
  operatorId = centralRow!.operatorId;
  emptyBranchId = await makeEmptyBranch('clone-target', 'Clone Target');
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const preview = (targetId: string, sourceId: string, cookie = adminCookie) =>
  ctx.app.inject({
    method: 'GET',
    url: `/branches/${targetId}/clone-preview?from=${sourceId}`,
    headers: { cookie },
  });

const clone = (targetId: string, sourceId: string, cookie = adminCookie) =>
  ctx.app.inject({
    method: 'POST',
    url: `/branches/${targetId}/clone`,
    headers: { cookie },
    payload: { sourceBranchId: sourceId },
  });

describe('the preview', () => {
  it('reports the seeded pair as already carrying what a clone would copy', async () => {
    const res = await preview(chalongId, centralId);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.sourceBranch.id).toBe(centralId);
    expect(body.targetBranch.id).toBe(chalongId);
    expect(body.targetHasSales).toBe(false);

    // The seed prices both parks and gives both the same holiday, the same tax
    // configuration and the same six print templates, so there is nothing to
    // create — which is what "already exists" has to be able to say.
    expect(body.counts.ticketPackages).toEqual({ created: 0, existing: 4, blocked: 0 });
    expect(body.counts.holidays).toEqual({ created: 0, existing: 1, blocked: 0 });
    expect(body.counts.taxConfig).toEqual({ created: 0, existing: 1, blocked: 0 });
    expect(body.counts.printTemplates).toEqual({ created: 0, existing: 6, blocked: 0 });
    expect(body.plan.printTemplates.exists).toContain('receipt');

    // The menu is seeded at Central only, so its items are the ones a clone
    // would carry — except that every seeded item has a code, and a code names
    // one product per operator. Those are reported blocked, with the reason.
    expect(body.counts.products.blocked).toBeGreaterThan(0);
    expect(body.plan.products.blocked[0].reason).toMatch(/whole operator/);

    // What a cloned item points at rather than copies is named on the answer.
    expect(body.shared).toContain('product categories');
  });

  it('refuses a source in another operator with 404, not 403', async () => {
    const res = await preview(chalongId, secondOperatorBranchId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('refuses a target in another operator with 404', async () => {
    const res = await preview(secondOperatorBranchId, centralId);
    expect(res.statusCode).toBe(404);
  });

  it('refuses a branch cloned into itself', async () => {
    const res = await preview(centralId, centralId);
    expect(res.statusCode).toBe(400);
  });
});

describe('the clone', () => {
  /**
   * An item with NO code and no barcode, an inline modifier group of its own,
   * and a link into the shared library. It is what proves the two halves of the
   * rule in one row: the branch-owned parts are copied with fresh ids, and the
   * operator-wide parts — its category, the library group — are pointed at.
   */
  let sourceProductId: string;
  let sharedCategoryId: string;
  let sharedLibraryGroupId: string;
  let inlineGroupId: string;

  beforeAll(async () => {
    const [category] = await ctx.db
      .select()
      .from(productCategory)
      .where(and(eq(productCategory.operatorId, operatorId), isNull(productCategory.archivedAt)))
      .limit(1);
    sharedCategoryId = category!.id;

    const [library] = await ctx.db
      .select()
      .from(modifierGroup)
      .where(and(eq(modifierGroup.operatorId, operatorId), isNull(modifierGroup.productId)))
      .limit(1);
    sharedLibraryGroupId = library!.id;

    sourceProductId = newId();
    await ctx.db.insert(product).values({
      id: sourceProductId,
      operatorId,
      branchId: centralId,
      categoryId: sharedCategoryId,
      kind: 'menu',
      name: 'Birthday Cupcake',
      priceSatang: 8000,
      sortOrder: 99,
    });
    inlineGroupId = newId();
    await ctx.db.insert(modifierGroup).values({
      id: inlineGroupId,
      operatorId,
      productId: sourceProductId,
      name: 'Candle',
      required: false,
      selectionType: 'single',
    });
    await ctx.db.insert(modifierOption).values({
      id: newId(),
      operatorId,
      modifierGroupId: inlineGroupId,
      name: 'One candle',
      priceSatang: 1000,
    });
    await ctx.db.insert(productModifierGroup).values({
      operatorId,
      productId: sourceProductId,
      modifierGroupId: sharedLibraryGroupId,
      sortOrder: 0,
    });
  });

  it('copies the branch-owned rows with fresh ids and shares the operator-wide ones', async () => {
    const res = await clone(emptyBranchId, centralId);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.counts.ticketPackages.created).toBe(4);
    expect(body.counts.holidays.created).toBe(1);
    expect(body.counts.taxConfig.created).toBe(1);
    expect(body.counts.printTemplates.created).toBe(6);
    expect(body.counts.products.created).toBeGreaterThanOrEqual(1);
    expect(body.created).toBeGreaterThan(10);

    // --- fresh ids, same content ------------------------------------------
    const sourcePackages = await ctx.db
      .select()
      .from(ticketPackage)
      .where(eq(ticketPackage.branchId, centralId));
    const clonedPackages = await ctx.db
      .select()
      .from(ticketPackage)
      .where(eq(ticketPackage.branchId, emptyBranchId));
    expect(clonedPackages).toHaveLength(4);
    const sourceIds = new Set(sourcePackages.map((p) => p.id));
    for (const p of clonedPackages) expect(sourceIds.has(p.id)).toBe(false);
    expect(clonedPackages.map((p) => p.name).sort()).toEqual(
      sourcePackages.map((p) => p.name).sort(),
    );
    // The price map travels verbatim — it is keyed by tier code, and tiers are
    // the operator's, shared by both branches.
    const byName = new Map(clonedPackages.map((p) => [p.name, p]));
    for (const p of sourcePackages) expect(byName.get(p.name)!.prices).toEqual(p.prices);

    const [clonedTax] = await ctx.db
      .select()
      .from(branchTaxConfig)
      .where(eq(branchTaxConfig.branchId, emptyBranchId));
    const [sourceTax] = await ctx.db
      .select()
      .from(branchTaxConfig)
      .where(eq(branchTaxConfig.branchId, centralId));
    expect(clonedTax!.config).toEqual(sourceTax!.config);
    expect(clonedTax!.id).not.toBe(sourceTax!.id);

    const clonedHolidays = await ctx.db
      .select()
      .from(branchHoliday)
      .where(eq(branchHoliday.branchId, emptyBranchId));
    expect(clonedHolidays).toHaveLength(1);
    expect(clonedHolidays[0]!.name).toBe('Loy Krathong');

    // A print template's version starts again at 1: a box syncs on that number.
    const clonedTemplates = await ctx.db
      .select()
      .from(printTemplate)
      .where(eq(printTemplate.branchId, emptyBranchId));
    expect(clonedTemplates).toHaveLength(6);
    for (const t of clonedTemplates) expect(t.version).toBe(1);

    // --- the item, its inline group, and what it only points at -------------
    const [clonedItem] = await ctx.db
      .select()
      .from(product)
      .where(and(eq(product.branchId, emptyBranchId), eq(product.name, 'Birthday Cupcake')))
      .limit(1);
    expect(clonedItem).toBeDefined();
    expect(clonedItem!.id).not.toBe(sourceProductId);
    expect(clonedItem!.priceSatang).toBe(8000);
    // REFERENCED, not copied: the category is the operator's own row.
    expect(clonedItem!.categoryId).toBe(sharedCategoryId);

    const [clonedInline] = await ctx.db
      .select()
      .from(modifierGroup)
      .where(eq(modifierGroup.productId, clonedItem!.id))
      .limit(1);
    expect(clonedInline).toBeDefined();
    expect(clonedInline!.id).not.toBe(inlineGroupId);
    expect(clonedInline!.name).toBe('Candle');
    const clonedOptions = await ctx.db
      .select()
      .from(modifierOption)
      .where(eq(modifierOption.modifierGroupId, clonedInline!.id));
    expect(clonedOptions.map((o) => o.name)).toEqual(['One candle']);

    const clonedLinks = await ctx.db
      .select()
      .from(productModifierGroup)
      .where(eq(productModifierGroup.productId, clonedItem!.id));
    expect(clonedLinks).toHaveLength(1);
    // REFERENCED, not copied: the same library group id as the source item's.
    expect(clonedLinks[0]!.modifierGroupId).toBe(sharedLibraryGroupId);
  });

  it('is audited as catalog.clone with the source branch and the counts', async () => {
    const [row] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'catalog.clone'), eq(auditLog.entityId, emptyBranchId)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.branchId).toBe(emptyBranchId);
    expect(row!.actorAccountId).not.toBeNull();
    const after = row!.after as {
      sourceBranchId: string;
      created: number;
      counts: Record<string, { created: number }>;
    };
    expect(after.sourceBranchId).toBe(centralId);
    expect(after.counts.ticketPackages?.created).toBe(4);
    expect(after.created).toBeGreaterThan(10);
  });

  it('creates nothing on a second run and says everything already exists', async () => {
    const before = await ctx.db
      .select()
      .from(ticketPackage)
      .where(eq(ticketPackage.branchId, emptyBranchId));

    const res = await clone(emptyBranchId, centralId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(0);
    expect(body.counts.ticketPackages).toEqual({ created: 0, existing: 4, blocked: 0 });
    expect(body.counts.printTemplates.existing).toBe(6);
    expect(body.counts.holidays).toEqual({ created: 0, existing: 1, blocked: 0 });
    expect(body.counts.taxConfig.existing).toBe(1);

    const after = await ctx.db
      .select()
      .from(ticketPackage)
      .where(eq(ticketPackage.branchId, emptyBranchId));
    expect(after.map((p) => p.id).sort()).toEqual(before.map((p) => p.id).sort());

    const items = await ctx.db
      .select()
      .from(product)
      .where(and(eq(product.branchId, emptyBranchId), eq(product.name, 'Birthday Cupcake')));
    expect(items).toHaveLength(1);

    const templates = await ctx.db
      .select()
      .from(printTemplate)
      .where(eq(printTemplate.branchId, emptyBranchId));
    expect(templates).toHaveLength(6);
  });

  it('replays the same idempotency key instead of cloning a second time', async () => {
    const target = await makeEmptyBranch('clone-target-2', 'Clone Target Two');
    const key = newId();
    const send = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/branches/${target}/clone`,
        headers: { cookie: adminCookie, 'idempotency-key': key },
        payload: { sourceBranchId: centralId },
      });

    const first = await send();
    expect(first.statusCode).toBe(200);
    const second = await send();
    expect(second.statusCode).toBe(200);
    // Byte-identical, and — the part that matters — the second request did no
    // work at all: the answer came out of the replay store.
    expect(second.json()).toEqual(first.json());
    expect(first.json().created).toBeGreaterThan(0);

    const packages = await ctx.db
      .select()
      .from(ticketPackage)
      .where(eq(ticketPackage.branchId, target));
    expect(packages).toHaveLength(4);
  });
});

describe('the refusals', () => {
  it('refuses a target that has taken sales, and says why', async () => {
    // A sale at Central, written straight into the ledger: this test is about
    // the guard, not about the till that would normally put the row there.
    const [centralRow] = await ctx.db.select().from(branch).where(eq(branch.id, centralId)).limit(1);
    const [till] = await ctx.db
      .select()
      .from(station)
      .where(eq(station.branchId, centralId))
      .limit(1);
    const [actor] = await ctx.db.select().from(account).limit(1);
    const gross = 52000;
    const tax = Math.round((gross * 7) / 107);
    await ctx.db.insert(sale).values({
      id: newId(),
      operatorId,
      branchId: centralId,
      stationId: till!.id,
      businessDate: '2026-09-19',
      businessDayStart: centralRow!.businessDayStart,
      timezone: centralRow!.timezone,
      occurredAt: new Date('2026-09-19T12:00:00+07:00'),
      createdByAccountId: actor!.id,
      pricingMode: 'weekday',
      pricingModeReason: 'Weekday pricing',
      customerTier: 'tourist',
      engineVersion: PRICING_ENGINE_VERSION,
      taxConfig: { rates: [], categoryRules: [], discountPlacement: 'before_tax' },
      taxBreakdown: { categories: [], grandTotal: gross },
      subtotalSatang: gross,
      netSatang: gross - tax,
      taxInclusiveSatang: tax,
      grossSatang: gross,
      status: 'tendering',
    });

    const res = await clone(centralId, chalongId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BRANCH_HAS_SALES');
    expect(res.json().error.message).toMatch(/already taken sales/);

    // And the preview says so too, rather than offering a copy that would fail.
    const shown = await preview(centralId, chalongId);
    expect(shown.statusCode).toBe(200);
    expect(shown.json().targetHasSales).toBe(true);
  });

  it('refuses reception, who may read a price list but not fill a branch with one', async () => {
    const res = await clone(emptyBranchId, centralId, receptionCookie);
    expect(res.statusCode).toBe(403);
  });

  it('refuses a source in another operator with 404 on the write too', async () => {
    const res = await clone(emptyBranchId, secondOperatorBranchId);
    expect(res.statusCode).toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${emptyBranchId}/clone`,
      payload: { sourceBranchId: centralId },
    });
    expect(res.statusCode).toBe(401);
  });
});
