import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  auditLog,
  box,
  boxCommand,
  branch,
  device,
  member,
  opsRun,
  paymentAttempt,
  sale,
  station,
  ticketPackage,
} from '@oto/db';
import {
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import { newId } from '@oto/shared';
import {
  ADMIN,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { attachInProcessBox, provisionVirtualBox } from '../src/services/box';

/**
 * S2-10a (SCRUM-206, Slice C2) — THE CARD TENDER, END TO END.
 *
 * Nothing here calls the terminal service directly. A tender is a POST to the
 * route the till posts to; the instruction is taken off `edge.box_command` by
 * the agent from `@oto/box-agent` — the same file a Raspberry Pi runs, pointed
 * at this api through `app.inject` — the terminal at the far end is C1's
 * simulator parsing the adapter's own bytes, and the outcome comes back on
 * `POST /payments/attempts/:id/result` under the box's credential. So a green
 * case here is a statement about the whole path: till, cloud, command queue,
 * box, dialect, wire, and the answer coming back up into the ledger.
 *
 * ONE DELIBERATE SHORTCUT, named where it is taken. A GHL terminal that gives
 * no answer gives no answer: its simulator withholds the frame, and the
 * adapter then waits out the full 120-second customer-interaction budget
 * (`DEVICE_INVENTORY.md:948`), which is not a thing to put in a test suite and
 * cannot be shortened from here — `createTerminals` takes a `timeouts` option
 * and `agent.ts` does not expose one. So the NEXGO no-answer case posts the
 * box's own result body on the real route under the box's own credential,
 * which is byte for byte what the agent posts 120 seconds later. Every other
 * case, including the two plants, goes the whole way round.
 */

let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let agent: BoxAgent;
let operatorId: string;
let branchId: string;
let stationId: string;
let boxId: string;
let cardDeviceId: string;
let qrDeviceId: string;
let twoHoursId: string;
let jamesId: string;
let boxCredential = '';

function injectTransport(): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const auth = init.headers?.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      boxCredential = auth.slice('Bearer '.length);
    }
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    return {
      status: res.statusCode,
      json: async () => (res.body ? JSON.parse(res.body) : null),
      text: async () => res.body,
      header: (name) => {
        const value = res.headers[name.toLowerCase()];
        return typeof value === 'string' ? value : null;
      },
    };
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central') ?? branches[0]!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;

  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  const till = stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!;
  stationId = till.id;
  boxId = till.boxId!;

  const devices = await ctx.db.select().from(device).where(eq(device.branchId, branchId));
  cardDeviceId = devices.find((d) => d.label === 'EDC 1')!.id;
  qrDeviceId = devices.find((d) => d.label === 'EDC 3')!.id;

  const packages = await ctx.db
    .select()
    .from(ticketPackage)
    .where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;

  const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
  jamesId = members.find((m) => m.phone === '+66822222222')!.id;

  /**
   * The box, registered by its own agent — which is what a Raspberry Pi does
   * the first time it is switched on, and what sets `registered_at`. A tender
   * for a box that has never come online is refused by name.
   */
  agent = createBoxAgent({
    apiBaseUrl: 'http://terminal.test',
    credentials: memoryCredentialStore(),
    hostname: 'virtual-terminal-test',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
    // The reference counter lives in the store, so a box without one refuses
    // card tenders by name (`terminal/counter.ts`).
    store: boxStoreFor(ctx.db),
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  expect(agent.state.boxId).toBe(boxId);
  // Say that this agent runs in this process, which is what lets the Console's
  // terminal simulator route reach its simulators.
  attachInProcessBox(agent);
}, 180_000);

afterAll(async () => {
  agent.stop();
  await ctx.close();
  await teardownAll();
});

// --- Helpers -----------------------------------------------------------------

async function commitSale(): Promise<{ saleId: string; owed: number }> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: {
      id: saleId,
      stationId,
      memberId: jamesId,
      lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
      finalise: true,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { saleId, owed: res.json().outstandingSatang as number };
}

async function setOutcome(
  deviceId: string,
  body: Record<string, unknown>,
  who = adminCookie,
): Promise<ReturnType<typeof ctx.app.inject>> {
  return ctx.app.inject({
    method: 'POST',
    url: '/payments/terminal-simulator',
    headers: { cookie: who },
    payload: { action: 'terminal.outcome', deviceId, ...body },
  });
}

async function startTender(
  saleId: string,
  extra: Record<string, unknown> = {},
): Promise<ReturnType<typeof ctx.app.inject>> {
  return ctx.app.inject({
    method: 'POST',
    url: '/payments/attempts',
    headers: { cookie },
    payload: { saleId, ...extra },
  });
}

async function attemptRow(id: string) {
  const [row] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, id));
  return row!;
}

async function readAttempt(id: string) {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/payments/attempts/${id}`,
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    attempt: { status: string; approvalCode: string | null; last4: string | null; tid: string | null };
    qrPayload: string | null;
    deviceLabel: string | null;
    responseText: string | null;
    outstandingSatang: number | null;
  };
}

/** What the box would post, posted the way the box posts it. */
async function postResult(attemptId: string, body: Record<string, unknown>, actionId?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/payments/attempts/${attemptId}/result`,
    headers: {
      authorization: `Bearer ${boxCredential}`,
      ...(actionId ? { 'x-oto-action-id': actionId } : {}),
    },
    payload: body,
  });
}

/** The commands this box has been given, newest last. */
async function terminalCommands(attemptId: string) {
  const rows = await ctx.db
    .select()
    .from(boxCommand)
    .where(and(eq(boxCommand.boxId, boxId), eq(boxCommand.kind, 'terminal_sale')));
  return rows.filter((row) => (row.payload as { attemptId?: string } | null)?.attemptId === attemptId);
}

/** One simulated terminal's tape, as the Console panel reads it. */
function tape(deviceId: string) {
  return agent.terminal()?.events(deviceId, 200) ?? [];
}

// --- Approved ----------------------------------------------------------------

describe('a card approved on the terminal', () => {
  it('settles the attempt with the approval code, the TID, the last four and the 12-character reference', async () => {
    const { saleId, owed } = await commitSale();
    expect((await setOutcome(cardDeviceId, { outcome: 'approved' })).statusCode).toBe(200);

    const started = await startTender(saleId);
    expect(started.statusCode, started.body).toBe(200);
    const body = started.json() as { route: string; attempt: { id: string; status: string } };
    expect(body.route).toBe('card_terminal');
    expect(body.attempt.status).toBe('sent_to_terminal');

    // The box takes the instruction off the queue, drives the dialect, and
    // posts the outcome on its own route.
    expect(await agent.runPendingCommands()).toBeGreaterThanOrEqual(1);

    const row = await attemptRow(body.attempt.id);
    expect(row.status).toBe('approved');
    expect(row.method).toBe('card');
    expect(row.methodCode).toBe('card');
    // The device is simulated, so the ledger says the simulator answered
    // rather than claiming GHL took the money.
    expect(row.provider).toBe('simulator');
    expect(row.deviceId).toBe(cardDeviceId);
    expect(row.amountSatang).toBe(owed);
    expect(row.paidAt).not.toBeNull();
    expect(row.approvalCode).toMatch(/^R\d{5}$/);
    // GHL never sends the identities on the card wire (p.8) — they are frozen
    // onto the row from the device.
    expect(row.tid).toBe('65703235');
    expect(row.mid).toBe('4648434010');
    // Four digits of the masked PAN, and only four.
    expect(row.last4).toBe('4242');
    // `YYMMDD` + device(2) + seq(4): twelve characters, all digits.
    expect(row.terminalRef).toMatch(/^\d{12}$/);
    expect(row.invoiceNo).toMatch(/^\d{6}$/);

    // And the sale is left for the till to close — the balance is covered and
    // no receipt number has been spent.
    const [saleRow] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(saleRow!.status).toBe('tendering');
    expect(saleRow!.receiptNumber).toBeNull();
    expect((await readAttempt(body.attempt.id)).outstandingSatang).toBe(0);
  });

  it('the till closes it on the finalise route with no second tender', async () => {
    const { saleId, owed } = await commitSale();
    await setOutcome(cardDeviceId, { outcome: 'approved' });
    const started = await startTender(saleId);
    const attemptId = (started.json() as { attempt: { id: string } }).attempt.id;
    await agent.runPendingCommands();

    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().finalised).toBe(true);
    expect(closed.json().sale.receiptNumber).toBeTruthy();

    // One attempt, for the whole balance: the finalise took no cash on top.
    const rows = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(attemptId);
    expect(rows[0]!.amountSatang).toBe(owed);
  });
});

// --- Declined ----------------------------------------------------------------

describe('a card the host refuses', () => {
  it('leaves the attempt declined and the sale exactly as it was', async () => {
    const { saleId, owed } = await commitSale();
    await setOutcome(cardDeviceId, { outcome: 'declined' });
    const started = await startTender(saleId);
    const attemptId = (started.json() as { attempt: { id: string } }).attempt.id;
    await agent.runPendingCommands();

    const row = await attemptRow(attemptId);
    expect(row.status).toBe('declined');
    expect(row.paidAt).toBeNull();
    // `05` Do not honor, in the ISO space a card SALE answers in.
    expect((row.payload as { exchange?: { responseCode?: string } }).exchange?.responseCode).toBe('05');
    // The reference survives the refusal: it is what a person holding the
    // terminal's slip searches by tomorrow morning.
    expect(row.terminalRef).toMatch(/^\d{12}$/);

    const view = await readAttempt(attemptId);
    expect(view.outstandingSatang).toBe(owed);
    const [saleRow] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(saleRow!.status).toBe('tendering');
  });
});

// --- PLANT 1: approved for ฿1 less than asked -------------------------------

describe('PLANT — the terminal approves ฿1 less than the sale asked for', () => {
  it('refuses the sale and sends a void, on a fresh reference, for the amount it took', async () => {
    const { saleId, owed } = await commitSale();
    expect(
      (await setOutcome(cardDeviceId, { outcome: 'partial', approvedSatang: owed - 100 })).statusCode,
    ).toBe(200);

    const started = await startTender(saleId);
    const attemptId = (started.json() as { attempt: { id: string } }).attempt.id;
    await agent.runPendingCommands();

    const afterSale = await attemptRow(attemptId);
    // NOT approved. The platform has no way to take the difference, and a
    // guest charged less than the till shows is the failure this branch exists
    // for.
    expect(afterSale.status).toBe('declined');
    expect(afterSale.paidAt).toBeNull();
    const saleRef = afterSale.terminalRef!;
    const voidPlan = (afterSale.payload as { void?: { amountSatang?: number; reason?: string } }).void;
    expect(voidPlan?.reason).toBe('partial_approval');
    expect(voidPlan?.amountSatang).toBe(owed - 100);

    // The void is a command of its own, queued in the same transaction that
    // declined the attempt.
    const queued = await terminalCommands(attemptId);
    const voidCommand = queued.find((row) => (row.payload as { mode?: string }).mode === 'void');
    expect(voidCommand, 'a void was queued').toBeTruthy();
    expect((voidCommand!.payload as { amountSatang: number }).amountSatang).toBe(owed - 100);
    expect((voidCommand!.payload as { tranRef: string }).tranRef).toBe(afterSale.tranRef);

    // Run it, and read the FRAME the simulator was actually sent — the status
    // alone would pass even if the void had gone out keyed on the sale's own
    // reference, which both vendors forbid.
    expect(await agent.runPendingCommands()).toBeGreaterThanOrEqual(1);
    const voidRequest = tape(cardDeviceId)
      .filter((event) => event.kind === 'request' && event.detail.transactionType === 'VOID')
      .at(-1);
    expect(voidRequest, 'a VOID frame reached the terminal').toBeTruthy();
    expect(voidRequest!.detail.tradeType).toBe('CARD');
    expect(voidRequest!.detail.ref).toMatch(/^\d{12}$/);
    // A FRESH reference (pp.16-17). The sale is found by its invoice number.
    expect(voidRequest!.detail.ref).not.toBe(saleRef);

    // And the attempt is still declined, with the rescue recorded beside it.
    const afterVoid = await attemptRow(attemptId);
    expect(afterVoid.status).toBe('declined');
    const recorded = (afterVoid.payload as { void?: { result?: { outcome?: string; mode?: string } } })
      .void?.result;
    expect(recorded?.mode).toBe('void');
    expect(recorded?.outcome).toBe('approved');

    // Nothing of this sale was taken.
    const view = await readAttempt(attemptId);
    expect(view.outstandingSatang).toBe(owed);
  });
});

// --- PLANT 2: a second result for an attempt that already settled -----------

describe('PLANT — the box reports the same approval twice', () => {
  it('ignores the second one: no second charge, no second paid_at', async () => {
    const { saleId, owed } = await commitSale();
    await setOutcome(cardDeviceId, { outcome: 'approved' });
    const started = await startTender(saleId);
    const attemptId = (started.json() as { attempt: { id: string } }).attempt.id;
    await agent.runPendingCommands();

    const first = await attemptRow(attemptId);
    expect(first.status).toBe('approved');
    const runsBefore = (await ctx.db.select().from(opsRun)).length;

    /**
     * The retry, exactly as it arrives: the box re-posts the outcome whenever
     * an acknowledgement is lost, which is the normal condition rather than
     * the exception.
     */
    const again = await postResult(attemptId, {
      stage: 'final',
      outcome: 'approved',
      requestedSatang: owed,
      approvedSatang: owed,
      terminalRef: first.terminalRef,
      tranRef: first.tranRef,
      invoiceNo: first.invoiceNo,
      approvalCode: 'R99999',
      last4: '1111',
      responseCode: '00',
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().replayed).toBe(true);

    const after = await attemptRow(attemptId);
    expect(after.paidAt!.toISOString()).toBe(first.paidAt!.toISOString());
    expect(after.approvalCode).toBe(first.approvalCode);
    expect(after.last4).toBe(first.last4);
    // One tender against the sale, still.
    const rows = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    expect(rows).toHaveLength(1);
    // And a replay is not an exchange with a terminal, so it writes no run.
    expect((await ctx.db.select().from(opsRun)).length).toBe(runsBefore);
  });
});

// --- No final answer, and the inquiry that follows ---------------------------

describe('a terminal whose own host did not answer it', () => {
  it('records unknown, asks the terminal again, and settles on what the inquiry finds', async () => {
    const { saleId } = await commitSale();
    // Digio's `401 Host timeout`: the terminal is alive and can be asked, which
    // is what separates this from a silence.
    expect((await setOutcome(qrDeviceId, { outcome: 'timeout' })).statusCode).toBe(200);

    const started = await startTender(saleId, { tender: 'qr', method: 'promptpay' });
    expect(started.statusCode, started.body).toBe(200);
    const attemptId = (started.json() as { attempt: { id: string } }).attempt.id;
    await agent.runPendingCommands();

    const blocked = await attemptRow(attemptId);
    // NOT declined. Whether the money moved is unknown, and the inquiry rule
    // has already been queued in the same transaction that said so.
    expect(blocked.status).toBe('inquiring');
    const inquiry = (blocked.payload as { inquiry?: { actionId?: string } }).inquiry;
    expect(inquiry?.actionId).toBeTruthy();
    const queued = await terminalCommands(attemptId);
    expect(queued.some((row) => (row.payload as { mode?: string }).mode === 'inquire')).toBe(true);

    // The box runs the T2 and reports what it found. The simulator is holding
    // no such transaction, because the sale never completed.
    await agent.runPendingCommands();
    const settled = await attemptRow(attemptId);
    expect(settled.status).toBe('not_found');
    expect(settled.paidAt).toBeNull();
  }, 60_000);

  /**
   * The NEXGO card, where the inquiry does not exist.
   *
   * "***Cannot QUERY for trade type CARD" (vendor PDF p.13). That one sentence
   * is why the audited confirmation dialog is this terminal's permanent answer
   * and not a fallback — there is no message that could be sent.
   */
  it('a NEXGO card with no answer goes straight to a person, and no inquiry is queued', async () => {
    const { saleId, owed } = await commitSale();
    await setOutcome(cardDeviceId, { outcome: 'approved' });
    const started = await startTender(saleId);
    const attemptId = (started.json() as { attempt: { id: string } }).attempt.id;

    const reported = await postResult(attemptId, {
      stage: 'final',
      outcome: 'no_response',
      requestedSatang: owed,
      terminalRef: '260101990001',
      responseText: 'the terminal gave no final answer inside the customer-interaction budget',
    });
    expect(reported.statusCode, reported.body).toBe(200);

    const row = await attemptRow(attemptId);
    expect(row.status).toBe('awaiting_staff_confirmation');
    expect((row.payload as { inquiry?: unknown }).inquiry).toBeUndefined();
    const queued = await terminalCommands(attemptId);
    expect(queued.every((cmd) => (cmd.payload as { mode?: string }).mode !== 'inquire')).toBe(true);

    // And asking for one by hand is refused by name rather than pretending.
    const asked = await ctx.app.inject({
      method: 'POST',
      url: `/payments/attempts/${attemptId}/inquire`,
      headers: { cookie },
    });
    expect(asked.statusCode).toBe(409);
    expect(asked.json().error.code).toBe('INQUIRY_UNSUPPORTED');
  });
});

// --- The audited confirmation ------------------------------------------------

describe('a person reads the terminal’s own screen', () => {
  /**
   * A distinct reference per blocked tender, because
   * `unique(device_id, business_date, terminal_ref)` is real: two of these
   * sharing one is the ticket's own "refs are unique per terminal per day"
   * refusing a second tender, which is the index doing its job and not
   * something to work around.
   */
  let blockedRefs = 0;

  async function blockedAttempt(): Promise<{ attemptId: string; owed: number; saleId: string }> {
    const { saleId, owed } = await commitSale();
    await setOutcome(cardDeviceId, { outcome: 'approved' });
    const started = await startTender(saleId);
    const attemptId = (started.json() as { attempt: { id: string } }).attempt.id;
    blockedRefs += 1;
    await postResult(attemptId, {
      stage: 'final',
      outcome: 'no_response',
      requestedSatang: owed,
      terminalRef: `2601019${String(blockedRefs).padStart(5, '0')}`,
    });
    return { attemptId, owed, saleId };
  }

  it('writes their account id onto the attempt AND onto the audit row', async () => {
    const { attemptId } = await blockedAttempt();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/payments/attempts/${attemptId}/confirm`,
      headers: { cookie },
      payload: { took: true, approvalCode: 'R00042', tid: '65703235', last4: '4242' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const row = await attemptRow(attemptId);
    expect(row.status).toBe('approved');
    expect(row.approvalCode).toBe('R00042');
    expect(row.staffConfirmedByAccountId).toBeTruthy();
    expect(row.paidAt).not.toBeNull();

    const [entry] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, attemptId), eq(auditLog.action, 'payment.attempt.confirm')));
    expect(entry, 'the confirmation is audited').toBeTruthy();
    // The row names the account, and it is the SAME account the attempt names:
    // a confirmation nobody is named on is the thing an investigation looks for.
    expect(entry!.actorAccountId).toBe(row.staffConfirmedByAccountId);
    expect((entry!.after as { took: boolean }).took).toBe(true);
  });

  it('“nobody took it” is recorded with their name too, and the sale stays open', async () => {
    const { attemptId, owed } = await blockedAttempt();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/payments/attempts/${attemptId}/confirm`,
      headers: { cookie },
      payload: { took: false, note: 'the terminal screen says nothing was taken' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await attemptRow(attemptId);
    expect(row.status).toBe('declined');
    expect(row.staffConfirmedByAccountId).toBeTruthy();
    expect((await readAttempt(attemptId)).outstandingSatang).toBe(owed);
  });

  it('there is nothing to confirm on a tender that resolved itself', async () => {
    const { saleId } = await commitSale();
    await setOutcome(cardDeviceId, { outcome: 'declined' });
    const started = await startTender(saleId);
    const attemptId = (started.json() as { attempt: { id: string } }).attempt.id;
    await agent.runPendingCommands();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/payments/attempts/${attemptId}/confirm`,
      headers: { cookie },
      payload: { took: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ATTEMPT_NOT_AWAITING_CONFIRMATION');
  });
});

// --- Manual entry ------------------------------------------------------------

describe('an approval code keyed in off the slip', () => {
  it('records a manual tender with no device, and audits who keyed it', async () => {
    const { saleId, owed } = await commitSale();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/payments/manual',
      headers: { cookie },
      payload: { saleId, approvalCode: 'A12345', tid: '65703235', last4: '4242' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const attemptId = res.json().attempt.id as string;

    const row = await attemptRow(attemptId);
    expect(row.provider).toBe('manual');
    expect(row.deviceId).toBeNull();
    expect(row.status).toBe('approved');
    expect(row.approvalCode).toBe('A12345');
    expect(row.amountSatang).toBe(owed);
    // The person who keyed it is on the payload and in the log; the column
    // `staff_confirmed_by` stays for the confirmation path it was built for.
    expect(row.staffConfirmedByAccountId).toBeNull();

    const [entry] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, attemptId), eq(auditLog.action, 'payment.tender.manual')));
    expect(entry!.actorAccountId).toBeTruthy();
    expect((entry!.after as { approvalCode: string }).approvalCode).toBe('A12345');
  });

  it('a station routed to manual entry opens nothing and says so', async () => {
    await ctx.db
      .update(station)
      .set({ paymentRouting: { card: 'manual' } })
      .where(eq(station.id, stationId));
    try {
      const { saleId } = await commitSale();
      const started = await startTender(saleId);
      expect(started.statusCode, started.body).toBe(200);
      expect(started.json().route).toBe('manual');
      expect(started.json().attempt).toBeNull();
      const rows = await ctx.db
        .select()
        .from(paymentAttempt)
        .where(eq(paymentAttempt.saleId, saleId));
      expect(rows).toHaveLength(0);
    } finally {
      await ctx.db
        .update(station)
        .set({ paymentRouting: null })
        .where(eq(station.id, stationId));
    }
  });
});

// --- Pressing Card twice, and asking for more than is owed -------------------

describe('the safeguards on the press itself', () => {
  it('the same action id replayed answers the same attempt and sends no second tender', async () => {
    const { saleId } = await commitSale();
    await setOutcome(cardDeviceId, { outcome: 'approved' });
    const actionId = newId();
    const first = await startTender(saleId, { actionId });
    expect(first.statusCode, first.body).toBe(200);
    const attemptId = (first.json() as { attempt: { id: string } }).attempt.id;

    const second = await startTender(saleId, { actionId });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().attempt.id).toBe(attemptId);

    const rows = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    expect(rows).toHaveLength(1);
    const commands = await terminalCommands(attemptId);
    expect(commands.filter((c) => (c.payload as { mode?: string }).mode === 'sale')).toHaveLength(1);
    await agent.runPendingCommands();
  });

  it('a tender one satang over the balance is refused and writes nothing', async () => {
    const { saleId, owed } = await commitSale();
    const res = await startTender(saleId, { amountSatang: owed + 1 });
    expect(res.statusCode).toBe(400);
    const rows = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
    expect(rows).toHaveLength(0);
  });

  it('a counter with no terminal for that tender is refused by name', async () => {
    const [other] = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.kind, 'booth')));
    const saleId = newId();
    const committed = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: {
        id: saleId,
        stationId: other!.id,
        memberId: jamesId,
        lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 0 }],
      },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const res = await startTender(saleId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NO_TERMINAL_FOR_STATION');
  });
});

// --- What the Failures page is given -----------------------------------------

describe('every adapter call is an ops_run under the action id', () => {
  it('a decline is an ok run named for the exchange, with a fixed key set and no approval code', async () => {
    const { saleId } = await commitSale();
    await setOutcome(cardDeviceId, { outcome: 'declined' });
    const actionId = newId();
    const started = await startTender(saleId, { actionId });
    const attemptId = (started.json() as { attempt: { id: string } }).attempt.id;
    await agent.runPendingCommands();

    const runs = await ctx.db.select().from(opsRun).where(eq(opsRun.actionId, actionId));
    const run = runs.find((r) => r.name.startsWith('device:terminal'));
    expect(run, 'the exchange wrote a run under the press’s action id').toBeTruthy();
    // A declined card is a terminal doing its job, so the run is `ok` and the
    // Failures page is left for the things that actually need somebody.
    expect(run!.outcome).toBe('ok');
    expect(run!.name).toBe('device:terminal.sale');
    expect(run!.kind).toBe('device');
    expect(run!.stationId).toBe(stationId);

    /**
     * THE KEY SET, pinned. The detail is built from a fixed list rather than
     * from the box's body, which is what stops a firmware field nobody has
     * heard of arriving in a jsonb column that a Console page renders.
     */
    expect(Object.keys(run!.detail as object).sort()).toEqual([
      'approvedSatang',
      'attemptId',
      'deviceId',
      'elapsedMs',
      'mode',
      'outcome',
      'protocol',
      'requestedSatang',
      'responseCode',
      'saleId',
      'stationId',
    ]);
    expect(JSON.stringify(run!.detail)).not.toContain('approvalCode');
    expect((run!.detail as { attemptId: string }).attemptId).toBe(attemptId);
  });

  it('a partial approval is a failure, named so the Failures page groups by the failure', async () => {
    const { saleId, owed } = await commitSale();
    await setOutcome(cardDeviceId, { outcome: 'partial', approvedSatang: owed - 100 });
    const actionId = newId();
    expect((await startTender(saleId, { actionId })).statusCode).toBe(200);
    // The sale, then the void it queued — two exchanges, one press.
    await agent.runPendingCommands();
    await agent.runPendingCommands();

    const runs = await ctx.db.select().from(opsRun).where(eq(opsRun.actionId, actionId));
    const failed = runs.find((r) => r.outcome === 'failed');
    expect(failed, 'the shortfall is on the Failures page').toBeTruthy();
    expect(failed!.name).toBe('device:terminal.sale.partial_approval');
    expect(failed!.errorCode).toBe('PARTIAL_APPROVAL');
    expect(failed!.fingerprint).toBeTruthy();
  });
});

// --- The identities a PAX teaches us -----------------------------------------

describe('a Digio terminal reports its own TID and MID', () => {
  it('writes them back onto the device row the first time it answers, and never over an existing one', async () => {
    const [before] = await ctx.db.select().from(device).where(eq(device.id, qrDeviceId));
    // The seed has neither on file for the park's PAX (DEVICE_INVENTORY §4).
    expect(before!.terminalId).toBeNull();

    const { saleId } = await commitSale();
    await setOutcome(qrDeviceId, { outcome: 'approved' });
    const started = await startTender(saleId, { tender: 'qr', method: 'promptpay' });
    expect(started.statusCode, started.body).toBe(200);
    const attemptId = (started.json() as { attempt: { id: string } }).attempt.id;
    await agent.runPendingCommands();

    const row = await attemptRow(attemptId);
    expect(row.status).toBe('approved');
    const [after] = await ctx.db.select().from(device).where(eq(device.id, qrDeviceId));
    expect(after!.terminalId, 'the terminal taught the device row its TID').toBeTruthy();
    expect(row.tid).toBe(after!.terminalId);

    const [entry] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, qrDeviceId), eq(auditLog.action, 'device.terminal_identity')));
    expect(entry, 'learning an identity is audited').toBeTruthy();
    // Nobody chose it, so nobody is named: a terminal reported it.
    expect(entry!.actorAccountId).toBeNull();
  });
});

// --- The Console's panel -----------------------------------------------------

describe('the terminal simulator control', () => {
  it('needs admin:box:command — a counter cannot set what a terminal will do', async () => {
    const res = await setOutcome(cardDeviceId, { outcome: 'declined' }, cookie);
    expect(res.statusCode).toBe(403);
  });

  it('refuses a real terminal, because a real one cannot be asked to pretend', async () => {
    await ctx.db.update(device).set({ transport: 'serial' }).where(eq(device.id, cardDeviceId));
    try {
      const res = await setOutcome(cardDeviceId, { outcome: 'declined' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DEVICE_NOT_SIMULATED');
    } finally {
      await ctx.db
        .update(device)
        .set({ transport: 'simulated' })
        .where(eq(device.id, cardDeviceId));
      await agent.syncConfig();
    }
  });

  it('moves the terminal’s own clock, which is what makes a void window real', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/payments/terminal-simulator',
      headers: { cookie: adminCookie },
      payload: { action: 'terminal.advance_clock', deviceId: cardDeviceId, minutes: 24 * 60 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().applied).toBe(true);
    expect(tape(cardDeviceId).some((e) => e.kind === 'clock.advanced')).toBe(true);
  });

  it('a box this api does not run cannot have its simulators reached from here', async () => {
    const [second] = await ctx.db
      .select()
      .from(box)
      .where(and(eq(box.operatorId, operatorId), eq(box.slot, 'virtual-2')));
    const id = newId();
    await ctx.db.insert(device).values({
      id,
      operatorId,
      branchId: second!.branchId,
      boxId: second!.id,
      kind: 'terminal',
      label: 'EDC on another box',
      transport: 'simulated',
      protocol: 'ghl_linkpos',
    });
    const res = await setOutcome(id, { outcome: 'declined' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BOX_NOT_IN_THIS_PROCESS');
  });
});
