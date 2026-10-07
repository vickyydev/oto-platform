import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  branch,
  checkin,
  child,
  guardian,
  member,
  product,
  refund,
  registration,
  release,
  sale,
  spin,
  station,
  ticketPackage,
} from '@oto/db';
import {
  DEMO_BOOTH_NAME,
  DEMO_BRANCH_CODE,
  DEMO_BRANCH_NAME,
  DemoBranchRefusedError,
  DemoDayRefusedError,
  seedDemoDay,
} from '@oto/db/seed';
import { newId } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-503 REVIEW, items 7–9 — the staging demo controls, each driven on a
 * disposable database:
 *
 *   9  the re-press count: archived twice over, with stray presses beside the
 *      day's (another day's, and a live booth's at the same branch), the
 *      re-press still says exactly the day's six are present;
 *   8  the refusal passthrough: a refusal the builder did not drive (the demo
 *      till with no prefix) reaches the Console in its own words as a 409 and
 *      writes nothing; a real fault (a table gone) is still the generic 500;
 *   7  the reset over supervised stays made through the real routes — a
 *      seeded family's child released with an unused prepaid meal refunded,
 *      a walk-up family with a collector — then the park checks the same
 *      child in again; and a deployment without the switch, a branch-scoped
 *      manager and a wrong phrase still touch nothing.
 */

const STORAGE_ENV = {
  MINIO_ENDPOINT: 'localhost',
  MINIO_PORT: '9000',
  MINIO_USE_SSL: 'false',
  MINIO_ACCESS_KEY: 'oto',
  MINIO_SECRET_KEY: 'otosecret123',
  MINIO_BUCKET: 'oto-files-test',
};
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

let ctx: TestContext;
let admin: string;
let reception: string;
let manager: string;
let central: string;

async function send(as: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>, on = ctx) {
  return on.app.inject({ method, url, headers: { cookie: as }, ...(payload ? { payload } : {}) });
}
const pressDemoDay = (on = ctx, as = admin) => send(as, 'POST', '/ops/test-controls/demo.day', undefined, on);

async function liveDemoBooth() {
  const demo = await branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
  const [row] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, demo), eq(station.name, DEMO_BOOTH_NAME), isNull(station.archivedAt)));
  return row!;
}

/** What a press must never move at a live park. */
async function liveParkRows(on: TestContext, branchId: string) {
  const [sales] = await on.db.select({ n: sql<number>`count(*)::int` }).from(sale).where(eq(sale.branchId, branchId));
  const [spins] = await on.db.select({ n: sql<number>`count(*)::int` }).from(spin).where(eq(spin.branchId, branchId));
  return { sales: sales!.n, spins: spins!.n };
}

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: { ...STORAGE_ENV, OPS_TEST_CONTROLS: 'true' } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// --- 9 ---------------------------------------------------------------------------------

describe('9 review — the re-press counts the day, and only the day', () => {
  it('archived twice, with another day’s press and a live press beside it, still says the day’s six', async () => {
    const parkBefore = await liveParkRows(ctx, central);
    const first = await pressDemoDay();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().message).toMatch(/: 11 sales added, 0 already present; booth: 6 spins added, 0 already present/);
    const demo = await branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
    const daySpins = await ctx.db.select().from(spin).where(eq(spin.branchId, demo));
    expect(daySpins).toHaveLength(6);
    const day = daySpins[0]!.businessDate;
    expect(daySpins.every((s) => s.actionId?.startsWith(`demo-day/${day}/${DEMO_BRANCH_CODE}/`))).toBe(true);

    // Archived in the Console, twice over: each press makes the booth again.
    for (let round = 0; round < 2; round += 1) {
      const old = await liveDemoBooth();
      const archived = await send(admin, 'DELETE', `/stations/${old.id}`);
      expect(archived.statusCode, archived.body).toBe(200);
      const again = await pressDemoDay();
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().message).toMatch(/: 0 sales added, 11 already present; booth: 0 spins added, 6 already present\./);
      expect((await liveDemoBooth()).id).not.toBe(old.id);
    }

    // Two presses that are not this day's, at the same branch: one from the
    // day before under the demo day's own key shape, one a live press today.
    const model = daySpins[0]!;
    const yesterday = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    for (const [actionId, businessDate] of [
      [`demo-day/${yesterday}/${DEMO_BRANCH_CODE}/booth/older`, yesterday],
      [`booth-press/${newId()}`, day],
    ] as const) {
      await ctx.db.execute(sql`
        insert into booth.spin
        select (s).* from (
          select (jsonb_populate_record(null::booth.spin,
                    to_jsonb(x) || jsonb_build_object('id', ${newId()}::text, 'voucher_id', null,
                                                      'action_id', ${actionId}::text, 'business_date', ${businessDate}::text))) as s
            from booth.spin x where x.id = ${model.id}
        ) t`);
    }
    expect(await ctx.db.select({ id: spin.id }).from(spin).where(eq(spin.branchId, demo))).toHaveLength(8);
    const counted = await pressDemoDay();
    expect(counted.statusCode, counted.body).toBe(200);
    expect(counted.json().message).toMatch(/booth: 0 spins added, 6 already present\./);

    // Never at a live park.
    expect(await liveParkRows(ctx, central)).toEqual(parkBefore);
  });

  it('pointed at a live park the seed refuses before it writes, as a refusal', async () => {
    const before = await liveParkRows(ctx, central);
    const err = await seedDemoDay(ctx.db, { branchCode: CENTRAL_BRANCH_CODE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DemoBranchRefusedError);
    expect(err).toBeInstanceOf(DemoDayRefusedError);
    expect((err as Error).message).toBe(`Demo sales are written to ${DEMO_BRANCH_NAME} only; "${CENTRAL_BRANCH_CODE}" is not a demo branch.`);
    expect(await liveParkRows(ctx, central)).toEqual(before);
  });
});

// --- 8 ---------------------------------------------------------------------------------

describe('8 review — a refusal reaches the Console in its words; a fault stays a fault', () => {
  it('the demo till left with no prefix: 409 DEMO_DAY_REFUSED with the sentence the Console shows, nothing written', async () => {
    const demo = await branchIdByCode(ctx.db, DEMO_BRANCH_CODE);
    const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, demo), eq(station.kind, 'till'), isNull(station.archivedAt)));
    expect(till?.codePrefix).toBeTruthy();
    const [demoBranch] = await ctx.db.select({ name: branch.name }).from(branch).where(eq(branch.id, demo));
    const salesBefore = await ctx.db.select({ id: sale.id }).from(sale);
    const spinsBefore = await ctx.db.select({ id: spin.id }).from(spin);
    await ctx.db.update(station).set({ codePrefix: null }).where(eq(station.id, till!.id));
    try {
      const refused = await pressDemoDay();
      expect(refused.statusCode, refused.body).toBe(409);
      // The Console's client reads `error.message` and the Health card shows it as the press's note.
      expect(refused.json()).toEqual({
        error: { code: 'DEMO_DAY_REFUSED', message: `No station "${till!.name}" with a code prefix at ${demoBranch!.name}.` },
      });
      expect(await ctx.db.select({ id: sale.id }).from(sale)).toHaveLength(salesBefore.length);
      expect(await ctx.db.select({ id: spin.id }).from(spin)).toHaveLength(spinsBefore.length);
    } finally {
      await ctx.db.update(station).set({ codePrefix: till!.codePrefix }).where(eq(station.id, till!.id));
    }
    expect((await pressDemoDay()).statusCode).toBe(200);
  });

  it('a real fault — a table the seed reads is gone — is still the generic 500 with nothing leaked', async () => {
    await ctx.db.execute(sql`alter table pos.branch_tax_config rename to branch_tax_config_s502_review`);
    try {
      const fault = await pressDemoDay();
      expect(fault.statusCode, fault.body).toBe(500);
      expect(fault.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    } finally {
      await ctx.db.execute(sql`alter table pos.branch_tax_config_s502_review rename to branch_tax_config`);
    }
    expect((await pressDemoDay()).statusCode).toBe(200);
  });
});

// --- 7 ---------------------------------------------------------------------------------

async function tillAndPackage(on: TestContext) {
  const park = await branchIdByCode(on.db, CENTRAL_BRANCH_CODE);
  const [till] = await on.db.select().from(station).where(and(eq(station.branchId, park), eq(station.codePrefix, 'T1')));
  const [pkg] = await on.db.select().from(ticketPackage).where(and(eq(ticketPackage.branchId, park), eq(ticketPackage.name, '2 Hours Play')));
  const [hotdog] = await on.db.select().from(product).where(and(eq(product.operatorId, till!.operatorId), eq(product.code, 'FB-HOTDOG')));
  return { park, till: till!, pkg: pkg!, hotdog: hotdog! };
}

/** A drop-off stay through the real routes: registered, paid, checked in, banded. */
async function stayFor(
  on: TestContext,
  as: string,
  child: { memberId?: string; childId?: string; name: string; meals: number },
): Promise<{ registrationId: string; checkinId: string; saleId: string }> {
  const { park, till, pkg, hotdog } = await tillAndPackage(on);
  const registrationId = newId();
  const checkinId = newId();
  const food = child.meals > 0
    ? {
        mode: 'prepaid_items' as const,
        paidSatang: hotdog.priceSatang * child.meals,
        items: [{ menuItemId: hotdog.id, menuItemName: hotdog.name, unitSatang: hotdog.priceSatang, qty: child.meals, redeemedQty: 0 }],
      }
    : { mode: 'none' as const, paidSatang: 0 };
  const reg = await send(as, 'POST', '/checkin/registrations', {
    id: registrationId, branchId: park, stationId: till.id,
    ...(child.memberId ? { memberId: child.memberId } : {}),
    guardianName: 'Ploy', guardianPhone: '0812345678', contactChannel: 'whatsapp',
    consentAcknowledged: true, acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
    children: [{ checkinId, ...(child.childId ? { childId: child.childId } : {}), name: child.name, ageYears: 6, service: 'drop_off', allergies: null, foodRestrictions: null, foodProvision: food }],
  }, on);
  expect(reg.statusCode, reg.body).toBe(200);
  const saleId = newId();
  const rung = await send(as, 'POST', '/sales', {
    id: saleId, stationId: till.id,
    lines: [{ id: checkinId, packageId: pkg.id, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 }, foodProvision: child.meals > 0 ? { mode: food.mode, paidSatang: food.paidSatang } : null }],
  }, on);
  expect(rung.statusCode, rung.body).toBe(200);
  const paid = await send(as, 'POST', `/sales/${saleId}/finalise`, {}, on);
  expect(paid.statusCode, paid.body).toBe(200);
  const inPark = await send(as, 'POST', '/checkin/check-in-now', { saleId, entries: [{ checkinId, nannyId: null }] }, on);
  expect(inPark.statusCode, inPark.body).toBe(200);
  return { registrationId, checkinId, saleId };
}

const STAY_TYPES = ['checkin', 'registration', 'guardian', 'release', 'supervision_waiver'];

describe('7 review — the reset over supervised stays made through the real routes', () => {
  let mali: { id: string; ploy: { id: string; allergies: string | null; updatedAt: Date } };
  let released: { registrationId: string; checkinId: string; saleId: string };
  let walkUp: { registrationId: string; checkinId: string };

  it('builds a day of supervision: a seeded family’s child released with a meal refunded, a walk-up child in the park with a collector', async () => {
    const [m] = await ctx.db.select().from(member).where(eq(member.phone, '+66811111111'));
    const [ploy] = await ctx.db.select().from(child).where(and(eq(child.memberId, m!.id), eq(child.name, 'Nong Ploy')));
    mali = { id: m!.id, ploy: { id: ploy!.id, allergies: ploy!.allergies, updatedAt: ploy!.updatedAt } };

    released = await stayFor(ctx, reception, { memberId: mali.id, childId: mali.ploy.id, name: 'Nong Ploy', meals: 2 });
    const photoId = newId();
    const photo = await send(reception, 'POST', '/files', { id: photoId, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: released.registrationId, filename: 'pickup.jpg' });
    expect(photo.statusCode, photo.body).toBe(200);
    const out = await send(reception, 'POST', `/checkin/pickups/stays/${released.checkinId}/release`, { id: newId(), collector: { kind: 'dropper_off' }, pickupPhotoFileId: photoId });
    expect(out.statusCode, out.body).toBe(200);
    const [handBack] = await ctx.db.select().from(release).where(eq(release.checkinId, released.checkinId));
    expect(handBack).toBeTruthy();

    const signedUp = await send(reception, 'POST', '/members', { phone: '0655502001', nickname: 'S502 review family' });
    expect(signedUp.statusCode, signedUp.body).toBe(200);
    walkUp = await stayFor(ctx, reception, { memberId: signedUp.json().member.id as string, name: 'Pim', meals: 0 });
    const collector = await send(reception, 'POST', `/checkin/pickups/registrations/${walkUp.registrationId}/guardians`, { id: newId(), name: 'Khun Somchai', relationship: 'grandfather', source: 'in_person' });
    expect(collector.statusCode, collector.body).toBe(200);
  });

  it('a branch-scoped manager, a wrong phrase and a deployment without the switch delete nothing', async () => {
    const stays = await ctx.db.select({ id: checkin.id }).from(checkin);
    expect(stays.length).toBeGreaterThanOrEqual(2);
    const byManager = await send(manager, 'POST', '/ops/demo-reset', { confirm: 'RESET DEMO DATA' });
    expect(byManager.statusCode).toBe(403);
    const wrongPhrase = await send(admin, 'POST', '/ops/demo-reset', { confirm: 'reset demo data' });
    expect(wrongPhrase.statusCode).toBe(400);
    expect(await ctx.db.select({ id: checkin.id }).from(checkin)).toHaveLength(stays.length);

    // Production: no switch. The same admin, the same phrase — and nothing moves.
    const live = await createTestContext();
    try {
      const liveAdmin = await signInAs(live.app, ADMIN.phone, ADMIN.password);
      const liveReception = await signInAs(live.app, RECEPTION.phone, RECEPTION.password);
      const liveStay = await stayFor(live, liveReception, { name: 'Live park child', meals: 0 });
      const refused = await send(liveAdmin, 'POST', '/ops/demo-reset', { confirm: 'RESET DEMO DATA' }, live);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.message).toBe('Operational test controls are off on this deployment');
      const noDemo = await pressDemoDay(live, liveAdmin);
      expect(noDemo.statusCode).toBe(403);
      expect(await live.db.select({ id: checkin.id }).from(checkin).where(eq(checkin.id, liveStay.checkinId))).toHaveLength(1);
      expect(await live.db.select({ id: sale.id }).from(sale).where(eq(sale.id, liveStay.saleId))).toHaveLength(1);
      expect(await live.db.select({ id: branch.id }).from(branch).where(eq(branch.code, DEMO_BRANCH_CODE))).toEqual([]);
    } finally {
      await live.close();
    }
  });

  it('the reset clears every stay, its hand-back and its refund, keeps the seeded family whole, and the park checks the same child in again', async () => {
    const reset = await send(admin, 'POST', '/ops/demo-reset', { confirm: 'RESET DEMO DATA' });
    expect(reset.statusCode, reset.body).toBe(200);
    const { deleted } = reset.json() as { deleted: Record<string, number> };
    expect(deleted.checkin).toBeGreaterThanOrEqual(2);
    expect(deleted.registration).toBeGreaterThanOrEqual(2);
    expect(deleted.release).toBe(1);
    expect(deleted.guardian).toBeGreaterThanOrEqual(1);
    expect(deleted.refund).toBeGreaterThanOrEqual(1);

    for (const table of [checkin, registration, guardian, release, refund]) {
      expect(await ctx.db.select().from(table)).toEqual([]);
    }
    expect(await ctx.db.select({ id: auditLog.id }).from(auditLog).where(inArray(auditLog.entityType, STAY_TYPES))).toEqual([]);
    // The seeded family is configuration of the demo, kept whole; the walk-up family went with the day.
    const [m] = await ctx.db.select().from(member).where(eq(member.id, mali.id));
    expect(m).toBeTruthy();
    const [ploy] = await ctx.db.select().from(child).where(eq(child.id, mali.ploy.id));
    expect(ploy).toMatchObject({ allergies: mali.ploy.allergies });
    expect(await ctx.db.select().from(member).where(eq(member.phone, '+66655502001'))).toEqual([]);
    // Accounts and the till stay.
    expect(await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone))).toHaveLength(1);

    // The park carries on: the same seeded child is checked in again, and the reset can run again.
    const again = await stayFor(ctx, reception, { memberId: mali.id, childId: mali.ploy.id, name: 'Nong Ploy', meals: 1 });
    const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, again.checkinId));
    expect(row).toMatchObject({ status: 'in_park', childId: mali.ploy.id });
    const second = await send(admin, 'POST', '/ops/demo-reset', { confirm: 'RESET DEMO DATA' });
    expect(second.statusCode, second.body).toBe(200);
    expect((second.json() as { deleted: Record<string, number> }).deleted).toMatchObject({ checkin: 1, registration: 1, release: 0 });
  });
});
