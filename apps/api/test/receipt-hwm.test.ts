import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { box, branch, receiptSeries, sale, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { cacheBundle } from '../src/services/sync';
import type { BoxAuth } from '../src/services/box';

/**
 * SCRUM-275, half two — the receipt high-water mark the cache bundle ships.
 *
 * `receipt_series` shipped `highWaterMark: 0` for every station on every box,
 * with a comment saying the money path would fill it. The money path landed
 * (S2-09a) and this did not. What that costs is not a wrong figure on a report:
 * a box that starts from 0 mints `T1-000001` for a sale it takes offline, and
 * if any other box has already issued that number — a Pi restored from an image,
 * a standby swapped into the slot, a store reset — then `sale_receipt_number_unique`
 * refuses the second one at the cloud. Offline that refusal arrives after the
 * money is in the drawer, and the sale is quarantined rather than banked.
 *
 * So what is asserted here is narrow and is the thing that matters: the number
 * the bundle tells a box to continue FROM is the last number the cloud actually
 * issued for that station's series, and a station that has never numbered a
 * receipt is the only station that gets 0.
 *
 * The sales are made through the real route with a real reception session, as
 * `sales.test.ts` does, so the mark is read off numbers that were allocated by
 * `allocateReceipt` rather than by this file.
 *
 * WHAT IT DOES NOT PROVE: that a box CONTINUES from the mark. Nothing on the box
 * allocates a receipt number yet — there is no offline sale path in
 * `@oto/box-agent` to allocate one — so there is nothing to test on that side.
 * The bundle is correct for S2-12 to read; the moment that path exists it owes
 * this file a case saying it starts from `max(local, cloud)`.
 */

let ctx: TestContext;
let cookie: string;
let auth: BoxAuth;
let tillId: string;
let boothId: string;
let twoHoursId: string;

interface SeriesItem {
  stationId: string;
  prefix: string | null;
  highWaterMark: number;
}

/** The `receipt_series` scope of the bundle this box would be served, by prefix. */
async function marks(): Promise<Map<string, SeriesItem>> {
  const bundle = await cacheBundle(ctx.db, auth, { scopes: ['receipt_series'] });
  const items = (bundle.scopes.receipt_series?.items ?? []) as SeriesItem[];
  return new Map(items.map((item) => [item.prefix ?? item.stationId, item]));
}

/** A ฿0 comp, which finalises in one call and therefore takes a receipt number. */
async function comp(): Promise<number> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: {
      stationId: tillId,
      id: newId(),
      lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 0 }],
      manualDiscounts: [
        { id: newId(), scope: 'order', type: 'comp', value: 0, reason: 'Staff / family' },
      ],
      finalise: true,
    },
  });
  expect(res.statusCode).toBe(200);
  return Number(res.json().sale.receiptSeq);
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  const stations = await ctx.db.select().from(station).where(eq(station.branchId, hkt!.id));
  const till = stations.find((s) => s.codePrefix === 'T1')!;
  tillId = till.id;
  // The booth sits on the same box and has a prefix of its own, so it is the
  // station in this bundle that has never numbered anything.
  boothId = stations.find((s) => s.codePrefix === 'B1' && s.boxId === till.boxId)!.id;

  const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, till.boxId!));
  auth = {
    boxId: boxRow!.id,
    operatorId: boxRow!.operatorId,
    branchId: boxRow!.branchId,
    name: boxRow!.name,
    slot: boxRow!.slot,
    role: boxRow!.role,
    status: boxRow!.status,
    currentEpoch: boxRow!.currentEpoch,
    syncPublicKey: boxRow!.syncPublicKey,
    lastStatus: boxRow!.lastStatus as Record<string, unknown> | null,
  };

  const packages = await ctx.db
    .select()
    .from(ticketPackage)
    .where(eq(ticketPackage.branchId, hkt!.id));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the cache bundle tells a box where its receipt numbering stands (SCRUM-275)', () => {
  it('ships the last number issued, and 0 only for a station that has issued none', async () => {
    const before = await marks();
    // Nothing has sold on this fresh database, so this is the honest 0 — the
    // one the old code shipped for every station whatever the ledger said.
    expect(before.get('T1')!.highWaterMark).toBe(0);
    expect(before.get('T1')!.stationId).toBe(tillId);

    const first = await comp();
    const second = await comp();
    expect(second).toBe(first + 1);

    const after = await marks();
    // Two sales, two numbers, and the box is told to continue past the second.
    expect(after.get('T1')!.highWaterMark).toBe(2);
    expect(after.get('T1')!.highWaterMark).toBe(second);
    // The booth is on the same box and in the same bundle, and it has sold
    // nothing: its 0 is the real one, which is why a blanket 0 was invisible.
    expect(after.get('B1')!.highWaterMark).toBe(0);
    expect(after.get('B1')!.stationId).toBe(boothId);
  });

  it("is the allocator's own mark, so it is never behind a number already printed", async () => {
    const seq = await comp();
    const [row] = await ctx.db
      .select()
      .from(sale)
      .where(and(eq(sale.stationId, tillId), eq(sale.receiptSeq, seq)));
    expect(row!.receiptNumber).toBe(`T1-${String(seq).padStart(6, '0')}`);

    const [series] = await ctx.db
      .select()
      .from(receiptSeries)
      .where(and(eq(receiptSeries.stationId, tillId), eq(receiptSeries.series, 'T1')));
    // `next_seq` is what will be issued next; the mark is what HAS been issued.
    // A box handed `next_seq` would skip a number on every reconnect; a box
    // handed anything lower would re-issue one somebody is holding on paper.
    expect(series!.nextSeq).toBe(seq + 1);
    expect((await marks()).get('T1')!.highWaterMark).toBe(seq);
  });

  it('counts the series the station prints under, not every series it ever had', async () => {
    /**
     * The printed number carries the prefix, so a station whose prefix changes
     * starts a NEW series at 1 rather than continuing the old one's count under
     * a new name — and the old series keeps its own mark for the numbers it
     * issued. A mark carried across the rename would tell the box to skip
     * `T9-000001` … `T9-000003`, which is a gap nobody can explain from the
     * ledger.
     */
    const carried = (await marks()).get('T1')!.highWaterMark;
    expect(carried).toBeGreaterThan(0);
    await ctx.db.update(station).set({ codePrefix: 'T9' }).where(eq(station.id, tillId));
    try {
      const renamed = await marks();
      expect(renamed.get('T9')!.highWaterMark).toBe(0);
      expect(renamed.has('T1')).toBe(false);
    } finally {
      await ctx.db.update(station).set({ codePrefix: 'T1' }).where(eq(station.id, tillId));
    }
    expect((await marks()).get('T1')!.highWaterMark).toBe(carried);
  });
});
