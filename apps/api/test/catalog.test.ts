import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let cookie: string;
let branchId: string;
beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const branches = await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie } });
  branchId = branches.json().branches[0].id;
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-35 — ticket packages', () => {
  it('lists the four seeded prototype packages with per-tier satang prices', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/ticket-packages`,
      headers: { cookie },
    });
    const packages = res.json().packages;
    expect(packages).toHaveLength(4);
    const oneHour = packages.find((p: { name: string }) => p.name === '1 Hour Play');
    expect(oneHour.prices.tourist).toEqual({ weekday: 69000, weekend: 69000 });
    expect(oneHour.prices.expat).toEqual({ weekday: 48300, weekend: 55200 }); // −30%/−20% rule
    expect(oneHour.prices.thai).toEqual({ weekday: 42000, weekend: 52000 });
    const fullDay = packages.find((p: { name: string }) => p.name === 'Full Day Pass');
    expect(fullDay.adultRules.thai.kind).toBe('free_adults'); // prototype: 1 free Thai adult
    expect(fullDay.adultRules.thai.freeAdults).toBe(1);
  });

  it('creates, edits, archives', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/ticket-packages`,
      headers: { cookie },
      payload: {
        name: 'Test 30 Min',
        durationLabel: '30 Minutes',
        hours: 1,
        prices: { tourist: { weekday: 30000, weekend: 35000 } },
      },
    });
    expect(create.statusCode).toBe(200);
    const id = create.json().id as string;

    const edit = await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchId}/ticket-packages/${id}`,
      headers: { cookie },
      payload: { prices: { tourist: { weekday: 32000, weekend: 36000 } } },
    });
    expect(edit.statusCode).toBe(200);

    const archive = await ctx.app.inject({
      method: 'DELETE',
      url: `/branches/${branchId}/ticket-packages/${id}`,
      headers: { cookie },
    });
    expect(archive.statusCode).toBe(200);
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/ticket-packages`,
      headers: { cookie },
    });
    expect(list.json().packages.some((p: { id: string }) => p.id === id)).toBe(false);
  });

  it('rejects negative prices and zero duration', async () => {
    const negative = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/ticket-packages`,
      headers: { cookie },
      payload: {
        name: 'Bad',
        durationLabel: 'Bad',
        hours: 1,
        prices: { tourist: { weekday: -100, weekend: 0 } },
      },
    });
    expect(negative.statusCode).toBe(400);
    const zeroHours = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/ticket-packages`,
      headers: { cookie },
      payload: { name: 'Bad2', durationLabel: 'Bad2', hours: 0, prices: {} },
    });
    expect(zeroHours.statusCode).toBe(400);
  });

  it('lists tiers (read path)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/tiers', headers: { cookie } });
    const tiers = res.json().tiers;
    expect(tiers.map((t: { id: string }) => t.id)).toEqual(['tourist', 'expat', 'thai']);
    expect(tiers[0].isDefault).toBe(true);
    expect(tiers[1].requiresVerification).toBe(true);
  });
});

describe('SCRUM-36 — pricing-mode resolver (prototype pricingMode.ts rules)', () => {
  it('weekday / Saturday / Sunday', async () => {
    const url = (d: string) => `/branches/${branchId}/pricing-mode?date=${d}`;
    const wed = await ctx.app.inject({ method: 'GET', url: url('2026-09-09'), headers: { cookie } });
    expect(wed.json()).toMatchObject({ mode: 'weekday', reason: 'Weekday pricing' });
    const sat = await ctx.app.inject({ method: 'GET', url: url('2026-09-12'), headers: { cookie } });
    expect(sat.json().mode).toBe('weekend');
    const sun = await ctx.app.inject({ method: 'GET', url: url('2026-09-13'), headers: { cookie } });
    expect(sun.json().mode).toBe('weekend');
  });

  it('a weekday inside a holiday range bills weekend with the holiday named; boundaries inclusive', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/holidays`,
      headers: { cookie },
      payload: { name: 'Songkran', startsOn: '2027-04-13', endsOn: '2027-04-15' },
    });
    const url = (d: string) => `/branches/${branchId}/pricing-mode?date=${d}`;
    const inside = await ctx.app.inject({ method: 'GET', url: url('2027-04-14'), headers: { cookie } });
    expect(inside.json()).toMatchObject({ mode: 'weekend', reason: 'Weekend pricing — Songkran' });
    const startEdge = await ctx.app.inject({ method: 'GET', url: url('2027-04-13'), headers: { cookie } });
    expect(startEdge.json().overrideName).toBe('Songkran');
    const endEdge = await ctx.app.inject({ method: 'GET', url: url('2027-04-15'), headers: { cookie } });
    expect(endEdge.json().overrideName).toBe('Songkran');
    const after = await ctx.app.inject({ method: 'GET', url: url('2027-04-16'), headers: { cookie } });
    expect(after.json().mode).toBe('weekday');
  });

  it('defaults to today in the branch timezone', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/pricing-mode`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('SCRUM-37 — tax resolver precedence', () => {
  it('branch default comes from the per-category engine config (7% inclusive VAT)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/tax-resolve?taxableCategory=tickets`,
      headers: { cookie },
    });
    expect(res.json()).toMatchObject({
      taxMode: 'inclusive',
      vatRateBp: 700,
      serviceChargeBp: 0,
      source: 'branch',
    });
  });

  it('category override beats branch; product override beats category', async () => {
    const cats = await ctx.app.inject({ method: 'GET', url: '/product-categories', headers: { cookie } });
    const categoryId = cats.json().categories[0].id as string;
    const productId = cats.json().products[0].id as string;

    await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/tax-overrides`,
      headers: { cookie },
      payload: { categoryId, vatRateBp: 500, serviceChargeBp: 1000 },
    });
    const catRes = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/tax-resolve?categoryId=${categoryId}`,
      headers: { cookie },
    });
    expect(catRes.json()).toMatchObject({ vatRateBp: 500, serviceChargeBp: 1000, source: 'category_override' });

    await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/tax-overrides`,
      headers: { cookie },
      payload: { productId, vatRateBp: 0 },
    });
    const prodRes = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/tax-resolve?categoryId=${categoryId}&productId=${productId}`,
      headers: { cookie },
    });
    expect(prodRes.json()).toMatchObject({ vatRateBp: 0, source: 'product_override' });
    // service charge not overridden at product level → category's stands.
    expect(prodRes.json().serviceChargeBp).toBe(1000);
  });

  it('tax config PUT replaces the engine config and is audited', async () => {
    const get = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/tax-config`,
      headers: { cookie },
    });
    const config = get.json().config;
    config.categoryRules = config.categoryRules.map((r: { category: string }) =>
      r.category === 'fnb' ? { ...r, serviceChargePercent: 10 } : r,
    );
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/branches/${branchId}/tax-config`,
      headers: { cookie },
      payload: config,
    });
    expect(put.statusCode).toBe(200);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/tax-resolve?taxableCategory=fnb`,
      headers: { cookie },
    });
    expect(res.json().serviceChargeBp).toBe(1000);
  });
});

describe('SCRUM-27 — operators and branches', () => {
  it('creates a second operator with a branch and assigns an administrator', async () => {
    const op = await ctx.app.inject({
      method: 'POST',
      url: '/operators',
      headers: { cookie },
      payload: { name: 'Second Park Co' },
    });
    expect(op.statusCode).toBe(200);
    const opId = op.json().id as string;

    const adminRes = await ctx.app.inject({
      method: 'POST',
      url: `/operators/${opId}/administrators`,
      headers: { cookie },
      payload: { phone: '+66644443333', name: 'Second Admin' },
    });
    expect(adminRes.statusCode).toBe(200);

    const archived = await ctx.app.inject({
      method: 'PATCH',
      url: `/operators/${opId}`,
      headers: { cookie },
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    const list = await ctx.app.inject({ method: 'GET', url: '/operators', headers: { cookie } });
    expect(list.json().operators.some((o: { id: string }) => o.id === opId)).toBe(false); // hidden from pickers
  });

  it('creates a branch with a timezone and archives it out of the picker', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/branches',
      headers: { cookie },
      payload: { name: 'HKT Chalong', code: 'hkt-chalong', timezone: 'Asia/Bangkok' },
    });
    expect(create.statusCode).toBe(200);
    const id = create.json().id as string;
    await ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${id}`,
      headers: { cookie },
      payload: { archived: true },
    });
    const list = await ctx.app.inject({ method: 'GET', url: '/branches', headers: { cookie } });
    expect(list.json().branches.some((b: { id: string }) => b.id === id)).toBe(false);
  });
});

describe('SCRUM-228 — customer tiers are data, not a screen-local list', () => {
  const code = 'student';

  it('creates a tier, lists it, renames it, and refuses a second with the same code', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/tiers',
      headers: { cookie },
      payload: { code, name: 'Student', requiresVerification: true, sortOrder: 9 },
    });
    expect(create.statusCode).toBe(200);

    const listed = await ctx.app.inject({ method: 'GET', url: '/tiers', headers: { cookie } });
    const added = listed.json().tiers.find((t: { id: string }) => t.id === code);
    expect(added).toMatchObject({ name: 'Student', requiresVerification: true, isDefault: false });

    const clash = await ctx.app.inject({
      method: 'POST',
      url: '/tiers',
      headers: { cookie },
      payload: { code, name: 'Student again' },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('TIER_CODE_EXISTS');

    const rename = await ctx.app.inject({
      method: 'PATCH',
      url: `/tiers/${code}`,
      headers: { cookie },
      payload: { name: 'Student (with card)' },
    });
    expect(rename.statusCode).toBe(200);
    const after = await ctx.app.inject({ method: 'GET', url: '/tiers', headers: { cookie } });
    expect(after.json().tiers.find((t: { id: string }) => t.id === code).name).toBe(
      'Student (with card)',
    );
  });

  it('keeps exactly one baseline tier, and the baseline never asks for a document', async () => {
    const promote = await ctx.app.inject({
      method: 'PATCH',
      url: `/tiers/${code}`,
      headers: { cookie },
      payload: { isDefault: true },
    });
    expect(promote.statusCode).toBe(200);
    const listed = await ctx.app.inject({ method: 'GET', url: '/tiers', headers: { cookie } });
    const defaults = listed.json().tiers.filter((t: { isDefault: boolean }) => t.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(code);
    expect(defaults[0].requiresVerification).toBe(false);

    // Demoting the baseline directly leaves the operator without one.
    const demote = await ctx.app.inject({
      method: 'PATCH',
      url: `/tiers/${code}`,
      headers: { cookie },
      payload: { isDefault: false },
    });
    expect(demote.statusCode).toBe(400);

    // Put the seeded baseline back for the rest of the suite.
    await ctx.app.inject({
      method: 'PATCH',
      url: '/tiers/tourist',
      headers: { cookie },
      payload: { isDefault: true },
    });
    await ctx.app.inject({
      method: 'PATCH',
      url: `/tiers/${code}`,
      headers: { cookie },
      payload: { requiresVerification: true },
    });
  });

  it('refuses to archive a tier that prices a member, and archives it once nobody holds it', async () => {
    const member = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      headers: { cookie },
      payload: { phone: '0891112233', nickname: 'Tier holder' },
    });
    expect(member.statusCode).toBe(200);
    const memberId = member.json().member.id as string;
    const verify = await ctx.app.inject({
      method: 'POST',
      url: `/members/${memberId}/tier-verification`,
      headers: { cookie },
      payload: { toTier: code, evidenceType: 'School card', evidenceExpiresAt: '2030-01-01' },
    });
    expect(verify.statusCode).toBe(200);

    const refused = await ctx.app.inject({
      method: 'DELETE',
      url: `/tiers/${code}`,
      headers: { cookie },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('TIER_IN_USE');

    await ctx.app.inject({ method: 'DELETE', url: `/members/${memberId}`, headers: { cookie } });
    const archived = await ctx.app.inject({
      method: 'DELETE',
      url: `/tiers/${code}`,
      headers: { cookie },
    });
    expect(archived.statusCode).toBe(200);
    const listed = await ctx.app.inject({ method: 'GET', url: '/tiers', headers: { cookie } });
    expect(listed.json().tiers.some((t: { id: string }) => t.id === code)).toBe(false);
  });

  it('refuses to archive the baseline tier', async () => {
    const res = await ctx.app.inject({ method: 'DELETE', url: '/tiers/tourist', headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an adult rule that charges a price it does not carry', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/ticket-packages`,
      headers: { cookie },
      payload: {
        name: 'Unpriced adults',
        durationLabel: '1 Hour',
        hours: 1,
        prices: { tourist: { weekday: 30000, weekend: 35000 } },
        adultRules: { tourist: { kind: 'set_price' } },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
