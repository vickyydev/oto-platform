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
    // The slug is still the prototype's; the name is the park's own.
    expect(body.branch.name).toBe('Oto Play Park, Central Floresta');
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

/**
 * SCRUM-298 — the booking site's double submit.
 *
 * Every mutating route on this api is covered by the idempotency plugin, and
 * this one was not: a row in that store is owned by an account
 * (`core.idempotency_key.account_id` is not null and references
 * `core.account`), so a customer on the booking page has nothing to own a key
 * with and the plugin returns before claiming one. The `Idempotency-Key` the
 * site sends did nothing here. A double-tap on a mall's wifi — or a browser
 * retrying a request it never saw answered — was two bookings, two references
 * and two held slots for one family, and reception found out at the door.
 *
 * What closes it needs no migration and no anonymous principal: the SITE mints
 * the booking id, and the primary key is the unique constraint. This file pins
 * the second submit being answered with the FIRST one's row rather than
 * re-priced — the reference is random and the prices move, so a fresh
 * computation would be a different answer to the same question.
 */
describe('a booking submitted twice is one booking (SCRUM-298)', () => {
  const fullDayId = async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/public/branches/hkt-central/catalog' });
    const packages = res.json().packages as Array<{ id: string; name: string }>;
    return packages.find((p) => p.name === 'Full Day Pass')!.id;
  };

  const submit = (payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: '/public/bookings', payload });

  const bookingFor = async (id: string) => {
    const packageId = await fullDayId();
    return {
      id,
      branchCode: 'hkt-central',
      parentName: 'Double Tap',
      tier: 'tourist',
      visitDate: '2026-09-09',
      lines: [{ packageId, kids: 1, adults: 1 }],
    };
  };

  it('the same id twice is one row, one set of attendees and one audit entry', async () => {
    const id = newId();
    const payload = await bookingFor(id);

    const first = await submit(payload);
    const second = await submit(payload);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // The reference is random per call, so an equal answer is only possible if
    // the second submit was ANSWERED FROM THE ROW rather than served by a
    // second booking that happens to cost the same. Values, not bytes: the
    // priced lines come back through a `jsonb` column, and Postgres orders an
    // object's keys its own way.
    expect(second.json()).toEqual(first.json());
    expect(second.headers['x-oto-replay']).toBe('true');

    expect(await ctx.db.select().from(booking).where(eq(booking.id, id))).toHaveLength(1);
    // The attendees and the trail are the part reception and the door see. A
    // replay that re-ran the inserts would show one booking with two children
    // on it, which is worse than two bookings because nothing looks wrong.
    expect(await ctx.db.select().from(attendee).where(eq(attendee.bookingId, id))).toHaveLength(1);
    expect(await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, id))).toHaveLength(1);
  });

  it('two submits racing each other still make one booking', async () => {
    // Both pass the read before either has written: the read cannot close
    // this, and `onConflictDoNothing` is what does. The loser waits on the
    // winner's row and is handed the winner's answer.
    const id = newId();
    const payload = await bookingFor(id);

    const [a, b] = await Promise.all([submit(payload), submit(payload)]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(await ctx.db.select().from(booking).where(eq(booking.id, id))).toHaveLength(1);
    expect(await ctx.db.select().from(attendee).where(eq(attendee.bookingId, id))).toHaveLength(1);
  });

  it('without an id, two submits are two bookings — the id is what does the work', async () => {
    // Not vacuous: the same payload with no id still makes two, which is the
    // behaviour this route had for every caller until the id existed. The
    // site sends one; a caller that does not gets what it asks for.
    const packageId = await fullDayId();
    const payload = {
      branchCode: 'hkt-central',
      parentName: 'No Id At All',
      tier: 'tourist',
      visitDate: '2026-09-09',
      lines: [{ packageId, kids: 1, adults: 0 }],
    };

    const first = await submit(payload);
    const second = await submit(payload);

    expect(first.json().reference).not.toBe(second.json().reference);
    expect(second.headers['x-oto-replay']).toBeUndefined();
  });

  it('an id that belongs to another operator is refused, and says nothing about whose', async () => {
    // The id is a uuid the site mints, so a collision is vanishingly unlikely
    // and a deliberate one is not: this is the path where somebody sends an id
    // that is not theirs to use. It must not become a way to read a booking
    // across tenants, and it must not confirm that the id is in use elsewhere
    // by answering differently from any other bad request.
    const [other] = await ctx.db
      .insert(operator)
      .values({ id: newId(), name: 'Other Co (bookings)' })
      .returning();
    const [otherBranch] = await ctx.db
      .insert(branch)
      .values({ id: newId(), operatorId: other!.id, name: 'Other Branch', code: 'other-bookings' })
      .returning();
    const stolen = newId();
    await ctx.db.insert(booking).values({
      id: stolen,
      operatorId: other!.id,
      branchId: otherBranch!.id,
      reference: 'OTO-9999-9999',
      bookingDate: '2026-09-09',
      status: 'paid',
      totalSatang: 100,
    });

    const res = await submit(await bookingFor(stolen));

    expect(res.statusCode).toBe(400);
    // Not the other operator's reference, not its total, not its branch.
    expect(res.body).not.toContain('OTO-9999-9999');
    expect(res.body).not.toContain(otherBranch!.id);
    // And the row it names is untouched.
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, stolen));
    expect(row!.reference).toBe('OTO-9999-9999');
  });
});
