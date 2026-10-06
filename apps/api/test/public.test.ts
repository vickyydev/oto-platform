import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendee, auditLog, booking, branch, operator } from '@oto/db';
import { newId } from '@oto/shared';
import { createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * A plain weekday inside the bookable window (the server refuses a visit date
 * before the branch's trading day or past sixty days out since SCRUM-209),
 * computed so this file never goes stale. Seven days out, skipping weekends
 * and the seeded Loy Krathong range.
 */
const BOOKABLE_WEEKDAY = (() => {
  const day = new Date(Date.now() + 7 * 86_400_000);
  for (;;) {
    const iso = new Date(day.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    const nearHoliday = iso >= '2026-11-23' && iso <= '2026-11-25';
    if (dow !== 0 && dow !== 6 && !nearHoliday) return iso;
    day.setUTCDate(day.getUTCDate() + 1);
  }
})();


/**
 * BUDGET: `POST /public/bookings` is capped at 20 a minute per address
 * (routes/public.ts), and `inject` always arrives from 127.0.0.1, so every
 * booking in this file shares one bucket. This file spends 12 of them — five
 * in the pricing block (the three refusals count too: the limiter runs in
 * `onRequest`, before the body is validated) and seven in the double-submit
 * block. Adding nine more here starts answering 429; `bookings-redeem.test.ts`
 * already sits at 19 and plants its remaining rows for that reason.
 *
 * Past the cap the answer is a 429 `TOO_MANY_REQUESTS` carrying
 * `details.retryAfterSeconds` and a `Retry-After` header — pinned by
 * `rate-limit-public.test.ts`, not here (SCRUM-335).
 */

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

/**
 * SCRUM-252 — the open catalogue answers what the booking site reads, and
 * nothing else.
 *
 * `packages` was the raw `select()`, so every column of `pos.ticket_package`
 * left the building on a URL addressed by a slug a stranger can guess:
 * `operatorId`, `branchId`, `createdAt`, `updatedAt`, `archivedAt`.
 *
 * The lists below are the contract, and they are written out rather than
 * derived so that a column added to the table is a line somebody has to add
 * here on purpose. The key set is compared for EQUALITY: a subset check would
 * pass on the very leak this exists to stop.
 */
describe('public catalogue exposure (SCRUM-252)', () => {
  /** Never in a public answer, whatever it is called. */
  const INTERNAL = /operator|archived|updated|created|cost|note/i;

  const catalog = async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/public/branches/hkt-central/catalog' });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const keys = (o: object) => Object.keys(o).sort();

  it('answers exactly the package fields the site consumes', async () => {
    const body = await catalog();
    expect(body.packages.length).toBeGreaterThan(0);
    for (const pkg of body.packages) {
      expect(keys(pkg), `package ${pkg.name}`).toEqual(
        [
          // The one internal uuid kept: POST /public/bookings takes it back.
          'id',
          'name',
          'description',
          'durationLabel',
          'hours',
          'prices',
          'tierPricing',
          'adultRules',
          'freebies',
          'creditRule',
          'gateAccess',
          'translations',
          'active',
        ].sort(),
      );
    }
  });

  it('answers exactly the branch, tier, rate-mode and holiday fields', async () => {
    const body = await catalog();
    expect(keys(body)).toEqual(['addOns', 'branch', 'holidays', 'packages', 'rateMode', 'taxConfig', 'tiers']);
    expect(keys(body.branch)).toEqual(['businessDayStart', 'code', 'name', 'timezone']);
    for (const tier of body.tiers) {
      // `id` here is the tier CODE, not the row's uuid.
      expect(keys(tier)).toEqual(['id', 'isDefault', 'name', 'requiresVerification']);
      expect(tier.id).not.toMatch(/^[0-9a-f]{8}-/);
    }
    for (const holiday of body.holidays) {
      expect(keys(holiday)).toEqual(['endsOn', 'name', 'startsOn']);
    }
    // `overrideName` is present only on a date a holiday range covers.
    expect(keys(body.rateMode).filter((k) => k !== 'overrideName')).toEqual([
      'date',
      'mode',
      'reason',
    ]);
  });

  it('answers exactly the extra fields the site prices with, and the tax configuration (S2-12)', async () => {
    const body = await catalog();
    expect(body.addOns.length).toBeGreaterThan(0);
    for (const addOn of body.addOns) {
      expect(keys(addOn), `add-on ${addOn.name}`).toEqual(
        ['id', 'name', 'priceSatang', 'priceWeekendSatang', 'taxCategory', 'translations'].sort(),
      );
    }
    // The seeded extras keep the ids the site's own rules read them by.
    expect(body.addOns.map((a: { id: string }) => a.id)).toContain('a-socks');
    expect(keys(body.taxConfig)).toEqual(['categoryRules', 'discountPlacement', 'rates']);
  });

  it('carries no internal column anywhere in the answer', async () => {
    const body = await catalog();
    const walk = (value: unknown, path: string): string[] => {
      if (Array.isArray(value)) return value.flatMap((v, i) => walk(v, `${path}[${i}]`));
      if (value && typeof value === 'object') {
        return Object.entries(value).flatMap(([k, v]) =>
          INTERNAL.test(k) ? [`${path}.${k}`] : walk(v, `${path}.${k}`),
        );
      }
      return [];
    };
    expect(walk(body, 'catalog')).toEqual([]);
    // And the ids of the rows behind it are not in the bytes either: the
    // branch and the operator are addressed by slug and by nothing.
    const [br] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
    const res = await ctx.app.inject({ method: 'GET', url: '/public/branches/hkt-central/catalog' });
    expect(res.body).not.toContain(br!.id);
    expect(res.body).not.toContain(br!.operatorId);
  });

  it('still carries everything the booking site hydrates from', async () => {
    // The other half of the contract: a projection that strips too much is the
    // same defect pointing the other way, and it would show up as a customer
    // being quoted nothing.
    const body = await catalog();
    const fullDay = body.packages.find((p: { name: string }) => p.name === 'Full Day Pass');
    expect(fullDay.prices.thai).toMatchObject({ weekday: expect.any(Number), weekend: expect.any(Number) });
    expect(fullDay.adultRules.thai).toMatchObject({ kind: 'free_adults', freeAdults: 1 });
    expect(fullDay.translations.th.name).toBeTruthy();
    expect(fullDay.durationLabel).toBe('All Day');
    expect(fullDay.hours).toBe(8);
    expect(body.branch.timezone).toBe('Asia/Bangkok');
    expect(body.branch.businessDayStart).toMatch(/^05:00/);
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
        visitDate: BOOKABLE_WEEKDAY, // a computed in-window weekday
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
      visitDate: BOOKABLE_WEEKDAY,
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
      visitDate: BOOKABLE_WEEKDAY,
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
