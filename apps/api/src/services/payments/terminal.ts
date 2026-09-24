import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  box,
  boxCommand,
  device,
  paymentAttempt,
  sale,
  station,
  stationDevice,
  type Db,
  type PaymentProvider,
} from '@oto/db';
import {
  PaymentRoutingSchema,
  newId,
  projectAttemptPayload,
  type PaymentAttemptStatus,
  type PaymentAttemptView,
} from '@oto/shared';
import {
  roleForTender,
  terminalProtocolOf,
  type TerminalOutcomeKind,
  type TerminalProtocol,
  type TerminalTender,
} from '@oto/box-agent';
import { AppError, errors } from '../../lib/errors';
import { audit } from '../audit';
import { boxSettings } from '../box';
import { recordRun } from '../ops';
import { assertSaleVouchersHeld } from '../vouchers';
import {
  attemptView,
  failAttempt,
  findAttemptByAction,
  openAttempt,
  outstandingAfter,
  settleAttempt,
  tenderMethodOf,
} from './attempt';
import type { Exec, OpContext, Tx } from '../tx';

/**
 * THE CARD TENDER, IN THE CLOUD (S2-10a, SCRUM-206, Slice C2).
 *
 * Slice C1 built the two dialects and their simulators inside
 * `packages/box-agent`; Slice B built the one writer of `pos.payment_attempt`.
 * This file is what sits between them: it decides WHICH terminal a press of
 * Card goes to, writes the instruction the box will find on its next poll,
 * reads back what the terminal said, and turns that into a row in the ledger.
 *
 * FOUR FACTS SHAPE EVERY DECISION HERE, and none of them is a preference.
 *
 *  1. **A tender takes up to two minutes and the answer comes back its own
 *     way.** The customer-interaction budget is 120 seconds
 *     (`DEVICE_INVENTORY.md:948`) and a command poll is five
 *     (`packages/box-agent/src/agent.ts`), so the instruction is a queued
 *     `edge.box_command` and the outcome arrives on
 *     `POST /payments/attempts/:id/result` — exactly as a print job's does
 *     (`services/print.ts`, `recordPrintJobResult`). Nothing in this file holds
 *     an HTTP call open waiting for a guest to find a card.
 *  2. **"No answer" is not "declined".** A terminal that says nothing may
 *     still have taken the money. Recording that as a decline is how a guest
 *     gets charged twice, so it is recorded as `unknown` and the inquiry rule
 *     runs: `T2` on Digio, `QUERY` on a GHL wallet — and on a GHL CARD there
 *     is no query at all (vendor PDF p.13), which is why the audited
 *     staff-confirmation dialog is that terminal's permanent state rather than
 *     a degraded one.
 *  3. **An approval for less than was asked is refused and voided.** The
 *     platform has no way to take the difference, and a guest charged ฿500 for
 *     a ฿1,000 sale with the till showing "paid" is the failure the branch
 *     exists to prevent. The comparison is on INTEGERS after the round-trip,
 *     never on the strings the two vendors send (`100.25` on GHL, ASCII satang
 *     on Digio).
 *  4. **The raw frame never arrives here and never would be kept if it did.**
 *     The parsers on the box reduce a masked PAN to `last4` and drop the
 *     cardholder's name; `ATTEMPT_ALLOW_LIST` is the second net, applied to
 *     whatever the box posts before any of it is stored; and `ops_run.detail`
 *     is built from a fixed key set rather than from the body.
 *
 * WHY THE FOLLOW-UP COMMANDS ARE WRITTEN INSIDE THE TRANSACTION, which is a
 * deliberate departure from `payments/drawer.ts`. The drawer is queued through
 * `queueCommand` AFTER the sale commits, because that helper opens a
 * transaction of its own and would commit an instruction for money that might
 * yet roll back. A command row written with the CALLER's handle has no such
 * problem: it is invisible to the box's poll until the same commit that
 * records the attempt. So an attempt that says `inquiring` and an inquiry that
 * was never queued cannot exist here — they are one write.
 */

// --- What the box reports ----------------------------------------------------

/**
 * One stage of a terminal exchange, as `agent.ts`'s `terminalResultBody` and
 * `terminalProgressBody` send it.
 *
 * Not a copy of `TerminalResult`: this is the WIRE, and a wire is validated
 * rather than trusted. Unknown keys are dropped by zod at the route, which is
 * the first of the three nets keeping a raw frame out of the database.
 */
export interface TerminalFinalReport {
  deviceId?: string | null;
  protocol?: string | null;
  outcome: TerminalOutcomeKind;
  requestedSatang?: number | null;
  approvedSatang?: number | null;
  terminalRef?: string | null;
  tranRef?: string | null;
  invoiceNo?: string | null;
  approvalCode?: string | null;
  last4?: string | null;
  tid?: string | null;
  mid?: string | null;
  qrPayload?: string | null;
  responseCode?: string | null;
  responseText?: string | null;
  elapsedMs?: number | null;
  at?: string | null;
}

export interface TerminalProgressReport {
  kind: 'sent' | 'qr_payload';
  deviceId?: string | null;
  qrPayload?: string | null;
  tranRef?: string | null;
  at?: string | null;
}

/** Which of the three exchanges an incoming result is about. */
export type TerminalPhase = 'sale' | 'inquire' | 'void';

/**
 * What lives in `payment_attempt.payload` for a terminal tender.
 *
 * `terminal` is the adapter's answer after `projectAttemptPayload` and holds
 * exactly the seven allow-listed keys. `exchange` is the PLATFORM's reading of
 * the same answer — which branch it took and what the vendor called it — and
 * carries nothing off the instrument. Keeping them apart is what lets the
 * redaction test assert the first without arguing about the second.
 */
interface AttemptPayload {
  takenByAccountId?: string;
  actionId?: string;
  kind?: string;
  protocol?: string;
  deviceLabel?: string;
  tender?: TerminalTender;
  wallet?: string | null;
  terminal?: Record<string, unknown>;
  exchange?: Record<string, unknown>;
  void?: Record<string, unknown>;
  inquiry?: Record<string, unknown>;
  staffConfirmation?: Record<string, unknown>;
  manual?: Record<string, unknown>;
  [key: string]: unknown;
}

// --- Vocabulary --------------------------------------------------------------

/** Every status a further answer can still move an attempt out of. */
const IN_FLIGHT: readonly PaymentAttemptStatus[] = [
  'created',
  'sent_to_terminal',
  'unknown',
  'inquiring',
];

/**
 * Who answered, which is not the same question as which dialect was spoken.
 *
 * A device whose transport is `simulated` is answered by the simulator on the
 * box — the same bytes, nothing on the other end of the cable — and the ledger
 * says so rather than claiming GHL took the money. The dialect is kept beside
 * it in `payload.protocol`, so a reconciliation can still tell a NEXGO
 * rehearsal from a PAX one.
 */
function providerFor(row: { transport: string | null; protocol: string | null }): PaymentProvider {
  if (row.transport === 'simulated') return 'simulator';
  return row.protocol === 'digio_tlv' ? 'digio' : 'ghl';
}

/**
 * Can this terminal be asked what happened to a transaction it never answered
 * about?
 *
 * Digio has `T2` for everything. GHL has `QUERY` for wallets and Thai QR and
 * NOTHING for a card (vendor PDF p.13, and `ghl.ts`'s `inquire` refuses one
 * before a byte goes out). That single vendor sentence is the whole reason the
 * audited staff-confirmation path exists, and it is permanent for that
 * terminal rather than a fallback somebody will fix later.
 */
export function canInquire(protocol: TerminalProtocol, tender: TerminalTender): boolean {
  return protocol === 'digio_tlv' || tender !== 'card';
}

/** The tender's default token when the till names none, by what it is buying with. */
const DEFAULT_TOKEN: Record<TerminalTender, string> = {
  card: 'card',
  qr: 'promptpay',
  wallet: 'promptpay',
};

// --- Reading an attempt ------------------------------------------------------

export interface LoadedAttempt {
  attempt: typeof paymentAttempt.$inferSelect;
  device: typeof device.$inferSelect | null;
}

/**
 * The attempt, inside the caller's operator.
 *
 * Scoped like every other by-id loader in this codebase: an id belonging to
 * another tenant is "not found" rather than "not allowed", so a refusal cannot
 * be used to confirm that somebody else's attempt exists.
 */
export async function loadAttempt(
  db: Exec,
  operatorId: string,
  id: string,
): Promise<typeof paymentAttempt.$inferSelect> {
  const [row] = await db
    .select()
    .from(paymentAttempt)
    .where(and(eq(paymentAttempt.id, id), eq(paymentAttempt.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('No such payment attempt');
  return row;
}

/**
 * The attempt as THIS BOX may speak about it.
 *
 * A box may only report on an attempt whose terminal is one of its own
 * devices, and an attempt it does not own answers 404 rather than 403 — the
 * rule `recordPrintJobResult` states, for the same reason: an id must not be
 * confirmed by probing.
 */
export async function loadAttemptForBox(
  db: Exec,
  boxAuth: { boxId: string; operatorId: string; branchId: string },
  id: string,
): Promise<LoadedAttempt> {
  const [row] = await db
    .select({ attempt: paymentAttempt, device })
    .from(paymentAttempt)
    .innerJoin(device, eq(paymentAttempt.deviceId, device.id))
    .where(
      and(
        eq(paymentAttempt.id, id),
        eq(paymentAttempt.operatorId, boxAuth.operatorId),
        eq(device.boxId, boxAuth.boxId),
      ),
    )
    .limit(1);
  if (!row) throw errors.notFound('No such payment attempt on this box');
  return { attempt: row.attempt, device: row.device };
}

export interface AttemptReadView {
  attempt: PaymentAttemptView;
  /** The EMVCo payload the display draws, when the terminal minted one. */
  qrPayload: string | null;
  /** The terminal this tender went to, for the screen to name it. */
  deviceLabel: string | null;
  /** What the vendor said, as the till may show it. Never a code on its own. */
  responseText: string | null;
  /** What the sale still owes after this attempt. Null for an attempt with no sale. */
  outstandingSatang: number | null;
}

export async function readAttempt(
  db: Exec,
  operatorId: string,
  id: string,
): Promise<AttemptReadView> {
  const row = await loadAttempt(db, operatorId, id);
  const payload = (row.payload ?? {}) as AttemptPayload;
  let outstandingSatang: number | null = null;
  if (row.saleId) {
    const [saleRow] = await db
      .select({ id: sale.id, grossSatang: sale.grossSatang })
      .from(sale)
      .where(eq(sale.id, row.saleId))
      .limit(1);
    if (saleRow) outstandingSatang = await outstandingAfter(db, saleRow);
  }
  return {
    attempt: attemptView(row),
    qrPayload: row.qrPayload,
    deviceLabel: typeof payload.deviceLabel === 'string' ? payload.deviceLabel : null,
    responseText:
      typeof payload.exchange?.responseText === 'string' ? payload.exchange.responseText : null,
    outstandingSatang,
  };
}

// --- Writing what only this file can write -----------------------------------

/**
 * The fields `payments/attempt.ts` has no verb for.
 *
 * Slice B's file is the one writer for the three states a tender at a counter
 * passes through — open, taken, closed — and its `settleAttempt` and
 * `failAttempt` accept exactly the statuses that mean those things. A terminal
 * on a serial cable has four more: `sent_to_terminal` while a guest is finding
 * a card, `unknown` when nothing came back, `inquiring` while the terminal is
 * being asked, and `awaiting_staff_confirmation` when it cannot be. None of
 * them can go through either function, and `attempt.ts` is Slice B's file.
 *
 * So this is the second writer, deliberately narrow: it never sets a TAKEN
 * status (that is `settleAttempt`'s, so `paid_at` is stamped in one place) and
 * never sets `declined`/`cancelled`/`not_found` (that is `failAttempt`'s). It
 * writes the waiting states and the facts a terminal reports on its way
 * through them. Reported back to Slice B as the gap it is.
 */
async function stampAttempt(
  tx: Tx,
  attemptId: string,
  fields: {
    status?: Extract<
      PaymentAttemptStatus,
      'sent_to_terminal' | 'unknown' | 'inquiring' | 'awaiting_staff_confirmation'
    >;
    terminalRef?: string | null;
    tranRef?: string | null;
    invoiceNo?: string | null;
    tid?: string | null;
    mid?: string | null;
    last4?: string | null;
    approvalCode?: string | null;
    qrPayload?: string | null;
    staffConfirmedByAccountId?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<typeof paymentAttempt.$inferSelect> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) set[key] = value;
  }
  if (Object.keys(set).length === 0) {
    // Nothing the terminal said is worth writing — a decline with no reference
    // on it. Read the row back rather than asking Postgres to set no columns.
    const [held] = await tx
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.id, attemptId))
      .limit(1);
    if (!held) throw new Error('the payment attempt could not be read back');
    return held;
  }
  const [row] = await tx
    .update(paymentAttempt)
    .set(set as never)
    .where(eq(paymentAttempt.id, attemptId))
    .returning();
  if (!row) throw new Error('the payment attempt could not be stamped');
  return row;
}

/**
 * Write one instruction for the box, with the caller's transaction handle.
 *
 * `services/fleet.ts`'s `queueCommand` is the Console's door and opens a
 * transaction of its own; this is the money path's, and it has to commit with
 * the attempt whose state it explains — see the file header. The audit row is
 * written with the same handle for the same reason, and carries the action id
 * so the Box log, the command history and the attempt all answer to one press.
 */
async function queueTerminalCommand(
  tx: Tx,
  input: {
    boxId: string;
    branchId: string;
    operatorId: string;
    actorAccountId: string | null;
    actionId: string;
    requestId?: string;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const id = newId();
  await tx.insert(boxCommand).values({
    id,
    boxId: input.boxId,
    kind: 'terminal_sale',
    payload: input.payload as never,
    requestedByAccountId: input.actorAccountId,
    actionId: input.actionId,
    expiresAt: new Date(Date.now() + boxSettings().commandTtlS * 1000),
  });
  await audit.record(tx, {
    actorAccountId: input.actorAccountId,
    operatorId: input.operatorId,
    branchId: input.branchId,
    action: 'box.command.terminal_sale',
    entityType: 'box',
    entityId: input.boxId,
    actionId: input.actionId,
    requestId: input.requestId,
    after: { commandId: id, kind: 'terminal_sale', payload: input.payload, actionId: input.actionId },
  });
  return id;
}

// --- Starting a tender -------------------------------------------------------

export interface StartTenderInput {
  saleId: string;
  /** Satang this tender should take. Defaults to everything the sale still owes. */
  amountSatang?: number;
  /** What the terminal is being asked for: a card, its own QR, or a wallet. */
  tender?: TerminalTender;
  /** The configured tender's token, for the receipt and the reconciliation. */
  methodCode?: string;
  /** The till's own classification of that token, as the cash path sends it. */
  kind?: string;
  /** The vendor's word for a wallet — `ALIPAY`, `WECHATPAY`, `THAIQRCODE`. */
  wallet?: string | null;
  /** Our display drawing the code, or staff reading the guest's phone. */
  qrDirection?: 'show' | 'scan';
  /** Ask the terminal to hand the payload back so OUR display draws it (Digio). */
  requestQrPayload?: boolean;
  /** Who is at the till, as the terminal stamps it. */
  cashier?: string | null;
  actionId?: string | null;
}

export interface StartTenderResult {
  /**
   * `card_terminal` when the instruction is with the box; `manual` when this
   * station takes card by having staff key the approval code in, in which case
   * no attempt is opened and nothing was asked of any device.
   */
  route: 'card_terminal' | 'manual';
  attempt: PaymentAttemptView | null;
  /** True when this press had already been recorded and this call wrote nothing. */
  replayed: boolean;
  /** What the sale still owes. The till needs it to know whether a split is under way. */
  outstandingSatang: number;
}

export interface TenderActor {
  accountId: string;
  operatorId: string;
  requestId?: string;
  assertBranchAllowed: (branchId: string) => Promise<void>;
}

/**
 * Press Card: open the attempt, and give the box the instruction.
 *
 * Both halves in one transaction. An attempt with no command is a till waiting
 * for a terminal nobody asked; a command with no attempt is a guest charged
 * against a row that does not exist.
 */
export async function startTerminalTender(
  tx: Tx,
  actor: TenderActor,
  input: StartTenderInput,
): Promise<StartTenderResult> {
  const [saleRow] = await tx
    .select()
    .from(sale)
    .where(eq(sale.id, input.saleId))
    .for('update')
    .limit(1);
  if (!saleRow || saleRow.operatorId !== actor.operatorId) throw errors.notFound('Sale not found');
  await actor.assertBranchAllowed(saleRow.branchId);
  if (saleRow.status !== 'tendering') {
    // `paid`, `finalised`, `voided`, `refunded` — a sale in any of them has
    // either been closed or been taken off the ledger, and neither is a thing
    // to put a guest's card against.
    throw errors.conflict(
      'SALE_CLOSED',
      `This sale is ${saleRow.status} and cannot take another tender`,
    );
  }

  /**
   * PRESSING CARD TWICE. The press is the key, not the sale: the retry of a
   * press that already reached a terminal must find its attempt rather than
   * send a second guest-facing request to the same EDC. The unique index on
   * `(operator_id, action_id)` is the net under the race this read cannot see.
   */
  const already = input.actionId
    ? await findAttemptByAction(tx, actor.operatorId, input.actionId)
    : null;
  if (already) {
    if (already.saleId !== input.saleId) {
      throw errors.conflict(
        'ACTION_ID_REUSED',
        'That action id already recorded a tender against another sale',
        { actionId: input.actionId, saleId: already.saleId },
      );
    }
    return {
      route: 'card_terminal',
      attempt: attemptView(already),
      replayed: true,
      outstandingSatang: await outstandingAfter(tx, saleRow),
    };
  }

  /**
   * S2-10b — THE TENDER GUARD: no card or QR is asked for on a sale priced
   * with a voucher that is no longer held for it (VOUCHER_NOT_HELD), before
   * the attempt is written or the box is told anything. The sale is locked
   * above; `assertSaleVouchersHeld` locks the voucher after it.
   */
  await assertSaleVouchersHeld(
    tx,
    {
      saleId: saleRow.id,
      operatorId: saleRow.operatorId,
      branchId: saleRow.branchId,
      stationId: saleRow.stationId,
    },
    new Date(),
  );

  const owed = await outstandingAfter(tx, saleRow);
  const amountSatang = input.amountSatang ?? owed;
  if (amountSatang <= 0) throw errors.badRequest('A tender has to settle something');
  if (amountSatang > owed) {
    throw errors.badRequest('That tender is more than this sale still owes', {
      amountSatang,
      outstandingSatang: owed,
    });
  }

  const [stationRow] = await tx
    .select()
    .from(station)
    .where(eq(station.id, saleRow.stationId))
    .limit(1);
  if (!stationRow) throw errors.badRequest('This sale names a station that no longer exists');

  const tender: TerminalTender = input.tender ?? 'card';
  const routing = PaymentRoutingSchema.safeParse(stationRow.paymentRouting ?? {});
  /**
   * A STATION THAT HAS NEVER BEEN CONFIGURED USES ITS TERMINAL, for the reason
   * `resolveDrawerKick` gives about the drawer: `payment_routing` is absent on
   * every station the platform has today and the park's counters all have an
   * EDC. `card: 'manual'` is how a station says otherwise, and it is honoured.
   */
  if (tender === 'card' && routing.success && routing.data.card === 'manual') {
    return { route: 'manual', attempt: null, replayed: false, outstandingSatang: owed };
  }

  const role = roleForTender(tender);
  const [routed] = await tx
    .select({ device })
    .from(stationDevice)
    .innerJoin(device, eq(stationDevice.deviceId, device.id))
    .where(
      and(
        eq(stationDevice.stationId, stationRow.id),
        eq(stationDevice.role, role),
        isNull(device.archivedAt),
      ),
    )
    .orderBy(asc(stationDevice.deviceId))
    .limit(1);
  const terminalRow = routed?.device ?? null;
  const protocol = terminalProtocolOf(terminalRow?.protocol);
  if (!terminalRow || !protocol) {
    throw errors.conflict(
      'NO_TERMINAL_FOR_STATION',
      `This counter has no ${role.replace('_', ' ')} assigned, so it cannot take that tender`,
      { stationId: stationRow.id, role },
    );
  }
  if (!terminalRow.boxId) {
    throw errors.conflict(
      'TERMINAL_HAS_NO_BOX',
      `${terminalRow.label} is not plugged into a box, so nothing can reach it`,
      { deviceId: terminalRow.id },
    );
  }
  const [boxRow] = await tx.select().from(box).where(eq(box.id, terminalRow.boxId)).limit(1);
  if (!boxRow?.registeredAt) {
    throw errors.conflict(
      'BOX_UNCLAIMED',
      'The box this terminal is plugged into has never come online, so it cannot be sent a tender',
      { boxId: terminalRow.boxId },
    );
  }

  const methodCode = input.methodCode ?? DEFAULT_TOKEN[tender];
  const method = await tenderMethodOf(tx, actor.operatorId, methodCode, input.kind);

  const opened = await openAttempt(tx, {
    operatorId: saleRow.operatorId,
    branchId: saleRow.branchId,
    stationId: saleRow.stationId,
    deviceId: terminalRow.id,
    businessDate: saleRow.businessDate,
    saleId: saleRow.id,
    method,
    methodCode,
    provider: providerFor(terminalRow),
    amountSatang,
    actionId: input.actionId ?? null,
    payload: {
      takenByAccountId: actor.accountId,
      ...(input.actionId ? { actionId: input.actionId } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      protocol,
      deviceLabel: terminalRow.label,
      tender,
      ...(input.wallet ? { wallet: input.wallet } : {}),
    } satisfies AttemptPayload,
  });

  /**
   * TID AND MID ARE FROZEN ONTO THE ROW AT THE MOMENT OF THE TENDER, from the
   * device, because on GHL they are never on the card wire at all (p.8). On
   * Digio they arrive on the frame and are written back onto the device row the
   * first time a terminal answers — see `learnIdentities` below — so the second
   * tender on a PAX has them here too.
   */
  const stamped = await stampAttempt(tx, opened.id, {
    status: 'sent_to_terminal',
    tid: terminalRow.terminalId,
    mid: terminalRow.merchantId,
  });

  const actionId = input.actionId ?? newId();
  await queueTerminalCommand(tx, {
    boxId: terminalRow.boxId,
    branchId: saleRow.branchId,
    operatorId: saleRow.operatorId,
    actorAccountId: actor.accountId,
    actionId,
    requestId: actor.requestId,
    payload: {
      mode: 'sale',
      attemptId: opened.id,
      stationId: stationRow.id,
      deviceId: terminalRow.id,
      role,
      amountSatang,
      tender,
      ...(input.wallet ? { wallet: input.wallet } : {}),
      ...(input.cashier ? { cashier: input.cashier } : {}),
      ...(input.requestQrPayload ? { requestQrPayload: true } : {}),
      ...(input.qrDirection ? { qrDirection: input.qrDirection } : {}),
    },
  });

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: saleRow.operatorId,
    branchId: saleRow.branchId,
    action: 'payment.tender.start',
    entityType: 'payment_attempt',
    entityId: opened.id,
    actionId: input.actionId ?? null,
    requestId: actor.requestId,
    after: {
      saleId: saleRow.id,
      stationId: stationRow.id,
      deviceId: terminalRow.id,
      method,
      methodCode,
      tender,
      amountSatang,
      status: 'sent_to_terminal',
    },
  });

  return {
    route: 'card_terminal',
    attempt: attemptView(stamped),
    replayed: false,
    outstandingSatang: owed,
  };
}

// --- The box's answer --------------------------------------------------------

export interface RecordResultOutput {
  attempt: PaymentAttemptView;
  /** True when the attempt had already settled and this answer changed nothing. */
  replayed: boolean;
  /** Which exchange this answer was about. */
  phase: TerminalPhase;
}

/**
 * Which exchange an incoming result belongs to.
 *
 * The box reports every outcome on one route and its body does not say which
 * of the three it ran — it carries the terminal's answer, not the question. The
 * ACTION ID does say: the void and the inquiry are queued with ids of their
 * own, recorded on the attempt when they are queued, and the box carries the
 * command's id back on `x-oto-action-id` (`agent.ts`'s `reportTerminalResult`).
 * So the phase is read from what this attempt is waiting for rather than
 * guessed from the outcome, which would mis-read a successful void of a partial
 * approval as a second partial approval.
 */
function phaseOf(payload: AttemptPayload, actionId: string | null): TerminalPhase {
  if (!actionId) return 'sale';
  if (payload.void?.actionId === actionId) return 'void';
  if (payload.inquiry?.actionId === actionId) return 'inquire';
  return 'sale';
}

/** The allow-listed projection of what the box said, and nothing else. */
function projectedTerminalPayload(report: TerminalFinalReport): Record<string, unknown> {
  return projectAttemptPayload({
    tid: report.tid,
    mid: report.mid,
    approvalCode: report.approvalCode,
    last4: report.last4,
    amountSatang: report.approvedSatang,
    status: report.outcome,
    invoiceNo: report.invoiceNo,
  });
}

/** The platform's own reading of the exchange. Carries nothing off the instrument. */
function exchangeFacts(
  report: TerminalFinalReport,
  phase: TerminalPhase,
  protocol: TerminalProtocol,
): Record<string, unknown> {
  return {
    mode: phase,
    outcome: report.outcome,
    protocol,
    requestedSatang: report.requestedSatang ?? null,
    approvedSatang: report.approvedSatang ?? null,
    responseCode: report.responseCode ?? null,
    responseText: report.responseText ?? null,
    elapsedMs: report.elapsedMs ?? null,
    at: report.at ?? new Date().toISOString(),
  };
}

/**
 * The identities a PAX learns us.
 *
 * `DEVICE_INVENTORY.md:40-41` — the park's two PAX terminals have no TID or MID
 * on file, and Digio sends both on the frame (tags `13`/`14`). The first
 * terminal that answers therefore teaches the device row, and every tender
 * after it carries them from the row like a GHL one does. Only ever fills a
 * blank: a terminal re-keyed to another merchant is an administrator's decision
 * and not a frame's.
 */
async function learnIdentities(
  tx: Tx,
  ctx: OpContext,
  row: typeof device.$inferSelect,
  report: TerminalFinalReport,
): Promise<void> {
  const tid = row.terminalId ? null : (report.tid ?? null);
  const mid = row.merchantId ? null : (report.mid ?? null);
  if (!tid && !mid) return;
  await tx
    .update(device)
    .set({ ...(tid ? { terminalId: tid } : {}), ...(mid ? { merchantId: mid } : {}) })
    .where(eq(device.id, row.id));
  await audit.record(tx, {
    // The box, not a person: nobody chose this, a terminal reported it.
    actorAccountId: null,
    operatorId: row.operatorId,
    branchId: row.branchId,
    action: 'device.terminal_identity',
    entityType: 'device',
    entityId: row.id,
    requestId: ctx.requestId,
    before: { terminalId: row.terminalId, merchantId: row.merchantId },
    after: { terminalId: tid ?? row.terminalId, merchantId: mid ?? row.merchantId },
  });
}

/**
 * Outcomes that mean somebody has to go and look, as against outcomes that are
 * the machine working correctly.
 *
 * A declined card is a terminal doing its job — the same rule the agent states
 * when it answers `succeeded` for one — so it is an `ok` run with a response
 * code on it. A silence, a host timeout, a partial approval and a dialect that
 * cannot do what was asked all leave money or a guest in an unresolved state,
 * and those are what the Failures page is for.
 */
const FAILING_OUTCOMES: readonly TerminalOutcomeKind[] = [
  'no_response',
  'timeout',
  'partial_approval',
  'unsupported',
];

/**
 * Take what the terminal said and make it a fact in the ledger.
 *
 * Every branch of the acceptance criteria is here, and the order matters: the
 * replay guard comes before anything is written, because the box re-sends an
 * outcome whenever an acknowledgement is lost and a second `approved` must not
 * become a second charge.
 */
export async function recordTerminalResult(
  tx: Tx,
  ctx: OpContext,
  loaded: LoadedAttempt,
  report: TerminalFinalReport,
  actionId: string | null,
): Promise<RecordResultOutput & { run: { name: string; failed: boolean; detail: Record<string, unknown> } }> {
  const [locked] = await tx
    .select()
    .from(paymentAttempt)
    .where(eq(paymentAttempt.id, loaded.attempt.id))
    .for('update')
    .limit(1);
  const current = locked ?? loaded.attempt;
  const payload = (current.payload ?? {}) as AttemptPayload;
  const phase = phaseOf(payload, actionId);
  const deviceRow = loaded.device;
  const protocol =
    terminalProtocolOf(deviceRow?.protocol) ??
    terminalProtocolOf(report.protocol) ??
    'ghl_linkpos';
  const tender = (payload.tender ?? 'card') as TerminalTender;
  const facts = exchangeFacts(report, phase, protocol);
  const run = {
    name:
      report.outcome === 'approved' || !FAILING_OUTCOMES.includes(report.outcome)
        ? `device:terminal.${phase}`
        : `device:terminal.${phase}.${report.outcome}`,
    failed: FAILING_OUTCOMES.includes(report.outcome),
    detail: {
      attemptId: current.id,
      saleId: current.saleId,
      deviceId: current.deviceId,
      stationId: current.stationId,
      protocol,
      mode: phase,
      outcome: report.outcome,
      responseCode: report.responseCode ?? null,
      requestedSatang: report.requestedSatang ?? current.amountSatang,
      approvedSatang: report.approvedSatang ?? null,
      elapsedMs: report.elapsedMs ?? null,
    },
  };

  // --- A void's answer never moves the attempt ------------------------------
  if (phase === 'void') {
    const stamped = await stampAttempt(tx, current.id, {
      payload: {
        ...payload,
        void: { ...(payload.void ?? {}), result: facts },
      },
    });
    return { attempt: attemptView(stamped), replayed: false, phase, run };
  }

  /**
   * THE REPLAY GUARD. An attempt that has reached a state nothing further can
   * move it out of is answered as a replay and nothing is written — a second
   * `approved` for the same tender is the box retrying a lost acknowledgement,
   * not a second guest.
   */
  if (!IN_FLIGHT.includes(current.status)) {
    return { attempt: attemptView(current), replayed: true, phase, run };
  }
  if (phase === 'inquire' && current.status !== 'inquiring') {
    return { attempt: attemptView(current), replayed: true, phase, run };
  }

  if (deviceRow) await learnIdentities(tx, ctx, deviceRow, report);

  const settledPayload: AttemptPayload = {
    ...payload,
    terminal: projectedTerminalPayload(report),
    exchange: facts,
  };

  const approvedSatang = report.approvedSatang ?? null;
  /**
   * THE AMOUNT CHECK, ON INTEGERS, MADE AGAIN HERE.
   *
   * The adapter already reads an approval for the wrong amount as
   * `partial_approval` on a SALE. The cloud compares as well rather than
   * trusting that word, because this is the one comparison whose failure mode
   * is a guest charged for an amount nobody at the counter agreed to — and
   * because an inquiry's `approved` has not been through the adapter's rule at
   * all (an inquiry may be sent with no amount, so it must not be).
   */
  const short =
    report.outcome === 'approved' &&
    approvedSatang !== null &&
    approvedSatang !== current.amountSatang;

  // --- Approved -------------------------------------------------------------
  if (report.outcome === 'approved' && !short) {
    const settled = await settleAttempt(tx, current.id, {
      paidAt: report.at ? new Date(report.at) : new Date(),
      terminalRef: report.terminalRef ?? current.terminalRef,
      tranRef: report.tranRef ?? current.tranRef,
      invoiceNo: report.invoiceNo ?? current.invoiceNo,
      approvalCode: report.approvalCode ?? null,
      last4: report.last4 ?? null,
      tid: report.tid ?? current.tid,
      mid: report.mid ?? current.mid,
      payload: settledPayload,
    });
    return { attempt: attemptView(settled), replayed: false, phase, run };
  }

  // --- Approved for the wrong amount: refuse and hand it back ---------------
  if (report.outcome === 'partial_approval' || short) {
    return {
      ...(await refuseAndVoid(tx, ctx, {
        current,
        payload: settledPayload,
        report,
        tender,
        deviceRow,
        approvedSatang,
      })),
      phase,
      run: {
        ...run,
        failed: true,
        name: `device:terminal.${phase}.partial_approval`,
        detail: { ...run.detail, outcome: 'partial_approval' },
      },
    };
  }

  // --- Declined, cancelled, not found ---------------------------------------
  if (report.outcome === 'declined' || report.outcome === 'cancelled') {
    const closed = await failTerminalAttempt(tx, current.id, report.outcome, settledPayload, report);
    return { attempt: attemptView(closed), replayed: false, phase, run };
  }
  if (report.outcome === 'not_found') {
    const closed = await failTerminalAttempt(tx, current.id, 'not_found', settledPayload, report);
    return { attempt: attemptView(closed), replayed: false, phase, run };
  }

  // --- No final answer, or one that cannot be acted on ----------------------
  /**
   * `unsupported` is the dialect saying it has no way to answer this question:
   * a NEXGO card sale has no QUERY (p.13). That is not a fault and not a
   * retry — it is the permanent state of that terminal, and the only thing left
   * is a person reading its screen.
   */
  if (report.outcome === 'unsupported' || phase === 'inquire') {
    const waiting = await stampAttempt(tx, current.id, {
      status: 'awaiting_staff_confirmation',
      terminalRef: report.terminalRef ?? current.terminalRef,
      tranRef: report.tranRef ?? current.tranRef,
      payload: settledPayload,
    });
    return { attempt: attemptView(waiting), replayed: false, phase, run };
  }

  /**
   * `no_response` and `timeout`: the money may or may not have moved, and the
   * only honest word for that is `unknown`. The till blocks here and the
   * inquiry rule runs — if the dialect has one for this tender.
   */
  const inquiryActionId = newId();
  const canAsk =
    canInquire(protocol, tender) && Boolean(report.terminalRef ?? current.terminalRef);
  const nextPayload: AttemptPayload = {
    ...settledPayload,
    ...(canAsk
      ? { inquiry: { actionId: inquiryActionId, queuedAt: new Date().toISOString() } }
      : {}),
  };
  const waiting = await stampAttempt(tx, current.id, {
    status: canAsk ? 'inquiring' : 'awaiting_staff_confirmation',
    terminalRef: report.terminalRef ?? current.terminalRef,
    tranRef: report.tranRef ?? current.tranRef,
    payload: nextPayload,
  });
  if (canAsk && deviceRow?.boxId) {
    await queueTerminalCommand(tx, {
      boxId: deviceRow.boxId,
      branchId: current.branchId,
      operatorId: current.operatorId,
      actorAccountId: (payload.takenByAccountId as string | undefined) ?? null,
      actionId: inquiryActionId,
      requestId: ctx.requestId,
      payload: {
        mode: 'inquire',
        attemptId: current.id,
        deviceId: deviceRow.id,
        stationId: current.stationId,
        role: roleForTender(tender),
        // An inquiry needs no amount; the sale's is carried so the result's
        // `requestedSatang` is the figure the cloud compares against.
        amountSatang: current.amountSatang,
        tender,
        ...(payload.wallet ? { wallet: payload.wallet } : {}),
        terminalRef: report.terminalRef ?? current.terminalRef,
        ...(report.tranRef ?? current.tranRef
          ? { tranRef: report.tranRef ?? current.tranRef }
          : {}),
      },
    });
  }
  return { attempt: attemptView(waiting), replayed: false, phase, run };
}

/**
 * Close the attempt through Slice B's `failAttempt`, then stamp the references
 * the vendor answered with.
 *
 * Two statements rather than one because `failAttempt` owns the three closing
 * statuses and takes no reference fields — and a declined card still has a
 * `pos_ref_no` and sometimes an invoice number, which is what a person holding
 * the terminal's slip will search by tomorrow morning. Reported to Slice B as
 * the gap it is rather than worked around by writing the status here.
 */
async function failTerminalAttempt(
  tx: Tx,
  attemptId: string,
  status: 'declined' | 'cancelled' | 'not_found',
  payload: AttemptPayload,
  report: TerminalFinalReport,
): Promise<typeof paymentAttempt.$inferSelect> {
  await failAttempt(tx, attemptId, { status, payload });
  return stampAttempt(tx, attemptId, {
    ...(report.terminalRef ? { terminalRef: report.terminalRef } : {}),
    ...(report.tranRef ? { tranRef: report.tranRef } : {}),
    ...(report.invoiceNo ? { invoiceNo: report.invoiceNo } : {}),
  });
}

/**
 * An approval for the wrong amount: refuse the sale and hand the money back.
 *
 * The attempt is left `declined` — no money of ours, and the sale is untouched
 * — and the void is queued with a FRESH reference (the counter on the box mints
 * it) keyed on what each vendor keys a void on: the EDC's invoice number plus
 * the card approval code on GHL (p.16), the transaction id on Digio's `A10`.
 * Its own answer comes back on the same route and is recorded on
 * `payload.void`, without moving the status: the attempt failed, and the fact
 * that the rescue worked is a fact about the rescue.
 */
async function refuseAndVoid(
  tx: Tx,
  ctx: OpContext,
  input: {
    current: typeof paymentAttempt.$inferSelect;
    payload: AttemptPayload;
    report: TerminalFinalReport;
    tender: TerminalTender;
    deviceRow: typeof device.$inferSelect | null;
    approvedSatang: number | null;
  },
): Promise<{ attempt: PaymentAttemptView; replayed: boolean }> {
  const { current, report, tender, deviceRow } = input;
  const voidActionId = newId();
  const tranRef = report.tranRef ?? report.invoiceNo ?? current.tranRef;
  const takenSatang = input.approvedSatang ?? 0;
  const payload: AttemptPayload = {
    ...input.payload,
    void: {
      actionId: voidActionId,
      queuedAt: new Date().toISOString(),
      // THE AMOUNT BEING HANDED BACK, which is what the terminal took and not
      // what the sale asked for.
      amountSatang: takenSatang,
      reason: 'partial_approval',
      requestedSatang: current.amountSatang,
      ...(tranRef ? {} : { unvoidable: 'the terminal named no transaction to void' }),
    },
  };
  const closed = await failTerminalAttempt(tx, current.id, 'declined', payload, report);

  if (tranRef && deviceRow?.boxId) {
    await queueTerminalCommand(tx, {
      boxId: deviceRow.boxId,
      branchId: current.branchId,
      operatorId: current.operatorId,
      actorAccountId: (input.payload.takenByAccountId as string | undefined) ?? null,
      actionId: voidActionId,
      requestId: ctx.requestId,
      payload: {
        mode: 'void',
        attemptId: current.id,
        deviceId: deviceRow.id,
        stationId: current.stationId,
        role: roleForTender(tender),
        amountSatang: takenSatang,
        tender,
        ...(input.payload.wallet ? { wallet: input.payload.wallet } : {}),
        tranRef,
        /**
         * The approval code travels because a GHL card void will not be
         * accepted without it beside the invoice number (p.16) and there is no
         * other path to a terminal on a Raspberry Pi. It is the number printed
         * on the guest's own slip rather than a credential, and the command
         * history that renders this payload is behind `admin:box:read` — but it
         * is still the one value in this file that would be better not stored,
         * and it is reported as such.
         */
        ...(report.approvalCode ? { approvalCode: report.approvalCode } : {}),
      },
    });
  }
  return { attempt: attemptView(closed), replayed: false };
}

/** The `ops_run` for one adapter call, written the way a print job's failure is. */
export async function recordTerminalRun(
  db: Db,
  input: {
    run: { name: string; failed: boolean; detail: Record<string, unknown> };
    operatorId: string;
    branchId: string;
    stationId: string | null;
    actionId: string | null;
    requestId?: string | null;
    startedAt: Date;
  },
): Promise<void> {
  await recordRun(db, {
    // `device`, as a printer's failure is: the far end is a machine on a cable
    // at a counter, and the Failures page groups by what broke rather than by
    // which sale was standing in front of it.
    kind: 'device',
    name: input.run.name,
    outcome: input.run.failed ? 'failed' : 'ok',
    startedAt: input.startedAt,
    finishedAt: new Date(),
    ...(input.run.failed
      ? {
          /**
           * An `AppError` rather than a bare object: `errorInfo` reduces an
           * AppError to its code and message and everything else to
           * `UNKNOWN` — and the code is half of the fingerprint the Failures
           * page groups by, so a plain object here would collapse every
           * terminal failure in the estate into one row.
           */
          error: new AppError(
            502,
            String(input.run.detail.outcome ?? 'TERMINAL_FAILED').toUpperCase(),
            `The terminal exchange ended ${String(input.run.detail.outcome)}`,
          ),
        }
      : {}),
    detail: input.run.detail,
    operatorId: input.operatorId,
    branchId: input.branchId,
    stationId: input.stationId,
    actionId: input.actionId,
    requestId: input.requestId ?? null,
  });
}

// --- The QR payload, before the guest has paid -------------------------------

/**
 * A progress report: the payload the terminal minted, so OUR display can draw
 * it before anybody pays.
 *
 * It changes no status. A QR on a screen is not money.
 */
export async function recordTerminalProgress(
  tx: Tx,
  loaded: LoadedAttempt,
  report: TerminalProgressReport,
): Promise<PaymentAttemptView> {
  if (report.kind !== 'qr_payload' || !report.qrPayload) {
    return attemptView(loaded.attempt);
  }
  const stamped = await stampAttempt(tx, loaded.attempt.id, {
    qrPayload: report.qrPayload,
    ...(report.tranRef ? { tranRef: report.tranRef } : {}),
  });
  return attemptView(stamped);
}

// --- What a person says when no machine can ----------------------------------

export interface ConfirmInput {
  /** True when the terminal's own screen says the money was taken. */
  took: boolean;
  /** Read off the terminal's slip. Stored on the attempt; never in an `ops_run`. */
  approvalCode?: string | null;
  tid?: string | null;
  last4?: string | null;
  note?: string | null;
  actionId?: string | null;
}

/**
 * The audited staff confirmation.
 *
 * This is the branch the GHL card sale always ends in when nothing came back,
 * because that dialect has no QUERY for a card. The answer is a person's, so it
 * is written with that person's account id on the row AND in the audit log:
 * `staff_confirmed_by` is the whole reason `awaiting_staff_confirmation` is a
 * status and not a flag, and an investigation that cannot name who said the
 * money moved has nothing to investigate.
 */
export async function confirmAttempt(
  tx: Tx,
  actor: TenderActor,
  attemptId: string,
  input: ConfirmInput,
): Promise<PaymentAttemptView> {
  const [current] = await tx
    .select()
    .from(paymentAttempt)
    .where(and(eq(paymentAttempt.id, attemptId), eq(paymentAttempt.operatorId, actor.operatorId)))
    .for('update')
    .limit(1);
  if (!current) throw errors.notFound('No such payment attempt');
  await actor.assertBranchAllowed(current.branchId);
  if (current.status !== 'awaiting_staff_confirmation') {
    throw errors.conflict(
      'ATTEMPT_NOT_AWAITING_CONFIRMATION',
      `This tender is ${current.status}; there is nothing for a person to confirm`,
      { status: current.status },
    );
  }
  const payload = (current.payload ?? {}) as AttemptPayload;
  const confirmation = {
    accountId: actor.accountId,
    took: input.took,
    at: new Date().toISOString(),
    ...(input.note ? { note: input.note } : {}),
  };
  const next: AttemptPayload = { ...payload, staffConfirmation: confirmation };

  const row = input.took
    ? await settleAttempt(tx, attemptId, {
        staffConfirmedByAccountId: actor.accountId,
        approvalCode: input.approvalCode ?? current.approvalCode,
        tid: input.tid ?? current.tid,
        last4: input.last4 ?? current.last4,
        payload: next,
      })
    : await (async () => {
        await failAttempt(tx, attemptId, { status: 'declined', payload: next });
        // The name goes on whichever way the answer went: "nobody took this"
        // is a statement somebody made, and it is worth as much as the other.
        return stampAttempt(tx, attemptId, { staffConfirmedByAccountId: actor.accountId });
      })();

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: current.operatorId,
    branchId: current.branchId,
    action: 'payment.attempt.confirm',
    entityType: 'payment_attempt',
    entityId: attemptId,
    actionId: input.actionId ?? null,
    requestId: actor.requestId,
    before: { status: current.status },
    after: {
      status: row.status,
      took: input.took,
      staffConfirmedBy: actor.accountId,
      saleId: current.saleId,
      amountSatang: current.amountSatang,
      ...(input.note ? { note: input.note } : {}),
    },
  });
  return attemptView(row);
}

// --- Keyed in by hand --------------------------------------------------------

export interface ManualTenderInput {
  saleId: string;
  amountSatang?: number;
  methodCode?: string;
  kind?: string;
  /** The two things the terminal's own slip shows, and what makes this auditable. */
  approvalCode: string;
  tid?: string | null;
  last4?: string | null;
  reference?: string | null;
  actionId?: string | null;
}

/**
 * A tender taken on a terminal the platform cannot reach.
 *
 * `provider = 'manual'`, no device, and the approval code and TID the staff
 * member read off the slip. It is the routing a station declares with
 * `card: 'manual'` and it is also what is left when a terminal is unplugged
 * mid-service — so it is a first-class path rather than a fallback, and it is
 * audited with the account that keyed it in.
 */
export async function recordManualTender(
  tx: Tx,
  actor: TenderActor,
  input: ManualTenderInput,
): Promise<{ attempt: PaymentAttemptView; replayed: boolean; outstandingSatang: number }> {
  const [saleRow] = await tx
    .select()
    .from(sale)
    .where(eq(sale.id, input.saleId))
    .for('update')
    .limit(1);
  if (!saleRow || saleRow.operatorId !== actor.operatorId) throw errors.notFound('Sale not found');
  await actor.assertBranchAllowed(saleRow.branchId);
  if (saleRow.status !== 'tendering') {
    // `paid`, `finalised`, `voided`, `refunded` — a sale in any of them has
    // either been closed or been taken off the ledger, and neither is a thing
    // to put a guest's card against.
    throw errors.conflict(
      'SALE_CLOSED',
      `This sale is ${saleRow.status} and cannot take another tender`,
    );
  }

  const already = input.actionId
    ? await findAttemptByAction(tx, actor.operatorId, input.actionId)
    : null;
  if (already) {
    if (already.saleId !== input.saleId) {
      throw errors.conflict(
        'ACTION_ID_REUSED',
        'That action id already recorded a tender against another sale',
        { actionId: input.actionId, saleId: already.saleId },
      );
    }
    return {
      attempt: attemptView(already),
      replayed: true,
      outstandingSatang: await outstandingAfter(tx, saleRow),
    };
  }

  /**
   * S2-10b — THE TENDER GUARD, as for a terminal tender: an approval code is
   * not recorded against a sale priced with a voucher that is no longer held
   * for it (VOUCHER_NOT_HELD).
   */
  await assertSaleVouchersHeld(
    tx,
    {
      saleId: saleRow.id,
      operatorId: saleRow.operatorId,
      branchId: saleRow.branchId,
      stationId: saleRow.stationId,
    },
    new Date(),
  );

  const owed = await outstandingAfter(tx, saleRow);
  const amountSatang = input.amountSatang ?? owed;
  if (amountSatang <= 0) throw errors.badRequest('A tender has to settle something');
  if (amountSatang > owed) {
    throw errors.badRequest('That tender is more than this sale still owes', {
      amountSatang,
      outstandingSatang: owed,
    });
  }
  const methodCode = input.methodCode ?? 'card';
  const method = await tenderMethodOf(tx, actor.operatorId, methodCode, input.kind);

  const opened = await openAttempt(tx, {
    operatorId: saleRow.operatorId,
    branchId: saleRow.branchId,
    stationId: saleRow.stationId,
    businessDate: saleRow.businessDate,
    saleId: saleRow.id,
    method,
    methodCode,
    provider: 'manual',
    amountSatang,
    actionId: input.actionId ?? null,
    payload: {
      takenByAccountId: actor.accountId,
      ...(input.actionId ? { actionId: input.actionId } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      manual: {
        accountId: actor.accountId,
        at: new Date().toISOString(),
        ...(input.reference ? { reference: input.reference } : {}),
      },
    } satisfies AttemptPayload,
  });
  const settled = await settleAttempt(tx, opened.id, {
    approvalCode: input.approvalCode,
    tid: input.tid ?? null,
    last4: input.last4 ?? null,
  });

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: saleRow.operatorId,
    branchId: saleRow.branchId,
    action: 'payment.tender.manual',
    entityType: 'payment_attempt',
    entityId: opened.id,
    actionId: input.actionId ?? null,
    requestId: actor.requestId,
    after: {
      saleId: saleRow.id,
      method,
      methodCode,
      amountSatang,
      provider: 'manual',
      // The code is on the attempt row and in the log, because a manual entry
      // IS the record of the money: there is no terminal answer behind it.
      approvalCode: input.approvalCode,
      tid: input.tid ?? null,
      takenByAccountId: actor.accountId,
    },
  });

  return {
    attempt: attemptView(settled),
    replayed: false,
    outstandingSatang: owed - amountSatang,
  };
}

// --- Asking the terminal again, by hand --------------------------------------

/**
 * Run the inquiry again from the blocked screen.
 *
 * The rule runs on its own when nothing comes back; this is the same rule with
 * a person's finger on it, for the case where the terminal was busy or the
 * cable was out the first time. Refused where the dialect has no inquiry — a
 * NEXGO card — because a button that pretends to ask a question nobody can ask
 * is worse than one that says so.
 */
export async function requestInquiry(
  tx: Tx,
  actor: TenderActor,
  attemptId: string,
): Promise<PaymentAttemptView> {
  const [current] = await tx
    .select()
    .from(paymentAttempt)
    .where(and(eq(paymentAttempt.id, attemptId), eq(paymentAttempt.operatorId, actor.operatorId)))
    .for('update')
    .limit(1);
  if (!current) throw errors.notFound('No such payment attempt');
  await actor.assertBranchAllowed(current.branchId);
  if (current.status !== 'unknown' && current.status !== 'awaiting_staff_confirmation') {
    throw errors.conflict(
      'ATTEMPT_NOT_INQUIRABLE',
      `This tender is ${current.status}; there is nothing outstanding to ask about`,
      { status: current.status },
    );
  }
  if (!current.deviceId) {
    throw errors.conflict('ATTEMPT_HAS_NO_TERMINAL', 'This tender was not taken on a terminal');
  }
  const [deviceRow] = await tx.select().from(device).where(eq(device.id, current.deviceId)).limit(1);
  const protocol = terminalProtocolOf(deviceRow?.protocol);
  const payload = (current.payload ?? {}) as AttemptPayload;
  const tender = (payload.tender ?? 'card') as TerminalTender;
  if (!deviceRow || !protocol || !canInquire(protocol, tender) || !current.terminalRef) {
    throw errors.conflict(
      'INQUIRY_UNSUPPORTED',
      'This terminal has no way to be asked about a transaction it did not answer — a person has to read its screen',
      { protocol: deviceRow?.protocol ?? null, tender },
    );
  }
  if (!deviceRow.boxId) {
    throw errors.conflict('TERMINAL_HAS_NO_BOX', 'That terminal is not plugged into a box');
  }
  const actionId = newId();
  const stamped = await stampAttempt(tx, attemptId, {
    status: 'inquiring',
    payload: {
      ...payload,
      inquiry: { actionId, queuedAt: new Date().toISOString(), askedByAccountId: actor.accountId },
    },
  });
  await queueTerminalCommand(tx, {
    boxId: deviceRow.boxId,
    branchId: current.branchId,
    operatorId: current.operatorId,
    actorAccountId: actor.accountId,
    actionId,
    requestId: actor.requestId,
    payload: {
      mode: 'inquire',
      attemptId,
      deviceId: deviceRow.id,
      stationId: current.stationId,
      role: roleForTender(tender),
      amountSatang: current.amountSatang,
      tender,
      ...(payload.wallet ? { wallet: payload.wallet } : {}),
      terminalRef: current.terminalRef,
      ...(current.tranRef ? { tranRef: current.tranRef } : {}),
    },
  });
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: current.operatorId,
    branchId: current.branchId,
    action: 'payment.attempt.inquire',
    entityType: 'payment_attempt',
    entityId: attemptId,
    actionId,
    requestId: actor.requestId,
    before: { status: current.status },
    after: { status: 'inquiring', terminalRef: current.terminalRef },
  });
  return attemptView(stamped);
}
