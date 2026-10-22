import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, discountDefinition, paymentMethod, role, roleAssignment, rolePermission, voucher, voucherCampaign, voucherDefinition } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, BRANCH_MANAGER, SECOND_OPERATOR_ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string, manager: string, outside: string;
let operatorId: string, park: string, sibling: string, foreignPark: string;
let definitionId: string, foreignDefinitionId: string, ownCampaign: string, siblingCampaign: string, foreignCampaign: string;
let tenderCode: string, discountId: string;
const code = () => 'zz_623_' + newId().replaceAll('-', '').slice(0, 16);
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function request(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, cookie = admin, key = newId()) {
  return ctx.app.inject({ method, url, headers: { cookie, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
}
const trail = (id: string, action: string) => ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, action)));
const issuedCodes = (id: string) => ctx.db.select({ id: voucher.id, code: voucher.code }).from(voucher).where(eq(voucher.campaignId, id));
async function define(cookie = admin) {
  const response = await request('POST', '/voucher-definitions', { code: 'zz-test-623-' + newId(), nameEn: 'ZZ TEST Money voucher', kind: 'discount', valueType: 'amount', valueSatang: 12345, active: true, codeMode: 'generated' }, cookie);
  expect(response.statusCode).toBe(201); return response.json().definition.id as string;
}
async function mint(definition: string, target: string, cookie = admin) {
  const response = await request('POST', '/voucher-campaigns', { definitionId: definition, branchId: target, name: 'ZZ TEST Money campaign', quantity: 2 }, cookie);
  expect(response.statusCode).toBe(200); return response.json().campaign.id as string;
}
beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  outside = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  operatorId = (await request('GET', '/me')).json().account.operatorId as string;
  park = (await request('GET', '/me', undefined, manager)).json().branch.id as string;
  foreignPark = (await request('GET', '/me', undefined, outside)).json().branch.id as string;
  sibling = newId(); await ctx.db.insert(branch).values({ id: sibling, operatorId, code: 'zz-money-' + sibling, name: 'ZZ TEST Money sibling park' });
  const [caller] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  const roleId = newId(); await ctx.db.insert(role).values({ id: roleId, operatorId, name: 'ZZ TEST Money scoped reviewer' });
  await ctx.db.insert(rolePermission).values(['catalog:menu:read', 'catalog:menu:manage', 'catalog:tax:read', 'catalog:tax:manage', 'pos:event:read', 'admin:event_pricing:manage', 'admin:booth:read', 'admin:booth:manage'].map(permission => ({ id: newId(), roleId, permission })));
  await ctx.db.insert(roleAssignment).values({ id: newId(), roleId, accountId: caller!.id, scopeType: 'branch', scopeId: park });
  definitionId = await define(); foreignDefinitionId = await define(outside);
  ownCampaign = await mint(definitionId, park); siblingCampaign = await mint(definitionId, sibling); foreignCampaign = await mint(foreignDefinitionId, foreignPark, outside);
  tenderCode = code(); expect((await request('POST', '/payment-methods', { code: tenderCode, label: 'ZZ TEST Money tender', kind: 'other' })).statusCode).toBe(200);
  const discount = await request('POST', '/menu/discounts', { code: code().toUpperCase(), label: 'ZZ TEST Money discount', kind: 'fixed', valueSatang: 12345 });
  expect(discount.statusCode).toBe(200); discountId = discount.json().id as string;
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-623 independent money review', () => {
  it('R1 [critical] sibling-park campaign CSV cannot cross branch reach; fix: resolve the owned campaign park and require manage there before reading bearer rows', async () => {
    const own = await request('GET', '/voucher-campaigns/' + ownCampaign + '/codes', undefined, manager);
    expect(own.statusCode).toBe(200); expect(own.headers['cache-control']).toBe('no-store');
    const siblingCodes = await issuedCodes(siblingCampaign);
    const refused = await request('GET', '/voucher-campaigns/' + siblingCampaign + '/codes', undefined, manager);
    expect.soft(refused.statusCode).toBe(403);
    // Assert booleans only: an assertion failure must never print a bearer value.
    expect.soft(siblingCodes.every(row => !refused.body.includes(row.code))).toBe(true);
    expect((await request('GET', '/voucher-campaigns/' + foreignCampaign + '/codes')).statusCode).toBe(404);
  });

  it('R2 [critical] corrupt attached voucher rows cannot expose foreign or sibling codes; fix: fence CSV rows by campaign operator and resolved campaign park', async () => {
    const foreignRows = await issuedCodes(foreignCampaign), siblingRows = await issuedCodes(siblingCampaign);
    const foreignDecoy = foreignRows[0]!, siblingDecoy = siblingRows[0]!;
    await ctx.db.update(voucher).set({ campaignId: ownCampaign }).where(eq(voucher.id, foreignDecoy.id));
    await ctx.db.update(voucher).set({ campaignId: ownCampaign }).where(eq(voucher.id, siblingDecoy.id));
    const before = await ctx.db.select({ id: voucher.id, campaignId: voucher.campaignId, operatorId: voucher.operatorId, branchId: voucher.branchId }).from(voucher);
    const response = await request('GET', '/voucher-campaigns/' + ownCampaign + '/codes', undefined, manager);
    expect(response.statusCode).toBe(200);
    expect.soft(response.body.includes(foreignDecoy.code)).toBe(false);
    expect.soft(response.body.includes(siblingDecoy.code)).toBe(false);
    expect(await ctx.db.select({ id: voucher.id, campaignId: voucher.campaignId, operatorId: voucher.operatorId, branchId: voucher.branchId }).from(voucher)).toEqual(before);
  });

  it('R3 [high] branch grants never authorize operator-wide codes, tenders or type edits; fix: preserve operator targets and keep all refused rows unchanged', async () => {
    const before = { discounts: await ctx.db.select().from(discountDefinition), tenders: await ctx.db.select().from(paymentMethod), definitions: await ctx.db.select().from(voucherDefinition) };
    for (const [method, url, body] of [
      ['POST', '/menu/discounts', { code: code().toUpperCase(), label: 'ZZ TEST Refused discount', kind: 'fixed', valueSatang: 12345 }],
      ['PATCH', '/menu/discounts/' + discountId, { code: code().toUpperCase(), label: 'ZZ TEST Refused edit', kind: 'fixed', valueSatang: 12345 }],
      ['DELETE', '/menu/discounts/' + discountId, undefined],
      ['POST', '/payment-methods', { code: code(), label: 'ZZ TEST Refused tender', kind: 'other' }],
      ['PATCH', '/payment-methods/' + tenderCode, { label: 'ZZ TEST Refused tender edit' }],
      ['POST', '/payment-methods/' + tenderCode + '/move', { direction: 'up' }],
      ['DELETE', '/payment-methods/' + tenderCode, undefined],
      ['POST', '/voucher-definitions', { code: 'zz-test-623-' + newId(), nameEn: 'ZZ TEST Refused type', kind: 'manual' }],
      ['PATCH', '/voucher-definitions/' + definitionId, { nameEn: 'ZZ TEST Refused type edit' }],
      ['DELETE', '/voucher-definitions/' + definitionId, undefined],
    ] as const) expect((await request(method, url, body, manager)).statusCode).toBe(403);
    expect(await ctx.db.select().from(discountDefinition)).toEqual(before.discounts);
    expect(await ctx.db.select().from(paymentMethod)).toEqual(before.tenders);
    expect(fingerprint(await ctx.db.select().from(voucherDefinition))).toBe(fingerprint(before.definitions));
  });

  it('R4 [high] tax and event writes use the exact path park with canonical fractions and replay; fix: retain branch targets without widening from the current seat', async () => {
    const tax = { rates: [{ id: 'zz-primary', name: 'ZZ TEST Tax', percent: 7.25, defaultMode: 'exclusive' }, { id: 'zz-secondary', name: 'ZZ TEST Secondary tax', percent: 0.5 }], categoryRules: [{ category: 'fnb', taxMode: 'exclusive', taxRateId: 'zz-primary', serviceChargePercent: 2.5, taxOnServiceCharge: true, secondaryTaxRateId: 'zz-secondary', secondaryTaxMode: 'inclusive' }, { category: 'stored_value', taxMode: 'none' }], discountPlacement: 'after_tax' };
    const pricing = { campDay: { weekday: 12345, weekend: 16789 }, eventDay: { weekday: 23456, weekend: 27890 }, partyGuest: { weekday: 34567, weekend: 38901 } };
    for (const [route, body, action, field] of [
      ['tax-config', tax, 'branch_tax_config.update', 'config'],
      ['event-drop-in-pricing', pricing, 'event_pricing.update', 'pricing'],
    ] as const) {
      const target = '/branches/' + park + '/' + route, key = newId();
      for (let attempt = 0; attempt < 2; attempt++) expect((await request('PUT', target, body, manager, key)).statusCode).toBe(200);
      const canonical = await request('GET', target, undefined, manager);
      expect(canonical.statusCode).toBe(200); expect(canonical.json()[field]).toEqual(body);
      expect(await trail(park, action)).toHaveLength(1);
      expect((await request('PUT', '/branches/' + sibling + '/' + route, body, manager)).statusCode).toBe(403);
      expect((await request('GET', '/branches/' + sibling + '/' + route, undefined, manager)).statusCode).toBe(403);
      expect((await request('PUT', target, body, outside)).statusCode).toBe(404);
      expect((await request('GET', target, undefined, manager)).json()[field]).toEqual(body);
    }
  });

  it('R5 [high] own-park campaign minting remains allowed and idempotent without JSON bearer disclosure; fix: restrict exports at their actual park, not legitimate branch minting', async () => {
    const body = { definitionId, branchId: park, name: 'ZZ TEST Scoped money campaign', quantity: 2 }, key = newId();
    const first = await request('POST', '/voucher-campaigns', body, manager, key), replay = await request('POST', '/voucher-campaigns', body, manager, key);
    expect(first.statusCode).toBe(200); expect(replay.statusCode).toBe(200);
    const id = first.json().campaign.id as string; expect(replay.json().campaign.id).toBe(id);
    const issued = await issuedCodes(id); expect(issued.length).toBe(2);
    const list = await request('GET', '/voucher-campaigns', undefined, manager);
    expect(list.statusCode).toBe(200); expect(list.json().campaigns.some((row: { id: string }) => row.id === id)).toBe(true);
    expect(issued.every(row => !first.body.includes(row.code) && !replay.body.includes(row.code) && !list.body.includes(row.code))).toBe(true);
    expect(await trail(id, 'voucher_campaign.create')).toHaveLength(1);
    expect((await request('POST', '/voucher-campaigns', { ...body, name: 'ZZ TEST Changed retry body' }, manager, key)).statusCode).toBe(409);
  });

  it('R6 [critical] another operator cannot mutate owned money records; fix: preserve independent row ownership fences and public metadata reads', async () => {
    const before = { discounts: await ctx.db.select().from(discountDefinition), tenders: await ctx.db.select().from(paymentMethod), definitions: await ctx.db.select().from(voucherDefinition), campaigns: await ctx.db.select().from(voucherCampaign) };
    expect((await request('PATCH', '/menu/discounts/' + discountId, { code: code().toUpperCase(), label: 'ZZ TEST Foreign edit', kind: 'fixed', valueSatang: 12345 }, outside)).statusCode).toBe(404);
    expect((await request('PATCH', '/payment-methods/' + tenderCode, { label: 'ZZ TEST Foreign tender edit' }, outside)).statusCode).toBe(404);
    expect((await request('PATCH', '/voucher-definitions/' + definitionId, { nameEn: 'ZZ TEST Foreign type edit' }, outside)).statusCode).toBe(404);
    for (const url of ['/menu/discounts', '/payment-methods', '/voucher-definitions', '/voucher-campaigns']) expect((await request('GET', url, undefined, manager)).statusCode).toBe(200);
    expect(await ctx.db.select().from(discountDefinition)).toEqual(before.discounts);
    expect(await ctx.db.select().from(paymentMethod)).toEqual(before.tenders);
    expect(fingerprint(await ctx.db.select().from(voucherDefinition))).toBe(fingerprint(before.definitions));
    expect(await ctx.db.select().from(voucherCampaign)).toEqual(before.campaigns);
  });
});
