import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, branch, sale, station, ticketPackage, type Db } from '@oto/db';
import { newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';
import { withBandGateDetails } from '../src/services/band-gate-details';

/**
 * SCRUM-1077 — the language the guest chose at the till is kept with the sale
 * (`pos.sale.guest_language`) and sent to the gate box with each of the sale's
 * bands (`guestLanguage` on the `bands` scope's rows), so the gate shows that
 * guest's messages in it.
 *
 * Only one of the customer display's five is kept; nothing, null or anything
 * else is kept as none, and a sale is never refused over it. The sale stays
 * idempotent as before: the same sale sent again answers the one recorded.
 * The offline path (a sale rung up on the box and replayed later) is in
 * `offline-selling.test.ts`.
 */

let ctx: TestContext;
let db: Db;
let cookie: string;
let stationId: string;
let twoHoursId: string;

async function ringUp(extra: Record<string, unknown>, id = newId(), lineId = newId()) {
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie, 'idempotency-key': `sale:${id}` },
    payload: { id, cart: { stationId, lines: [{ id: lineId, packageId: twoHoursId, kids: 1, adults: 1 }], ...extra } },
  });
  return made;
}

async function admission(extra: Record<string, unknown>) {
  const made = await ringUp(extra);
  expect(made.statusCode, made.body).toBe(200);
  const id = made.json().sale.id as string;
  const closed = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${id}/finalise`,
    headers: { cookie },
    payload: { actionId: newId() },
  });
  expect(closed.statusCode, closed.body).toBe(200);
  return id;
}

const languageOf = async (id: string) =>
  (await db.select({ guestLanguage: sale.guestLanguage }).from(sale).where(eq(sale.id, id)))[0]?.guestLanguage;

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  const tills = await db.select().from(station).where(and(eq(station.branchId, hkt!.id), eq(station.kind, 'till')));
  stationId = (tills.find((s) => s.codePrefix === 'T1') ?? tills[0]!).id;
  const packages = await db.select().from(ticketPackage).where(eq(ticketPackage.branchId, hkt!.id));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  await takeStation(ctx.app, cookie, stationId);
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the guest’s language travels from the sale to the gate (SCRUM-1077)', () => {
  it('keeps the chosen language on the sale and sends it with each of its bands', async () => {
    const saleId = await admission({ guestLanguage: 'ru' });
    expect(await languageOf(saleId)).toBe('ru');
    const rows = await db.select().from(band).where(eq(band.saleId, saleId));
    expect(rows).toHaveLength(2);
    const detailed = await withBandGateDetails(db, rows);
    for (const r of detailed) {
      expect(r.guestLanguage).toBe('ru');
      // Beside the details the gate already had, never in place of one.
      expect(r.ticketLabel).toBe('2 Hours Play');
      expect(r.validUntil).toBeTruthy();
    }
  });

  it('keeps every one of the five, and none when nobody chose', async () => {
    for (const lang of ['en', 'zh', 'th', 'ru', 'fr']) {
      expect(await languageOf(await admission({ guestLanguage: lang }))).toBe(lang);
    }
    const none = await admission({});
    const nulled = await admission({ guestLanguage: null });
    expect(await languageOf(none)).toBeNull();
    expect(await languageOf(nulled)).toBeNull();
    const rows = await db.select().from(band).where(eq(band.saleId, none));
    for (const r of await withBandGateDetails(db, rows)) expect(r.guestLanguage).toBeNull();
    // A band with no sale has no language made up.
    const [one] = await withBandGateDetails(db, [{ ...rows[0]!, saleId: null }]);
    expect(one!.guestLanguage).toBeNull();
  });

  it('never refuses a sale over it: anything that is not one of the five is kept as none', async () => {
    for (const other of ['de', 'EN', '', 42, { lang: 'ru' }]) {
      const made = await ringUp({ guestLanguage: other });
      expect(made.statusCode, made.body).toBe(200);
      expect(await languageOf(made.json().sale.id as string)).toBeNull();
    }
  });

  it('is idempotent as before: the same sale sent again answers the one recorded, language kept', async () => {
    const id = newId();
    const lineId = newId();
    const first = await ringUp({ guestLanguage: 'fr' }, id, lineId);
    expect(first.statusCode, first.body).toBe(200);
    const again = await ringUp({ guestLanguage: 'fr' }, id, lineId);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().sale.id).toBe(id);
    expect(await db.select({ id: sale.id }).from(sale).where(eq(sale.id, id))).toHaveLength(1);
    expect(await languageOf(id)).toBe('fr');
  });

  it('the quote takes the field and prices the cart exactly as without it', async () => {
    const quote = async (extra: Record<string, unknown>) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/sales/quote',
        headers: { cookie },
        payload: { stationId, lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }], ...extra },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().quote.totals;
    };
    expect(await quote({ guestLanguage: 'zh' })).toEqual(await quote({}));
  });
});
