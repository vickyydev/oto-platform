import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, branchTaxConfig, discountDefinition, paymentMethod, voucher, voucherDefinition } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext, cookie: string, branchId: string, operatorId: string, accountId: string;
beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.ready();
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const response = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
  expect(response.statusCode).toBe(200);
  const me = response.json(); branchId = me.branch.id; operatorId = me.account.operatorId; accountId = me.account.id;
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });
const headers = (key = newId()) => ({ cookie, 'idempotency-key': key });
const actionsFor = async (id: string) => (await ctx.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, id))).map(row => row.action).sort();

describe('SCRUM-623 money response contracts', () => {
  for (const [label, routes] of [
    ['tenders', [['/payment-methods', 'get'], ['/payment-methods', 'post'], ['/payment-methods/{code}', 'patch'], ['/payment-methods/{code}/move', 'post'], ['/payment-methods/{code}', 'delete']]],
    ['discount codes', [['/menu/discounts', 'get'], ['/menu/discounts', 'post'], ['/menu/discounts/{id}', 'patch'], ['/menu/discounts/{id}', 'delete']]],
    ['tax configuration', [['/branches/{branchId}/tax-config', 'get'], ['/branches/{branchId}/tax-config', 'put']]],
    ['voucher campaign metadata', [['/voucher-campaigns', 'get'], ['/voucher-campaigns', 'post']]],
  ] as const) {
    it(`describes all lifted JSON responses for ${label}`, () => {
      const document = ctx.app.swagger();
      for (const [path, verb] of routes) {
        const response = document.paths?.[path]?.[verb]?.responses?.['200'];
        expect(response && 'content' in response ? response.content?.['application/json']?.schema : undefined, `${verb.toUpperCase()} ${path}`).toBeDefined();
      }
    });
  }

  it('retains tender codes, ordering, enable state and one audit for each replayed mutation', async () => {
    const code = 'zz_test_623_contract', createHeaders = headers();
    const created = await ctx.app.inject({ method: 'POST', url: '/payment-methods', headers: createHeaders, payload: { code, label: 'ZZ TEST Contract tender', kind: 'other', sortOrder: 150 } });
    expect(created.statusCode).toBe(200); const id = created.json().id as string;
    expect(created.json()).toEqual({ id }); expect(id).toMatch(/^[a-f0-9-]{36}$/i);
    const replay = await ctx.app.inject({ method: 'POST', url: '/payment-methods', headers: createHeaders, payload: { code, label: 'ZZ TEST Contract tender', kind: 'other', sortOrder: 150 } });
    expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual({ id });
    const patchHeaders = headers();
    for (let n = 0; n < 2; n++) {
      const changed = await ctx.app.inject({ method: 'PATCH', url: `/payment-methods/${code}`, headers: patchHeaders, payload: { label: 'ZZ TEST Renamed tender', enabled: false } });
      expect(changed.statusCode).toBe(200); expect(changed.json()).toEqual({ ok: true });
    }
    const listed = await ctx.app.inject({ method: 'GET', url: '/payment-methods', headers: { cookie } }); expect(listed.statusCode).toBe(200);
    expect(listed.json().methods.find((row: { id: string }) => row.id === code)).toEqual({ id: code, label: 'ZZ TEST Renamed tender', kind: 'other', enabled: false, sortOrder: 150, attempts: 0 });
    const moveHeaders = headers();
    for (let n = 0; n < 2; n++) {
      const moved = await ctx.app.inject({ method: 'POST', url: `/payment-methods/${code}/move`, headers: moveHeaders, payload: { direction: 'up' } });
      expect(moved.statusCode).toBe(200); expect(moved.json()).toEqual({ ok: true, moved: true });
    }
    const deleteHeaders = headers();
    for (let n = 0; n < 2; n++) { const removed = await ctx.app.inject({ method: 'DELETE', url: `/payment-methods/${code}`, headers: deleteHeaders }); expect(removed.statusCode).toBe(200); expect(removed.json()).toEqual({ ok: true }); }
    expect(await actionsFor(id)).toEqual(['payment_method.archive', 'payment_method.create', 'payment_method.reorder', 'payment_method.update']);
    const [stored] = await ctx.db.select().from(paymentMethod).where(eq(paymentMethod.id, id)); expect(stored?.archivedAt).not.toBeNull(); expect(stored?.enabled).toBe(false);
  });

  it('retains every discount read field including stored target metadata and lifecycle replay', async () => {
    const body = { code: 'ZZTEST623CONTRACT', label: 'ZZ TEST Contract discount', kind: 'fixed', valueSatang: 123, branchId, target: { kind: 'everything' }, validFrom: '2026-01-01', validUntil: '2029-12-31', usageLimit: 10, perCustomerLimit: 2, stackable: true, active: true };
    const createHeaders = headers(), created = await ctx.app.inject({ method: 'POST', url: '/menu/discounts', headers: createHeaders, payload: body });
    expect(created.statusCode).toBe(200); const id = created.json().id as string;
    const replay = await ctx.app.inject({ method: 'POST', url: '/menu/discounts', headers: createHeaders, payload: body }); expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual({ id });
    const target = { kind: 'everything', futureWriter: { kept: true, labels: ['ZZ TEST'] } };
    await ctx.db.update(discountDefinition).set({ target }).where(eq(discountDefinition.id, id));
    const listed = await ctx.app.inject({ method: 'GET', url: '/menu/discounts', headers: { cookie } }); expect(listed.statusCode).toBe(200);
    const row = listed.json().discounts.find((item: { id: string }) => item.id === id);
    expect(row).toEqual({ id, operatorId, branchId, code: body.code, label: body.label, kind: 'fixed', valueBp: null, valueSatang: 123, freeProductId: null, target, validFrom: body.validFrom, validUntil: body.validUntil, usageLimit: 10, perCustomerLimit: 2, stackable: true, active: true, createdAt: expect.any(String), updatedAt: expect.any(String), archivedAt: null, usedCount: 0 });
    const patchHeaders = headers();
    for (let n = 0; n < 2; n++) { const changed = await ctx.app.inject({ method: 'PATCH', url: `/menu/discounts/${id}`, headers: patchHeaders, payload: { ...body, label: 'ZZ TEST Edited discount', valueSatang: 234 } }); expect(changed.statusCode).toBe(200); expect(changed.json()).toEqual({ ok: true }); }
    const deleteHeaders = headers();
    for (let n = 0; n < 2; n++) { const removed = await ctx.app.inject({ method: 'DELETE', url: `/menu/discounts/${id}`, headers: deleteHeaders }); expect(removed.statusCode).toBe(200); expect(removed.json()).toEqual({ ok: true }); }
    expect(await actionsFor(id)).toEqual(['discount_definition.archive', 'discount_definition.create', 'discount_definition.update']);
  });

  it('reads stored tax JSON losslessly and preserves full replacement with audit-once replay', async () => {
    const config = { rates: [{ id: 'zz-vat', name: 'ZZ TEST VAT', percent: 7.25, defaultMode: 'inclusive', futureRate: { retained: true } }], categoryRules: [{ category: 'fnb', taxRateId: 'zz-vat', taxMode: 'inclusive', serviceChargePercent: 2.5, taxOnServiceCharge: true, futureRule: ['ZZ TEST'] }], discountPlacement: 'before_tax', futureConfig: { retained: true } };
    await ctx.db.insert(branchTaxConfig).values({ id: newId(), branchId, config }).onConflictDoUpdate({ target: branchTaxConfig.branchId, set: { config } });
    const before = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/tax-config`, headers: { cookie } }); expect(before.statusCode).toBe(200); expect(before.json()).toEqual({ config });
    const replacement = { rates: [{ id: 'zz-vat', name: 'ZZ TEST VAT edited', percent: 7.25, defaultMode: 'exclusive' }], categoryRules: [{ category: 'fnb', taxRateId: 'zz-vat', taxMode: 'exclusive', serviceChargePercent: 3.75 }], discountPlacement: 'after_tax' }, writeHeaders = headers();
    const priorAudits = await ctx.db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.entityId, branchId), eq(auditLog.action, 'branch_tax_config.update')));
    for (let n = 0; n < 2; n++) { const changed = await ctx.app.inject({ method: 'PUT', url: `/branches/${branchId}/tax-config`, headers: writeHeaders, payload: replacement }); expect(changed.statusCode).toBe(200); expect(changed.json()).toEqual({ ok: true }); }
    const after = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/tax-config`, headers: { cookie } }); expect(after.statusCode).toBe(200); expect(after.json()).toEqual({ config: replacement });
    const audits = await ctx.db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.entityId, branchId), eq(auditLog.action, 'branch_tax_config.update'))); expect(audits.length).toBe(priorAudits.length + 1);
  });

  it('keeps campaign metadata code-free, replay atomic and native CSV uncached', async () => {
    const definitionId = newId(), definitionCode = 'zz-test-623-' + definitionId;
    await ctx.db.insert(voucherDefinition).values({ id: definitionId, operatorId, code: definitionCode, nameEn: 'ZZ TEST Contract voucher type', kind: 'discount', valueType: 'amount', valueSatang: 123 });
    const body = { definitionId, branchId, name: 'ZZ TEST Contract campaign', quantity: 2 }, writeHeaders = headers();
    const created = await ctx.app.inject({ method: 'POST', url: '/voucher-campaigns', headers: writeHeaders, payload: body }); expect(created.statusCode).toBe(200);
    const campaign = created.json().campaign; expect(campaign).toEqual({ id: expect.any(String), name: body.name, branchId, definitionId, definitionCode, quantity: 2, redeemed: 0, createdAt: expect.any(String), createdByAccountId: accountId });
    const replay = await ctx.app.inject({ method: 'POST', url: '/voucher-campaigns', headers: writeHeaders, payload: body }); expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual({ campaign });
    const listed = await ctx.app.inject({ method: 'GET', url: '/voucher-campaigns', headers: { cookie } }); expect(listed.statusCode).toBe(200); expect(listed.json().campaigns.find((row: { id: string }) => row.id === campaign.id)).toEqual(campaign);
    const stored = await ctx.db.select({ code: voucher.code }).from(voucher).where(eq(voucher.campaignId, campaign.id)); expect(stored.length).toBe(2);
    expect(stored.every(row => !created.body.includes(row.code) && !listed.body.includes(row.code) && !replay.body.includes(row.code))).toBe(true);
    const csv = await ctx.app.inject({ method: 'GET', url: `/voucher-campaigns/${campaign.id}/codes`, headers: { cookie } }); expect(csv.statusCode).toBe(200); expect(csv.headers['cache-control']).toBe('no-store'); expect(csv.headers['content-type']).toContain('text/csv'); expect(csv.body.trim().split('\n').length).toBe(3);
    expect(await actionsFor(campaign.id)).toEqual(['voucher_campaign.create']);
  });
});
