import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, paymentAttempt, paymentMethod, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-206 (S2-10a, Slice E) — the tenders the park takes money in.
 *
 * The prototype's Payments panel edits three rows in browser memory
 * (`apps/pos/src/store/catalogStore.ts:786-790`) and loses them on reload.
 * These routes are where they live now, and what this file pins is the set of
 * rules that make a tender list safe to edit while a till is standing open:
 *
 *   - the list, its order and its ticks persist, operator-wide;
 *   - a kind the ledger has no word for cannot be created, because
 *     `finaliseSale` would refuse the sale AFTER the customer had paid;
 *   - a tender that has taken money cannot be deleted, and the refusal carries
 *     the count so the panel can offer to disable it instead (decision O-7);
 *   - a legacy token still resolves — `credit_card` is the `card` tender's
 *     history and is counted as such.
 */

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let packageId: string;

interface MethodView {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  sortOrder: number;
  attempts: number;
}

const list = async (as: string = cookie): Promise<MethodView[]> => {
  const res = await ctx.app.inject({ method: 'GET', url: '/payment-methods', headers: { cookie: as } });
  expect(res.statusCode).toBe(200);
  return res.json().methods as MethodView[];
};

const create = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: '/payment-methods', headers: { cookie, ...headers }, payload });

const patch = (code: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'PATCH', url: `/payment-methods/${code}`, headers: { cookie }, payload });

const move = (code: string, direction: 'up' | 'down') =>
  ctx.app.inject({
    method: 'POST',
    url: `/payment-methods/${code}/move`,
    headers: { cookie },
    payload: { direction },
  });

const remove = (code: string) =>
  ctx.app.inject({ method: 'DELETE', url: `/payment-methods/${code}`, headers: { cookie } });

const auditRows = async (action: string) =>
  ctx.db.select().from(auditLog).where(eq(auditLog.action, action));

/** A sale settled at the counter, so a tender has money against it. */
async function sellFor(tender: Record<string, unknown>): Promise<string> {
  const till = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const saleId = newId();
  const committed = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: till },
    payload: {
      id: saleId,
      stationId,
      lines: [{ id: newId(), packageId, kids: 1, adults: 0 }],
      finalise: true,
    },
  });
  expect(committed.statusCode).toBe(200);
  const finalised = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: till },
    payload: tender,
  });
  expect(finalised.statusCode).toBe(200);
  return saleId;
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  operatorId = await operatorIdByName(ctx.db, 'OTO');
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;
  const packages = await ctx.db
    .select()
    .from(ticketPackage)
    .where(eq(ticketPackage.branchId, branchId));
  packageId = packages.find((p) => p.name === '2 Hours Play')!.id;
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the configured tender list', () => {
  it('answers the three the park has always taken, in till order', async () => {
    const methods = await list();
    expect(methods.map((m) => m.id)).toEqual(['cash', 'card', 'promptpay']);
    expect(methods.map((m) => m.kind)).toEqual(['cash', 'card', 'qr']);
    expect(methods.every((m) => m.enabled)).toBe(true);
    // Nothing has been sold in this fixture yet, so nothing is in use.
    expect(methods.every((m) => m.attempts === 0)).toBe(true);
  });

  it('is operator-wide: another operator sees its own list and not this one', async () => {
    const other = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    await create({ code: 'shopee_pay', label: 'ShopeePay', kind: 'qr' });
    const mine = await list();
    const theirs = await list(other);
    expect(mine.map((m) => m.id)).toContain('shopee_pay');
    expect(theirs.map((m) => m.id)).not.toContain('shopee_pay');
    await remove('shopee_pay');
  });

  it('the counter may read the list it has to draw, and may not edit it', async () => {
    const till = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const methods = await list(till);
    expect(methods.length).toBeGreaterThan(0);
    const refused = await ctx.app.inject({
      method: 'POST',
      url: '/payment-methods',
      headers: { cookie: till },
      payload: { code: 'reception_idea', label: 'Reception idea', kind: 'cash' },
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe('creating a tender', () => {
  it('adds it at the end of the grid, enabled, and records the audit row', async () => {
    const before = await auditRows('payment_method.create');
    const res = await create({ code: 'bank_transfer', label: 'Bank transfer', kind: 'card' });
    expect(res.statusCode).toBe(200);
    const methods = await list();
    expect(methods.map((m) => m.id)).toEqual(['cash', 'card', 'promptpay', 'bank_transfer']);
    const added = methods.at(-1)!;
    expect(added).toMatchObject({ label: 'Bank transfer', kind: 'card', enabled: true, attempts: 0 });

    const after = await auditRows('payment_method.create');
    expect(after.length).toBe(before.length + 1);
    const row = after.at(-1)!;
    expect(row.entityType).toBe('payment_method');
    expect(row.operatorId).toBe(operatorId);
    expect(row.after).toMatchObject({ code: 'bank_transfer', kind: 'card', enabled: true });
  });

  it('refuses a kind the ledger has no word for, naming the kinds it has', async () => {
    const res = await create({ code: 'loyalty_points', label: 'Loyalty points', kind: 'other' });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.message).toContain('cash, card, qr');
    expect(error.details.allowed).toEqual(['cash', 'card', 'qr']);
    expect((await list()).map((m) => m.id)).not.toContain('loyalty_points');
  });

  it('refuses the legacy card token, which no reader would ever look up', async () => {
    const res = await create({ code: 'credit_card', label: 'Credit Card', kind: 'card' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('credit_card');
  });

  it('refuses a second tender on the same token', async () => {
    const res = await create({ code: 'cash', label: 'Cash again', kind: 'cash' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PAYMENT_METHOD_CODE_EXISTS');
  });

  it('replays on the same idempotency key rather than adding a second row', async () => {
    const key = `pm-${newId()}`;
    const body = { code: 'promptpay_biz', label: 'PromptPay (business)', kind: 'qr' };
    const first = await create(body, { 'idempotency-key': key });
    const second = await create(body, { 'idempotency-key': key });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const rows = await ctx.db
      .select()
      .from(paymentMethod)
      .where(and(eq(paymentMethod.operatorId, operatorId), eq(paymentMethod.code, 'promptpay_biz')));
    expect(rows).toHaveLength(1);
    await remove('promptpay_biz');
  });
});

describe('editing a tender', () => {
  it('renames it without touching the token a sale carries', async () => {
    const res = await patch('bank_transfer', { label: 'Bank transfer (SCB)' });
    expect(res.statusCode).toBe(200);
    const method = (await list()).find((m) => m.id === 'bank_transfer')!;
    expect(method.label).toBe('Bank transfer (SCB)');
    expect(method.id).toBe('bank_transfer');
    const rows = await auditRows('payment_method.update');
    expect(rows.at(-1)!.after).toMatchObject({ label: 'Bank transfer (SCB)' });
  });

  it('refuses a change of kind to one the ledger has no word for', async () => {
    const res = await patch('bank_transfer', { kind: 'other' });
    expect(res.statusCode).toBe(400);
    expect((await list()).find((m) => m.id === 'bank_transfer')!.kind).toBe('card');
  });

  it('unticks a tender, and the list the till reads no longer offers it', async () => {
    const res = await patch('promptpay', { enabled: false });
    expect(res.statusCode).toBe(200);
    const methods = await list();
    // Still configured — every sale that named it still reads back — but the
    // POS builds its method grid from the enabled rows (`lib/payments.ts:17`),
    // so this is the tender leaving the till.
    expect(methods.find((m) => m.id === 'promptpay')!.enabled).toBe(false);
    expect(methods.filter((m) => m.enabled).map((m) => m.id)).not.toContain('promptpay');
    await patch('promptpay', { enabled: true });
  });

  it('is refused for a tender this operator does not have', async () => {
    const res = await patch('nothing_like_it', { label: 'x' });
    expect(res.statusCode).toBe(404);
  });
});

describe('the order of the method grid', () => {
  it('moves a tender one place, swapping two sort orders in one transaction', async () => {
    const before = (await list()).map((m) => m.id);
    expect(before.slice(0, 3)).toEqual(['cash', 'card', 'promptpay']);
    const res = await move('promptpay', 'up');
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toBe(true);
    expect((await list()).map((m) => m.id).slice(0, 3)).toEqual(['cash', 'promptpay', 'card']);
    const rows = await auditRows('payment_method.reorder');
    expect(rows.at(-1)!.before).toMatchObject({ code: 'promptpay', direction: 'up' });
    // Put it back, which is the same swap the other way.
    await move('promptpay', 'down');
    expect((await list()).map((m) => m.id)).toEqual(before);
  });

  it('says so rather than failing when there is nowhere to move', async () => {
    const res = await move('cash', 'up');
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toBe(false);
    expect((await list()).map((m) => m.id)[0]).toBe('cash');
  });
});

describe('removing a tender', () => {
  it('archives one nothing was paid in, and frees its token for a later tender', async () => {
    const res = await remove('bank_transfer');
    expect(res.statusCode).toBe(200);
    expect((await list()).map((m) => m.id)).not.toContain('bank_transfer');

    const [row] = await ctx.db
      .select()
      .from(paymentMethod)
      .where(and(eq(paymentMethod.operatorId, operatorId), eq(paymentMethod.code, 'bank_transfer')));
    // Archived, not deleted, and unticked with it: a reader that forgets the
    // archive filter still sees a tender nobody can pick.
    expect(row!.archivedAt).not.toBeNull();
    expect(row!.enabled).toBe(false);
    expect((await auditRows('payment_method.archive')).at(-1)!.before).toMatchObject({
      code: 'bank_transfer',
    });

    // The unique index is partial on `archived_at is null`, so the token is free.
    const again = await create({ code: 'bank_transfer', label: 'Bank transfer', kind: 'card' });
    expect(again.statusCode).toBe(200);
    await remove('bank_transfer');
  });

  it('refuses one that has taken money, with the count, and leaves it alone', async () => {
    await sellFor({ method: 'cash', kind: 'cash' });
    const res = await remove('cash');
    expect(res.statusCode).toBe(409);
    const { error } = res.json();
    expect(error.code).toBe('PAYMENT_METHOD_IN_USE');
    expect(error.details.attempts).toBeGreaterThan(0);
    expect(error.message).toContain(`${error.details.attempts} payment`);
    // The copy the panel turns into its offer to disable instead.
    expect(error.message).toContain('Disable it instead');

    const cash = (await list()).find((m) => m.id === 'cash')!;
    expect(cash.enabled).toBe(true);
    expect(cash.attempts).toBe(error.details.attempts);
  });

  it('counts the legacy token as the card tender’s own history', async () => {
    // `finaliseSale` normalises `credit_card` to `card` before it resolves the
    // kind, and stores the token as it arrived — so these rows ARE the card
    // tender's money, and a park must not be told its card tender is unused.
    const saleId = await sellFor({ method: 'credit_card', kind: 'card' });
    const [attempt] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempt!.method).toBe('card');
    expect(attempt!.methodCode).toBe('credit_card');

    expect((await list()).find((m) => m.id === 'card')!.attempts).toBeGreaterThan(0);
    const res = await remove('card');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PAYMENT_METHOD_IN_USE');
  });
});

/**
 * WHAT THE LEDGER ITSELF WILL AND WILL NOT REFUSE.
 *
 * Three tests, because between them they say exactly how much of "the till may
 * only take money in a tender the park offers" is enforced below the screen —
 * and the honest answer today is: only for a caller that declares no kind.
 *
 * `finaliseSale` resolves a tender through `pos.payment_method` and falls back
 * to the kind the till declared when no live row answers (`tenderMethodOf`,
 * `services/sale.ts`). That fallback is deliberate and right: a tender archived
 * between the press and the write must not cost the park a sale at the counter.
 * Its consequence is that the METHOD GRID is the whole of the enforcement for
 * both `enabled` and `archived_at`, because the till always declares a kind
 * (`SaleTenderPayload.kind` is required, `apps/pos/src/api/sales.ts`).
 *
 * That is a real gap against the prototype's rule — "never record an order
 * against a hidden tender"
 * (`imports/oto-pos/artifacts/oto-till/src/components/fnb/FnbPayment.tsx:82`) —
 * and it is not this slice's to close: the predicate belongs in
 * `tenderMethodOf`, in the file Slice B owns, so that the EDC, the QR and the
 * offline writers inherit the same refusal. Pinned here so that the day it is
 * closed, these two tests fail and their opposites go in their place rather
 * than the change landing silently.
 */
describe('what the ledger does with a tender that has left the list', () => {
  it('refuses a tender it has never heard of, when nothing declares its kind', async () => {
    const till = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const saleId = newId();
    await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: till },
      payload: {
        id: saleId,
        stationId,
        lines: [{ id: newId(), packageId, kids: 1, adults: 0 }],
        finalise: true,
      },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: till },
      payload: { method: 'gift_certificate' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('takes no tender called');
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(0);
  });

  it('still records one against an ARCHIVED tender when the till declares a kind', async () => {
    await create({ code: 'gift_certificate', label: 'Gift certificate', kind: 'cash' });
    expect((await remove('gift_certificate')).statusCode).toBe(200);
    const saleId = await sellFor({ method: 'gift_certificate', kind: 'cash' });
    const [attempt] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempt!.method).toBe('cash');
    expect(attempt!.methodCode).toBe('gift_certificate');
    // And the archived tender's history stays countable, which is why a
    // re-created `gift_certificate` would be refused a delete from here on.
    expect((await list()).map((m) => m.id)).not.toContain('gift_certificate');
  });

  it('still records one against a DISABLED tender — Slice B’s to refuse', async () => {
    await patch('promptpay', { enabled: false });
    const saleId = await sellFor({ method: 'promptpay', kind: 'qr' });
    const [attempt] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempt!.method).toBe('qr');
    expect(attempt!.methodCode).toBe('promptpay');
    await patch('promptpay', { enabled: true });
  });
});
