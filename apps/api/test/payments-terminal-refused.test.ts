import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  alert,
  auditLog,
  boxCommand,
  branch,
  device,
  member,
  paymentAttempt,
  refund,
  sale,
  station,
  stationDevice,
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
import { attachInProcessBox, provisionVirtualBox } from '../src/services/box';
import { flagPendingPayments } from '../src/services/payments/gateway';
import { TERMINAL_NOTHING_SENT_CODES, terminalNotSentWords } from '../src/services/payments/terminal';

/**
 * SCRUM-972 — A CARD THE COUNTER'S BOX REFUSES BEFORE IT REACHES THE TERMINAL.
 *
 * Found on staging (SCRUM-952's proof, 13 November): Card pressed fifteen
 * seconds after the terminal was assigned on the Console, before the box had
 * pulled its new set-up. The box refused the `terminal_sale` at once
 * (`TERMINAL_NOT_ON_THIS_BOX`), answering with a result object whose outcome is
 * null, and the attempt stayed `sent_to_terminal` for ever: the read-time
 * recovery only matched a failed command with NO result, and nothing else could
 * move it. The till was held, and the void answered `PAYMENT_IN_FLIGHT`.
 *
 * The first case drives that exact path end to end through the real agent: a
 * terminal the box's bundle does not hold yet. The table cases post the box's
 * own failed answer on the box's own route, in the shape `agent.ts` builds it.
 */

let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let managerCookie: string;
let agent: BoxAgent;
let operatorId: string;
let branchId: string;
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

let stationId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);

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

  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;

  const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
  jamesId = members.find((m) => m.phone === '+66822222222')!.id;

  agent = createBoxAgent({
    apiBaseUrl: 'http://terminal-refused.test',
    credentials: memoryCredentialStore(),
    hostname: 'virtual-terminal-refused-test',
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

async function commitSale(atStationId = stationId): Promise<{ saleId: string; owed: number }> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: {
      id: saleId,
      stationId: atStationId,
      memberId: jamesId,
      lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
      finalise: true,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { saleId, owed: res.json().outstandingSatang as number };
}

async function startTender(saleId: string, extra: Record<string, unknown> = {}) {
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
  const res = await ctx.app.inject({ method: 'GET', url: `/payments/attempts/${id}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    attempt: { status: string; inquirySupported: boolean; reversalPending?: boolean };
    responseText: string | null;
    outstandingSatang: number | null;
  };
}

/** Every `terminal_sale` command this box was given for one attempt. */
async function terminalCommands(attemptId: string) {
  const rows = await ctx.db
    .select()
    .from(boxCommand)
    .where(and(eq(boxCommand.boxId, boxId), eq(boxCommand.kind, 'terminal_sale')));
  return rows.filter((row) => (row.payload as { attemptId?: string } | null)?.attemptId === attemptId);
}

const modeOf = (row: { payload: unknown }) => (row.payload as { mode?: string } | null)?.mode;

async function audits(attemptId: string, action: string) {
  return ctx.db.select().from(auditLog)
    .where(and(eq(auditLog.entityId, attemptId), eq(auditLog.action, action)));
}

async function voidSale(saleId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/void`,
    headers: { cookie },
    payload: { reason: 'Card never reached the terminal' },
  });
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

/** A card tender whose SALE command the box has taken and not answered yet. */
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
 * THE BOX'S FAILED ANSWER, as `agent.ts:4155-4169` builds it for a
 * `terminal_sale`: the terminal module's routing (`terminal/index.ts:353-360`,
 * `routed` is null when the device is not on the box, :346-351) spread into a
 * result whose outcome, reference and response code are all null — the box
 * holds no answer from the terminal, or the command would have been
 * `succeeded`. Three refusals come before the terminal module and carry no
 * result at all: `BOX_OFFLINE` (agent.ts:3906-3910), `TERMINALS_DISABLED`
 * (:4110-4114), `BAD_TENDER` (:4118-4122).
 */
function boxFailure(
  code: string,
  input: { attemptId: string; deviceId: string; protocol?: string; mode?: 'sale' | 'inquire' | 'void' },
): Record<string, unknown> {
  const mode = input.mode ?? 'sale';
  const errorMessage = `the box could not run the exchange (${code})`;
  if (['BOX_OFFLINE', 'TERMINALS_DISABLED', 'BAD_TENDER'].includes(code)) {
    return { state: 'failed', errorCode: code, errorMessage };
  }
  const routed = code === 'TERMINAL_NOT_ON_THIS_BOX'
    ? {}
    : { deviceId: input.deviceId, stationId: null, role: 'card_terminal', protocol: input.protocol ?? 'ghl_linkpos' };
  return {
    state: 'failed',
    result: { attemptId: input.attemptId, mode, ...routed, outcome: null, terminalRef: null, responseCode: null },
    errorCode: code,
    errorMessage,
  };
}

async function reportFailure(commandId: string, body: Record<string, unknown>) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/commands/${commandId}/result`,
    headers: { authorization: `Bearer ${boxCredential}` },
    payload: body,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

// --- The staging case, end to end --------------------------------------------

describe('a card pressed before the box has taken the terminal its counter was just given', () => {
  it('ends the attempt at once, frees the sale, and never sends that SALE again', async () => {
    // A counter on this box with a terminal the box's bundle does not hold yet:
    // assigned "on the Console" after the box last pulled its set-up.
    const newTill = newId();
    const newTerminal = newId();
    await ctx.db.insert(device).values({
      id: newTerminal, operatorId, branchId, boxId, kind: 'terminal',
      label: 'Refused EDC', transport: 'simulated', model: 'NEXGO N5', protocol: 'ghl_linkpos',
    });
    await ctx.db.insert(station).values({
      id: newTill, operatorId, branchId, boxId, kind: 'till', name: 'Refused counter', codePrefix: 'RZ',
    });
    await ctx.db.insert(stationDevice).values({
      id: newId(), stationId: newTill, deviceId: newTerminal, role: 'card_terminal',
    });

    const toVoid = await commitSale(newTill);
    const toRetry = await commitSale(newTill);
    const attempts: string[] = [];
    for (const { saleId } of [toVoid, toRetry]) {
      const started = await startTender(saleId, { actionId: newId() });
      expect(started.statusCode, started.body).toBe(200);
      expect(started.json().attempt.status).toBe('sent_to_terminal');
      attempts.push(started.json().attempt.id as string);
    }
    // The box takes the commands and refuses them itself: the real answer.
    for (let i = 0; i < 10; i += 1) {
      const states = await Promise.all(attempts.map(async (id) => (await terminalCommands(id))[0]!.state));
      if (states.every((state) => state === 'failed')) break;
      await agent.runPendingCommands();
    }

    for (const attemptId of attempts) {
      const [command] = await terminalCommands(attemptId);
      expect(command).toMatchObject({ state: 'failed', errorCode: 'TERMINAL_NOT_ON_THIS_BOX' });
      expect(command!.result).toEqual({
        attemptId, mode: 'sale', outcome: null, terminalRef: null, responseCode: null,
      });
      // Freed in the command's own transaction: no read of the attempt yet.
      const row = await attemptRow(attemptId);
      expect(row.status).toBe('declined');
      expect(row.paidAt).toBeNull();
      const audit = await audits(attemptId, 'payment.attempt.not_sent');
      expect(audit).toHaveLength(1);
      expect(audit[0]!.after).toMatchObject({
        status: 'declined', commandId: command!.id, commandState: 'failed', errorCode: 'TERMINAL_NOT_ON_THIS_BOX',
      });
      const view = await readAttempt(attemptId);
      expect(view.attempt.status).toBe('declined');
      expect(view.responseText).toBe(
        'The card terminal is not ready on this counter yet. Try again in a moment, or take another way to pay.',
      );
    }

    // The first sale can be voided.
    const voided = await voidSale(toVoid.saleId);
    expect(voided.statusCode, voided.body).toBe(200);

    // The second takes a new card once the box has its set-up: one new SALE,
    // and the refused one is never sent again.
    await agent.syncConfig();
    expect((await ctx.app.inject({
      method: 'POST', url: '/payments/terminal-simulator', headers: { cookie: adminCookie },
      payload: { action: 'terminal.outcome', deviceId: newTerminal, outcome: 'approved' },
    })).statusCode).toBe(200);
    const retried = await startTender(toRetry.saleId, { actionId: newId() });
    expect(retried.statusCode, retried.body).toBe(200);
    const retryId = retried.json().attempt.id as string;
    expect(retryId).not.toBe(attempts[1]);
    expect((await terminalCommands(retryId)).filter((row) => modeOf(row) === 'sale')).toHaveLength(1);
    for (let i = 0; i < 10 && (await attemptRow(retryId)).status === 'sent_to_terminal'; i += 1) {
      await agent.runPendingCommands();
    }
    expect((await attemptRow(retryId)).status).toBe('approved');
    for (const attemptId of attempts) {
      expect(await terminalCommands(attemptId)).toHaveLength(1);
      expect((await attemptRow(attemptId)).status).toBe('declined');
    }
    const [retrySale] = await ctx.db.select().from(sale).where(eq(sale.id, toRetry.saleId));
    expect(retrySale!.status).toBe('tendering');
    expect((await readAttempt(retryId)).outstandingSatang).toBe(0);
  }, 120_000);
});

// --- Every code that proves nothing was sent ---------------------------------

/** Written out rather than imported, so a code dropped from the service fails here. */
const NOTHING_SENT: ReadonlyArray<[string, string]> = [
  ['BOX_OFFLINE', 'This counter’s box is offline, so the card terminal was not asked. Take another way to pay, or try again when the box is back online.'],
  ['TERMINALS_DISABLED', 'The card terminal on this counter is not set up to take payments, so it was not asked. Take another way to pay, and ask a manager to check the terminal.'],
  ['BAD_TENDER', 'The card terminal could not be asked for this payment, so nothing was charged. Try again, or take another way to pay.'],
  ['TERMINAL_NOT_ON_THIS_BOX', 'The card terminal is not ready on this counter yet. Try again in a moment, or take another way to pay.'],
  ['DEVICE_NO_ADDRESS', 'The card terminal on this counter is not set up to take payments, so it was not asked. Take another way to pay, and ask a manager to check the terminal.'],
  ['TERMINAL_NO_SERIAL_DRIVER', 'The card terminal on this counter is not set up to take payments, so it was not asked. Take another way to pay, and ask a manager to check the terminal.'],
  ['TERMINAL_NOT_CONFIGURED', 'The card terminal on this counter is not set up to take payments, so it was not asked. Take another way to pay, and ask a manager to check the terminal.'],
  ['TERMINAL_BAD_REQUEST', 'The card terminal could not be asked for this payment, so nothing was charged. Try again, or take another way to pay.'],
];

describe('every failed SALE whose code proves nothing reached the terminal', () => {
  it('the service names exactly these codes', () => {
    expect([...TERMINAL_NOTHING_SENT_CODES].sort()).toEqual(NOTHING_SENT.map(([code]) => code).sort());
    for (const code of ['TERMINAL_UNREACHABLE', 'TERMINAL_WRITE_FAILED', 'TERMINAL_BAD_FRAME', 'NEW_CODE', '', null, undefined]) {
      expect(terminalNotSentWords(code)).toBeNull();
    }
  });

  it.each(NOTHING_SENT)('%s ends the attempt declined with its reason, and the sale can be voided', async (code, words) => {
    const held = await claimedTender();
    await reportFailure(held.command.id, boxFailure(code, { attemptId: held.attemptId, deviceId: cardDeviceId }));

    const row = await attemptRow(held.attemptId);
    expect(row.status).toBe('declined');
    expect(row.paidAt).toBeNull();
    expect((row.payload as { notSent?: { errorCode?: string } }).notSent?.errorCode).toBe(code);
    const view = await readAttempt(held.attemptId);
    expect(view.responseText).toBe(words);
    expect(view.outstandingSatang).toBe(held.owed);
    expect(await audits(held.attemptId, 'payment.attempt.not_sent')).toHaveLength(1);
    expect(await audits(held.attemptId, 'payment.attempt.result_missing')).toHaveLength(0);
    // The command keeps the box's own words.
    expect((await terminalCommands(held.attemptId))[0]).toMatchObject({ state: 'failed', errorCode: code });

    const voided = await voidSale(held.saleId);
    expect(voided.statusCode, voided.body).toBe(200);
    expect(await terminalCommands(held.attemptId)).toHaveLength(1);
  });
});

// --- A failed SALE that may have reached the terminal --------------------------

describe('a failed SALE whose code does not prove nothing was sent', () => {
  it.each(['TERMINAL_UNREACHABLE', 'TERMINAL_WRITE_FAILED', 'TERMINAL_BAD_FRAME', 'SOMETHING_NEW'])(
    '%s with no outcome goes to a person, and no second SALE is ever queued',
    async (code) => {
      const held = await claimedTender();
      await reportFailure(held.command.id, boxFailure(code, { attemptId: held.attemptId, deviceId: cardDeviceId }));

      // A GHL card has no inquiry: a person reads the terminal.
      expect((await attemptRow(held.attemptId)).status).toBe('awaiting_staff_confirmation');
      const views = await Promise.all([readAttempt(held.attemptId), readAttempt(held.attemptId)]);
      for (const view of views) {
        expect(view.attempt.status).toBe('awaiting_staff_confirmation');
        expect(view.outstandingSatang).toBe(held.owed);
      }
      const missing = await audits(held.attemptId, 'payment.attempt.result_missing');
      expect(missing).toHaveLength(1);
      expect(missing[0]!.after).toMatchObject({ commandState: 'failed', errorCode: code });
      expect(await audits(held.attemptId, 'payment.attempt.not_sent')).toHaveLength(0);

      const blocked = await voidSale(held.saleId);
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.code).toBe('PAYMENT_IN_FLIGHT');
      const cash = await ctx.app.inject({
        method: 'POST', url: `/sales/${held.saleId}/finalise`, headers: { cookie },
        payload: { method: 'cash', kind: 'cash', actionId: newId() },
      });
      expect(cash.statusCode).toBe(409);
      expect(cash.json().error.code).toBe('PAYMENT_IN_FLIGHT');
      await agent.runPendingCommands();
      const commands = await terminalCommands(held.attemptId);
      expect(commands).toHaveLength(1);
      expect(commands.filter((row) => modeOf(row) === 'sale')).toHaveLength(1);
    },
  );

  it('a terminal that can be asked again goes to unknown instead', async () => {
    const held = await claimedTender('qr');
    await ctx.db.update(paymentAttempt).set({ terminalRef: '972001' }).where(eq(paymentAttempt.id, held.attemptId));
    await reportFailure(held.command.id, boxFailure('TERMINAL_UNREACHABLE', {
      attemptId: held.attemptId, deviceId: qrDeviceId, protocol: 'digio_tlv',
    }));
    const view = await readAttempt(held.attemptId);
    expect(view.attempt).toMatchObject({ status: 'unknown', inquirySupported: true });
    expect((await terminalCommands(held.attemptId)).filter((row) => modeOf(row) === 'sale')).toHaveLength(1);
  });
});

// --- An attempt already held when this lands ---------------------------------

describe('an attempt held before this fix, freed by an ordinary read', () => {
  it('a failed command with the box’s result object, written before the fix, is freed by GET /payments/attempts/:id', async () => {
    const held = await claimedTender();
    // What staging holds: the command recorded failed by the old code, the
    // attempt left behind at sent_to_terminal.
    const failure = boxFailure('TERMINAL_NOT_ON_THIS_BOX', { attemptId: held.attemptId, deviceId: cardDeviceId });
    await ctx.db.update(boxCommand).set({
      state: 'failed', finishedAt: new Date(), result: failure.result as never,
      errorCode: 'TERMINAL_NOT_ON_THIS_BOX', errorMessage: 'this box has no card_terminal for a station',
    }).where(eq(boxCommand.id, held.command.id));
    expect((await attemptRow(held.attemptId)).status).toBe('sent_to_terminal');

    const view = await readAttempt(held.attemptId);
    expect(view.attempt.status).toBe('declined');
    expect(view.responseText).toBe(
      'The card terminal is not ready on this counter yet. Try again in a moment, or take another way to pay.',
    );
    expect(await audits(held.attemptId, 'payment.attempt.not_sent')).toHaveLength(1);
    // A second read changes nothing.
    await readAttempt(held.attemptId);
    expect(await audits(held.attemptId, 'payment.attempt.not_sent')).toHaveLength(1);
    const voided = await voidSale(held.saleId);
    expect(voided.statusCode, voided.body).toBe(200);
  });

  it('a SALE command that expired in the queue was never run, and frees its sale', async () => {
    const committed = await commitSale();
    const started = await startTender(committed.saleId);
    expect(started.statusCode, started.body).toBe(200);
    const attemptId = started.json().attempt.id as string;
    const [command] = await terminalCommands(attemptId);
    // Still queued (the box never came for it), and out of time.
    await ctx.db.update(boxCommand).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(boxCommand.id, command!.id));

    const view = await readAttempt(attemptId);
    expect(view.attempt.status).toBe('declined');
    expect(view.responseText).toBe(
      'This counter’s box did not pick up the card payment in time, so the terminal was never asked. Try again, or take another way to pay.',
    );
    expect((await terminalCommands(attemptId))[0]).toMatchObject({ state: 'expired', attempts: 0 });
    const audit = await audits(attemptId, 'payment.attempt.not_sent');
    expect(audit[0]!.after).toMatchObject({ errorCode: 'BOX_COMMAND_EXPIRED', commandState: 'expired' });
    // The box's next poll cannot hand it out.
    await agent.runPendingCommands();
    expect((await terminalCommands(attemptId))[0]!.state).toBe('expired');
    expect((await voidSale(committed.saleId)).statusCode).toBe(200);
  });
});

// --- What is left alone ------------------------------------------------------

describe('commands that are still the terminal’s business', () => {
  it('a running SALE inside its time budget is left alone', async () => {
    const held = await claimedTender();
    const view = await readAttempt(held.attemptId);
    expect(view.attempt.status).toBe('sent_to_terminal');
    expect((await terminalCommands(held.attemptId))[0]).toMatchObject({ state: 'running', errorCode: null });
    expect(await audits(held.attemptId, 'payment.attempt.not_sent')).toHaveLength(0);
    expect(await audits(held.attemptId, 'payment.attempt.result_missing')).toHaveLength(0);
  });

  it('a succeeded SALE with a result is untouched, however long ago it ended', async () => {
    const held = await claimedTender();
    const acked = await ctx.app.inject({
      method: 'POST', url: `/box/v1/commands/${held.command.id}/result`,
      headers: { authorization: `Bearer ${boxCredential}` },
      payload: { state: 'succeeded', result: {
        attemptId: held.attemptId, mode: 'sale', deviceId: cardDeviceId, stationId: null,
        role: 'card_terminal', protocol: 'ghl_linkpos', outcome: 'approved', terminalRef: '261113970001', responseCode: '00',
      } },
    });
    expect(acked.statusCode, acked.body).toBe(200);
    await ctx.db.update(boxCommand).set({ claimedAt: new Date(Date.now() - 600_000) })
      .where(eq(boxCommand.id, held.command.id));
    const view = await readAttempt(held.attemptId);
    expect(view.attempt.status).toBe('sent_to_terminal');
    expect(await audits(held.attemptId, 'payment.attempt.not_sent')).toHaveLength(0);
    expect(await audits(held.attemptId, 'payment.attempt.result_missing')).toHaveLength(0);
    expect((await terminalCommands(held.attemptId))[0]).toMatchObject({ state: 'succeeded', errorCode: null });
  });
});

// --- The inquiry that never answers ------------------------------------------

describe('an inquiry command the box could not finish', () => {
  async function inquiringTender() {
    const { saleId } = await commitSale();
    // Digio's host timeout: the attempt goes to `inquiring` and a T2 is queued.
    expect((await ctx.app.inject({
      method: 'POST', url: '/payments/terminal-simulator', headers: { cookie: adminCookie },
      payload: { action: 'terminal.outcome', deviceId: qrDeviceId, outcome: 'timeout' },
    })).statusCode).toBe(200);
    const started = await startTender(saleId, { tender: 'qr', method: 'promptpay' });
    expect(started.statusCode, started.body).toBe(200);
    const attemptId = started.json().attempt.id as string;
    for (let i = 0; i < 10 && (await attemptRow(attemptId)).status === 'sent_to_terminal'; i += 1) {
      await agent.runPendingCommands();
    }
    expect((await attemptRow(attemptId)).status).toBe('inquiring');
    const inquiry = (await terminalCommands(attemptId)).find((row) => modeOf(row) === 'inquire')!;
    await claim(inquiry.id);
    return { saleId, attemptId, inquiry };
  }

  it('hands the attempt back to a person when the inquiry fails, and queues no SALE', async () => {
    const held = await inquiringTender();
    await reportFailure(held.inquiry.id, boxFailure('TERMINAL_UNREACHABLE', {
      attemptId: held.attemptId, deviceId: qrDeviceId, protocol: 'digio_tlv', mode: 'inquire',
    }));
    const row = await attemptRow(held.attemptId);
    expect(row.status).toBe('awaiting_staff_confirmation');
    const missing = await audits(held.attemptId, 'payment.attempt.result_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.after).toMatchObject({ mode: 'inquire', commandState: 'failed', errorCode: 'TERMINAL_UNREACHABLE' });
    const commands = await terminalCommands(held.attemptId);
    expect(commands.filter((c) => modeOf(c) === 'sale')).toHaveLength(1);
    expect(commands.filter((c) => modeOf(c) === 'inquire')).toHaveLength(1);
    // A person may ask again, or answer.
    const asked = await ctx.app.inject({
      method: 'POST', url: `/payments/attempts/${held.attemptId}/inquire`, headers: { cookie },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json().attempt.status).toBe('inquiring');
  });

  it('an inquiry still running past its budget is handed back on a read', async () => {
    const held = await inquiringTender();
    expect((await readAttempt(held.attemptId)).attempt.status).toBe('inquiring');
    await ctx.db.update(boxCommand).set({ claimedAt: new Date(Date.now() - 160_000) })
      .where(eq(boxCommand.id, held.inquiry.id));
    expect((await readAttempt(held.attemptId)).attempt.status).toBe('awaiting_staff_confirmation');
    expect((await terminalCommands(held.attemptId)).find((c) => c.id === held.inquiry.id))
      .toMatchObject({ state: 'running', errorCode: 'TERMINAL_RESULT_MISSING' });
  });
});

// --- Health ------------------------------------------------------------------

describe('the Health alert for payments waiting more than ten minutes', () => {
  it('stops counting an attempt once the box’s refusal has ended it', async () => {
    const held = await claimedTender();
    const later = () => new Date(Date.now() + 11 * 60_000);
    const listed = async () => {
      const [row] = await ctx.db.select().from(alert)
        .where(and(eq(alert.key, `payments.pending:${branchId}`), isNull(alert.resolvedAt)));
      const ids = row ? ((row.detail as { attemptIds?: string[] } | null)?.attemptIds ?? []) : [];
      return ids.includes(held.attemptId);
    };
    await flagPendingPayments(ctx.db, ctx.app.env, later());
    expect(await listed()).toBe(true);

    await reportFailure(held.command.id, boxFailure('TERMINAL_NOT_ON_THIS_BOX', {
      attemptId: held.attemptId, deviceId: cardDeviceId,
    }));
    await flagPendingPayments(ctx.db, ctx.app.env, later());
    expect(await listed()).toBe(false);
  });
});

// --- A VOID the box could not send -------------------------------------------

const VOID_NOT_SENT_DETAIL = 'The box could not send the void to the terminal — hand it back in cash';

async function setOutcome(deviceId: string, body: Record<string, unknown>) {
  const res = await ctx.app.inject({
    method: 'POST', url: '/payments/terminal-simulator', headers: { cookie: adminCookie },
    payload: { action: 'terminal.outcome', deviceId, ...body },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/**
 * A whole card tender taken on EDC 1, the sale closed, then refunded whole: a
 * VOID is queued. The tender is written as `sales-printing.test.ts` writes it,
 * rather than run through the box, to keep this file under the box's own
 * request ceiling (`BOX_RATE_LIMIT_MAX`, 240 a minute).
 */
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
  const closed = await ctx.app.inject({
    method: 'POST', url: `/sales/${committed.saleId}/finalise`, headers: { cookie }, payload: {},
  });
  expect(closed.statusCode, closed.body).toBe(200);
  const refunded = await ctx.app.inject({
    method: 'POST', url: `/sales/${committed.saleId}/refunds`, headers: { cookie: managerCookie },
    payload: { mode: 'whole', reason: 'Charged twice', actionId: newId() },
  });
  expect(refunded.statusCode, refunded.body).toBe(200);
  const refundId = refunded.json().refund.id as string;
  const [slice] = refunded.json().refund.tenderAllocation as Array<{ actionId: string }>;
  expect(slice).toMatchObject({
    attemptId, route: 'terminal_void', status: 'pending', detail: 'Void sent to the terminal',
  });
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

describe('a refund’s VOID the box proves it never sent', () => {
  it.each([...NOTHING_SENT.map(([code]) => code)])(
    '%s: the slice falls back to cash, audited, and no second VOID is queued',
    async (code) => {
      const held = await refundedCardSale();
      await claim(held.voidCommand.id);
      await reportFailure(held.voidCommand.id, boxFailure(code, {
        attemptId: held.attemptId, deviceId: cardDeviceId, mode: 'void',
      }));

      // Settled in the command's own transaction: nobody has read anything yet.
      expect(await refundSlice(held.refundId)).toMatchObject({
        route: 'terminal_void', status: 'failed', fallback: 'cash', detail: VOID_NOT_SENT_DETAIL,
      });
      const refused = await audits(held.refundId, 'refund.void_refused');
      expect(refused).toHaveLength(1);
      expect(refused[0]!.after).toMatchObject({ slice: { status: 'failed', fallback: 'cash' }, saleId: held.saleId });
      const notSent = await audits(held.attemptId, 'payment.attempt.void_not_sent');
      expect(notSent).toHaveLength(1);
      expect(notSent[0]!.after).toMatchObject({
        reason: 'refund', errorCode: code, commandId: held.voidCommand.id, commandState: 'failed',
        voidActionId: held.voidActionId,
      });
      // The attempt is still the money that was taken.
      const row = await attemptRow(held.attemptId);
      expect(row.status).toBe('approved');
      expect((row.payload as { void?: { result?: unknown } }).void?.result).toMatchObject({
        outcome: 'not_sent', errorCode: code, commandId: held.voidCommand.id,
      });

      // A read and a box poll change nothing: one VOID, one audit.
      await readAttempt(held.attemptId);
      await agent.runPendingCommands();
      expect(await voidCommandsOf(held.attemptId)).toHaveLength(1);
      expect(await audits(held.attemptId, 'payment.attempt.void_not_sent')).toHaveLength(1);
      expect(await audits(held.refundId, 'refund.void_refused')).toHaveLength(1);
    },
  );
});

describe('a refund’s VOID that may have reached the terminal', () => {
  it.each(['TERMINAL_UNREACHABLE', 'TERMINAL_WRITE_FAILED', 'TERMINAL_BAD_FRAME', 'SOMETHING_NEW'])(
    '%s leaves the slice pending for a person and queues no second VOID',
    async (code) => {
      const held = await refundedCardSale();
      await claim(held.voidCommand.id);
      await reportFailure(held.voidCommand.id, boxFailure(code, {
        attemptId: held.attemptId, deviceId: cardDeviceId, mode: 'void',
      }));
      await readAttempt(held.attemptId);
      await agent.runPendingCommands();

      expect(await refundSlice(held.refundId)).toMatchObject({
        route: 'terminal_void', status: 'pending', detail: 'Void sent to the terminal',
      });
      expect(await audits(held.refundId, 'refund.void_refused')).toHaveLength(0);
      expect(await audits(held.attemptId, 'payment.attempt.void_not_sent')).toHaveLength(0);
      expect((await attemptRow(held.attemptId)).payload).not.toHaveProperty('void.result');
      expect(await voidCommandsOf(held.attemptId)).toHaveLength(1);
    },
  );

  it('a VOID still running, however long, is left alone', async () => {
    const held = await refundedCardSale();
    await claim(held.voidCommand.id);
    await ctx.db.update(boxCommand).set({ claimedAt: new Date(Date.now() - 600_000) })
      .where(eq(boxCommand.id, held.voidCommand.id));
    await readAttempt(held.attemptId);
    expect(await refundSlice(held.refundId)).toMatchObject({ status: 'pending' });
    expect((await voidCommandsOf(held.attemptId))[0]).toMatchObject({ state: 'running', errorCode: null });
    expect(await audits(held.attemptId, 'payment.attempt.void_not_sent')).toHaveLength(0);
  });
});

describe('a refund’s VOID already held when this lands, freed by an ordinary read', () => {
  it('a failed VOID with the box’s result object is settled by GET /payments/attempts/:id', async () => {
    const held = await refundedCardSale();
    // What the old code left: the command failed, the slice still pending.
    const failure = boxFailure('TERMINAL_NOT_CONFIGURED', {
      attemptId: held.attemptId, deviceId: cardDeviceId, mode: 'void',
    });
    await ctx.db.update(boxCommand).set({
      state: 'failed', finishedAt: new Date(), result: failure.result as never,
      errorCode: 'TERMINAL_NOT_CONFIGURED', errorMessage: 'this box has no void password configured',
    }).where(eq(boxCommand.id, held.voidCommand.id));
    expect(await refundSlice(held.refundId)).toMatchObject({ status: 'pending' });

    await readAttempt(held.attemptId);
    expect(await refundSlice(held.refundId)).toMatchObject({
      status: 'failed', fallback: 'cash', detail: VOID_NOT_SENT_DETAIL,
    });
    await readAttempt(held.attemptId);
    expect(await audits(held.refundId, 'refund.void_refused')).toHaveLength(1);
    expect(await audits(held.attemptId, 'payment.attempt.void_not_sent')).toHaveLength(1);
  });

  it('a VOID that expired in the queue was never run: the slice falls back to cash on a read', async () => {
    const held = await refundedCardSale();
    await ctx.db.update(boxCommand).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(boxCommand.id, held.voidCommand.id));
    await readAttempt(held.attemptId);
    expect(await refundSlice(held.refundId)).toMatchObject({
      status: 'failed', fallback: 'cash', detail: VOID_NOT_SENT_DETAIL,
    });
    expect((await voidCommandsOf(held.attemptId))[0]).toMatchObject({ state: 'expired', attempts: 0 });
    expect((await audits(held.attemptId, 'payment.attempt.void_not_sent'))[0]!.after)
      .toMatchObject({ errorCode: 'BOX_COMMAND_EXPIRED', commandState: 'expired' });
    await agent.runPendingCommands();
    expect((await voidCommandsOf(held.attemptId))[0]!.state).toBe('expired');
  });
});

describe('a partial approval whose rescue VOID the box cannot send', () => {
  it('records why on the attempt, keeps the charge reserved, and never sends the VOID again', async () => {
    const committed = await commitSale();
    // EDC 3 speaks Digio; this box has no Digio void password, so the box
    // itself refuses the rescue (digio.ts:908-913) — the staging case.
    await setOutcome(qrDeviceId, { outcome: 'partial', approvedSatang: committed.owed - 100 });
    const started = await startTender(committed.saleId, { tender: 'qr', method: 'promptpay', actionId: newId() });
    expect(started.statusCode, started.body).toBe(200);
    const attemptId = started.json().attempt.id as string;
    for (let i = 0; i < 10; i += 1) {
      const [rescue] = await voidCommandsOf(attemptId);
      if (rescue && !['queued', 'running'].includes(rescue.state)) break;
      await agent.runPendingCommands();
    }
    const [rescue] = await voidCommandsOf(attemptId);
    expect(rescue).toMatchObject({ state: 'failed', errorCode: 'TERMINAL_NOT_CONFIGURED' });
    expect(rescue!.result).toMatchObject({
      attemptId, mode: 'void', deviceId: qrDeviceId, outcome: null, terminalRef: null, responseCode: null,
    });

    const row = await attemptRow(attemptId);
    expect(row.status).toBe('declined');
    expect((row.payload as { void?: { reason?: string; result?: unknown } }).void).toMatchObject({
      reason: 'partial_approval',
      result: { outcome: 'not_sent', errorCode: 'TERMINAL_NOT_CONFIGURED', commandId: rescue!.id },
    });
    const notSent = await audits(attemptId, 'payment.attempt.void_not_sent');
    expect(notSent).toHaveLength(1);
    expect(notSent[0]!.after).toMatchObject({
      reason: 'partial_approval', errorCode: 'TERMINAL_NOT_CONFIGURED', amountSatang: committed.owed - 100,
    });

    // The money rule: the partial charge is still on the guest, so the sale is
    // not silently freed.
    expect((await readAttempt(attemptId)).attempt.reversalPending).toBe(true);
    const blocked = await voidSale(committed.saleId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('PAYMENT_IN_FLIGHT');
    await agent.runPendingCommands();
    expect(await voidCommandsOf(attemptId)).toHaveLength(1);
    expect((await terminalCommands(attemptId)).filter((c) => modeOf(c) === 'sale')).toHaveLength(1);
    expect(await audits(attemptId, 'payment.attempt.void_not_sent')).toHaveLength(1);
  });
});
