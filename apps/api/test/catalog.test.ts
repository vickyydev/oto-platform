import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  auditLog,
  branch,
  branchHoliday,
  member,
  paymentAttempt,
  sale,
  saleDiscount,
  saleLine,
  station,
  ticketPackage,
} from '@oto/db';
import { businessDate, newId, parseDayStart } from '@oto/shared';
import {
  ADMIN,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

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

  /**
   * SCRUM-308. Seen on staging just after midnight: the header chip said
   * Weekday while the platform priced the same basket as Weekend for a holiday
   * on the trading day, which was still the 22nd. The chip's default date was
   * the calendar day; a sale's is the trading day (`business_day_start`,
   * 05:00). Between midnight and five they disagreed.
   *
   * Only `Date` is faked, so the database calls underneath still run on real
   * time. The clock lands up to a day ahead, past the 12-hour session made
   * above, so this signs in again under the faked clock and uses that cookie.
   */
  it('at 00:30 the chip prices the trading day a sale would be priced on, not the calendar day', async () => {
    // The next 00:30 Asia/Bangkok (UTC+7) after real now: 17:30 UTC today or tomorrow.
    const real = new Date();
    const at = new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate(), 17, 30));
    if (at.getTime() <= real.getTime()) at.setUTCDate(at.getUTCDate() + 1);
    const calendarDay = new Date(at.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
    const tradingDay = new Date(at.getTime() + 7 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
    expect(tradingDay).not.toBe(calendarDay);

    // A holiday on the trading day only, so the two days answer differently
    // whatever weekday they fall on.
    const made = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/holidays`,
      headers: { cookie },
      payload: { name: 'Trading-day holiday (SCRUM-308)', startsOn: tradingDay, endsOn: tradingDay },
    });
    expect(made.statusCode, made.body).toBe(200);

    vi.useFakeTimers({ toFake: ['Date'], now: at });
    try {
      const lateCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/branches/${branchId}/pricing-mode`,
        headers: { cookie: lateCookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().date, 'the chip answered for the calendar day').toBe(tradingDay);
      expect(res.json()).toMatchObject({
        mode: 'weekend',
        overrideName: 'Trading-day holiday (SCRUM-308)',
      });
    } finally {
      vi.useRealTimers();
    }

    await ctx.app.inject({
      method: 'DELETE',
      url: `/branches/${branchId}/holidays/${made.json().holiday?.id ?? made.json().id}`,
      headers: { cookie },
    });
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

/**
 * SCRUM-309 — correcting a holiday range after the park has traded on it.
 *
 * Found on staging. SCRUM-258 refuses to REMOVE a range once a sale points at
 * it, which is right, and it was the only answer available to a manager who had
 * mistyped the name: the panel's edit was a delete followed by a create, so the
 * first ticket sold under the range froze the typo for good.
 *
 * The two halves of the row are not the same kind of fact. The name is copied
 * onto the sale when it is priced (`pos.sale.holiday_name`), so correcting it
 * rewrites nothing that has been printed. The dates are what the sale's weekend
 * pricing rests on, and moving them would leave a receipt charged weekend
 * prices for a holiday that no longer covers its trading day.
 *
 * Everything below goes in through the routes the panel calls, and the sale is
 * a real one rung on the till, because the guard is a count of rows pointing at
 * the range and a hand-inserted row would not prove the till ever writes one.
 */
describe('SCRUM-309 — correcting a holiday range', () => {
  let receptionCookie: string;
  let stationId: string;
  let packageId: string;
  let memberId: string;
  /** The day a sale rung now is priced on — the branch's, not the browser's. */
  let tradingDay: string;

  beforeAll(async () => {
    receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
    tradingDay = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
    const tills = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
    stationId = tills[0]!.id;
    const packages = await ctx.db
      .select()
      .from(ticketPackage)
      .where(eq(ticketPackage.branchId, branchId));
    packageId = packages.find((p) => p.name === '2 Hours Play')!.id;
    const members = await ctx.db.select().from(member).where(eq(member.operatorId, hkt!.operatorId));
    memberId = members.find((m) => m.phone === '+66822222222')!.id;
  });

  const addHoliday = async (name: string, startsOn: string, endsOn: string): Promise<string> => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${branchId}/holidays`,
      headers: { cookie },
      payload: { name, startsOn, endsOn },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().id as string;
  };

  const correct = (
    id: string,
    payload: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/branches/${branchId}/holidays/${id}`,
      headers: { cookie, ...extraHeaders },
      payload,
    });

  const holidayRow = async (id: string) =>
    (await ctx.db.select().from(branchHoliday).where(eq(branchHoliday.id, id)))[0]!;

  const updateTrail = async (id: string) =>
    ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, 'branch_holiday.update')));

  /** One ticket rung on the till, priced by whatever range covers today. */
  const sellOnTheTill = async (): Promise<string> => {
    const saleId = newId();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: receptionCookie },
      payload: {
        id: saleId,
        stationId,
        memberId,
        lines: [{ id: newId(), packageId, kids: 1, adults: 0 }],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    return saleId;
  };

  /**
   * Put the calendar back. A range covering today would leave every later test
   * on weekend prices, and the API will not remove one that has traded — which
   * is the whole point of the ticket — so the rows go directly.
   */
  const forget = async (saleId: string, holidayId: string): Promise<void> => {
    await ctx.db.delete(saleLine).where(eq(saleLine.saleId, saleId));
    await ctx.db.delete(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    await ctx.db.delete(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    await ctx.db.delete(sale).where(eq(sale.id, saleId));
    await ctx.db.delete(branchHoliday).where(eq(branchHoliday.id, holidayId));
  };

  it('moves the dates of a range nothing has been sold under', async () => {
    // Mon 2 Feb 2032 to Tue the 3rd, moved to Wed the 4th to Fri the 6th — all
    // five are weekdays, so only the range decides how they price.
    const id = await addHoliday('Refurbishment', '2032-02-02', '2032-02-03');
    const res = await correct(id, {
      name: 'Refurbishment week',
      startsOn: '2032-02-04',
      endsOn: '2032-02-06',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await holidayRow(id)).toMatchObject({
      name: 'Refurbishment week',
      startsOn: '2032-02-04',
      endsOn: '2032-02-06',
    });

    const mode = (d: string) =>
      ctx.app.inject({
        method: 'GET',
        url: `/branches/${branchId}/pricing-mode?date=${d}`,
        headers: { cookie },
      });
    expect((await mode('2032-02-05')).json()).toMatchObject({
      mode: 'weekend',
      overrideName: 'Refurbishment week',
    });
    // And the days it no longer covers price as the plain weekdays they are.
    expect((await mode('2032-02-02')).json().mode).toBe('weekday');

    await ctx.db.delete(branchHoliday).where(eq(branchHoliday.id, id));
  });

  it('renames a range the park has traded on, leaving the receipt as it was printed', async () => {
    const holidayId = await addHoliday('Kings Brithday', tradingDay, tradingDay);
    const saleId = await sellOnTheTill();
    try {
      const [sold] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
      expect(sold!.holidayId, 'the sale was not priced by the range').toBe(holidayId);
      expect(sold!.holidayName).toBe('Kings Brithday');

      const renamed = await correct(holidayId, { name: "King's Birthday" });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect((await holidayRow(holidayId)).name).toBe("King's Birthday");

      // The receipt keeps the words that were true on the day it was printed.
      const [still] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
      expect(still!.holidayName).toBe('Kings Brithday');
      expect(still!.holidayId).toBe(holidayId);

      const trail = await updateTrail(holidayId);
      expect(trail).toHaveLength(1);
      expect((trail[0]!.before as { name: string }).name).toBe('Kings Brithday');
      expect((trail[0]!.after as { name: string }).name).toBe("King's Birthday");
    } finally {
      await forget(saleId, holidayId);
    }
  });

  it('refuses to move the dates once a sale was priced by it, and names the count', async () => {
    const holidayId = await addHoliday('Traded Range', tradingDay, tradingDay);
    const saleId = await sellOnTheTill();
    try {
      const res = await correct(holidayId, { startsOn: '2033-05-01', endsOn: '2033-05-02' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('HOLIDAY_HAS_SALES');
      expect(res.json().error.details.saleCount).toBe(1);
      expect(res.json().error.message).toContain('Traded Range');

      // Refused, not half-applied: the range still covers the day it priced.
      expect(await holidayRow(holidayId)).toMatchObject({
        startsOn: tradingDay,
        endsOn: tradingDay,
      });
      expect(await updateTrail(holidayId)).toHaveLength(0);

      // A rename in the same state is still allowed — that is the ticket.
      const renamed = await correct(holidayId, { name: 'Traded Range (corrected)' });
      expect(renamed.statusCode, renamed.body).toBe(200);
    } finally {
      await forget(saleId, holidayId);
    }
  });

  it('answers a replayed correction once', async () => {
    const id = await addHoliday('Songkran typo', '2034-04-13', '2034-04-15');
    const headers = { 'idempotency-key': `holiday-correct-${id}` };
    const first = await correct(id, { name: 'Songkran' }, headers);
    const second = await correct(id, { name: 'Songkran' }, headers);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await updateTrail(id), 'the replay did the work a second time').toHaveLength(1);
    await ctx.db.delete(branchHoliday).where(eq(branchHoliday.id, id));
  });

  it('shows the panel how many sales each range priced', async () => {
    const holidayId = await addHoliday('Counted Range', tradingDay, tradingDay);
    const saleId = await sellOnTheTill();
    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/branches/${branchId}/holidays`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json().holidays as Array<{ id: string; pricedSales: number }>;
      expect(rows.find((h) => h.id === holidayId)!.pricedSales).toBe(1);
      // A range nothing has been sold under reads zero, not missing.
      expect(rows.every((h) => typeof h.pricedSales === 'number')).toBe(true);
      expect(rows.some((h) => h.pricedSales === 0)).toBe(true);
    } finally {
      await forget(saleId, holidayId);
    }
  });
});
