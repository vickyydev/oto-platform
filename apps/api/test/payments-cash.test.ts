import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  box,
  boxCommand,
  branch,
  idempotencyKey,
  member,
  paymentAttempt,
  sale,
  station,
  ticketPackage,
} from '@oto/db';
import { businessDate, newId, parseDayStart } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-10a (SCRUM-206, Slice B) — CASH AS A LEDGER ENTRY, not as a flag on a sale.
 *
 * `sales.test.ts` owns the shape of the tender the till sends. This file owns
 * what the ledger does with it: what each attempt is stamped with so the end of
 * day (S2-15a) can group a day's takings with no join and no backfill, what
 * opens the drawer and what leaves it shut, and what happens when the same
 * press arrives twice.
 *
 * Everything goes in through the route a till calls, with a real reception
 * session, and is then read out of Postgres — the same rule the sales suite
 * states: a test that asserts against the service it just called proves the
 * two halves of a seam separately and never that they meet.
 */

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let branchId: string;
let timezone: string;
let dayStart: string;
let stationId: string;
let boxId: string;
let twoHoursId: string;
let jamesId: string;

const today = (): string => businessDate(new Date(), timezone, parseDayStart(dayStart));

const cart = (saleId: string): Record<string, unknown> => ({
  id: saleId,
  stationId,
  memberId: jamesId,
  lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
  finalise: true,
});

async function commit(saleId: string) {
  return ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie }, payload: cart(saleId) });
}

async function finalise(
  saleId: string,
  payload?: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie, ...headers },
    ...(payload ? { payload } : {}),
  });
}

/** Every drawer kick queued for the box, newest last. */
async function drawerCommands() {
  return ctx.db
    .select()
    .from(boxCommand)
    .where(and(eq(boxCommand.boxId, boxId), eq(boxCommand.kind, 'drawer_kick')));
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central') ?? branches[0]!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  timezone = hkt.timezone;
  dayStart = hkt.businessDayStart;

  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  const till = stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!;
  stationId = till.id;
  boxId = till.boxId!;

  /**
   * The seed leaves every box `unclaimed`, because a box is claimed by its
   * agent starting up and Health should say so until it has. A command cannot
   * be queued for a box that has never registered, so this test registers one —
   * which is what the park's box does the first time it is switched on.
   */
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, boxId));

  const packages = await ctx.db
    .select()
    .from(ticketPackage)
    .where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;

  const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
  jamesId = members.find((m) => m.phone === '+66822222222')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('a cash tender is stamped with everything the day’s takings are grouped by', () => {
  it('carries the operator, the branch, the counter, the trading day and the time it was paid', async () => {
    const saleId = newId();
    const owed = (await commit(saleId)).json().outstandingSatang as number;
    const before = new Date();
    const res = await finalise(saleId, { method: 'cash', kind: 'cash', tenderedSatang: owed + 5000 });
    expect(res.statusCode).toBe(200);

    const [attempt] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempt!.operatorId).toBe(operatorId);
    expect(attempt!.branchId).toBe(branchId);
    expect(attempt!.stationId).toBe(stationId);
    // THE SALE'S trading day, not the calendar's: a cash-up after midnight
    // counts the late party's money on the day that is finishing.
    expect(attempt!.businessDate).toBe(today());
    expect(attempt!.paidAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    // The ledger's word for the money, and the park's own token beside it.
    expect(attempt!.method).toBe('cash');
    expect(attempt!.methodCode).toBe('cash');
    expect(attempt!.tenderedSatang).toBe(owed + 5000);
    expect(attempt!.changeSatang).toBe(5000);
    expect(attempt!.actionId).toBeNull();
  });

  it('records the action id on the attempt, so a press can be found by it', async () => {
    const saleId = newId();
    await commit(saleId);
    const actionId = newId();
    expect((await finalise(saleId, { method: 'cash', actionId })).statusCode).toBe(200);

    const [attempt] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempt!.actionId).toBe(actionId);
  });

  /**
   * The audit row still says what closed the sale, in the TOKEN staff chose
   * rather than the word the ledger files it under. Slice A moved `method`
   * onto a CHECKed vocabulary and deliberately left this alone; this is the
   * pin that keeps it that way.
   */
  it('leaves the audit row’s tender exactly as it was', async () => {
    const saleId = newId();
    const owed = (await commit(saleId)).json().outstandingSatang as number;
    await finalise(saleId, { method: 'cash', tenderedSatang: owed });

    const [entry] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.finalise')));
    expect((entry!.after as { tender: unknown }).tender).toMatchObject({
      method: 'cash',
      amountSatang: owed,
      changeSatang: 0,
    });
  });

  /** A part payment is a mutation of its own, and it says so in the log. */
  it('writes a sale.tender audit row for a part payment, and no receipt number', async () => {
    const saleId = newId();
    const owed = (await commit(saleId)).json().outstandingSatang as number;
    const res = await finalise(saleId, { method: 'cash', amountSatang: 10_000 });
    expect(res.statusCode).toBe(200);

    const [entry] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.tender')));
    expect((entry!.after as { outstandingSatang: number }).outstandingSatang).toBe(owed - 10_000);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.receiptNumber).toBeNull();
  });
});

describe('the cash drawer (O-4)', () => {
  it('is asked to open on a cash tender, naming the sale, the attempt and the printer the pulse rides', async () => {
    const before = (await drawerCommands()).length;
    const saleId = newId();
    await commit(saleId);
    expect((await finalise(saleId, { method: 'cash', kind: 'cash' })).statusCode).toBe(200);

    const commands = await drawerCommands();
    expect(commands).toHaveLength(before + 1);
    const queued = commands[commands.length - 1]!;
    const payload = queued.payload as {
      saleId: string;
      attemptId: string;
      stationId: string;
      deviceId?: string;
      role: string;
      finish: { drawerKick: boolean };
    };
    expect(payload.saleId).toBe(saleId);
    expect(payload.stationId).toBe(stationId);
    // The drawer hangs off the receipt printer's RJ11; the role is what the
    // box routes the pulse by.
    expect(payload.role).toBe('receipt');
    expect(payload.deviceId).toBeTruthy();
    expect(payload.finish.drawerKick).toBe(true);

    const [attempt] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(payload.attemptId).toBe(attempt!.id);
  });

  it('is not asked on a card tender', async () => {
    const before = (await drawerCommands()).length;
    const saleId = newId();
    await commit(saleId);
    expect((await finalise(saleId, { method: 'card', kind: 'card' })).statusCode).toBe(200);
    expect(await drawerCommands()).toHaveLength(before);
  });

  it('is not asked again when the same press is retried', async () => {
    const saleId = newId();
    await commit(saleId);
    const actionId = newId();
    await finalise(saleId, { method: 'cash', actionId });
    const after = (await drawerCommands()).length;
    // The retry of a closed sale answers from the row and opens nothing.
    const again = await finalise(saleId, { method: 'cash', actionId });
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(await drawerCommands()).toHaveLength(after);
  });
});

/**
 * THE DROPPED CONNECTION, which is the whole reason the till sends a key.
 *
 * `apps/pos/src/api/sales.ts` puts an `Idempotency-Key` on every finalise
 * (`saleFinaliseIdempotencyKey`), so the answer stored under that key is what
 * the till is handed when the first attempt dies in the mall's wifi — it reads
 * the sale and the receipt number straight out of it.
 *
 * The trap these cases exist for: a cash press queues the drawer command AFTER
 * the sale commits, and `queueCommand` opens a transaction of its own. Run that
 * second transaction under the request's claim and `withTx` writes ITS return
 * value over the finalise's (`services/tx.ts`), so the retry is answered 200
 * with a `{commandId, actionId}` in it — no sale, nothing to print, on the
 * money path, on cash, which is most sales. `queueDrawerKick` drops the claim
 * for exactly this reason (`services/payments/drawer.ts`).
 */
describe('the retry down a dropped connection', () => {
  it('answers a cash press with the sale again, not with the drawer command', async () => {
    const before = (await drawerCommands()).length;
    const saleId = newId();
    const owed = (await commit(saleId)).json().outstandingSatang as number;
    const key = `finalise-cash-${saleId}`;
    const press = { method: 'cash', kind: 'cash', amountSatang: owed };

    const first = await finalise(saleId, press, { 'idempotency-key': key });
    expect(first.statusCode).toBe(200);
    expect(first.json().finalised).toBe(true);
    expect(first.json().sale.receiptNumber).toMatch(/^T\d-\d{6}$/);
    // The press opened the drawer once.
    expect(await drawerCommands()).toHaveLength(before + 1);

    // The same request, the same key: the till never learned it had succeeded.
    const second = await finalise(saleId, press, { 'idempotency-key': key });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-oto-replay']).toBe('true');
    // Every field the first answer carried, carried again and unchanged.
    expect(second.json()).toEqual(first.json());
    expect(first.json()).not.toHaveProperty('drawerKick');
    expect(second.json().sale.receiptNumber).toBe(first.json().sale.receiptNumber);
    expect(second.json().attempt.id).toBe(first.json().attempt.id);
    // And not the box command that ran after the sale committed.
    expect(second.json().commandId).toBeUndefined();

    // The replay is served from the store without reaching the handler, so
    // nothing queued a second pulse either.
    expect(await drawerCommands()).toHaveLength(before + 1);

    const [stored] = await ctx.db
      .select()
      .from(idempotencyKey)
      .where(eq(idempotencyKey.key, key));
    const body = stored!.responseBody as {
      sale?: { id?: string; receiptNumber?: string | null };
      commandId?: string;
    };
    expect(stored!.statusCode).toBe(200);
    expect(body.sale?.id).toBe(saleId);
    expect(body.sale?.receiptNumber).toBe(first.json().sale.receiptNumber);
    expect(body.commandId).toBeUndefined();
    expect(stored!.responseBody).toEqual(first.json());
    expect(stored!.responseBody).not.toHaveProperty('drawerKick');
  });

  it('answers a card press the same way, with no drawer in the picture at all', async () => {
    const before = (await drawerCommands()).length;
    const saleId = newId();
    const owed = (await commit(saleId)).json().outstandingSatang as number;
    const key = `finalise-card-${saleId}`;
    const press = { method: 'card', kind: 'card', amountSatang: owed };

    const first = await finalise(saleId, press, { 'idempotency-key': key });
    expect(first.statusCode).toBe(200);
    expect(first.json().sale.receiptNumber).toMatch(/^T\d-\d{6}$/);

    const second = await finalise(saleId, press, { 'idempotency-key': key });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-oto-replay']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(second.json().sale.receiptNumber).toBe(first.json().sale.receiptNumber);

    const [stored] = await ctx.db
      .select()
      .from(idempotencyKey)
      .where(eq(idempotencyKey.key, key));
    expect((stored!.responseBody as { sale?: { id?: string } }).sale?.id).toBe(saleId);
    expect(stored!.responseBody).toEqual(first.json());
    expect(stored!.responseBody).not.toHaveProperty('drawerKick');
    // Card takes no cash, so there was never a pulse to overwrite the answer.
    expect(await drawerCommands()).toHaveLength(before);
  });
});

describe('two tills, one press', () => {
  /**
   * THE PLANT'S CASE, run as a test: the same finalise twice, with the same
   * action id, on two connections at once. The sale row is locked FOR UPDATE,
   * so the second transaction waits for the first and then finds the sale
   * closed; what it must never do is take a second tender or a second receipt
   * number.
   */
  it('takes one tender and one receipt number when the same press arrives twice at once', async () => {
    const saleId = newId();
    const owed = (await commit(saleId)).json().outstandingSatang as number;
    const actionId = newId();
    const press = { method: 'cash', kind: 'cash', amountSatang: owed, actionId };

    const [first, second] = await Promise.all([finalise(saleId, press), finalise(saleId, press)]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().sale.receiptNumber).toBe(second.json().sale.receiptNumber);
    expect(first.json().sale.receiptNumber).toMatch(/^T\d-\d{6}$/);

    const attempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.amountSatang).toBe(owed);
  });

  /**
   * And the same press on a sale that stays OPEN, which is the case
   * `status = 'finalised'` cannot catch and the attempt's `action_id` unique
   * has to: two part payments of the same press are one part payment.
   */
  it('takes one tender when the same part payment arrives twice at once', async () => {
    const saleId = newId();
    const owed = (await commit(saleId)).json().outstandingSatang as number;
    const actionId = newId();
    const press = { method: 'cash', kind: 'cash', amountSatang: Math.floor(owed / 4), actionId };

    const answers = await Promise.all([finalise(saleId, press), finalise(saleId, press)]);
    expect(answers.map((a) => a.statusCode)).toEqual([200, 200]);
    const attempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.saleId, saleId));
    expect(attempts).toHaveLength(1);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).toBe('tendering');
    expect(row!.receiptNumber).toBeNull();
  });
});

describe('money reserved by an unresolved payment', () => {
  const startCard = (saleId: string, amountSatang?: number) =>
    ctx.app.inject({
      method: 'POST',
      url: '/payments/attempts',
      headers: { cookie },
      payload: { saleId, tender: 'card', actionId: newId(), amountSatang },
    });

  it.each([
    { name: 'an unvoidable positive partial approval', payload: { void: { reason: 'partial_approval', amountSatang: 100, unvoidable: 'no transaction reference' } } },
    { name: 'an unknown approved amount saved as zero', payload: { exchange: { approvedSatang: null }, void: { reason: 'partial_approval', amountSatang: 0 } } },
    { name: 'a partial approval with no saved amount', payload: { void: { reason: 'partial_approval' } } },
  ])('retains the original reservation for $name', async ({ payload }) => {
    const saleId = newId();
    await commit(saleId);
    const first = await startCard(saleId);
    expect(first.statusCode).toBe(200);
    const attemptId = first.json().attempt.id as string;
    await ctx.db.update(paymentAttempt).set({ status: 'declined', payload })
      .where(eq(paymentAttempt.id, attemptId));
    const cash = await finalise(saleId, { method: 'cash', kind: 'cash', actionId: newId() });
    expect(cash.statusCode).toBe(409);
    expect(cash.json().error.code).toBe('PAYMENT_IN_FLIGHT');
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(1);
  });

  it('does not reserve a confirmed zero approval', async () => {
    const saleId = newId();
    await commit(saleId);
    const first = await startCard(saleId);
    expect(first.statusCode).toBe(200);
    await ctx.db.update(paymentAttempt).set({ status: 'declined', payload: {
      exchange: { approvedSatang: 0 }, void: { reason: 'partial_approval', amountSatang: 0 },
    } }).where(eq(paymentAttempt.id, first.json().attempt.id));
    const cash = await finalise(saleId, { method: 'cash', kind: 'cash', actionId: newId() });
    expect(cash.statusCode).toBe(200);
    expect(cash.json().finalised).toBe(true);
  });

  it('does not close a fully covered sale while an older partial charge awaits reversal', async () => {
    const saleId = newId();
    await commit(saleId);
    const first = await startCard(saleId);
    expect(first.statusCode).toBe(200);
    const [original] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, first.json().attempt.id));
    await ctx.db.update(paymentAttempt).set({ status: 'declined', payload: {
      void: { reason: 'partial_approval', amountSatang: 100 },
    } }).where(eq(paymentAttempt.id, original!.id));
    // Model the persisted state left by the earlier gap: a second full tender
    // was recorded before the first partial charge had been returned.
    await ctx.db.insert(paymentAttempt).values({
      ...original!, id: newId(), actionId: newId(), deviceId: null,
      method: 'cash', methodCode: 'cash', provider: 'manual', status: 'approved',
      paidAt: new Date(), payload: null,
    });
    const close = await finalise(saleId, { method: 'other', kind: 'other', amountSatang: 0 });
    expect(close.statusCode).toBe(409);
    expect(close.json().error.code).toBe('PAYMENT_IN_FLIGHT');
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).toBe('tendering');
    expect(row!.receiptNumber).toBeNull();
  });

  it('opens only one full-balance terminal tender from two distinct simultaneous presses', async () => {
    const saleId = newId();
    await commit(saleId);
    const answers = await Promise.all([startCard(saleId), startCard(saleId)]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
    expect(answers.find((answer) => answer.statusCode === 409)!.json().error.code)
      .toBe('PAYMENT_IN_FLIGHT');
    const attempts = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    expect(attempts).toHaveLength(1);
    const commands = await ctx.db.select().from(boxCommand).where(eq(boxCommand.kind, 'terminal_sale'));
    expect(commands.filter((command) => (command.payload as { attemptId?: string }).attemptId === attempts[0]!.id))
      .toHaveLength(1);
  });

  it.each(['created', 'sent_to_terminal', 'unknown', 'inquiring', 'awaiting_staff_confirmation'] as const)(
    'does not record cash or manual money against the balance reserved by %s',
    async (status) => {
      const saleId = newId();
      await commit(saleId);
      const opened = await startCard(saleId);
      expect(opened.statusCode).toBe(200);
      await ctx.db.update(paymentAttempt).set({ status }).where(eq(paymentAttempt.id, opened.json().attempt.id));
      const kicksBefore = (await drawerCommands()).length;
      const cash = await finalise(saleId, { method: 'cash', kind: 'cash', actionId: newId() });
      expect(cash.statusCode).toBe(409);
      expect(cash.json().error.code).toBe('PAYMENT_IN_FLIGHT');
      const manual = await ctx.app.inject({
        method: 'POST', url: '/payments/manual', headers: { cookie },
        payload: { saleId, approvalCode: 'TESTONLY', tid: 'TEST', actionId: newId() },
      });
      expect(manual.statusCode).toBe(409);
      expect(manual.json().error.code).toBe('PAYMENT_IN_FLIGHT');
      expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(1);
      expect((await drawerCommands()).length).toBe(kicksBefore);
      const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
      expect(row!.status).toBe('tendering');
      expect(row!.receiptNumber).toBeNull();
    },
  );

  it('allows only the unreserved half and keeps the sale open until the other payment resolves', async () => {
    const saleId = newId();
    const owed = (await commit(saleId)).json().outstandingSatang as number;
    const reserved = Math.floor(owed / 2);
    const first = await startCard(saleId, reserved);
    expect(first.statusCode).toBe(200);
    const extra = await finalise(saleId, { method: 'cash', kind: 'cash', amountSatang: owed - reserved + 1 });
    expect(extra.statusCode).toBe(409);
    const remaining = await finalise(saleId, {
      method: 'cash', kind: 'cash', amountSatang: owed - reserved, actionId: newId(),
    });
    expect(remaining.statusCode).toBe(200);
    expect(remaining.json().finalised).toBe(false);
    expect(remaining.json().outstandingSatang).toBe(reserved);
    await ctx.db.update(paymentAttempt).set({ status: 'declined' }).where(eq(paymentAttempt.id, first.json().attempt.id));
    const completed = await finalise(saleId, { method: 'cash', kind: 'cash', actionId: newId() });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().finalised).toBe(true);
    expect(completed.json().outstandingSatang).toBe(0);
  });

  it.each(['declined', 'cancelled', 'not_found'] as const)('releases a %s reservation', async (status) => {
    const saleId = newId();
    await commit(saleId);
    const first = await startCard(saleId);
    expect(first.statusCode).toBe(200);
    await ctx.db.update(paymentAttempt).set({ status }).where(eq(paymentAttempt.id, first.json().attempt.id));
    const cash = await finalise(saleId, { method: 'cash', kind: 'cash', actionId: newId() });
    expect(cash.statusCode).toBe(200);
    expect(cash.json().finalised).toBe(true);
  });
});
