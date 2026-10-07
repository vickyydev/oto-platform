import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  account,
  boothConfigVersion,
  boothPrize,
  boothStaffAssignment,
  box,
  sale,
  spin,
  station,
  voucher,
  voucherPrint,
} from '@oto/db';
import { DEMO_BOOTH_NAME, DEMO_BOOTH_PREFIX, DEMO_BRANCH_CODE, seedDemoDay } from '@oto/db/seed';
import { addDaysToIsoDate, businessDate, parseDayStart, verifyBoothCode } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-15b (SCRUM-216) — RE-CHECK of the demo-day fix after the review round
 * (2c18981f: the demo booth left to the Console once made, presses drawn from
 * its latest published bundle, the operator-wide prefix rule, the plural).
 *
 *   first use    two presses at once on a database with no demo booth make one
 *                booth, one box, one wheel and one staff row
 *   the Console  what the Console can and cannot do to the demo booth once made,
 *                and what the next press does after each
 *   the draw     every spin the demo day ever filed, across every edit and
 *                publish this file makes, names a drawable slice of the very
 *                bundle it cites, at that bundle's cost, with a code of its
 *                booth's prefix; and the two places the seed's draw is not the
 *                box's (a daily cap, a wheel published after the press) are
 *                pinned as they stand
 *   convergence  after all of it, a re-press moves no byte, and the rollup twice
 *                leaves the analytics rows as they were (H10)
 */

let ctx: TestContext;
let admin: string;
let hkt: string;
let chalong: string;
let demo: string;
let somId: string;
let T: string;
let firstRun: Awaited<ReturnType<typeof seedDemoDay>>[] = [];

const send = (method: 'GET' | 'PATCH' | 'DELETE' | 'POST', url: string, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, headers: { cookie: admin }, ...(payload ? { payload } : {}) });

async function rollUp(): Promise<void> {
  const res = await send('POST', '/ops/test-controls/rollup.run');
  expect(res.statusCode, res.body).toBe(200);
}

async function demoBooth() {
  const [row] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, demo), eq(station.name, DEMO_BOOTH_NAME), isNull(station.archivedAt)));
  return row!;
}

/** A row as Postgres holds it, and the transaction that last wrote it. */
async function rowsAsStored(table: string, where: string) {
  const { rows } = await ctx.db.execute<{ id: string; xmin: string; bytes: string }>(
    sql.raw(`select x.id::text as id, x.xmin::text as xmin, x::text as bytes from ${table} x where ${where} order by x.id`),
  );
  return rows;
}

async function demoDayRows() {
  const at = `branch_id = '${demo}'`;
  return {
    sale: await rowsAsStored('pos.sale', at),
    sale_discount: await rowsAsStored('pos.sale_discount', at),
    spin: await rowsAsStored('booth.spin', at),
    voucher: await rowsAsStored('promo.voucher', at),
    voucher_print: await rowsAsStored('booth.voucher_print', at),
    voucher_redemption: await rowsAsStored('promo.voucher_redemption', at),
    booth_duty_assignment: await rowsAsStored('booth.booth_duty_assignment', at),
    booth_prize: await rowsAsStored('booth.booth_prize', at),
    booth_config_version: await rowsAsStored('booth.booth_config_version', at),
    station: await rowsAsStored('core.station', at),
    box: await rowsAsStored('core.box', at),
    booth_staff_assignment: await rowsAsStored(
      'booth.booth_staff_assignment',
      `station_id in (select id from core.station where branch_id = '${demo}')`,
    ),
  };
}

async function liveParkRows() {
  const at = `branch_id in ('${hkt}', '${chalong}')`;
  return {
    sale: await rowsAsStored('pos.sale', at),
    sale_discount: await rowsAsStored('pos.sale_discount', at),
    spin: await rowsAsStored('booth.spin', at),
    voucher: await rowsAsStored('promo.voucher', at),
    voucher_print: await rowsAsStored('booth.voucher_print', at),
    booth_prize: await rowsAsStored('booth.booth_prize', at),
    booth_config_version: await rowsAsStored('booth.booth_config_version', at),
    station: await rowsAsStored('core.station', at),
    box: await rowsAsStored('core.box', at),
  };
}

async function demoAnalyticsRows() {
  const at = `branch_id = '${demo}'`;
  return {
    legacy: await rowsAsStored('analytics.daily_summary', `${at} and source <> 'oto_pos'`),
    platform: await rowsAsStored('analytics.daily_summary', `${at} and source = 'oto_pos'`),
    booth: await rowsAsStored('analytics.fact_booth_daily', at),
    discounts: await rowsAsStored('analytics.daily_discount_summary', at),
  };
}

type Slice = { id: string; nameEn: string; active: boolean; weightBp: number; costSatang: number; voucherDefinitionId: string | null; dailyCap: number | null };

/** A day's presses at one booth, each with the bundle slice that drew it. */
async function pressesOn(stationId: string, on: string) {
  const rows = await ctx.db
    .select({ spin, voucher, version: boothConfigVersion })
    .from(spin)
    .innerJoin(voucher, eq(voucher.id, spin.voucherId))
    .innerJoin(boothConfigVersion, eq(boothConfigVersion.id, spin.boothConfigVersionId))
    .where(and(eq(spin.stationId, stationId), eq(spin.businessDate, on)))
    .orderBy(asc(spin.occurredAt));
  return rows.map((r) => ({ ...r, slice: (r.version.bundle as { prizes: Slice[] }).prizes.find((p) => p.id === r.spin.prizeId) }));
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  hkt = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  const [som] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  somId = som!.id;
  T = businessDate(new Date(), 'Asia/Bangkok', parseDayStart('05:00'));
  // The very first presses on this database, at once: nothing exists yet —
  // no demo branch, no demo booth, no box, no wheel.
  firstRun = await Promise.all([seedDemoDay(ctx.db), seedDemoDay(ctx.db)]);
  demo = await branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
  await rollUp();
}, 300_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('first use: two presses at once make one booth', () => {
  it('one booth, one box, one wheel of three slices, one staff row; each sale and press once, and the counts add up', async () => {
    const [a, b] = firstRun;
    expect(a!.sales + b!.sales).toBe(11);
    expect(a!.sales + a!.skipped).toBe(11);
    expect(b!.sales + b!.skipped).toBe(11);
    expect(a!.boothSpins + b!.boothSpins).toBe(6);
    expect(a!.boothSpins + a!.boothSpinsPresent).toBe(6);
    expect(b!.boothSpins + b!.boothSpinsPresent).toBe(6);
    expect(a!.discounts + b!.discounts).toBe(1);

    const booths = await ctx.db.select().from(station).where(and(eq(station.branchId, demo), eq(station.kind, 'booth')));
    expect(booths).toHaveLength(1);
    expect(booths[0]).toMatchObject({ name: DEMO_BOOTH_NAME, codePrefix: DEMO_BOOTH_PREFIX, archivedAt: null });
    expect(await ctx.db.select().from(box).where(eq(box.branchId, demo))).toHaveLength(1);
    expect(await ctx.db.select().from(boothPrize).where(eq(boothPrize.stationId, booths[0]!.id))).toHaveLength(3);
    expect(await ctx.db.select().from(boothConfigVersion).where(eq(boothConfigVersion.stationId, booths[0]!.id))).toHaveLength(1);
    expect(await ctx.db.select().from(boothStaffAssignment).where(eq(boothStaffAssignment.stationId, booths[0]!.id))).toEqual([
      expect.objectContaining({ accountId: somId }),
    ]);
    expect(await ctx.db.select().from(sale).where(and(eq(sale.branchId, demo), eq(sale.businessDate, T)))).toHaveLength(11);
    expect(await ctx.db.select().from(spin).where(eq(spin.stationId, booths[0]!.id))).toHaveLength(6);
  });
});

describe('the demo booth in the Console', () => {
  it('reads like any booth: its station, the branch lists, its status and its versions all answer', async () => {
    const booth = await demoBooth();
    for (const url of [
      `/stations/${booth.id}`,
      `/branches/${demo}/stations`,
      `/branches/${demo}/booths`,
      `/booths/${booth.id}/status`,
      `/booths/${booth.id}/versions`,
      `/booths/${booth.id}/draft`,
    ]) {
      const res = await send('GET', url);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    }
  });

  it('OBSERVED: its station cannot be edited — the Console refuses any edit of a station whose box is archived', async () => {
    const booth = await demoBooth();
    const renamed = await send('PATCH', `/stations/${booth.id}`, { name: 'Demo Booth One' });
    expect(renamed.statusCode, renamed.body).toBe(404);
    expect(renamed.json<{ error: { code: string } }>().error.code).toBe('BOX_NOT_FOUND');
    const reprefixed = await send('PATCH', `/stations/${booth.id}`, { codePrefix: 'DX' });
    expect(reprefixed.statusCode, reprefixed.body).toBe(404);
    expect((await demoBooth()).name).toBe(DEMO_BOOTH_NAME);
  });

  it('OBSERVED: the real fleet path never makes a live station on an archived box — archiving a box with a live station is refused', async () => {
    const [carrier] = await ctx.db
      .select({ boxId: box.id })
      .from(box)
      .innerJoin(station, and(eq(station.boxId, box.id), isNull(station.archivedAt)))
      .where(and(eq(box.branchId, hkt), isNull(box.archivedAt)))
      .limit(1);
    expect(carrier, 'a live park box carrying a live station').toBeTruthy();
    const refused = await send('DELETE', `/boxes/${carrier!.boxId}`);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('BOX_HAS_LIVE_STATIONS');
  });

  it('OBSERVED: a demo booth renamed (outside the Console) stops the next press — it is not found by name, and its own prefix refuses a new one', async () => {
    const booth = await demoBooth();
    await ctx.db.update(station).set({ name: 'Demo Booth One' }).where(eq(station.id, booth.id));
    try {
      const before = await demoDayRows();
      await expect(seedDemoDay(ctx.db, { on: addDaysToIsoDate(T, -30) })).rejects.toThrow(
        'Code prefix DB is already used by Demo Booth One at Demo Branch 2',
      );
      expect(await demoDayRows()).toEqual(before);
      // OBSERVED: through Health's control the refusal's words never reach the
      // person who pressed it — a plain Error is the api's generic 500.
      const pressed = await send('POST', '/ops/test-controls/demo.day');
      expect(pressed.statusCode).toBe(500);
      expect(pressed.json<{ error: { code: string; message: string } }>().error).toEqual({
        code: 'INTERNAL',
        message: 'Internal server error',
      });
      expect(await demoDayRows()).toEqual(before);
    } finally {
      await ctx.db.update(station).set({ name: DEMO_BOOTH_NAME }).where(eq(station.id, booth.id));
    }
  });
});

describe('what a press draws, against what a box would', () => {
  it('OBSERVED: a daily cap on a slice is not applied — a cap of 1 on the 100 still gives three 100s in a day', async () => {
    const booth = await demoBooth();
    const live = await ctx.db.select().from(boothPrize).where(and(eq(boothPrize.stationId, booth.id), isNull(boothPrize.archivedAt)));
    const p100 = live.find((p) => p.nameEn === '100 THB Voucher')!;
    expect((await send('PATCH', `/booths/${booth.id}/prizes/${p100.id}`, { dailyCap: 1 })).statusCode).toBe(200);
    const published = await send('POST', `/booths/${booth.id}/publish`, {});
    expect(published.statusCode, published.body).toBe(200);
    try {
      const D = addDaysToIsoDate(T, -20);
      expect(await seedDemoDay(ctx.db, { on: D })).toMatchObject({ sales: 11, boothSpins: 6 });
      const presses = await pressesOn(booth.id, D);
      expect(presses).toHaveLength(6);
      const capped = presses.filter((p) => p.slice?.id === p100.id);
      expect(capped[0]!.slice!.dailyCap).toBe(1);
      // A box would refuse the 100 after the first (judgePrizes: 'capped').
      expect(capped).toHaveLength(3);

      // And every one of them cites a wheel published after the press happened —
      // the latest version, published today, on a day twenty days back.
      for (const p of presses) {
        expect(p.version.publishedAt.getTime()).toBeGreaterThan(p.spin.occurredAt.getTime());
      }
    } finally {
      expect((await send('PATCH', `/booths/${booth.id}/prizes/${p100.id}`, { dailyCap: null })).statusCode).toBe(200);
      expect((await send('POST', `/booths/${booth.id}/publish`, {})).statusCode).toBe(200);
    }
  });

  it('a booth archived in the Console is made again on the next press, on the same archived box; the old one keeps its rows', async () => {
    const old = await demoBooth();
    const oldRows = await rowsAsStored('booth.spin', `station_id = '${old.id}'`);
    const archived = await send('DELETE', `/stations/${old.id}`);
    expect(archived.statusCode, archived.body).toBe(200);
    const E = addDaysToIsoDate(T, -21);
    expect(await seedDemoDay(ctx.db, { on: E })).toMatchObject({ sales: 11, boothSpins: 6, boothSpinsPresent: 0 });
    const fresh = await demoBooth();
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.boxId).toBe(old.boxId);
    expect(fresh.codePrefix).toBe(DEMO_BOOTH_PREFIX);
    expect(await ctx.db.select().from(boothConfigVersion).where(eq(boothConfigVersion.stationId, fresh.id))).toHaveLength(1);
    expect(await rowsAsStored('booth.spin', `station_id = '${old.id}'`)).toEqual(oldRows);
    expect(await ctx.db.select().from(box).where(eq(box.branchId, demo))).toHaveLength(1);
  });

  it('every spin the demo day ever filed names a drawable slice of the bundle it cites, at its cost, with its booth’s code', async () => {
    const spins = await ctx.db.select().from(spin).where(eq(spin.branchId, demo));
    // Today, the capped day and the day after the archive; the refused press wrote none.
    expect(spins).toHaveLength(6 * 3);
    for (const s of spins) {
      const label = `spin ${s.id} on ${s.businessDate}`;
      expect(s.simulated, label).toBe(false);
      const [version] = await ctx.db.select().from(boothConfigVersion).where(eq(boothConfigVersion.id, s.boothConfigVersionId));
      expect(version!.stationId, label).toBe(s.stationId);
      const slice = (version!.bundle as { prizes: Slice[] }).prizes.find((p) => p.id === s.prizeId);
      expect(slice, label).toBeTruthy();
      expect(slice!.active && slice!.weightBp > 0, label).toBe(true);
      const [v] = await ctx.db.select().from(voucher).where(eq(voucher.id, s.voucherId!));
      expect(v!.voucherDefinitionId, label).toBe(slice!.voucherDefinitionId);
      expect(v!.costSatang, label).toBe(slice!.costSatang);
      const [st] = await ctx.db.select().from(station).where(eq(station.id, s.stationId));
      expect(verifyBoothCode(v!.code), label).toEqual({ ok: true, prefix: st!.codePrefix });
      expect(await ctx.db.select().from(voucherPrint).where(eq(voucherPrint.voucherId, v!.id)), label).toHaveLength(1);
      expect(s.boxId, label).toBe(st!.boxId);
    }
    const { rows } = await ctx.db.execute<{ n: number }>(sql`
      select (select count(*) from booth.spin where branch_id in (${hkt}::uuid, ${chalong}::uuid))
           + (select count(*) from booth.voucher_print where branch_id in (${hkt}::uuid, ${chalong}::uuid))
           + (select count(*) from promo.voucher where branch_id in (${hkt}::uuid, ${chalong}::uuid) and source = 'booth') as n`);
    expect(Number(rows[0]!.n)).toBe(0);
    // Each sale's demo-day presses: exactly one spin per voucher, never two.
    const doubles = await ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from (select voucher_id from booth.spin where voucher_id is not null group by voucher_id having count(*) > 1) x`);
    expect(Number(doubles.rows[0]!.n)).toBe(0);
  });
});

describe('convergence after all of it', () => {
  it('a re-press of today moves no byte the demo day owns, and no live park row', async () => {
    // Today's day was filed by the first booth, now archived. A re-press finds
    // every press filed (a press's id is the day's key, not the booth's) and
    // writes none — but counts "already present" at the NEW booth only, so it
    // says 0 where six presses stand at the archived one.
    const first = await seedDemoDay(ctx.db);
    expect(first).toMatchObject({ sales: 0, skipped: 11, boothSpins: 0, boothSpinsPresent: 0 });
    const today = await ctx.db.select().from(spin).where(and(eq(spin.branchId, demo), eq(spin.businessDate, T)));
    expect(today).toHaveLength(6);
    const before = await demoDayRows();
    const parks = await liveParkRows();
    const again = await seedDemoDay(ctx.db);
    expect(again).toMatchObject({ sales: 0, skipped: 11, discounts: 0, discountsToppedUp: 0, boothSpins: 0, legacyFixtureDays: 0 });
    expect(await demoDayRows()).toEqual(before);
    expect(await liveParkRows()).toEqual(parks);
  });

  it('H10: the rollup twice leaves the frozen days, the booth facts and the discount rows byte-identical', async () => {
    await rollUp();
    const before = await demoAnalyticsRows();
    expect(before.legacy).toHaveLength(2);
    await rollUp();
    await rollUp();
    expect(await demoAnalyticsRows()).toEqual(before);
  });

  it('the booth spins of one day are never counted twice in the booth fact', async () => {
    const { rows } = await ctx.db.execute<{ fact: string; spins: string }>(sql`
      select (select coalesce(sum(spins), 0) from analytics.fact_booth_daily where branch_id = ${demo}::uuid)::text as fact,
             (select count(*) from booth.spin where branch_id = ${demo}::uuid and not simulated)::text as spins`);
    expect(Number(rows[0]!.fact)).toBe(Number(rows[0]!.spins));
    expect(await ctx.db.select().from(spin).where(inArray(spin.branchId, [hkt, chalong]))).toHaveLength(0);
  });
});
