import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  alert,
  auditLog,
  box,
  boxCommand,
  branch,
  device,
  member,
  opsRun,
  paymentAttempt,
  refund,
  station,
  ticketPackage,
} from '@oto/db';
import {
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import { businessDate, newId, parseDayStart } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { attachInProcessBox, expireStaleCommands, provisionVirtualBox } from '../src/services/box';
import { flagPendingPayments } from '../src/services/payments/gateway';

/**
 * SCRUM-979 — THE PLATFORM SIDE OF THE CARD PAYMENT LEFTOVERS.
 *
 *  2. A terminal answer lost on its way: the box posts the result, and when
 *     that post is refused or lost it only logs it and still acknowledges the
 *     command `succeeded` with the outcome on it. The attempt takes it from
 *     there, once; a late post changes nothing.
 *  5, 8. A held payment is freed by the sale's own read and by the sweep.
 *  6. A terminal moved to another box since, or retired there, is still found.
 *  7. A card command that expires in the queue settles where it expires.
 *  8. Card payments waiting for a person have their own Health line.
 *  And a till's poll does not lock a queued command it has nothing to do with.
 *
 * The box's own answers are copied from the box, by line:
 *  - the acknowledgement: `packages/box-agent/src/agent.ts:4155-4169`, its
 *    routing spread from `terminal/index.ts:355-360` (`stationId` null: every
 *    platform command names its device, `index.ts:331-334`);
 *  - the result post: `terminalResultBody`, `agent.ts:1973-1994`.
 */

let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let managerCookie: string;
let agent: BoxAgent;
let operatorId: string;
let branchId: string;
let boxId: string;
let stationId: string;
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
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);

  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central') ?? branches[0]!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;

  const stations = await ctx.db.select().from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  const till = stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!;
  stationId = till.id;
  boxId = till.boxId!;

  const devices = await ctx.db.select().from(device).where(eq(device.branchId, branchId));
  cardDeviceId = devices.find((d) => d.label === 'EDC 1')!.id;
  qrDeviceId = devices.find((d) => d.label === 'EDC 3')!.id;

  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;

  const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
  jamesId = members.find((m) => m.phone === '+66822222222')!.id;

  agent = createBoxAgent({
    apiBaseUrl: 'http://terminal-leftovers.test',
    credentials: memoryCredentialStore(),
    hostname: 'virtual-terminal-leftovers-test',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
    store: boxStoreFor(ctx.db),
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  expect(agent.state.boxId).toBe(boxId);
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
    method: 'POST', url: '/sales', headers: { cookie },
    payload: {
      id: saleId, stationId, memberId: jamesId,
      lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }], finalise: true,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { saleId, owed: res.json().outstandingSatang as number };
}

async function startTender(saleId: string, extra: Record<string, unknown> = {}) {
  return ctx.app.inject({ method: 'POST', url: '/payments/attempts', headers: { cookie }, payload: { saleId, ...extra } });
}

async function attemptRow(id: string) {
  const [row] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, id));
  return row!;
}

async function readAttempt(id: string) {
  const res = await ctx.app.inject({ method: 'GET', url: `/payments/attempts/${id}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { attempt: { status: string; reversalPending?: boolean }; outstandingSatang: number | null };
}

async function readSale(id: string) {
  const res = await ctx.app.inject({ method: 'GET', url: `/sales/${id}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { attempts: Array<{ id: string; status: string }> };
}

/** Every `terminal_sale` command for one attempt, on whichever box. */
async function terminalCommands(attemptId: string) {
  const rows = await ctx.db.select().from(boxCommand).where(eq(boxCommand.kind, 'terminal_sale'));
  return rows
    .filter((row) => (row.payload as { attemptId?: string } | null)?.attemptId === attemptId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

const modeOf = (row: { payload: unknown }) => (row.payload as { mode?: string } | null)?.mode;

async function audits(entityId: string, action: string) {
  return ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action)));
}

async function voidSale(saleId: string) {
  return ctx.app.inject({
    method: 'POST', url: `/sales/${saleId}/void`, headers: { cookie },
    payload: { reason: 'The card terminal answered no' },
  });
}

async function setOutcome(deviceId: string, body: Record<string, unknown>) {
  const res = await ctx.app.inject({
    method: 'POST', url: '/payments/terminal-simulator', headers: { cookie: adminCookie },
    payload: { action: 'terminal.outcome', deviceId, ...body },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Claim one command through the box's own poll, as the agent does, so it is `running`. */
async function claim(commandId: string) {
  for (let tries = 0; tries < 10; tries += 1) {
    const polled = await ctx.app.inject({
      method: 'POST', url: '/box/v1/commands/poll',
      headers: { authorization: `Bearer ${boxCredential}` },
      payload: { max: 10, kinds: ['terminal_sale'] },
    });
    expect(polled.statusCode).toBe(200);
    if (polled.json().commands.some((item: { id: string }) => item.id === commandId)) return;
  }
  throw new Error(`command ${commandId} was never handed out`);
}

/** A tender whose SALE command the box has taken and not answered yet. */
async function claimedTender(tender: 'card' | 'qr' = 'card') {
  const committed = await commitSale();
  const started = await startTender(committed.saleId, tender === 'qr' ? { tender, method: 'promptpay' } : {});
  expect(started.statusCode, started.body).toBe(200);
  const attemptId = started.json().attempt.id as string;
  const [command] = await terminalCommands(attemptId);
  await claim(command!.id);
  const [claimed] = await terminalCommands(attemptId);
  expect(claimed!.state).toBe('running');
  return { ...committed, attemptId, command: claimed! };
}

/**
 * THE BOX'S ACKNOWLEDGEMENT OF A TERMINAL COMMAND THE TERMINAL ANSWERED, as
 * `agent.ts:4155-4169` builds it: `succeeded` because the box holds an answer,
 * the routing spread from `terminal/index.ts:355-360`, then the outcome, the
 * reference and the response code — and nothing else off the terminal.
 */
function boxAck(input: {
  attemptId: string; mode: 'sale' | 'inquire' | 'void'; deviceId: string;
  protocol: 'ghl_linkpos' | 'digio_tlv'; role?: string;
  outcome: string; terminalRef: string | null; responseCode: string | null;
}) {
  return {
    state: 'succeeded',
    result: {
      attemptId: input.attemptId,
      mode: input.mode,
      deviceId: input.deviceId,
      stationId: null,
      role: input.role ?? (input.protocol === 'digio_tlv' ? 'qr_terminal' : 'card_terminal'),
      protocol: input.protocol,
      outcome: input.outcome,
      terminalRef: input.terminalRef,
      responseCode: input.responseCode,
    },
  };
}

async function postAck(commandId: string, body: Record<string, unknown>) {
  const res = await ctx.app.inject({
    method: 'POST', url: `/box/v1/commands/${commandId}/result`,
    headers: { authorization: `Bearer ${boxCredential}` }, payload: body,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

/** The result post, as `terminalResultBody` (agent.ts:1973-1994) builds it. */
function resultPost(input: {
  deviceId: string; protocol: 'ghl_linkpos' | 'digio_tlv'; outcome: string;
  requestedSatang: number; approvedSatang?: number | null; terminalRef: string;
  tranRef?: string | null; invoiceNo?: string | null; approvalCode?: string | null;
  last4?: string | null; responseCode?: string | null; responseText?: string | null;
}) {
  return {
    stage: 'final',
    deviceId: input.deviceId,
    protocol: input.protocol,
    outcome: input.outcome,
    requestedSatang: input.requestedSatang,
    approvedSatang: input.approvedSatang ?? null,
    terminalRef: input.terminalRef,
    tranRef: input.tranRef ?? null,
    invoiceNo: input.invoiceNo ?? null,
    approvalCode: input.approvalCode ?? null,
    last4: input.last4 ?? null,
    tid: null,
    mid: null,
    qrPayload: null,
    responseCode: input.responseCode ?? null,
    responseText: input.responseText ?? null,
    elapsedMs: 1200,
    at: new Date().toISOString(),
  };
}

async function postResult(attemptId: string, body: Record<string, unknown>, actionId: string | null) {
  return ctx.app.inject({
    method: 'POST', url: `/payments/attempts/${attemptId}/result`,
    headers: { authorization: `Bearer ${boxCredential}`, ...(actionId ? { 'x-oto-action-id': actionId } : {}) },
    payload: body,
  });
}

/** What the old code left behind: the command ended, the attempt untouched. */
async function endCommandUnsettled(commandId: string, fields: Partial<typeof boxCommand.$inferInsert>) {
  await ctx.db.update(boxCommand).set({ finishedAt: new Date(), ...fields }).where(eq(boxCommand.id, commandId));
}

function notOnThisBox(attemptId: string) {
  return {
    state: 'failed' as const,
    result: { attemptId, mode: 'sale', outcome: null, terminalRef: null, responseCode: null },
    errorCode: 'TERMINAL_NOT_ON_THIS_BOX',
    errorMessage: 'this box has no card_terminal for any station',
  };
}

const later = () => new Date(Date.now() + 11 * 60_000);

// --- 2 · The answer that reached the platform only on the acknowledgement ------

describe('a terminal answer whose result post never landed, taken from the acknowledgement', () => {
  it('approved: the attempt is approved and the sale paid exactly once; a late post changes nothing', async () => {
    const held = await claimedTender();
    await postAck(held.command.id, boxAck({
      attemptId: held.attemptId, mode: 'sale', deviceId: cardDeviceId, protocol: 'ghl_linkpos',
      outcome: 'approved', terminalRef: '261113979001', responseCode: '00',
    }));

    // Settled in the acknowledgement's own transaction: nobody has read it.
    const row = await attemptRow(held.attemptId);
    expect(row.status).toBe('approved');
    expect(row.paidAt).not.toBeNull();
    expect(row.terminalRef).toBe('261113979001');
    // What the acknowledgement does not carry stays empty rather than invented.
    expect(row.approvalCode).toBeNull();
    expect(row.last4).toBeNull();
    expect((row.payload as { fromCommand?: unknown }).fromCommand).toMatchObject({
      mode: 'sale', commandId: held.command.id, outcome: 'approved',
    });
    expect((row.payload as { exchange?: unknown }).exchange).toMatchObject({
      mode: 'sale', outcome: 'approved', source: 'box_command', commandId: held.command.id, responseCode: '00',
    });
    const taken = await audits(held.attemptId, 'payment.attempt.result_from_command');
    expect(taken).toHaveLength(1);
    expect(taken[0]!.after).toMatchObject({
      status: 'approved', mode: 'sale', commandId: held.command.id, outcome: 'approved',
      missing: expect.arrayContaining(['approvedSatang', 'approvalCode', 'last4', 'tranRef', 'invoiceNo']),
    });
    // The run the result route writes, so the Failures page sees the exchange.
    const runs = (await ctx.db.select().from(opsRun).where(eq(opsRun.name, 'device:terminal.sale')))
      .filter((r) => (r.detail as { attemptId?: string } | null)?.attemptId === held.attemptId);
    expect(runs).toHaveLength(1);
    expect((await readAttempt(held.attemptId)).outstandingSatang).toBe(0);

    // The post arrives late, with everything the acknowledgement lacked.
    const late = await postResult(held.attemptId, resultPost({
      deviceId: cardDeviceId, protocol: 'ghl_linkpos', outcome: 'approved', requestedSatang: held.owed,
      approvedSatang: held.owed, terminalRef: '261113979001', tranRef: '979001', invoiceNo: '979001',
      approvalCode: 'R97901', last4: '4242', responseCode: '00', responseText: 'Approved',
    }), held.command.actionId);
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json().replayed).toBe(true);
    const after = await attemptRow(held.attemptId);
    expect(after.paidAt!.toISOString()).toBe(row.paidAt!.toISOString());
    expect(after.approvalCode).toBeNull();
    expect(await audits(held.attemptId, 'payment.attempt.result_from_command')).toHaveLength(1);

    // The till closes the sale on the money already taken: one attempt, no second tender.
    const closed = await ctx.app.inject({ method: 'POST', url: `/sales/${held.saleId}/finalise`, headers: { cookie }, payload: {} });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().finalised).toBe(true);
    const rows = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, held.saleId));
    expect(rows).toHaveLength(1);
    // And the box was never asked for a second SALE.
    await agent.runPendingCommands();
    expect((await terminalCommands(held.attemptId)).filter((c) => modeOf(c) === 'sale')).toHaveLength(1);
  });

  it('declined: the attempt is declined and the sale can be voided; a late post changes nothing', async () => {
    const held = await claimedTender();
    await postAck(held.command.id, boxAck({
      attemptId: held.attemptId, mode: 'sale', deviceId: cardDeviceId, protocol: 'ghl_linkpos',
      outcome: 'declined', terminalRef: '261113979002', responseCode: '05',
    }));
    const row = await attemptRow(held.attemptId);
    expect(row.status).toBe('declined');
    expect(row.paidAt).toBeNull();
    expect((await readAttempt(held.attemptId)).outstandingSatang).toBe(held.owed);

    const late = await postResult(held.attemptId, resultPost({
      deviceId: cardDeviceId, protocol: 'ghl_linkpos', outcome: 'declined', requestedSatang: held.owed,
      terminalRef: '261113979002', responseCode: '05', responseText: 'Do not honor',
    }), held.command.actionId);
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json().replayed).toBe(true);
    expect((await attemptRow(held.attemptId)).status).toBe('declined');
    expect(await audits(held.attemptId, 'payment.attempt.result_from_command')).toHaveLength(1);
    expect((await voidSale(held.saleId)).statusCode).toBe(200);
  });

  it('a Digio host timeout queues one inquiry, and the late post of the same answer queues no second', async () => {
    const held = await claimedTender('qr');
    await postAck(held.command.id, boxAck({
      attemptId: held.attemptId, mode: 'sale', deviceId: qrDeviceId, protocol: 'digio_tlv',
      outcome: 'timeout', terminalRef: '979003', responseCode: '401',
    }));
    const row = await attemptRow(held.attemptId);
    expect(row.status).toBe('inquiring');
    expect(row.terminalRef).toBe('979003');
    const inquiries = async () => (await terminalCommands(held.attemptId)).filter((c) => modeOf(c) === 'inquire');
    expect(await inquiries()).toHaveLength(1);

    const late = await postResult(held.attemptId, resultPost({
      deviceId: qrDeviceId, protocol: 'digio_tlv', outcome: 'timeout', requestedSatang: held.owed,
      terminalRef: '979003', responseCode: '401', responseText: 'Host timeout',
    }), held.command.actionId);
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json().replayed).toBe(true);
    expect(await inquiries()).toHaveLength(1);
    expect((await terminalCommands(held.attemptId)).filter((c) => modeOf(c) === 'sale')).toHaveLength(1);
  });

  it('a result post that landed first leaves the acknowledgement nothing to do', async () => {
    const { saleId } = await commitSale();
    await setOutcome(qrDeviceId, { outcome: 'timeout' });
    const started = await startTender(saleId, { tender: 'qr', method: 'promptpay' });
    expect(started.statusCode, started.body).toBe(200);
    const attemptId = started.json().attempt.id as string;
    // The real box: it posts the timeout, then acknowledges the SALE with it.
    for (let i = 0; i < 10 && (await attemptRow(attemptId)).status === 'sent_to_terminal'; i += 1) {
      await agent.runPendingCommands();
    }
    expect((await attemptRow(attemptId)).status).toBe('inquiring');
    const sale = (await terminalCommands(attemptId)).find((c) => modeOf(c) === 'sale')!;
    expect(sale).toMatchObject({ state: 'succeeded' });
    // The real agent's acknowledgement, key for key: the shape `boxAck` copies.
    const terminalRef = (await attemptRow(attemptId)).terminalRef;
    expect(sale.result).toEqual(boxAck({
      attemptId, mode: 'sale', deviceId: qrDeviceId, protocol: 'digio_tlv',
      outcome: 'timeout', terminalRef, responseCode: '401',
    }).result);
    expect((await terminalCommands(attemptId)).filter((c) => modeOf(c) === 'inquire')).toHaveLength(1);
    expect(await audits(attemptId, 'payment.attempt.result_from_command')).toHaveLength(0);
  });
});

describe('an inquiry answered only on its acknowledgement', () => {
  async function inquiringTender() {
    const { saleId, owed } = await commitSale();
    await setOutcome(qrDeviceId, { outcome: 'timeout' });
    const started = await startTender(saleId, { tender: 'qr', method: 'promptpay' });
    expect(started.statusCode, started.body).toBe(200);
    const attemptId = started.json().attempt.id as string;
    for (let i = 0; i < 10 && (await attemptRow(attemptId)).status === 'sent_to_terminal'; i += 1) {
      await agent.runPendingCommands();
    }
    expect((await attemptRow(attemptId)).status).toBe('inquiring');
    const inquiry = (await terminalCommands(attemptId)).find((row) => modeOf(row) === 'inquire')!;
    await claim(inquiry.id);
    const terminalRef = (await attemptRow(attemptId)).terminalRef!;
    return { saleId, owed, attemptId, inquiry, terminalRef };
  }

  it('not found: the sale never happened, the attempt ends, and a late post changes nothing', async () => {
    const held = await inquiringTender();
    await postAck(held.inquiry.id, boxAck({
      attemptId: held.attemptId, mode: 'inquire', deviceId: qrDeviceId, protocol: 'digio_tlv',
      outcome: 'not_found', terminalRef: held.terminalRef, responseCode: '203',
    }));
    const row = await attemptRow(held.attemptId);
    expect(row.status).toBe('not_found');
    expect(row.paidAt).toBeNull();
    expect(await audits(held.attemptId, 'payment.attempt.result_from_command')).toHaveLength(1);
    const late = await postResult(held.attemptId, resultPost({
      deviceId: qrDeviceId, protocol: 'digio_tlv', outcome: 'not_found', requestedSatang: held.owed,
      terminalRef: held.terminalRef, responseCode: '203',
    }), held.inquiry.actionId);
    expect(late.json().replayed).toBe(true);
    expect((await attemptRow(held.attemptId)).status).toBe('not_found');
    expect((await voidSale(held.saleId)).statusCode).toBe(200);
  });

  it('approved carries no amount to check, so it is handed to a person, and nothing more is queued', async () => {
    const held = await inquiringTender();
    const before = (await terminalCommands(held.attemptId)).length;
    await postAck(held.inquiry.id, boxAck({
      attemptId: held.attemptId, mode: 'inquire', deviceId: qrDeviceId, protocol: 'digio_tlv',
      outcome: 'approved', terminalRef: held.terminalRef, responseCode: '00',
    }));
    const row = await attemptRow(held.attemptId);
    expect(row.status).toBe('awaiting_staff_confirmation');
    expect(row.paidAt).toBeNull();
    expect((row.payload as { fromCommand?: unknown }).fromCommand).toMatchObject({
      mode: 'inquire', commandId: held.inquiry.id, outcome: 'approved', held: 'inquiry',
    });
    expect((await audits(held.attemptId, 'payment.attempt.result_from_command'))[0]!.after)
      .toMatchObject({ status: 'awaiting_staff_confirmation', held: 'inquiry' });
    expect(await terminalCommands(held.attemptId)).toHaveLength(before);
  });
});

describe('a SALE acknowledgement that carries too little', () => {
  it('a partial approval is handed to a person; the full post arriving later is still taken', async () => {
    const held = await claimedTender();
    await postAck(held.command.id, boxAck({
      attemptId: held.attemptId, mode: 'sale', deviceId: cardDeviceId, protocol: 'ghl_linkpos',
      outcome: 'partial_approval', terminalRef: '261113979004', responseCode: '10',
    }));
    const row = await attemptRow(held.attemptId);
    expect(row.status).toBe('awaiting_staff_confirmation');
    expect(row.terminalRef).toBe('261113979004');
    expect((row.payload as { fromCommand?: unknown }).fromCommand).toMatchObject({ held: 'partial', outcome: 'partial_approval' });
    // No void can be sent: the acknowledgement names no transaction to void.
    expect((await terminalCommands(held.attemptId)).filter((c) => modeOf(c) === 'void')).toHaveLength(0);
    // The sale stays held for the person: no cash on top of a possible charge.
    const cash = await ctx.app.inject({
      method: 'POST', url: `/sales/${held.saleId}/finalise`, headers: { cookie },
      payload: { method: 'cash', kind: 'cash', actionId: newId() },
    });
    expect(cash.statusCode).toBe(409);
    expect(cash.json().error.code).toBe('PAYMENT_IN_FLIGHT');

    // The terminal's full answer, when it does arrive, is the platform's rule.
    const late = await postResult(held.attemptId, resultPost({
      deviceId: cardDeviceId, protocol: 'ghl_linkpos', outcome: 'partial_approval', requestedSatang: held.owed,
      approvedSatang: held.owed - 100, terminalRef: '261113979004', tranRef: '979004', invoiceNo: '979004',
      approvalCode: 'R97904', last4: '4242', responseCode: '10',
    }), held.command.actionId);
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json().replayed).toBe(false);
    expect((await attemptRow(held.attemptId)).status).toBe('declined');
    expect((await terminalCommands(held.attemptId)).filter((c) => modeOf(c) === 'void')).toHaveLength(1);
    expect((await readAttempt(held.attemptId)).attempt.reversalPending).toBe(true);
  });

  async function confirmTook(attemptId: string) {
    return ctx.app.inject({
      method: 'POST', url: `/payments/attempts/${attemptId}/confirm`, headers: { cookie },
      payload: { took: true, note: 'The terminal screen says APPROVED' },
    });
  }

  async function expectStillHeld(attemptId: string, owed: number) {
    const row = await attemptRow(attemptId);
    expect(row.status).toBe('awaiting_staff_confirmation');
    expect(row.paidAt).toBeNull();
    expect(row.staffConfirmedByAccountId).toBeNull();
    expect(await audits(attemptId, 'payment.attempt.confirm')).toHaveLength(0);
    expect((await readAttempt(attemptId)).outstandingSatang).toBe(owed);
  }

  it('a partial approval cannot be confirmed as paid in full, and the till reads why', async () => {
    const held = await claimedTender();
    await postAck(held.command.id, boxAck({
      attemptId: held.attemptId, mode: 'sale', deviceId: cardDeviceId, protocol: 'ghl_linkpos',
      outcome: 'partial_approval', terminalRef: '261113979011', responseCode: '10',
    }));
    const read = await ctx.app.inject({ method: 'GET', url: `/payments/attempts/${held.attemptId}`, headers: { cookie } });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().responseText).toMatch(/approved a different amount.*cannot be confirmed as paid in full/);

    const took = await confirmTook(held.attemptId);
    expect(took.statusCode, took.body).toBe(409);
    expect(took.json().error).toMatchObject({
      code: 'PARTIAL_APPROVAL_NOT_CONFIRMABLE', details: { held: 'partial' },
    });
    await expectStillHeld(held.attemptId, held.owed);
  });

  it('an inquiry’s approval after a partial approval does not lift the hold', async () => {
    const held = await claimedTender('qr');
    await postAck(held.command.id, boxAck({
      attemptId: held.attemptId, mode: 'sale', deviceId: qrDeviceId, protocol: 'digio_tlv',
      outcome: 'partial_approval', terminalRef: '979012', responseCode: '00',
    }));
    expect((await attemptRow(held.attemptId)).status).toBe('awaiting_staff_confirmation');
    // A person asks the terminal again; only the acknowledgement of that comes back.
    const asked = await ctx.app.inject({ method: 'POST', url: `/payments/attempts/${held.attemptId}/inquire`, headers: { cookie } });
    expect(asked.statusCode, asked.body).toBe(200);
    const inquiry = (await terminalCommands(held.attemptId)).find((row) => modeOf(row) === 'inquire')!;
    await claim(inquiry.id);
    await postAck(inquiry.id, boxAck({
      attemptId: held.attemptId, mode: 'inquire', deviceId: qrDeviceId, protocol: 'digio_tlv',
      outcome: 'approved', terminalRef: '979012', responseCode: '00',
    }));
    const row = await attemptRow(held.attemptId);
    expect((row.payload as { fromCommand?: unknown }).fromCommand).toMatchObject({
      mode: 'inquire', commandId: inquiry.id, outcome: 'approved', held: 'partial',
    });

    const took = await confirmTook(held.attemptId);
    expect(took.statusCode, took.body).toBe(409);
    expect(took.json().error.code).toBe('PARTIAL_APPROVAL_NOT_CONFIRMABLE');
    await expectStillHeld(held.attemptId, held.owed);
  });
});

// --- A refund's VOID answered only on its acknowledgement ---------------------

async function refundedCardSale() {
  const committed = await commitSale();
  const attemptId = newId();
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
  await ctx.db.insert(paymentAttempt).values({
    id: attemptId, operatorId, branchId, saleId: committed.saleId, stationId, deviceId: cardDeviceId,
    businessDate: businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart)),
    method: 'card', methodCode: 'card', provider: 'simulator', status: 'approved',
    amountSatang: committed.owed, tranRef: `TR${attemptId.slice(-8)}`, approvalCode: 'A1B2C3', last4: '4242',
    paidAt: new Date(), payload: { tender: 'card', protocol: 'ghl_linkpos' },
  });
  const closed = await ctx.app.inject({ method: 'POST', url: `/sales/${committed.saleId}/finalise`, headers: { cookie }, payload: {} });
  expect(closed.statusCode, closed.body).toBe(200);
  const refunded = await ctx.app.inject({
    method: 'POST', url: `/sales/${committed.saleId}/refunds`, headers: { cookie: managerCookie },
    payload: { mode: 'whole', reason: 'Charged twice', actionId: newId() },
  });
  expect(refunded.statusCode, refunded.body).toBe(200);
  const refundId = refunded.json().refund.id as string;
  const [slice] = refunded.json().refund.tenderAllocation as Array<{ actionId: string }>;
  const voidCommand = (await terminalCommands(attemptId)).find((row) => row.actionId === slice!.actionId)!;
  expect(modeOf(voidCommand)).toBe('void');
  expect(voidCommand.state).toBe('queued');
  return { ...committed, attemptId, refundId, voidActionId: slice!.actionId, voidCommand };
}

async function refundSlice(refundId: string) {
  const [row] = await ctx.db.select().from(refund).where(eq(refund.id, refundId));
  return row!.tenderAllocation![0]!;
}

const voidCommandsOf = async (attemptId: string) =>
  (await terminalCommands(attemptId)).filter((row) => modeOf(row) === 'void');

describe('a refund’s VOID answered only on its acknowledgement', () => {
  it('approved: money back on the card, once; a late post changes nothing', async () => {
    const held = await refundedCardSale();
    await claim(held.voidCommand.id);
    await postAck(held.voidCommand.id, boxAck({
      attemptId: held.attemptId, mode: 'void', deviceId: cardDeviceId, protocol: 'ghl_linkpos',
      outcome: 'approved', terminalRef: '261113979005', responseCode: '00',
    }));
    expect(await refundSlice(held.refundId)).toMatchObject({ status: 'done', detail: 'Voided on the terminal' });
    expect(await audits(held.refundId, 'refund.void_approved')).toHaveLength(1);
    const row = await attemptRow(held.attemptId);
    expect(row.status).toBe('approved');
    expect((row.payload as { void?: { result?: unknown } }).void?.result).toMatchObject({
      mode: 'void', outcome: 'approved', source: 'box_command', commandId: held.voidCommand.id,
    });

    const late = await postResult(held.attemptId, resultPost({
      deviceId: cardDeviceId, protocol: 'ghl_linkpos', outcome: 'approved', requestedSatang: held.owed,
      approvedSatang: held.owed, terminalRef: '261113979005', responseCode: '00',
    }), held.voidActionId);
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json()).toMatchObject({ replayed: true, phase: 'void' });
    expect(await audits(held.refundId, 'refund.void_approved')).toHaveLength(1);
    expect(await audits(held.refundId, 'refund.void_refused')).toHaveLength(0);
    expect(await voidCommandsOf(held.attemptId)).toHaveLength(1);
  });

  it('declined: the terminal refused the void, and the slice falls back to cash', async () => {
    const held = await refundedCardSale();
    await claim(held.voidCommand.id);
    await postAck(held.voidCommand.id, boxAck({
      attemptId: held.attemptId, mode: 'void', deviceId: cardDeviceId, protocol: 'ghl_linkpos',
      outcome: 'declined', terminalRef: '261113979006', responseCode: '06',
    }));
    expect(await refundSlice(held.refundId)).toMatchObject({ status: 'failed', fallback: 'cash' });
    expect(await audits(held.refundId, 'refund.void_refused')).toHaveLength(1);
  });

  it('no final answer: the void may have gone through, so it stays pending for a person, read once', async () => {
    const held = await refundedCardSale();
    await claim(held.voidCommand.id);
    await postAck(held.voidCommand.id, boxAck({
      attemptId: held.attemptId, mode: 'void', deviceId: cardDeviceId, protocol: 'ghl_linkpos',
      outcome: 'no_response', terminalRef: '261113979007', responseCode: null,
    }));
    expect(await refundSlice(held.refundId)).toMatchObject({ status: 'pending' });
    const row = await attemptRow(held.attemptId);
    const reversal = (row.payload as { void?: { result?: unknown; commandAnswer?: unknown } }).void;
    expect(reversal?.result).toBeUndefined();
    expect(reversal?.commandAnswer).toMatchObject({ held: 'void', outcome: 'no_response', commandId: held.voidCommand.id });
    expect(await audits(held.attemptId, 'payment.attempt.result_from_command')).toHaveLength(1);
    // Reads and the box's polls change nothing more, and send no second VOID.
    await readAttempt(held.attemptId);
    await readSale(held.saleId);
    await agent.runPendingCommands();
    expect(await audits(held.attemptId, 'payment.attempt.result_from_command')).toHaveLength(1);
    expect(await refundSlice(held.refundId)).toMatchObject({ status: 'pending' });
    expect(await voidCommandsOf(held.attemptId)).toHaveLength(1);
  });
});

// --- 5, 8 · The sale's read and the sweep --------------------------------------

describe('a held payment freed without its own read', () => {
  it('GET /sales/:id frees a held attempt, so History offers the void', async () => {
    const held = await claimedTender();
    await endCommandUnsettled(held.command.id, notOnThisBox(held.attemptId));
    expect((await attemptRow(held.attemptId)).status).toBe('sent_to_terminal');

    const detail = await readSale(held.saleId);
    expect(detail.attempts.find((a) => a.id === held.attemptId)?.status).toBe('declined');
    expect(await audits(held.attemptId, 'payment.attempt.not_sent')).toHaveLength(1);
    // A second read changes nothing.
    await readSale(held.saleId);
    expect(await audits(held.attemptId, 'payment.attempt.not_sent')).toHaveLength(1);
    expect((await voidSale(held.saleId)).statusCode).toBe(200);
  });

  it('GET /sales/:id takes an acknowledged answer the old code left on the command', async () => {
    const held = await claimedTender();
    const ack = boxAck({
      attemptId: held.attemptId, mode: 'sale', deviceId: cardDeviceId, protocol: 'ghl_linkpos',
      outcome: 'approved', terminalRef: '261113979008', responseCode: '00',
    });
    await endCommandUnsettled(held.command.id, { state: 'succeeded', result: ack.result as never });
    const detail = await readSale(held.saleId);
    expect(detail.attempts.find((a) => a.id === held.attemptId)?.status).toBe('approved');
  });

  it('a status poll stays readable when recovery collides with another terminal reference', async () => {
    // Medium finding: a recovery write must not turn the till's status read
    // into an error response. Keep the attempt held for investigation, without tendering
    // again or accepting an acknowledgement that belongs to another payment.
    const other = await claimedTender();
    const terminalRef = '261113979099';
    await ctx.db.update(paymentAttempt).set({ terminalRef }).where(eq(paymentAttempt.id, other.attemptId));
    const stuck = await claimedTender();
    const ack = boxAck({
      attemptId: stuck.attemptId, mode: 'sale', deviceId: cardDeviceId, protocol: 'ghl_linkpos',
      outcome: 'approved', terminalRef, responseCode: '00',
    });
    await endCommandUnsettled(stuck.command.id, { state: 'succeeded', result: ack.result as never });
    const before = await attemptRow(stuck.attemptId);
    const commandsBefore = await terminalCommands(stuck.attemptId);
    try {
      for (let poll = 0; poll < 2; poll += 1) {
        const status = await readAttempt(stuck.attemptId);
        expect(status.attempt.status).toBe('sent_to_terminal');
        expect(await attemptRow(stuck.attemptId)).toEqual(before);
      }
      expect(await terminalCommands(stuck.attemptId)).toEqual(commandsBefore);
    } finally {
      await ctx.db.update(paymentAttempt).set({ terminalRef: null }).where(eq(paymentAttempt.id, other.attemptId));
    }
  });

  it('the sweep frees a held attempt nobody reads, and one that cannot be settled never stops it', async () => {
    // One the sweep can free: refused by the box, recorded by the old code.
    const free = await claimedTender();
    await endCommandUnsettled(free.command.id, notOnThisBox(free.attemptId));
    // One it cannot: its acknowledged reference is already another attempt's
    // on this terminal today, so settling it throws on the unique index.
    const other = await claimedTender();
    await ctx.db.update(paymentAttempt).set({ terminalRef: '261113979009' }).where(eq(paymentAttempt.id, other.attemptId));
    const stuck = await claimedTender();
    const ack = boxAck({
      attemptId: stuck.attemptId, mode: 'sale', deviceId: cardDeviceId, protocol: 'ghl_linkpos',
      outcome: 'approved', terminalRef: '261113979009', responseCode: '00',
    });
    await endCommandUnsettled(stuck.command.id, { state: 'succeeded', result: ack.result as never });

    const summary = await flagPendingPayments(ctx.db, ctx.app.env, later(), ctx.app.log);
    expect(summary.heldFailed).toBeGreaterThanOrEqual(1);
    expect(summary.heldSettled).toBeGreaterThanOrEqual(1);
    expect((await attemptRow(free.attemptId)).status).toBe('declined');
    expect(await audits(free.attemptId, 'payment.attempt.not_sent')).toHaveLength(1);
    expect((await attemptRow(stuck.attemptId)).status).toBe('sent_to_terminal');
    // Still counted for a person to look at.
    const [open] = await ctx.db.select().from(alert)
      .where(and(eq(alert.key, `payments.pending:${branchId}`), isNull(alert.resolvedAt)));
    expect((open!.detail as { attemptIds: string[] }).attemptIds).toContain(stuck.attemptId);
    expect((open!.detail as { attemptIds: string[] }).attemptIds).not.toContain(free.attemptId);
    // Unblock the stuck one for the rest of this file.
    await ctx.db.update(paymentAttempt).set({ terminalRef: null }).where(eq(paymentAttempt.id, other.attemptId));
  });
});

// --- 6 · A terminal moved to another box, or taken off one ---------------------

describe('a held payment whose terminal has moved since', () => {
  async function anotherBox(): Promise<string> {
    const id = newId();
    await ctx.db.insert(box).values({ id, operatorId, branchId, name: 'ZZ 979 second box', slot: `zz979-${id.slice(-6)}` });
    return id;
  }

  it('the result post from the old box is refused, and the acknowledgement still settles it', async () => {
    const held = await claimedTender();
    const elsewhere = await anotherBox();
    await ctx.db.update(device).set({ boxId: elsewhere }).where(eq(device.id, cardDeviceId));
    try {
      // The real refusal: a box speaks only about its own terminals.
      const refused = await postResult(held.attemptId, resultPost({
        deviceId: cardDeviceId, protocol: 'ghl_linkpos', outcome: 'approved', requestedSatang: held.owed,
        approvedSatang: held.owed, terminalRef: '261113979010', responseCode: '00',
      }), held.command.actionId);
      expect(refused.statusCode).toBe(404);
      expect((await attemptRow(held.attemptId)).status).toBe('sent_to_terminal');
      // The box logs that and acknowledges the command, as it does.
      await postAck(held.command.id, boxAck({
        attemptId: held.attemptId, mode: 'sale', deviceId: cardDeviceId, protocol: 'ghl_linkpos',
        outcome: 'approved', terminalRef: '261113979010', responseCode: '00',
      }));
      expect((await attemptRow(held.attemptId)).status).toBe('approved');
    } finally {
      await ctx.db.update(device).set({ boxId }).where(eq(device.id, cardDeviceId));
    }
  });

  it('the read-time net finds the command on the old box, for a terminal moved, or retired elsewhere', async () => {
    const moved = await claimedTender();
    const retired = await claimedTender();
    for (const held of [moved, retired]) await endCommandUnsettled(held.command.id, notOnThisBox(held.attemptId));
    // `device.box_id` is required: a terminal leaves a box by moving to another.
    const elsewhere = await anotherBox();
    try {
      await ctx.db.update(device).set({ boxId: elsewhere }).where(eq(device.id, cardDeviceId));
      expect((await readAttempt(moved.attemptId)).attempt.status).toBe('declined');
      await ctx.db.update(device).set({ archivedAt: new Date() }).where(eq(device.id, cardDeviceId));
      expect((await readAttempt(retired.attemptId)).attempt.status).toBe('declined');
    } finally {
      await ctx.db.update(device).set({ boxId, archivedAt: null }).where(eq(device.id, cardDeviceId));
    }
    for (const held of [moved, retired]) {
      expect(await audits(held.attemptId, 'payment.attempt.not_sent')).toHaveLength(1);
      expect(await terminalCommands(held.attemptId)).toHaveLength(1);
    }
  });
});

// --- 7 · A card command that expires in the queue ------------------------------

const VOID_NOT_SENT_DETAIL = 'The box could not send the void to the terminal — hand it back in cash';

describe('a card command that runs out of time in the box’s queue', () => {
  it('a refund’s VOID expired by the hourly sweep falls back to cash with nobody reading it', async () => {
    const held = await refundedCardSale();
    await ctx.db.update(boxCommand).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(boxCommand.id, held.voidCommand.id));
    expect(await expireStaleCommands(ctx.db)).toBeGreaterThanOrEqual(1);
    expect(await refundSlice(held.refundId)).toMatchObject({
      status: 'failed', fallback: 'cash', detail: VOID_NOT_SENT_DETAIL,
    });
    expect((await audits(held.attemptId, 'payment.attempt.void_not_sent'))[0]!.after)
      .toMatchObject({ errorCode: 'BOX_COMMAND_EXPIRED', commandState: 'expired' });
    expect((await voidCommandsOf(held.attemptId))[0]).toMatchObject({ state: 'expired', attempts: 0 });
  });

  it('a refund’s VOID expired by the box’s own poll falls back to cash with nobody reading it', async () => {
    const held = await refundedCardSale();
    await ctx.db.update(boxCommand).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(boxCommand.id, held.voidCommand.id));
    const polled = await ctx.app.inject({
      method: 'POST', url: '/box/v1/commands/poll',
      headers: { authorization: `Bearer ${boxCredential}` }, payload: { max: 1, kinds: ['go_online'] },
    });
    expect(polled.statusCode).toBe(200);
    expect(await refundSlice(held.refundId)).toMatchObject({
      status: 'failed', fallback: 'cash', detail: VOID_NOT_SENT_DETAIL,
    });
    expect(await audits(held.attemptId, 'payment.attempt.void_not_sent')).toHaveLength(1);
    expect(await audits(held.refundId, 'refund.void_refused')).toHaveLength(1);
  });

  it('a SALE expired by the hourly sweep frees its sale with nobody reading it', async () => {
    const committed = await commitSale();
    const started = await startTender(committed.saleId);
    expect(started.statusCode, started.body).toBe(200);
    const attemptId = started.json().attempt.id as string;
    const [command] = await terminalCommands(attemptId);
    await ctx.db.update(boxCommand).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(boxCommand.id, command!.id));
    await expireStaleCommands(ctx.db);
    const row = await attemptRow(attemptId);
    expect(row.status).toBe('declined');
    expect((row.payload as { notSent?: { errorCode?: string } }).notSent?.errorCode).toBe('BOX_COMMAND_EXPIRED');
    expect((await voidSale(committed.saleId)).statusCode).toBe(200);
  });
});

// --- 6 · A till's poll does not lock a command it has nothing to do with --------

describe('a till polling a card payment the box has not taken yet', () => {
  it('reads the queued command without locking it, so the box can always claim it', async () => {
    const committed = await commitSale();
    const started = await startTender(committed.saleId);
    expect(started.statusCode, started.body).toBe(200);
    const attemptId = started.json().attempt.id as string;
    const [command] = await terminalCommands(attemptId);
    expect(command!.state).toBe('queued');

    // Somebody else holds the command's row lock, as the box's claim would.
    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const holder = ctx.db.transaction(async (tx) => {
      await tx.select({ id: boxCommand.id }).from(boxCommand).where(eq(boxCommand.id, command!.id)).for('update');
      locked();
      await released;
    });
    await holding;
    const outcome = await Promise.race([
      readAttempt(attemptId).then((view) => view.attempt.status),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked on the command lock'), 5_000)),
    ]);
    release();
    await holder;
    expect(outcome).toBe('sent_to_terminal');
  });
});

// --- 8 · Card payments waiting for a person, on Health -------------------------

describe('Health’s line for card payments waiting for staff', () => {
  it('lists a card waiting for a person on its own line, not as a tender with no outcome', async () => {
    const held = await claimedTender();
    await postAck(held.command.id, {
      state: 'failed',
      result: { attemptId: held.attemptId, mode: 'sale', deviceId: cardDeviceId, stationId: null,
        role: 'card_terminal', protocol: 'ghl_linkpos', outcome: null, terminalRef: null, responseCode: null },
      errorCode: 'TERMINAL_UNREACHABLE', errorMessage: 'the terminal did not answer on its port',
    });
    expect((await attemptRow(held.attemptId)).status).toBe('awaiting_staff_confirmation');

    const listed = async (key: string) => {
      const [row] = await ctx.db.select().from(alert).where(and(eq(alert.key, key), isNull(alert.resolvedAt)));
      return row ? ((row.detail as { attemptIds?: string[] } | null)?.attemptIds ?? []) : [];
    };
    const summary = await flagPendingPayments(ctx.db, ctx.app.env, later(), ctx.app.log);
    expect(summary.awaitingStaff).toBeGreaterThanOrEqual(1);
    expect(await listed(`payments.awaiting_staff:${branchId}`)).toContain(held.attemptId);
    expect(await listed(`payments.pending:${branchId}`)).not.toContain(held.attemptId);
    const [line] = await ctx.db.select().from(alert)
      .where(and(eq(alert.key, `payments.awaiting_staff:${branchId}`), isNull(alert.resolvedAt)));
    expect(line).toMatchObject({ subject: 'Card payments waiting for staff', severity: 'warning' });

    // A person answers, and the next sweep stops counting it.
    const confirmed = await ctx.app.inject({
      method: 'POST', url: `/payments/attempts/${held.attemptId}/confirm`, headers: { cookie },
      payload: { took: false, note: 'Nothing on the terminal' },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    await flagPendingPayments(ctx.db, ctx.app.env, later(), ctx.app.log);
    expect(await listed(`payments.awaiting_staff:${branchId}`)).not.toContain(held.attemptId);
  });
});
