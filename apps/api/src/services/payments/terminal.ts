import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  box,
  boxCommand,
  device,
  eventPassHold,
  paymentAttempt,
  sale,
  station,
  stationDevice,
  type Db,
  type PaymentProvider,
} from '@oto/db';
import {
  stationPaymentRoutes,
  stationSellingReadiness,
  type SellingStationSetup,
  newId,
  projectAttemptPayload,
  type PaymentAttemptStatus,
  type PaymentAttemptView,
} from '@oto/shared';
import {
  roleForTender,
  TERMINAL_OUTCOME_KINDS,
  TERMINAL_TIMEOUTS,
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
import { assertSalePromoUsesLeft } from '../promo-codes';
import { assertSaleExtensionCollectable } from '../sale-extension-lifecycle';
import { assertSaleBenefitsLive } from '../benefit-checkout';
import { refuseTenderOnStaysPaidAtTill } from '../checkin-paid-at-till';
import { settleRefundSlice } from '../refund-slices';
import { finaliseSale } from '../sale';
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

/** Batch the same current, operator-scoped terminal facts for the lists and selling gate. */
export async function readStationsSellingReadiness(
  db: Exec, operatorId: string, rows: Array<SellingStationSetup & { id: string }>,
) {
  const assignments = rows.length ? await db.select({
    stationId: stationDevice.stationId, role: stationDevice.role,
    kind: device.kind, boxId: device.boxId, protocol: device.protocol,
  }).from(stationDevice).innerJoin(device, eq(device.id, stationDevice.deviceId))
    .where(and(inArray(stationDevice.stationId, rows.map(r => r.id)), eq(device.operatorId, operatorId), isNull(device.archivedAt))) : [];
  return new Map(rows.map(row => [row.id, stationSellingReadiness(row, assignments.filter(a => a.stationId === row.id))]));
}

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
  /**
   * SCRUM-979 — set when this answer was read off the box's acknowledgement of
   * the command rather than posted on the result route (`takeCommandAnswer`).
   */
  source?: { commandId: string } | null;
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
  /** SCRUM-979 — the SALE's or inquiry's answer, as read off the box's acknowledgement. */
  fromCommand?: Record<string, unknown>;
  [key: string]: unknown;
}

// --- Vocabulary --------------------------------------------------------------

/** Every status a further answer can still move an attempt out of. */
const IN_FLIGHT: readonly PaymentAttemptStatus[] = [
  'created',
  'sent_to_terminal',
  'unknown',
  'inquiring',
  'awaiting_staff_confirmation',
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
  route: 'card_terminal' | 'manual' | 'gateway';
  attempt: PaymentAttemptView;
  /** The EMVCo payload the display draws for a gateway or terminal QR. */
  qrPayload: string | null;
  qrImageUrl: string | null;
  expiresAt: string | null;
  expiryTimerMs: number | null;
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
  const qrImageUrl = (row.payload as { qrImageUrl?: unknown } | null)?.qrImageUrl;
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
    route: row.deviceId ? 'card_terminal' : row.invoiceNo && row.method === 'qr' ? 'gateway' : 'manual',
    attempt: attemptView(row),
    qrPayload: row.qrPayload,
    qrImageUrl: typeof qrImageUrl === 'string' ? qrImageUrl : null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    expiryTimerMs: row.expiresAt ? Math.max(0, row.expiresAt.getTime() - Date.now()) : null,
    deviceLabel: typeof payload.deviceLabel === 'string' ? payload.deviceLabel : null,
    responseText:
      typeof payload.exchange?.responseText === 'string' ? payload.exchange.responseText : null,
    outstandingSatang,
  };
}

// --- When the box could not run the instruction (SCRUM-972) ------------------

/**
 * SCRUM-972 — EVERY WAY A `terminal_sale` COMMAND CAN END `failed`, read off
 * the box's own code (`packages/box-agent/src`), and whether a byte could have
 * reached the terminal before it.
 *
 * The box acknowledges a command `failed` only when it holds NO answer from the
 * terminal: `state: outcome.result || !outcome.errorCode ? 'succeeded' :
 * 'failed'` (agent.ts:4155-4169). So a failed command's `result` always reads
 * `{ attemptId, mode, ...routed, outcome: null, terminalRef: null,
 * responseCode: null }`, or there is no `result` at all for the three refusals
 * the agent makes before the terminal module is reached.
 *
 * CERTAINLY NOTHING SENT — every place the code is thrown is before the first
 * `channel.write`:
 *   BOX_OFFLINE               agent.ts:3900-3911, handed to an offline box, never run
 *   TERMINALS_DISABLED        agent.ts:4109-4115, an agent with no terminal pipeline
 *   BAD_TENDER                agent.ts:4116-4123, the payload did not parse
 *   TERMINAL_NOT_ON_THIS_BOX  terminal/index.ts:338-351, the device is not in the
 *                             set-up the box holds (a terminal assigned on the
 *                             Console that the box has not pulled yet)
 *   DEVICE_NO_ADDRESS         terminal/index.ts:216-222, thrown by `open()`
 *   TERMINAL_NO_SERIAL_DRIVER serial-channel.ts:184-189, the default opener, at `open()`
 *   TERMINAL_NOT_CONFIGURED   terminal/index.ts:154-163 and counter.ts:129-163 (minting
 *                             the reference), digio.ts:908-913 (void password)
 *   TERMINAL_BAD_REQUEST      terminal/index.ts:364-368/381-385, ghl.ts:255/454/592/696/793,
 *                             digio.ts:89/97/226/545/549, counter.ts:101-116: all while
 *                             the request is being built
 *
 * POSSIBLY SENT:
 *   TERMINAL_WRITE_FAILED     serial-channel.ts:228-241, the port died while the
 *                             request was going out (`partial: true`)
 *   TERMINAL_UNREACHABLE      serial-channel.ts:133-148 at `open()`, BUT ALSO
 *                             terminal/index.ts:409-421 for any error that is not a
 *                             `TerminalError`, which includes the store write in
 *                             `serialise`'s `finally` (index.ts:266-269), AFTER the
 *                             terminal has answered
 *
 * SENT AND ANSWERED, unreadably:
 *   TERMINAL_BAD_FRAME        digio.ts:106-160/266-281, a frame scanner throwing
 *                             inside `readFrame`, after the write
 *
 * Any other code, or none, is read as possibly sent. One caveat the list rests
 * on: `terminalChannel.write` rethrows a `TerminalError` from its transport
 * as it is (serial-channel.ts:235). The only transports in this tree are the
 * simulators and `noSerialDriver`; a host opener added later must not throw one
 * of the codes above from `write`.
 *
 * The list holds for a VOID and an INQUIRY as well: every mode runs through
 * the same `runCommand` (terminal/index.ts:328-423), and a void's own refusals
 * (index.ts:380-385, ghl.ts:695-704, digio.ts:908-914) all come before its
 * `channel.write` (ghl.ts:716, digio.ts:926).
 *
 * Each code proved to send nothing carries the sentence the till may show.
 */
const NOT_SENT_WORDS: Readonly<Record<string, string>> = {
  BOX_OFFLINE:
    'This counter’s box is offline, so the card terminal was not asked. Take another way to pay, or try again when the box is back online.',
  TERMINALS_DISABLED:
    'The card terminal on this counter is not set up to take payments, so it was not asked. Take another way to pay, and ask a manager to check the terminal.',
  BAD_TENDER:
    'The card terminal could not be asked for this payment, so nothing was charged. Try again, or take another way to pay.',
  TERMINAL_NOT_ON_THIS_BOX:
    'The card terminal is not ready on this counter yet. Try again in a moment, or take another way to pay.',
  DEVICE_NO_ADDRESS:
    'The card terminal on this counter is not set up to take payments, so it was not asked. Take another way to pay, and ask a manager to check the terminal.',
  TERMINAL_NO_SERIAL_DRIVER:
    'The card terminal on this counter is not set up to take payments, so it was not asked. Take another way to pay, and ask a manager to check the terminal.',
  TERMINAL_NOT_CONFIGURED:
    'The card terminal on this counter is not set up to take payments, so it was not asked. Take another way to pay, and ask a manager to check the terminal.',
  TERMINAL_BAD_REQUEST:
    'The card terminal could not be asked for this payment, so nothing was charged. Try again, or take another way to pay.',
};

/** Our own word for a SALE command the box never took: it expired in the queue. */
const COMMAND_EXPIRED = 'BOX_COMMAND_EXPIRED';
const COMMAND_EXPIRED_WORDS =
  'This counter’s box did not pick up the card payment in time, so the terminal was never asked. Try again, or take another way to pay.';

/** The error codes a failed `terminal_sale` proves sent nothing (SCRUM-972). */
export const TERMINAL_NOTHING_SENT_CODES: readonly string[] = Object.keys(NOT_SENT_WORDS);

/** The till's sentence for a refusal that sent nothing; null when a byte may have gone out. */
export function terminalNotSentWords(errorCode: string | null | undefined): string | null {
  return errorCode && Object.prototype.hasOwnProperty.call(NOT_SENT_WORDS, errorCode)
    ? NOT_SENT_WORDS[errorCode]!
    : null;
}

type CommandRow = typeof boxCommand.$inferSelect;
type AttemptRow = typeof paymentAttempt.$inferSelect;

/** How long a claimed exchange may run before its silence is read as a missing result. */
const EXCHANGE_BUDGET_MS = TERMINAL_TIMEOUTS.customerInteractionMs + 30_000;

function commandFacts(row: Pick<CommandRow, 'payload' | 'result'>): {
  mode: string | null;
  attemptId: string | null;
  deviceId: string | null;
  answered: boolean;
} {
  const payload = (row.payload ?? {}) as { mode?: unknown; attemptId?: unknown; deviceId?: unknown };
  const outcome = (row.result as { outcome?: unknown } | null)?.outcome;
  return {
    mode: typeof payload.mode === 'string' ? payload.mode : null,
    attemptId: typeof payload.attemptId === 'string' ? payload.attemptId : null,
    deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : null,
    // A result with no outcome is a missing result (SCRUM-972): the terminal
    // said nothing the result route could carry.
    answered: outcome !== undefined && outcome !== null,
  };
}

/**
 * Take the attempt's row lock BEFORE the command's, in the order the read-time
 * recovery takes them, so `completeCommand` and a till's poll of the same
 * attempt cannot deadlock (SCRUM-972).
 */
export async function lockAttemptOfTerminalCommand(
  tx: Tx,
  operatorId: string,
  command: Pick<CommandRow, 'kind' | 'payload' | 'result'>,
): Promise<void> {
  if (command.kind !== 'terminal_sale') return;
  const { attemptId } = commandFacts(command);
  if (!attemptId || !/^[0-9a-f-]{36}$/i.test(attemptId)) return;
  await tx.select({ id: paymentAttempt.id }).from(paymentAttempt)
    .where(and(eq(paymentAttempt.id, attemptId), eq(paymentAttempt.operatorId, operatorId)))
    .for('update').limit(1);
}

/**
 * What a settlement found at the box hands to the work done after its commit.
 * `run` is the `ops_run` the result route would have written, and is set only
 * when a terminal's answer was taken (SCRUM-979); a command proved never sent,
 * or one handed to a person, writes none, as the read-time net never did.
 */
export interface TerminalSettled {
  attemptId: string;
  operatorId: string;
  branchId: string;
  stationId: string | null;
  saleId: string | null;
  actionId: string | null;
  run: { name: string; failed: boolean; detail: Record<string, unknown> } | null;
  startedAt: Date;
}

function settledFrom(
  current: AttemptRow,
  command: CommandRow,
  run: TerminalSettled['run'],
): TerminalSettled {
  return {
    attemptId: current.id,
    operatorId: current.operatorId,
    branchId: current.branchId,
    stationId: current.stationId,
    saleId: current.saleId,
    actionId: command.actionId ?? current.actionId,
    run,
    startedAt: command.claimedAt ?? command.createdAt,
  };
}

/**
 * SCRUM-972 / SCRUM-979 — A TERMINAL COMMAND THAT HAS ENDED, settled for its
 * attempt: a command the box reports `failed`, one that `expired` in the queue,
 * and one it acknowledged `succeeded` with the terminal's answer on it. Called
 * in `completeCommand`'s transaction, and by the expiry sweeps right after
 * theirs. The ATTEMPT's lock is taken before the COMMAND's, the order the
 * read-time net takes them in, so the paths cannot deadlock one another.
 *
 * A SALE the box proves it never sent ends the attempt now; one that may have
 * reached the terminal takes the missing-result road; one the terminal
 * answered takes THAT answer. A VOID never sent ends `not_sent`, and a
 * refund's slice falls back to cash. Never a second SALE or VOID.
 */
export async function settleEndedTerminalCommand(
  tx: Tx,
  ctx: OpContext,
  operatorId: string,
  commandId: string,
): Promise<TerminalSettled | null> {
  const [seen] = await tx.select().from(boxCommand).where(eq(boxCommand.id, commandId)).limit(1);
  if (!seen || seen.kind !== 'terminal_sale') return null;
  await lockAttemptOfTerminalCommand(tx, operatorId, seen);
  const [command] = await tx.select().from(boxCommand).where(eq(boxCommand.id, commandId)).for('update').limit(1);
  if (!command || !['failed', 'expired', 'succeeded'].includes(command.state)) return null;
  const facts = commandFacts(command);
  if (!facts.attemptId || !facts.deviceId || !/^[0-9a-f-]{36}$/i.test(facts.attemptId)) return null;
  const [current] = await tx.select().from(paymentAttempt)
    .where(and(eq(paymentAttempt.id, facts.attemptId), eq(paymentAttempt.operatorId, operatorId)))
    .for('update').limit(1);
  if (!current || current.deviceId !== facts.deviceId) return null;
  return settleCommandForAttempt(tx, ctx, current, command, Date.now());
}

/** One ended command against its locked attempt: its answer, or what its silence means. */
async function settleCommandForAttempt(
  tx: Tx,
  ctx: OpContext,
  current: AttemptRow,
  command: CommandRow,
  now: number,
): Promise<TerminalSettled | null> {
  if (command.state === 'succeeded') {
    return commandFacts(command).answered ? takeCommandAnswer(tx, ctx, current, command) : null;
  }
  return (await settleStalledCommand(tx, ctx, current, command, now))
    ? settledFrom(current, command, null)
    : null;
}

/**
 * What a terminal command that will never report means for its attempt.
 *
 * Its SALE: proved never sent (a failed command whose code is on the list
 * above, or one that expired in the queue) ends the attempt `declined`, the
 * word `failAttempt` and the box's own lane (station-bridge.ts:4069-4074) use
 * for a payment that did not happen; anything else waits for a person or an
 * inquiry. Its INQUIRY: says nothing about the sale, so the attempt goes back
 * to a person, as an inquiry with no conclusive answer does
 * (`recordTerminalResult`). Its VOID: proved never sent, the void ends
 * `not_sent` (a refund's slice falls back to cash); anything else stays
 * pending for a person. Never a second SALE or VOID. True when it wrote.
 */
async function settleStalledCommand(
  tx: Tx,
  ctx: OpContext,
  current: AttemptRow,
  command: CommandRow,
  now: number,
): Promise<boolean> {
  const facts = commandFacts(command);
  if (facts.answered) return false;
  const inquiry = facts.mode === 'inquire';
  const voiding = facts.mode === 'void';
  if (inquiry) {
    if (current.status !== 'inquiring') return false;
    const asked = ((current.payload ?? {}) as AttemptPayload).inquiry?.actionId;
    if (!asked || asked !== command.actionId) return false;
  } else if (voiding) {
    // Only the void this attempt is waiting on, and only once.
    const reversal = ((current.payload ?? {}) as AttemptPayload).void;
    if (!reversal || reversal.actionId !== command.actionId || reversal.result) return false;
  } else if (facts.mode !== 'sale' || !['created', 'sent_to_terminal'].includes(current.status)) {
    return false;
  }

  let state = command.state;
  if (state === 'queued') {
    // Never handed to the box, and from here never will be: the claim needs
    // `expires_at > now()`, and this row is locked.
    if (!command.expiresAt || command.expiresAt.getTime() > now) return false;
    const [expired] = await tx.update(boxCommand)
      .set({ state: 'expired', finishedAt: new Date(now) })
      .where(and(eq(boxCommand.id, command.id), eq(boxCommand.state, 'queued')))
      .returning({ id: boxCommand.id });
    if (!expired) return false;
    state = 'expired';
  }
  if (state === 'running') {
    // A void that may be on the terminal stays pending for a person.
    if (voiding) return false;
    // A still-running exchange gets its full budget.
    if (!command.claimedAt || now - command.claimedAt.getTime() < EXCHANGE_BUDGET_MS) return false;
    await tx.update(boxCommand).set({
      errorCode: 'TERMINAL_RESULT_MISSING',
      errorMessage: 'The terminal result did not arrive. Check the terminal before confirming the payment.',
    }).where(and(eq(boxCommand.id, command.id), eq(boxCommand.state, 'running')));
  } else if (state !== 'failed' && state !== 'expired') {
    return false;
  }

  if (inquiry) {
    await returnInquiryToPerson(tx, ctx, current, command, state);
    return true;
  }
  const notSent = state === 'expired'
    ? { code: COMMAND_EXPIRED, words: COMMAND_EXPIRED_WORDS }
    : state === 'failed' && terminalNotSentWords(command.errorCode)
      ? { code: command.errorCode!, words: terminalNotSentWords(command.errorCode)! }
      : null;
  if (voiding) {
    // A void that may have reached the terminal stays pending for a person.
    if (!notSent) return false;
    await endVoidNotSent(tx, ctx, current, command, state, notSent.code);
    return true;
  }
  if (notSent) {
    await endAttemptNotSent(tx, ctx, current, command, state, notSent);
    return true;
  }
  await markTerminalResultMissing(tx, ctx, current, command, state);
  return true;
}

/** A SALE the box never sent: the attempt ends, the sale is free (SCRUM-972). */
async function endAttemptNotSent(
  tx: Tx,
  ctx: OpContext,
  current: AttemptRow,
  command: CommandRow,
  commandState: string,
  notSent: { code: string; words: string },
): Promise<void> {
  const payload = (current.payload ?? {}) as AttemptPayload;
  const at = new Date().toISOString();
  await failAttempt(tx, current.id, {
    status: 'declined',
    payload: {
      ...payload,
      // `exchange.responseText` is the read view's `responseText`, the field
      // the till reads for an ended tender. Nothing here came off a terminal.
      exchange: {
        mode: 'sale',
        outcome: null,
        protocol: payload.protocol ?? null,
        requestedSatang: current.amountSatang,
        approvedSatang: null,
        responseCode: null,
        responseText: notSent.words,
        elapsedMs: null,
        at,
      },
      notSent: { commandId: command.id, commandState, errorCode: notSent.code, at },
    },
  });
  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId ?? null,
    operatorId: current.operatorId,
    branchId: current.branchId,
    action: 'payment.attempt.not_sent',
    entityType: 'payment_attempt',
    entityId: current.id,
    actionId: current.actionId,
    requestId: ctx.requestId,
    before: { status: current.status },
    after: {
      status: 'declined',
      commandId: command.id,
      commandState,
      errorCode: notSent.code,
      saleId: current.saleId,
      amountSatang: current.amountSatang,
    },
  });
}

/** A SALE that may have reached the terminal: unknown or a person, never a second SALE. */
async function markTerminalResultMissing(
  tx: Tx,
  ctx: OpContext,
  current: AttemptRow,
  command: CommandRow,
  commandState: string,
): Promise<void> {
  const payload = (current.payload ?? {}) as AttemptPayload;
  const protocol = terminalProtocolOf(payload.protocol);
  const canAsk = protocol && canInquire(protocol, payload.tender ?? 'card') && Boolean(current.terminalRef);
  const status = canAsk ? 'unknown' : 'awaiting_staff_confirmation';
  await stampAttempt(tx, current.id, { status });
  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId ?? null, operatorId: current.operatorId, branchId: current.branchId,
    action: 'payment.attempt.result_missing', entityType: 'payment_attempt', entityId: current.id,
    actionId: current.actionId, requestId: ctx.requestId,
    before: { status: current.status },
    after: { status, commandId: command.id, commandState,
      ...(command.errorCode ? { errorCode: command.errorCode } : {}),
      saleId: current.saleId, amountSatang: current.amountSatang },
  });
}

/** An inquiry that will never answer: back to a person, who may also ask again. */
async function returnInquiryToPerson(
  tx: Tx,
  ctx: OpContext,
  current: AttemptRow,
  command: CommandRow,
  commandState: string,
): Promise<void> {
  const payload = (current.payload ?? {}) as AttemptPayload;
  await stampAttempt(tx, current.id, {
    status: 'awaiting_staff_confirmation',
    payload: {
      ...payload,
      inquiry: {
        ...(payload.inquiry ?? {}),
        ended: { commandId: command.id, commandState, errorCode: command.errorCode ?? null, at: new Date().toISOString() },
      },
    },
  });
  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId ?? null, operatorId: current.operatorId, branchId: current.branchId,
    action: 'payment.attempt.result_missing', entityType: 'payment_attempt', entityId: current.id,
    actionId: current.actionId, requestId: ctx.requestId,
    before: { status: current.status },
    after: { status: 'awaiting_staff_confirmation', mode: 'inquire', commandId: command.id, commandState,
      ...(command.errorCode ? { errorCode: command.errorCode } : {}),
      saleId: current.saleId, amountSatang: current.amountSatang },
  });
}

/** A refund slice's words when its void never left the box (SCRUM-972). */
const VOID_NOT_SENT_DETAIL = 'The box could not send the void to the terminal — hand it back in cash';

/**
 * A VOID the box never sent (SCRUM-972). A void's answer never moves the
 * attempt (`recordTerminalResult`), and neither does this: the void is stamped
 * `not_sent`, which `isPaymentReversalPending` does not read as done, so a
 * partial charge stays reserved until a person settles it. A refund's slice
 * that asked for the void falls back to cash, as when the terminal refuses it.
 */
async function endVoidNotSent(
  tx: Tx,
  ctx: OpContext,
  current: AttemptRow,
  command: CommandRow,
  commandState: string,
  errorCode: string,
): Promise<void> {
  const payload = (current.payload ?? {}) as AttemptPayload;
  const reversal = payload.void ?? {};
  const at = new Date().toISOString();
  await stampAttempt(tx, current.id, {
    payload: {
      ...payload,
      void: {
        ...reversal,
        result: { mode: 'void', outcome: 'not_sent', errorCode, commandId: command.id, commandState, at },
      },
    },
  });
  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId ?? null, operatorId: current.operatorId, branchId: current.branchId,
    action: 'payment.attempt.void_not_sent', entityType: 'payment_attempt', entityId: current.id,
    actionId: current.actionId, requestId: ctx.requestId,
    before: { status: current.status, void: { reason: reversal.reason ?? null, result: null } },
    after: { status: current.status, reason: reversal.reason ?? null, voidActionId: command.actionId,
      commandId: command.id, commandState, errorCode, saleId: current.saleId,
      amountSatang: typeof reversal.amountSatang === 'number' ? reversal.amountSatang : null },
  });
  const refundId = reversal.refundId;
  if (reversal.reason === 'refund' && typeof refundId === 'string' && command.actionId) {
    await settleRefundSlice(tx, {
      refundId,
      match: (entry) => entry.actionId === command.actionId,
      update: { status: 'failed', fallback: 'cash', detail: VOID_NOT_SENT_DETAIL, settledAt: at },
      actorAccountId: null,
      requestId: ctx.requestId,
      action: 'refund.void_refused',
    });
  }
}

// --- When the terminal's answer reached the platform only on the command (SCRUM-979)

/**
 * SCRUM-979 — WHAT THE BOX'S ACKNOWLEDGEMENT CARRIES, against its result post.
 *
 * The box posts the terminal's answer on `POST /payments/attempts/:id/result`
 * (`terminalResultBody`, agent.ts:1973-1994) and then acknowledges the command
 * (agent.ts:4155-4169). When the post is refused — a 404 for a terminal moved
 * to another box since the tender, the rate ceiling, a 5xx — or skipped by a
 * box in offline mode (agent.ts:1962), the box only logs it (:1968-1970) and
 * the acknowledgement still arrives, `succeeded`, with this result:
 *
 *   { attemptId, mode, deviceId, stationId, role, protocol,
 *     outcome, terminalRef, responseCode }
 *
 * The same for GHL and Digio: both adapters answer into one `TerminalResult`
 * (ghl.ts:467-575, digio.ts:657-740) and the acknowledgement is built from it
 * whatever the dialect. It does NOT carry what the post does beside that:
 * requestedSatang, approvedSatang, tranRef, invoiceNo, approvalCode, last4,
 * tid, mid, qrPayload, responseText, elapsedMs, at.
 *
 * Taken, through `recordTerminalResult` as the post would be:
 *  - a SALE `approved`, when the command asked for this attempt's amount. Both
 *    adapters turn an approval for any other amount into `partial_approval`
 *    before the result is built (ghl.ts:542-549, digio.ts:694-713), so the
 *    approved amount is the command's own. Missing: the slip — approval code,
 *    last four, invoice number, transaction id. The receipt prints without
 *    them, and a later refund's terminal void is keyed on the reference
 *    (refunds.ts `queueRefundVoid`), which the terminal may refuse; the
 *    refund then falls back to cash.
 *  - on a SALE or an inquiry: declined, cancelled, not_found, no_response,
 *    timeout, unsupported. None of them needs an amount or a handle.
 *  - a VOID approved, declined, cancelled, not_found or unsupported.
 * Handed to a person (`heldBecause`), because the acknowledgement is too little:
 *  - a SALE `partial_approval`: neither the amount taken nor the transaction
 *    to void it by;
 *  - an inquiry `approved`: an inquiry's amount is not checked on the box
 *    (contract.ts:72-79), and the platform's check needs `approvedSatang`;
 *  - a VOID no_response, timeout or partial_approval: the void may have
 *    reached the terminal, and stays pending for a person, as one that may
 *    have been sent does (SCRUM-972).
 */
const COMMAND_SOURCE = 'box_command';

/** What the post carries and the acknowledgement does not. */
const MISSING_FROM_ACK = [
  'approvedSatang', 'tranRef', 'invoiceNo', 'approvalCode', 'last4', 'tid', 'mid', 'responseText',
] as const;

interface CommandAnswer {
  outcome: TerminalOutcomeKind;
  terminalRef: string | null;
  responseCode: string | null;
  protocol: string | null;
  deviceId: string | null;
}

/** The terminal's answer on a `succeeded` acknowledgement, at the result route's own limits. */
function commandAnswerOf(row: Pick<CommandRow, 'state' | 'result'>): CommandAnswer | null {
  if (row.state !== 'succeeded') return null;
  const result = (row.result ?? null) as Record<string, unknown> | null;
  const outcome = result?.outcome;
  if (typeof outcome !== 'string' || !(TERMINAL_OUTCOME_KINDS as readonly string[]).includes(outcome)) return null;
  const text = (value: unknown, max: number): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
  return {
    outcome: outcome as TerminalOutcomeKind,
    terminalRef: text(result?.terminalRef, 32),
    responseCode: text(result?.responseCode, 8),
    protocol: text(result?.protocol, 32),
    deviceId: text(result?.deviceId, 36),
  };
}

const HELD_WORDS = {
  unreadable: 'The box acknowledged the terminal command with an answer the platform cannot read. Check the terminal before confirming the payment.',
  partial: 'The terminal approved a different amount, and only the box’s acknowledgement reached the platform: it names neither the amount taken nor the transaction to void. Check the terminal before confirming the payment.',
  amount: 'The terminal command asked for a different amount from this payment. Check the terminal before confirming the payment.',
  inquiry: 'The terminal says the payment went through, but only the box’s acknowledgement reached the platform and it carries no amount to check. Check the terminal before confirming the payment.',
  void: 'The terminal gave no final answer to the void, so it may have gone through. A person has to check the terminal.',
} as const;

/** Why this acknowledgement is too little to settle on, or null when it is enough. */
function heldBecause(
  mode: TerminalPhase,
  answer: CommandAnswer | null,
  command: CommandRow,
  current: AttemptRow,
): keyof typeof HELD_WORDS | null {
  if (!answer) return 'unreadable';
  if (mode === 'sale') {
    if (answer.outcome === 'partial_approval') return 'partial';
    const asked = (command.payload as { amountSatang?: unknown } | null)?.amountSatang;
    if (answer.outcome === 'approved' && asked !== current.amountSatang) return 'amount';
    return null;
  }
  if (mode === 'inquire') {
    return answer.outcome === 'approved' || answer.outcome === 'partial_approval' ? 'inquiry' : null;
  }
  return ['no_response', 'timeout', 'partial_approval'].includes(answer.outcome) ? 'void' : null;
}

/** The answer this attempt is waiting on from this command, not yet taken; null otherwise. */
function waitingModeFor(current: AttemptRow, command: CommandRow): TerminalPhase | null {
  const payload = (current.payload ?? {}) as AttemptPayload;
  const mode = commandFacts(command).mode;
  if (mode === 'sale') return ['created', 'sent_to_terminal'].includes(current.status) ? 'sale' : null;
  if (mode === 'inquire') {
    return current.status === 'inquiring' && command.actionId && payload.inquiry?.actionId === command.actionId
      ? 'inquire' : null;
  }
  if (mode === 'void') {
    const reversal = payload.void;
    if (!reversal || !command.actionId || reversal.actionId !== command.actionId || reversal.result) return null;
    // A void already handed to a person from this acknowledgement is not read twice.
    return (reversal.commandAnswer as { commandId?: unknown } | undefined)?.commandId === command.id ? null : 'void';
  }
  return null;
}

/**
 * SCRUM-979 — TAKE THE TERMINAL'S ANSWER OFF THE BOX'S ACKNOWLEDGEMENT, when
 * its result post never landed. The attempt's lock is held. Only the answer the
 * attempt is still waiting on, and only once: a result post that arrives after
 * this changes nothing (`answerTakenFromCommand`), and one that arrived before
 * it has already moved the attempt on, so this finds nothing to do. Never a
 * second SALE or VOID: this writes what the terminal said and queues only what
 * the result route would — an inquiry after a silence.
 */
async function takeCommandAnswer(
  tx: Tx,
  ctx: OpContext,
  current: AttemptRow,
  command: CommandRow,
): Promise<TerminalSettled | null> {
  const mode = waitingModeFor(current, command);
  if (!mode) return null;
  const payload = (current.payload ?? {}) as AttemptPayload;
  const answer = commandAnswerOf(command);
  const at = (command.finishedAt ?? new Date()).toISOString();
  const taken = {
    mode,
    commandId: command.id,
    actionId: command.actionId,
    outcome: answer?.outcome ?? null,
    terminalRef: answer?.terminalRef ?? null,
    responseCode: answer?.responseCode ?? null,
    at,
  };
  const auditAfter = {
    mode,
    commandId: command.id,
    commandState: command.state,
    outcome: taken.outcome,
    responseCode: taken.responseCode,
    missing: [...MISSING_FROM_ACK],
    saleId: current.saleId,
    amountSatang: current.amountSatang,
  };

  const held = heldBecause(mode, answer, command, current);
  if (held) {
    const fromCommand = { ...taken, held, reason: HELD_WORDS[held] };
    const stamped = mode === 'void'
      ? await stampAttempt(tx, current.id, {
          payload: { ...payload, void: { ...(payload.void ?? {}), commandAnswer: fromCommand } },
        })
      : await stampAttempt(tx, current.id, {
          status: 'awaiting_staff_confirmation',
          ...(answer?.terminalRef && !current.terminalRef ? { terminalRef: answer.terminalRef } : {}),
          payload: { ...payload, fromCommand },
        });
    await audit.record(tx, {
      actorAccountId: ctx.actorAccountId ?? null, operatorId: current.operatorId, branchId: current.branchId,
      action: 'payment.attempt.result_from_command', entityType: 'payment_attempt', entityId: current.id,
      actionId: command.actionId ?? current.actionId, requestId: ctx.requestId,
      before: { status: current.status },
      after: { ...auditAfter, status: stamped.status, held },
    });
    return settledFrom(current, command, null);
  }
  // `heldBecause` answers 'unreadable' for no answer; this narrows it for the compiler.
  if (!answer) return null;

  // The same code the result route runs, with what the acknowledgement holds.
  const [deviceRow] = current.deviceId
    ? await tx.select().from(device)
      .where(and(eq(device.id, current.deviceId), eq(device.operatorId, current.operatorId))).limit(1)
    : [];
  const asked = (command.payload as { amountSatang?: unknown } | null)?.amountSatang;
  const recorded = await recordTerminalResult(
    tx,
    ctx,
    { attempt: current, device: deviceRow ?? null },
    {
      deviceId: answer.deviceId ?? commandFacts(command).deviceId,
      protocol: answer.protocol,
      outcome: answer.outcome,
      requestedSatang: typeof asked === 'number' ? asked : current.amountSatang,
      approvedSatang: null,
      terminalRef: answer.terminalRef,
      responseCode: answer.responseCode,
      at,
      source: { commandId: command.id },
    },
    command.actionId,
  );
  if (recorded.replayed) return null;
  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId ?? null, operatorId: current.operatorId, branchId: current.branchId,
    action: 'payment.attempt.result_from_command', entityType: 'payment_attempt', entityId: current.id,
    actionId: command.actionId ?? current.actionId, requestId: ctx.requestId,
    before: { status: current.status },
    after: { ...auditAfter, status: recorded.attempt.status, phase: recorded.phase },
  });
  return settledFrom(current, command, recorded.run);
}

/**
 * An answer the box's acknowledgement already gave, so the result post that
 * arrives after it is a replay. A SALE's handed to a person is not: the post
 * carries what the acknowledgement lacked, and is the terminal's answer.
 */
function answerTakenFromCommand(payload: AttemptPayload, phase: TerminalPhase): boolean {
  if (phase === 'sale') return Boolean(payload.fromCommand && !payload.fromCommand.held);
  if (phase === 'void') return (payload.void?.result as { source?: unknown } | undefined)?.source === COMMAND_SOURCE;
  return false;
}

// --- Finding the command an attempt waits on ---------------------------------

/** Which command an attempt is waiting on, read off the attempt alone. */
function waitingOnOf(row: AttemptRow): { mode: TerminalPhase; actionId: string | null } | null {
  if (!row.deviceId) return null;
  const facts = (row.payload ?? {}) as AttemptPayload;
  if (['created', 'sent_to_terminal'].includes(row.status)) return { mode: 'sale', actionId: null };
  if (row.status === 'inquiring' && typeof facts.inquiry?.actionId === 'string') {
    return { mode: 'inquire', actionId: facts.inquiry.actionId };
  }
  // A void (a refund's, or a partial approval's rescue) still waiting on its answer.
  if (facts.void && !facts.void.result && typeof facts.void.actionId === 'string') {
    return { mode: 'void', actionId: facts.void.actionId };
  }
  return null;
}

/** The SALE command is written in the attempt's own transaction; this only bounds the scan. */
const SALE_COMMAND_WINDOW_MS = 5 * 60_000;

/**
 * SCRUM-979 — THE COMMAND, FOUND BY THE ATTEMPT ITSELF, on whichever of the
 * operator's boxes it was queued: a terminal moved to another box since, or
 * unassigned, no longer points at it. No lock: the caller locks only when
 * there is something to settle.
 *
 * Served by `box_command_history_idx` (box_id, created_at), one short range
 * per box of the operator (`box_operator_idx`): the command is never older
 * than its attempt, and a SALE is written in the attempt's own transaction, so
 * its range is closed five minutes on. An inquiry or a void is found by its
 * action id (`box_command_action_idx`).
 */
async function findTerminalCommand(
  tx: Tx,
  operatorId: string,
  seen: AttemptRow,
  waiting: { mode: TerminalPhase; actionId: string | null },
): Promise<CommandRow | null> {
  const [row] = await tx.select().from(boxCommand).where(and(
    eq(boxCommand.kind, 'terminal_sale'),
    inArray(boxCommand.boxId, tx.select({ id: box.id }).from(box).where(eq(box.operatorId, operatorId))),
    gte(boxCommand.createdAt, seen.createdAt),
    ...(waiting.mode === 'sale'
      ? [lte(boxCommand.createdAt, new Date(seen.createdAt.getTime() + SALE_COMMAND_WINDOW_MS))]
      : [eq(boxCommand.actionId, waiting.actionId ?? '')]),
    inArray(boxCommand.state, ['queued', 'running', 'failed', 'expired', 'succeeded']),
    sql`${boxCommand.payload}->>'attemptId' = ${seen.id}`,
    sql`${boxCommand.payload}->>'deviceId' = ${seen.deviceId}`,
    sql`${boxCommand.payload}->>'mode' = ${waiting.mode}`,
  )).orderBy(asc(boxCommand.createdAt), asc(boxCommand.id)).limit(1);
  return row ?? null;
}

/**
 * Is there anything for the net to settle on this command? Read without a
 * lock (SCRUM-979): a queued command inside its time, or an exchange inside its
 * budget, is the box's business, and locking it on every till poll would make
 * the box's `skip locked` claim pass it over for a poll.
 */
function commandNeedsSettling(command: CommandRow, current: AttemptRow, now: number): boolean {
  switch (command.state) {
    case 'queued':
      return Boolean(command.expiresAt && command.expiresAt.getTime() <= now);
    case 'running':
      return commandFacts(command).mode !== 'void'
        && Boolean(command.claimedAt && now - command.claimedAt.getTime() >= EXCHANGE_BUDGET_MS);
    case 'failed':
    case 'expired':
      return true;
    case 'succeeded':
      return commandFacts(command).answered && waitingModeFor(current, command) !== null;
    default:
      return false;
  }
}

/**
 * The read-time net: a stopped exchange, a failed command, one that expired
 * in the queue, or one the box acknowledged with the terminal's answer on it
 * (SCRUM-979), found when the attempt is read. Never replays SALE or VOID.
 *
 * Read first and lock only when there is something to settle: the attempt's
 * lock, then the command's — the order every other path takes them in — and
 * then everything is looked at again under them.
 */
export async function recoverMissingTerminalResult(
  tx: Tx,
  ctx: OpContext,
  operatorId: string,
  id: string,
): Promise<TerminalSettled | null> {
  const [seen] = await tx.select().from(paymentAttempt)
    .where(and(eq(paymentAttempt.id, id), eq(paymentAttempt.operatorId, operatorId))).limit(1);
  const waiting = seen ? waitingOnOf(seen) : null;
  if (!seen || !waiting) return null;
  const found = await findTerminalCommand(tx, operatorId, seen, waiting);
  if (!found || !commandNeedsSettling(found, seen, Date.now())) return null;

  const [current] = await tx.select().from(paymentAttempt)
    .where(and(eq(paymentAttempt.id, id), eq(paymentAttempt.operatorId, operatorId)))
    .for('update').limit(1);
  const still = current ? waitingOnOf(current) : null;
  if (!current || !still || still.mode !== waiting.mode || still.actionId !== waiting.actionId) return null;
  const [command] = await tx.select().from(boxCommand).where(eq(boxCommand.id, found.id)).for('update').limit(1);
  if (!command) return null;
  return settleCommandForAttempt(tx, ctx, current, command, Date.now());
}

/**
 * The work after a settlement's commit, as the result route does it: the
 * `ops_run` of the terminal's answer, and the write-backs of a pass or a party
 * this money closed. Never throws — the money is committed.
 */
export async function afterTerminalSettled(
  db: Db,
  log: FastifyBaseLogger | undefined,
  settled: TerminalSettled | null,
): Promise<void> {
  if (!settled?.run) return;
  try {
    await recordTerminalRun(db, {
      run: settled.run,
      operatorId: settled.operatorId,
      branchId: settled.branchId,
      stationId: settled.stationId,
      actionId: settled.actionId,
      startedAt: settled.startedAt,
    });
    if (settled.saleId) {
      // Imported here: both modules sit on the sale's import graph, as this one does.
      const { writeBackSalePass } = await import('../booking-event-passes');
      await writeBackSalePass(db, log, settled.saleId);
      const { writeBackPartySettlement } = await import('../party-settlement');
      await writeBackPartySettlement(db, log, settled.saleId);
    }
  } catch (err) {
    log?.error({ err, attemptId: settled.attemptId }, 'a card payment settled at the box could not finish its follow-up');
  }
}

/** The read-time net in a transaction of its own, then its follow-up. True when it wrote. */
export async function recoverTerminalAttempt(
  db: Db,
  ctx: OpContext,
  operatorId: string,
  id: string,
): Promise<boolean> {
  const settled = await db.transaction((tx) => recoverMissingTerminalResult(tx, ctx, operatorId, id));
  await afterTerminalSettled(db, ctx.log, settled);
  return settled !== null;
}

/**
 * SCRUM-979 — A SALE'S READ FREES ITS HELD CARD PAYMENTS. History's detail
 * reads `GET /sales/:id`, and an attempt held only because nobody had read it
 * kept "Void unpaid sale" hidden there. Only this one sale's attempts that are
 * waiting on the terminal; each in a transaction of its own, and one that fails
 * is logged and never stops the read. The number that changed.
 */
export async function recoverSaleTerminalAttempts(
  db: Db,
  ctx: OpContext,
  operatorId: string,
  saleId: string,
): Promise<number> {
  const rows = await db.select().from(paymentAttempt).where(and(
    eq(paymentAttempt.saleId, saleId), eq(paymentAttempt.operatorId, operatorId), isNotNull(paymentAttempt.deviceId),
  ));
  let changed = 0;
  for (const row of rows) {
    if (!waitingOnOf(row)) continue;
    try {
      if (await recoverTerminalAttempt(db, ctx, operatorId, row.id)) changed += 1;
    } catch (err) {
      ctx.log?.error({ err, attemptId: row.id, saleId }, 'a held card payment could not be settled on the sale read');
    }
  }
  return changed;
}

/** How many held terminal tenders one sweep looks at. */
export const HELD_TENDERS_PER_SWEEP = 25;

/**
 * SCRUM-979 — THE SWEEP FREES HELD CARD PAYMENTS NOBODY READS. The attempts
 * `job:payments.pending` would list as waiting on a terminal (sent or being
 * asked, older than the cut-off, at a counter), newest first and at most
 * `HELD_TENDERS_PER_SWEEP` a run; each through the read-time net in a
 * transaction of its own, and a failure of one never stops the others.
 * `unknown` is not looked at: nothing at the box can move it, only a person.
 */
export async function recoverHeldTerminalTenders(
  db: Db,
  ctx: OpContext,
  cutoff: Date,
): Promise<{ tried: number; recovered: number; failed: number }> {
  const rows = await db
    .select({ id: paymentAttempt.id, operatorId: paymentAttempt.operatorId })
    .from(paymentAttempt)
    .where(and(
      inArray(paymentAttempt.status, ['sent_to_terminal', 'inquiring']),
      sql`${paymentAttempt.createdAt} < ${cutoff}`,
      isNotNull(paymentAttempt.stationId),
      isNotNull(paymentAttempt.deviceId),
    ))
    .orderBy(desc(paymentAttempt.createdAt))
    .limit(HELD_TENDERS_PER_SWEEP);
  let recovered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (await recoverTerminalAttempt(db, ctx, row.operatorId, row.id)) recovered += 1;
    } catch (err) {
      failed += 1;
      ctx.log?.error({ err, attemptId: row.id }, 'the payments sweep could not settle a held card payment');
    }
  }
  return { tried: rows.length, recovered, failed };
}

/**
 * SCRUM-979 — A TERMINAL COMMAND THAT EXPIRED IN THE BOX'S QUEUE, settled
 * right after the transaction that expired it: the claim-time expiry in
 * `pollCommands` and the hourly `expireStaleCommands` hold the commands' row
 * locks in their own statement, and the attempt's lock has to come first. A
 * refund's void that never left the queue falls back to cash; a SALE frees its
 * sale. Each command in a transaction of its own; never throws.
 */
export async function settleExpiredTerminalCommands(
  db: Db,
  ctx: OpContext,
  commandIds: readonly string[],
): Promise<number> {
  let settled = 0;
  for (const commandId of commandIds) {
    try {
      const done = await db.transaction(async (tx) => {
        const [row] = await tx.select({ operatorId: box.operatorId }).from(boxCommand)
          .innerJoin(box, eq(box.id, boxCommand.boxId)).where(eq(boxCommand.id, commandId)).limit(1);
        return row ? settleEndedTerminalCommand(tx, ctx, row.operatorId, commandId) : null;
      });
      await afterTerminalSettled(db, ctx.log, done);
      if (done) settled += 1;
    } catch (err) {
      ctx.log?.error({ err, commandId }, 'an expired terminal command could not settle its payment');
    }
  }
  return settled;
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
export async function queueTerminalCommand(
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
    // The command keeps a void's approval code (the terminal needs it); the
    // audit row does not, masked as the redactor masks it everywhere else.
    after: {
      commandId: id,
      kind: 'terminal_sale',
      payload: input.payload.approvalCode ? { ...input.payload, approvalCode: '[redacted]' } : input.payload,
      actionId: input.actionId,
    },
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
   * above; `assertSaleVouchersHeld` locks the voucher after it. S2-21 round 3 —
   * nor on a sale whose staff benefit was taken off or moved to the order rung
   * up again (BENEFIT_APPLICATION_RELEASED): the close would refuse it, and a
   * card approved here would leave the money on a sale that cannot close.
   */
  await assertSaleExtensionCollectable(tx, saleRow.id);
  await assertSaleBenefitsLive(tx, saleRow.id);
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
  /**
   * SCRUM-514 — nor on a sale holding a promo code whose last use another sale
   * has taken since this one was rung up (PROMO_CODE_USED_UP), counted under
   * the code's lock as the close counts it — asked before the guest is asked
   * for money, and only while none has been taken: a part payment already in
   * is not left on a sale that cannot close.
   */
  if ((await outstandingAfter(tx, saleRow)) === saleRow.grossSatang) {
    await assertSalePromoUsesLeft(tx, saleRow);
    // SCRUM-740 — nor for a child another sale has paid for since (CHECKIN_PAID_AT_TILL).
    await refuseTenderOnStaysPaidAtTill(tx, saleRow);
  }

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
  const routing = stationPaymentRoutes(stationRow.paymentRouting);
  /**
   * A STATION THAT HAS NEVER BEEN CONFIGURED USES ITS TERMINAL, for the reason
   * `resolveDrawerKick` gives about the drawer: `payment_routing` is absent on
   * every station the platform has today and the park's counters all have an
   * EDC. `card: 'manual'` is how a station says otherwise, and it is honoured.
   */
  if (tender === 'card' && routing.card === 'manual') {
    return { route: 'manual', attempt: null, replayed: false, outstandingSatang: owed };
  }

  const stamped = await sendTenderToTerminal(tx, actor, {
    operatorId: saleRow.operatorId,
    branchId: saleRow.branchId,
    stationRow,
    businessDate: saleRow.businessDate,
    saleId: saleRow.id,
    amountSatang,
    tender,
    ...(input.methodCode ? { methodCode: input.methodCode } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    wallet: input.wallet ?? null,
    cashier: input.cashier ?? null,
    ...(input.requestQrPayload ? { requestQrPayload: true } : {}),
    ...(input.qrDirection ? { qrDirection: input.qrDirection } : {}),
    actionId: input.actionId ?? null,
  });

  return {
    route: 'card_terminal',
    attempt: attemptView(stamped),
    replayed: false,
    outstandingSatang: owed,
  };
}

export interface TerminalTenderTarget {
  operatorId: string;
  branchId: string;
  stationRow: typeof station.$inferSelect;
  /** The trading day the tender belongs to. */
  businessDate: string;
  /** Null for money with no sale behind it: a party's balance (SCRUM-732). */
  saleId: string | null;
  amountSatang: number;
  tender: TerminalTender;
  methodCode?: string;
  kind?: string;
  wallet?: string | null;
  cashier?: string | null;
  requestQrPayload?: boolean;
  qrDirection?: 'show' | 'scan';
  actionId?: string | null;
  /** The action id the box carries back, when the attempt's own is not one it can carry. */
  commandActionId?: string;
  /** What the tender's owner keeps on the attempt. */
  payload?: Record<string, unknown>;
}

/**
 * The terminal half of pressing Card, whoever owns the tender: find the device
 * the station routes it to, open the attempt, give the box the instruction, all
 * in the caller's transaction. Refuses a counter nothing can reach.
 */
export async function sendTenderToTerminal(
  tx: Tx,
  actor: TenderActor,
  target: TerminalTenderTarget,
): Promise<typeof paymentAttempt.$inferSelect> {
  const { stationRow, tender, amountSatang, operatorId, branchId, saleId, businessDate } = target;
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

  const methodCode = target.methodCode ?? DEFAULT_TOKEN[tender];
  const method = await tenderMethodOf(tx, actor.operatorId, methodCode, target.kind);

  const opened = await openAttempt(tx, {
    operatorId,
    branchId,
    stationId: stationRow.id,
    deviceId: terminalRow.id,
    businessDate,
    saleId,
    method,
    methodCode,
    provider: providerFor(terminalRow),
    amountSatang,
    actionId: target.actionId ?? null,
    payload: {
      takenByAccountId: actor.accountId,
      ...(target.actionId ? { actionId: target.actionId } : {}),
      ...(target.kind ? { kind: target.kind } : {}),
      protocol,
      deviceLabel: terminalRow.label,
      tender,
      ...(target.wallet ? { wallet: target.wallet } : {}),
      ...target.payload,
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

  const actionId = target.commandActionId ?? target.actionId ?? newId();
  await queueTerminalCommand(tx, {
    boxId: terminalRow.boxId,
    branchId,
    operatorId,
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
      ...(target.wallet ? { wallet: target.wallet } : {}),
      ...(target.cashier ? { cashier: target.cashier } : {}),
      ...(target.requestQrPayload ? { requestQrPayload: true } : {}),
      ...(target.qrDirection ? { qrDirection: target.qrDirection } : {}),
    },
  });

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId,
    branchId,
    action: 'payment.tender.start',
    entityType: 'payment_attempt',
    entityId: opened.id,
    actionId: target.actionId ?? null,
    requestId: actor.requestId,
    after: {
      saleId,
      stationId: stationRow.id,
      deviceId: terminalRow.id,
      method,
      methodCode,
      tender,
      amountSatang,
      status: 'sent_to_terminal',
    },
  });

  return stamped;
}

// --- A pass waiting on this money ---------------------------------------------

/**
 * SCRUM-732 — A PASS DOES NOT WAIT FOR ITS TILL. A completed payment always lands
 * a roster entry, and a card answers the platform whether or not the till that
 * pressed it is still on screen. A sale whose tender a till pressed is otherwise
 * closed by that till; a pass is closed here, as a gateway QR's sale is closed
 * when the gateway answers (`settleWithin`), so the child lands with the money.
 * The till's own close afterwards is answered as the replay it then is.
 *
 * ONLY WHEN THE BALANCE IS ZERO: `finaliseSale` with no tender takes what is still
 * owed in cash. In a savepoint, because the money is the fact to keep: a close
 * that fails leaves the sale for the till, and never undoes the settlement.
 */
async function closeHeldPass(
  tx: Tx,
  settled: typeof paymentAttempt.$inferSelect,
  requestId: string | null | undefined,
  log?: OpContext['log'],
): Promise<void> {
  const saleId = settled.saleId;
  if (!saleId) return;
  const [hold] = await tx
    .select({ id: eventPassHold.id })
    .from(eventPassHold)
    .where(and(eq(eventPassHold.saleId, saleId), eq(eventPassHold.status, 'pending')))
    .limit(1);
  if (!hold) return;
  const accountId = (settled.payload as AttemptPayload | null)?.takenByAccountId;
  if (!accountId) return;
  const [saleRow] = await tx
    .select({ id: sale.id, grossSatang: sale.grossSatang, status: sale.status })
    .from(sale)
    .where(eq(sale.id, saleId))
    .limit(1);
  if (saleRow?.status !== 'tendering' || (await outstandingAfter(tx, saleRow)) > 0) return;
  try {
    await tx.transaction((sp) =>
      finaliseSale(
        sp,
        {
          accountId,
          operatorId: settled.operatorId,
          branchId: settled.branchId,
          ...(requestId ? { requestId } : {}),
        },
        saleId,
        { actionId: settled.actionId },
      ),
    );
  } catch (err) {
    log?.error({ err, attemptId: settled.id, saleId }, 'a paid pass could not close its sale here; the till closes it');
  }
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
    // SCRUM-979 — read off the box's acknowledgement, not posted.
    ...(report.source ? { source: COMMAND_SOURCE, commandId: report.source.commandId } : {}),
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

  /**
   * SCRUM-979 — AN ANSWER ALREADY TAKEN FROM THE BOX'S ACKNOWLEDGEMENT. The
   * box posts before it acknowledges, so this is a post that was lost, slow or
   * retried: the terminal said one thing, once, and it is already recorded.
   * Nothing is written, and no second inquiry is queued.
   */
  if (!report.source && answerTakenFromCommand(payload, phase)) {
    return { attempt: attemptView(current), replayed: true, phase, run };
  }

  // --- A void's answer never moves the attempt ------------------------------
  if (phase === 'void') {
    const stamped = await stampAttempt(tx, current.id, {
      payload: {
        ...payload,
        void: { ...(payload.void ?? {}), result: facts },
      },
    });
    /**
     * S2-11 — A REFUND'S VOID. The attempt stays `approved` (the money was
     * taken; the refund row is what says it went back), and the slice of the
     * refund that asked for this void learns how it ended: approved is money
     * back on the card; anything else is the terminal refusing — its void
     * window closed at settlement, or the dialect cannot void this tender — and
     * the slice falls back to cash, which staff hand over.
     */
    const refundId = payload.void?.refundId;
    if (payload.void?.reason === 'refund' && typeof refundId === 'string' && actionId) {
      const voided = report.outcome === 'approved';
      await settleRefundSlice(tx, {
        refundId,
        match: (entry) => entry.actionId === actionId,
        update: voided
          ? { status: 'done', detail: 'Voided on the terminal', respCode: report.responseCode ?? null, settledAt: new Date().toISOString() }
          : {
              status: 'failed',
              fallback: 'cash',
              respCode: report.responseCode ?? null,
              detail: `The terminal refused the void (${report.responseText ?? report.outcome}) — hand it back in cash`,
              settledAt: new Date().toISOString(),
            },
        actorAccountId: null,
        requestId: ctx.requestId,
        action: voided ? 'refund.void_approved' : 'refund.void_refused',
      });
    }
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
    // SCRUM-979 — the SALE's answer came off the acknowledgement: a late post is a replay.
    ...(report.source && phase === 'sale'
      ? { fromCommand: { mode: 'sale', commandId: report.source.commandId, outcome: report.outcome, at: facts.at } }
      : {}),
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
    if (!current.saleId) {
      // SCRUM-732 — no sale closes on this money, so its landing is recorded here.
      await audit.record(tx, {
        actorAccountId: null,
        operatorId: current.operatorId,
        branchId: current.branchId,
        action: 'payment.settled',
        entityType: 'payment_attempt',
        entityId: current.id,
        actionId: current.actionId,
        requestId: ctx.requestId,
        before: { status: current.status },
        after: { status: settled.status, source: 'terminal', amountSatang: settled.amountSatang, saleId: null },
      });
    }
    await closeHeldPass(tx, settled, ctx.requestId, ctx.log);
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
  // SCRUM-979 — and a box to ask it through: an `inquiring` with no inquiry
  // queued would wait for ever. Only an acknowledgement can arrive for a
  // terminal taken off its box; a post comes from the terminal's own box.
  const canAsk =
    canInquire(protocol, tender) && Boolean(report.terminalRef ?? current.terminalRef) && Boolean(deviceRow?.boxId);
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
 * The refused attempt is left `declined`, and the sale is untouched. That word
 * does not prove the partial charge was returned: its saved VOID facts keep
 * the balance reserved until the rescue succeeds. The void uses a FRESH
 * reference (the counter on the box mints
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
 *
 * SCRUM-390 — ONLY WHILE THE ATTEMPT IS IN FLIGHT. A progress post is the box
 * telling us what the terminal drew before the answer; one that arrives late
 * or twice, after the final result has settled the attempt, would overwrite
 * the reference a reconciliation searches by. It is read under the attempt's
 * row lock (the lock the final result takes) and answered with the attempt as
 * it stands, nothing written, once the attempt has left flight.
 */
export async function recordTerminalProgress(
  tx: Tx,
  loaded: LoadedAttempt,
  report: TerminalProgressReport,
): Promise<PaymentAttemptView> {
  if (report.kind !== 'qr_payload' || !report.qrPayload) {
    return attemptView(loaded.attempt);
  }
  const [locked] = await tx
    .select()
    .from(paymentAttempt)
    .where(eq(paymentAttempt.id, loaded.attempt.id))
    .for('update')
    .limit(1);
  const current = locked ?? loaded.attempt;
  if (!IN_FLIGHT.includes(current.status)) return attemptView(current);
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
  log?: OpContext['log'],
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
  if (input.took) await closeHeldPass(tx, row, actor.requestId, log);
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
   * for it (VOUCHER_NOT_HELD), nor against one whose staff benefit is no
   * longer its own (BENEFIT_APPLICATION_RELEASED).
   */
  await assertSaleExtensionCollectable(tx, saleRow.id);
  await assertSaleBenefitsLive(tx, saleRow.id);
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
