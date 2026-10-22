import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, modifierGroup, modifierOption, product, productCategory, ticketPackage, tier } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string;
let operatorId: string;
let branchId: string;
let baseTier: string;
beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.ready();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: admin } });
  expect(me.statusCode).toBe(200);
  operatorId = me.json().account.operatorId;
  const branches = await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie: admin } });
  expect(branches.statusCode).toBe(200);
  branchId = me.json().branch?.id ?? branches.json().branches[0].id;
  const tiers = await ctx.app.inject({ method: 'GET', url: '/tiers', headers: { cookie: admin } });
  baseTier = tiers.json().tiers.find((row: { isDefault: boolean }) => row.isDefault).id;
});
const headers = (key = newId()) => ({ cookie: admin, 'idempotency-key': key });
const entityAudits = (id: string) => ctx.db.select().from(auditLog).where(eq(auditLog.entityId, id));
const futureTranslations = {
  th: { name: 'ZZ TEST Thai label', description: 'ZZ TEST description', future: { style: 'kept' } },
  'zz-local': { name: 'ZZ TEST another language', futureVariants: ['short', 'long'] },
};
afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('SCRUM-621 catalogue response contracts', () => {
  for (const [label, routes] of [
    ['operator tiers', [['/tiers', 'get'], ['/tiers', 'post'], ['/tiers/{code}', 'patch'], ['/tiers/{code}', 'delete']]],
    ['branch ticket packages', [['/branches/{branchId}/ticket-packages', 'get'], ['/branches/{branchId}/ticket-packages', 'post'], ['/branches/{branchId}/ticket-packages/{id}', 'patch'], ['/branches/{branchId}/ticket-packages/{id}', 'delete']]],
    ['the menu read and branch products', [['/branches/{branchId}/menu', 'get'], ['/branches/{branchId}/menu/products', 'post'], ['/branches/{branchId}/menu/products/{id}', 'patch'], ['/branches/{branchId}/menu/products/{id}', 'delete']]],
  ] as const) {
    it(`describes all four lifted answers for ${label}`, () => {
      const document = ctx.app.swagger();
      for (const [path, verb] of routes) {
        const response = document.paths?.[path]?.[verb]?.responses?.['200'];
        expect(Boolean(response && 'content' in response && response.content), `${verb} ${path} must describe the actual response`).toBe(true);
      }
    });
  }

  it('keeps tier code IDs, canonical read-back and one audit per keyed create/update/archive', async () => {
    const code = 'zz_test_621_contract';
    const body = { code, name: 'ZZ TEST Contract tier', requiresVerification: true, sortOrder: 90 };
    const createHeaders = headers();
    const created = await ctx.app.inject({ method: 'POST', url: '/tiers', headers: createHeaders, payload: body });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ id: code });
    const replay = await ctx.app.inject({ method: 'POST', url: '/tiers', headers: createHeaders, payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(created.json());
    const [stored] = await ctx.db.select().from(tier).where(and(eq(tier.operatorId, operatorId), eq(tier.code, code)));
    const patchHeaders = headers();
    for (let n = 0; n < 2; n++) {
      const patched = await ctx.app.inject({ method: 'PATCH', url: `/tiers/${code}`, headers: patchHeaders, payload: { name: 'ZZ TEST Renamed contract tier' } });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toEqual({ ok: true });
    }
    const list = await ctx.app.inject({ method: 'GET', url: '/tiers', headers: { cookie: admin } });
    expect(list.json().tiers.find((row: { id: string }) => row.id === code)).toEqual({
      id: code, name: 'ZZ TEST Renamed contract tier', isDefault: false, requiresVerification: true, sortOrder: 90,
    });
    const deleteHeaders = headers();
    for (let n = 0; n < 2; n++) {
      const archived = await ctx.app.inject({ method: 'DELETE', url: `/tiers/${code}`, headers: deleteHeaders });
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toEqual({ ok: true });
    }
    expect((await entityAudits(stored!.id)).map(row => row.action).sort()).toEqual(['tier.archive', 'tier.create', 'tier.update']);
  });

  it('retains every ticket row column and future JSON keys across an unrelated keyed edit and archive', async () => {
    const id = newId();
    const body = { id, name: 'ZZ TEST Contract ticket', durationLabel: '2 Hours', hours: 2, prices: { [baseTier]: { weekday: 12345, weekend: 23456 } } };
    const createHeaders = headers();
    for (let n = 0; n < 2; n++) {
      const created = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/ticket-packages`, headers: createHeaders, payload: body });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toEqual({ id });
    }
    const future = {
      description: 'ZZ TEST Hidden description',
      prices: { [baseTier]: { weekday: 12345, weekend: 23456, futureCurrency: { scale: 100 } } },
      tierPricing: { [baseTier]: { mode: 'manual', value: 0, future: ['keep'] } },
      adultRules: { [baseTier]: { kind: 'set_price', price: { weekday: 1000, weekend: 2000, future: true }, futureRule: { revision: 2 } } },
      freebies: [{ id: 'zz-extra', kind: 'child', quantity: 1, tiers: [baseTier], future: { retained: true } }],
      creditRule: { appliesTo: 'kids', basis: 'fixed', value: 100, futureCredit: ['kept'] },
      translations: futureTranslations,
    };
    await ctx.db.update(ticketPackage).set(future).where(eq(ticketPackage.id, id));
    const assertWholeRow = async (includeArchived = false) => {
      const response = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/ticket-packages${includeArchived ? '?includeArchived=true' : ''}`, headers: { cookie: admin } });
      expect(response.statusCode).toBe(200);
      const [stored] = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.id, id));
      expect(response.json().packages.find((row: { id: string }) => row.id === id)).toEqual(JSON.parse(JSON.stringify(stored)));
    };
    await assertWholeRow();
    const patchHeaders = headers();
    for (let n = 0; n < 2; n++) {
      const patched = await ctx.app.inject({ method: 'PATCH', url: `/branches/${branchId}/ticket-packages/${id}`, headers: patchHeaders, payload: { name: 'ZZ TEST Renamed contract ticket' } });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toEqual({ ok: true });
    }
    await assertWholeRow();
    const deleteHeaders = headers();
    for (let n = 0; n < 2; n++) {
      const archived = await ctx.app.inject({ method: 'DELETE', url: `/branches/${branchId}/ticket-packages/${id}`, headers: deleteHeaders });
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toEqual({ ok: true });
    }
    await assertWholeRow(true);
    expect((await entityAudits(id)).map(row => row.action).sort()).toEqual(['ticket_package.archive', 'ticket_package.create', 'ticket_package.update']);
  });

  it('retains the complete menu projection, language and variant extras through an add-on edit and withdrawal', async () => {
    const categoryId = newId(), groupId = newId(), optionId = newId();
    await ctx.db.insert(productCategory).values({ id: categoryId, operatorId, name: 'ZZ TEST Contract category', taxableCategory: 'addons', defaultPrepStation: 'none', translations: futureTranslations });
    await ctx.db.insert(modifierGroup).values({ id: groupId, operatorId, name: 'ZZ TEST Contract question', selectionType: 'multi', translations: futureTranslations });
    await ctx.db.insert(modifierOption).values({ id: optionId, operatorId, modifierGroupId: groupId, name: 'ZZ TEST Contract answer', priceSatang: 25, translations: futureTranslations });
    const body = { name: 'ZZ TEST Contract add-on', kind: 'addon', categoryId, priceSatang: 1234, modifierGroupIds: [groupId] };
    const createHeaders = headers();
    const created = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/menu/products`, headers: createHeaders, payload: body });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    const replay = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/menu/products`, headers: createHeaders, payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ id });
    const variants = [{ id: 'one', label: 'ZZ TEST Size', sku: 'ZZ_TEST_621_SKU', barcode: 'ZZ_TEST_621_BARCODE', future: { kept: ['value'] } }];
    await ctx.db.update(product).set({ translations: futureTranslations, variants }).where(eq(product.id, id));
    const assertMenu = async (includeArchived = false) => {
      const response = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/menu${includeArchived ? '?includeArchived=true' : ''}`, headers: { cookie: admin } });
      expect(response.statusCode).toBe(200);
      const menu = response.json();
      expect(menu.categories.find((row: { id: string }) => row.id === categoryId)).toEqual({ id: categoryId, code: null, name: 'ZZ TEST Contract category', parentId: null, taxableCategory: 'addons', defaultPrepStation: 'none', effectiveTaxCategory: 'addons', effectivePrepStation: 'none', sortOrder: 0, translations: futureTranslations, archivedAt: null });
      expect(menu.modifierGroups.find((row: { id: string }) => row.id === groupId)).toEqual({ id: groupId, productId: null, name: 'ZZ TEST Contract question', required: false, selectionType: 'multi', minSelect: null, maxSelect: null, sortOrder: 0, translations: futureTranslations, options: [{ id: optionId, name: 'ZZ TEST Contract answer', priceSatang: 25, priceWeekendSatang: null, costSatang: null, sortOrder: 0, translations: futureTranslations }] });
      const [stored] = await ctx.db.select().from(product).where(eq(product.id, id));
      expect(menu.products.find((row: { id: string }) => row.id === id)).toEqual({
        id, kind: 'addon', code: null, name: stored!.name, description: null, categoryId, branchId,
        priceSatang: 1234, priceWeekendSatang: null, effectiveWeekendSatang: 1234, costSatang: null,
        prepStationOverride: null, taxCategoryOverride: null, effectivePrepStation: 'none', effectiveTaxCategory: 'addons',
        sku: null, variants, stockItemId: null, sortOrder: 0, active: stored!.active,
        translations: futureTranslations, archivedAt: stored!.archivedAt?.toISOString() ?? null,
        linkedModifierGroupIds: [groupId], stockLinks: [],
      });
    };
    await assertMenu();
    const patchHeaders = headers();
    for (let n = 0; n < 2; n++) {
      const patched = await ctx.app.inject({ method: 'PATCH', url: `/branches/${branchId}/menu/products/${id}`, headers: patchHeaders, payload: { name: 'ZZ TEST Renamed contract add-on' } });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toEqual({ ok: true });
    }
    await assertMenu();
    const deleteHeaders = headers();
    for (let n = 0; n < 2; n++) {
      const archived = await ctx.app.inject({ method: 'DELETE', url: `/branches/${branchId}/menu/products/${id}`, headers: deleteHeaders });
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toEqual({ ok: true });
    }
    await assertMenu(true);
    expect((await entityAudits(id)).map(row => row.action).sort()).toEqual(['menu_item.archive', 'menu_item.create', 'menu_item.update']);
  });
});
