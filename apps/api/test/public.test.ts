import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendee, auditLog, booking, branch, operator } from '@oto/db';
import { newId } from '@oto/shared';
import { createTestContext, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('public catalog (customer /book site)', () => {
  it('serves branch, tiers, active packages with full 5-language translations, and rate mode', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/public/branches/hkt-central/catalog' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.branch.name).toBe('HKT Central');
    expect(body.tiers.map((t: { id: string }) => t.id)).toEqual(['tourist', 'expat', 'thai']);
    expect(body.packages).toHaveLength(4);
    for (const pkg of body.packages) {
      for (const lang of ['zh', 'th', 'ru', 'fr']) {
        expect(pkg.translations?.[lang]?.name, `${pkg.name} missing ${lang}`).toBeTruthy();
        expect(pkg.translations?.[lang]?.description, `${pkg.name} missing ${lang} description`).toBeTruthy();
      }
    }
    expect(['weekday', 'weekend']).toContain(body.rateMode.mode);
  });

  it('404s for an unknown branch', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/public/branches/nope/catalog' });
    expect(res.statusCode).toBe(404);
  });
});

describe('public member-tier lookup', () => {
  it('returns nickname + tier ONLY — never children or other PII', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/public/member-tier?phone=0811111111&branch=hkt-central',
    });
    const body = res.json();
    expect(body).toMatchObject({ found: true, nickname: 'Mali', tierCode: 'thai' });
    expect(body.children).toBeUndefined();
    expect(body.phone).toBeUndefined();
  });

  it('unknown phone → found:false', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/public/member-tier?phone=0600000000&branch=hkt-central',
    });
    expect(res.json()).toEqual({ found: false });
  });

  // S2-01a: phone is unique PER OPERATOR, so the lookup must be scoped. An
  // unscoped call is refused outright rather than answered from whichever
  // tenant happens to match first.
  it('requires the branch scope', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/public/member-tier?phone=0811111111' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('does not answer from another operator', async () => {
    const [other] = await ctx.db.insert(operator).values({ id: newId(), name: 'Other Co' }).returning();
    const [otherBranch] = await ctx.db
      .insert(branch)
      .values({ id: newId(), operatorId: other!.id, name: 'Other Branch', code: 'other-one' })
      .returning();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/public/member-tier?phone=0811111111&branch=${otherBranch!.code}`,
    });
    expect(res.json()).toEqual({ found: false });
  });
});

describe('public booking creation — server-side pricing', () => {
  const getPackages = async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/public/branches/hkt-central/catalog' });
    return res.json().packages as Array<{ id: string; name: string }>;
  };

  it('computes the thai Full Day total with the free-adult rule (weekday)', async () => {
    const packages = await getPackages();
    const fullDay = packages.find((p) => p.name === 'Full Day Pass')!;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/public/bookings',
      payload: {
        branchCode: 'hkt-central',
        phone: '0811111111',
        parentName: 'Mali',
        tier: 'thai',
        visitDate: '2026-09-09', // Wednesday → weekday
        lines: [{ packageId: fullDay.id, kids: 2, adults: 2 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // kids 2 × ฿620 + adults: 1 free, 1 × ฿350 = ฿1,590
    expect(body.totalSatang).toBe(159000);
    expect(body.rateMode).toBe('weekday');
    expect(body.reference).toMatch(/^OTO-/);

    const [row] = await ctx.db.select().from(booking).where(eq(booking.reference, body.reference));
    expect(row!.totalSatang).toBe(159000);
    expect(row!.memberId).not.toBeNull(); // linked to Mali by phone
    const kids = await ctx.db.select().from(attendee).where(eq(attendee.bookingId, row!.id));
    expect(kids).toHaveLength(2);
    const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'booking.create'));
    expect(audits.length).toBeGreaterThan(0);
  });

  it('tourist pays the flat adult admission; weekend/holiday rates apply', async () => {
    const packages = await getPackages();
    const oneHour = packages.find((p) => p.name === '1 Hour Play')!;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/public/bookings',
      payload: {
        branchCode: 'hkt-central',
        parentName: 'Guest',
        tier: 'tourist',
        visitDate: '2026-11-24', // seeded Loy Krathong holiday (Tuesday) → weekend rates
        lines: [{ packageId: oneHour.id, kids: 1, adults: 1 }],
      },
    });
    const body = res.json();
    // kid ฿690 (flat both modes) + adult weekend admission ฿500 = ฿1,190
    expect(body.rateMode).toBe('weekend');
    expect(body.totalSatang).toBe(119000);
  });

  it('rejects unknown tiers, unknown packages, and empty selections', async () => {
    const packages = await getPackages();
    const anyPkg = packages[0]!;
    const badTier = await ctx.app.inject({
      method: 'POST',
      url: '/public/bookings',
      payload: {
        branchCode: 'hkt-central',
        parentName: 'X',
        tier: 'vip',
        lines: [{ packageId: anyPkg.id, kids: 1, adults: 0 }],
      },
    });
    expect(badTier.statusCode).toBe(400);

    const emptySelection = await ctx.app.inject({
      method: 'POST',
      url: '/public/bookings',
      payload: {
        branchCode: 'hkt-central',
        parentName: 'X',
        tier: 'tourist',
        lines: [{ packageId: anyPkg.id, kids: 0, adults: 0 }],
      },
    });
    expect(emptySelection.statusCode).toBe(400);

    const badPackage = await ctx.app.inject({
      method: 'POST',
      url: '/public/bookings',
      payload: {
        branchCode: 'hkt-central',
        parentName: 'X',
        tier: 'tourist',
        lines: [{ packageId: '00000000-0000-7000-8000-000000000000', kids: 1, adults: 0 }],
      },
    });
    expect(badPackage.statusCode).toBe(400);
  });
});
