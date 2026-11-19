import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, band, branch, checkin, product, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-1054 — THE PARENT'S TICK: "MAY ORDER FOOD WITH THE INCLUDED CREDIT"
 * (the owner's answer of 19 November 2026, R3,
 * docs/progress/plans/dropoff-beo-20261119/ANSWERS.md §8).
 *
 * A dropped-off or nanny child on a ticket that includes food credit (Eat &
 * Play) whose parent chose no extra food was registered "no food", so the
 * food counter asked a manager although the ticket's credit was on the band.
 * The form now asks the parent one tick. Pinned through the real routes:
 *
 * - Ticked: the stay's own food permission (`may_order_food`) is given with
 *   no extra food paid for, audited with the stay, shown on the board; the
 *   counter takes the child's order with no override, paid from the band.
 * - Not ticked: as before, "no food", and the counter refuses without the
 *   manager's override.
 * - Extra food paid for: as before, the child may order.
 *
 * Demo data only: every name and number below is a ZZ TEST fixture.
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
let cookie: string;
let branchId: string;
let stationId: string;
let eatPlayId: string;
let waterId: string;

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  eatPlayId = pkgs.find((p) => p.name === 'Eat & Play Kids Pass')!.id;
  const [water] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, hkt!.operatorId), eq(product.code, 'FB-WATER'), isNull(product.archivedAt)));
  waterId = water!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

type Food = { mode: 'none' | 'prepaid_credit'; paidSatang: number; creditSatang?: number };

function registration(checkinId: string, id: string, child: { food?: Food; tick?: boolean }) {
  return {
    id,
    branchId,
    stationId,
    guardianName: 'ZZ TEST Parent',
    guardianPhone: '0812345678',
    contactChannel: 'whatsapp',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
    children: [
      {
        checkinId,
        name: 'ZZ TEST Mint',
        ageYears: 6,
        service: 'drop_off',
        allergies: null,
        foodRestrictions: null,
        foodProvision: child.food ?? { mode: 'none', paidSatang: 0 },
        ...(child.tick !== undefined ? { orderWithIncludedCredit: child.tick } : {}),
      },
    ],
  };
}

async function register(child: { food?: Food; tick?: boolean }): Promise<{ checkinId: string; registrationId: string }> {
  const checkinId = newId();
  const registrationId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie, 'idempotency-key': newId() },
    payload: registration(checkinId, registrationId, child),
  });
  expect(res.statusCode, res.body).toBe(200);
  return { checkinId, registrationId };
}

/** Registered, paid on Eat & Play, checked in now: the child's band carries the ticket's credit. */
async function inPark(child: { food?: Food; tick?: boolean }): Promise<{ checkinId: string; bandCode: string }> {
  const { checkinId } = await register(child);
  const saleId = newId();
  const food = child.food && child.food.mode !== 'none' ? { foodProvision: { mode: child.food.mode, paidSatang: child.food.paidSatang } } : {};
  const rung = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: {
      id: saleId,
      stationId,
      lines: [{ id: checkinId, packageId: eatPlayId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 }, ...food }],
    },
  });
  expect(rung.statusCode, rung.body).toBe(200);
  const paid = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie }, payload: {} });
  expect(paid.statusCode, paid.body).toBe(200);
  const now = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-now',
    headers: { cookie },
    payload: { saleId, entries: [{ checkinId, nannyId: null }] },
  });
  expect(now.statusCode, now.body).toBe(200);
  const [row] = await ctx.db.select({ code: band.code }).from(checkin).innerJoin(band, eq(band.id, checkin.bandId)).where(eq(checkin.id, checkinId));
  return { checkinId, bandCode: row!.code };
}

function order(checkinId: string, extra: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie, 'idempotency-key': newId() },
    payload: {
      id: newId(),
      stationId,
      channel: 'fnb',
      pickupCode: '54',
      bandHolder: { checkinId, ...extra },
      items: [{ id: newId(), productId: waterId, quantity: 1 }],
    },
  });
}

const stayOf = async (checkinId: string) => (await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId)))[0]!;

describe('SCRUM-1054 — ticked: the child may order with the included credit', () => {
  it('the stay is given the food permission with no extra food paid for, audited with it', async () => {
    const { checkinId } = await register({ tick: true });
    const stay = await stayOf(checkinId);
    expect(stay.mayOrderFood).toBe(true);
    expect(stay.foodProvision).toMatchObject({ mode: 'none', paidSatang: 0 });
    const logged = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'checkin'), eq(auditLog.entityId, checkinId), eq(auditLog.action, 'checkin.create')));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.after).toMatchObject({ mayOrderFood: true, orderWithIncludedCredit: true, foodProvision: { mode: 'none' } });
  });

  it('the board shows it where it shows the food choice', async () => {
    const { checkinId } = await register({ tick: true });
    const res = await ctx.app.inject({ method: 'GET', url: `/checkin/board?branchId=${branchId}`, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const children = (res.json().families as { children: { id: string; mayOrderFood: boolean }[] }[]).flatMap((f) => f.children);
    expect(children.find((c) => c.id === checkinId)?.mayOrderFood).toBe(true);
  });

  it('the counter takes the order with no manager, paid from the band', async () => {
    const child = await inPark({ tick: true });
    const rung = await order(child.checkinId);
    expect(rung.statusCode, rung.body).toBe(200);
    const saleId = rung.json().sale.id as string;
    const paid = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie },
      payload: { wallet: { key: child.bandCode, useCredit: true }, actionId: newId() },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().finalised).toBe(true);
  });

  it('pressed again under its own id, one stay and one audit row', async () => {
    const checkinId = newId();
    const id = newId();
    for (let i = 0; i < 2; i += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/checkin/registrations',
        headers: { cookie, 'idempotency-key': newId() },
        payload: registration(checkinId, id, { tick: true }),
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId))).toHaveLength(1);
    const logged = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, checkinId), eq(auditLog.action, 'checkin.create')));
    expect(logged).toHaveLength(1);
  });
});

describe('SCRUM-1054 — not ticked, or extra food paid for: as before', () => {
  it('not ticked: "no food", and the counter refuses without the manager’s override', async () => {
    for (const tick of [undefined, false]) {
      const child = await inPark(tick === undefined ? {} : { tick });
      expect((await stayOf(child.checkinId)).mayOrderFood).toBe(false);
      const refused = await order(child.checkinId);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatchObject({ code: 'FOOD_NOT_AUTHORIZED' });
      const overridden = await order(child.checkinId, { foodOverride: true });
      expect(overridden.statusCode, overridden.body).toBe(200);
    }
  });

  it('extra food paid for: the child may order, ticked or not', async () => {
    const food: Food = { mode: 'prepaid_credit', paidSatang: 50_000, creditSatang: 50_000 };
    for (const tick of [undefined, true]) {
      const { checkinId } = await register(tick === undefined ? { food } : { food, tick });
      expect((await stayOf(checkinId)).mayOrderFood).toBe(true);
    }
  });

  it('the tick is a yes or no, nothing else', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/registrations',
      headers: { cookie, 'idempotency-key': newId() },
      payload: { ...registration(newId(), newId(), {}), children: [{ ...registration(newId(), newId(), {}).children[0], orderWithIncludedCredit: 'yes' }] },
    });
    expect(res.statusCode).toBe(400);
  });
});
