import { and, asc, desc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  branch,
  conversation,
  inboxEvent,
  message,
  partyDepositRequest,
  partyEdit,
  paymentAttempt,
  team,
  type Db,
  type PartyDepositRequestState,
} from '@oto/db';
import {
  PARTY_DEPOSIT_REFUSALS,
  PARTY_LINE_STATUSES,
  businessDate,
  deriveId,
  isoDateInTz,
  parseDayStart,
  type PartyDepositActionAnswer,
  type PartyDepositAnswer,
  type PartyDepositRequestView,
  type PartyLineStatus,
  type PartyMessageAnswer,
  type PartyStoredEditFields,
} from '@oto/shared';
import type { Env } from '../env';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { contactOf } from './inbox/handover-notice';
import {
  lockedConversation,
  partyAmountWords,
  partyClockWords,
  partyDateWords,
  partyMessageId,
  partyMessageLanguageOf,
  postPartyMessage,
  sendPartyMessages,
  type PartyMessageSender,
} from './inbox/party-messages';
import { routeConversation } from './inbox/router';
import type { OtoAppDirectory } from './otoapp-directory';
import { getEventAtBranches, type SeamEvent } from './otoapp-events';
import { pushPartyEdit, seamRead } from './parties';
import { actorAccountOf } from './party-menu';
import { lockParty } from './party-tab';
import { failAttempt, openAttempt, type AttemptRow } from './payments/attempt';
import { gatewayFor, gatewayProviderOf, mintWebInvoiceNo, requestHostedPayment } from './payments/gateway';
import { withTx, type Exec, type OpContext, type Tx } from './tx';

/**
 * SCRUM-825 — A DEPOSIT REQUESTED FROM THE BEO, PAID THROUGH THE GATEWAY'S
 * PAGE AND WATCHED BY THE PLATFORM.
 *
 * THE HOME IS THE BEO, NOT THE INBOX. Staff set an amount in the Billing
 * section and press "Request deposit"; the OTO App's server asks this
 * platform through its provisioning-key door (`routes/otoapp-party-deposit.ts`).
 * What happens then, and where each piece of it lives:
 *
 *   REQUEST    `requestPartyDeposit` — three acts, the booking checkout's shape
 *              (`booking-checkout.ts`): (1) the request row and a station-less
 *              gateway attempt on the `WEB` segment, committed; (2) the hosted
 *              page asked of the gateway outside any transaction
 *              (`requestHostedPayment`, which closes the attempt declined when
 *              the gateway refuses); (3) the link written onto the request and
 *              the assistant's ONE message posted in the family's chat
 *              (`inbox/party-messages.ts`), in their language, with the amount,
 *              the party's date, the link and its validity; a `deposit_requested`
 *              pill beside it. The request's id is derived from the app's
 *              Idempotency-Key: the same press again answers the same request.
 *              One open request per party. A page the gateway would not open
 *              closes the request `cancelled` (`gateway_refused`) with nothing
 *              posted, and the same key again is answered the same refusal —
 *              never a "request made" over a closed row.
 *   PAID       `confirmPartyDepositPaid`, INSIDE the gateway settlement's own
 *              transaction (`payments/gateway.ts` `settleWithin`, reached only
 *              on inquiry-agreed facts, exactly as a booking is): the request
 *              `paid`, the party's ONE deposit figure — read as the app holds
 *              it NOW, at whichever of the operator's parks the party is at;
 *              a party that cannot be read rolls the settlement back for the
 *              next notification or inquiry, never counts as zero — moved by
 *              the amount and written to the OTO App through the party-edit
 *              path (SCRUM-804, `write_back_edit_id`) as a FACT the app
 *              records whatever it changed since (`fields.fact`), the
 *              confirmation posted, a `deposit_paid` pill. After the commit
 *              (`afterPartyDepositPaid`) the edit is pushed, the line sent,
 *              and the birthday manager's bell rung through the app's
 *              directory.
 *   EXPIRED    `closePartyDepositUnpaid`, inside the gateway's close of the
 *              attempt (`applyNonPaidState`): the link ran out unpaid, or the
 *              gateway closed it — the request is over; the next "Request
 *              deposit" re-issues a fresh link as a new request.
 *   CANCELLED  `cancelPartyDeposit`: staff withdrew it; the attempt is closed
 *              and the gateway told, best effort.
 *   RESEND     `resendPartyDeposit`: the same link posted again, ONE line per
 *              press (the press's key names the line).
 *   FOLLOW-UP  `runPartyDepositFollowUpJob`, every minute: unpaid
 *              `PARTY_DEPOSIT_REMINDER_MIN` after the request, ONE reminder;
 *              unpaid `PARTY_DEPOSIT_HANDOVER_MIN` after the reminder, the
 *              thread handed to the birthday manager — the holding line, an
 *              `ai_handover` the assistant stands back on, the thread moved
 *              to Birthdays & Events where it is not there, the bell.
 *   MENU       `postPartyMenuLink` and `postPartyMenuReceived`: the parent's
 *              set-menu link posted with the right words, and their choices
 *              confirmed when the app says they landed.
 *
 * NOTHING HERE WRITES MONEY ON THE PARTY'S TAB. The deposit is the app's one
 * figure (SCRUM-813): the till reads it from the app's view and records it on
 * the settlement sale as "Deposit paid in advance" (SCRUM-804). A paid request
 * is the attempt's `approved` row plus the write-back; a `party_payment` row
 * here would be counted twice at the settlement.
 */

export const PARTY_DEPOSIT_FOLLOW_UP_JOB = 'job:party.deposit_follow_up';
export const PARTY_DEPOSIT_FOLLOW_UP_INTERVAL_S = 60;
/** How many requests one tick reminds or hands over, each. A bound on the tick. */
const FOLLOW_UP_BATCH = 25;

/** The return page the gateway sends the family's browser to, on this api. */
export const PARTY_DEPOSIT_RETURN_PATH = '/public/parties/deposit/return';
/** Relative to the simulator's own page (`/webhooks/2c2p/hosted/:id`), as the booking's is. */
const SIMULATOR_RETURN_PATH = '../../../public/parties/deposit/return';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The close reason of a request whose page the gateway would not open. */
const GATEWAY_REFUSED = 'gateway_refused';

type RequestRow = typeof partyDepositRequest.$inferSelect;
type ConversationRow = typeof conversation.$inferSelect;

/** The deposit's own refusal when the gateway would not open its page: said on the press, and again on the same key. */
const pageNotOpened = () => new AppError(400, PARTY_DEPOSIT_REFUSALS.PAGE_NOT_OPENED.code, PARTY_DEPOSIT_REFUSALS.PAGE_NOT_OPENED.message);

// --- The deployment's hooks ----------------------------------------------------------

export interface PartyDepositHooks {
  /** The OTO App's directory, as the app holds it: the write-back and the bell. */
  directory: () => OtoAppDirectory | null;
  /** The inbox's send path, as the routes hold it. */
  sender: () => PartyMessageSender | null;
}

let hooks: PartyDepositHooks | null = null;

/** Set once at start-up (`app.ts`), read at each use, so a test's stubs are the ones used. */
export function configurePartyDeposit(next: PartyDepositHooks | null): void {
  hooks = next;
}

const directoryNow = (): OtoAppDirectory | null => hooks?.directory() ?? null;
const senderNow = (): PartyMessageSender | null => hooks?.sender() ?? null;

// --- Reading ---------------------------------------------------------------------------

/** The request's id from the operator and the app's Idempotency-Key: derived, never minted. */
export function partyDepositRequestId(operatorId: string, idempotencyKey: string): string {
  return deriveId(operatorId, `party-deposit-request:${idempotencyKey}`);
}

const partyNotFound = () => errors.notFound('Party not found');

/** The party, at one of the operator's branches: the tenant fence of every read here. */
async function partyOfOperator(db: Exec, operatorId: string, eventId: string): Promise<SeamEvent> {
  if (!UUID.test(eventId)) throw partyNotFound();
  const parks = await db.select({ id: branch.id }).from(branch).where(eq(branch.operatorId, operatorId));
  const found = await seamRead(() => getEventAtBranches(db, { branchIds: parks.map((p) => p.id), eventId }));
  if (!found || found.type !== 'party') throw partyNotFound();
  return found;
}

/**
 * A request's party as the OTO App holds it NOW, at whichever of the operator's
 * parks it is at: a party moved between parks after the request is still this
 * request's. Null when no park of the operator has it (or the view cannot be
 * read); what that means is the caller's to say.
 */
async function partyOfRow(exec: Exec, row: Pick<RequestRow, 'operatorId' | 'otoappEventId'>): Promise<SeamEvent | null> {
  const parks = await exec.select({ id: branch.id }).from(branch).where(eq(branch.operatorId, row.operatorId));
  return getEventAtBranches(exec, { branchIds: parks.map((p) => p.id), eventId: row.otoappEventId });
}

/** The family's thread for the party: the conversation Book Date linked to it, the newest when several. */
async function conversationOfParty(db: Exec, operatorId: string, eventId: string): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(conversation)
    .where(and(eq(conversation.operatorId, operatorId), eq(conversation.eventOrderRef, eventId)))
    .orderBy(desc(conversation.createdAt))
    .limit(1);
  return row ?? null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function viewOf(db: Exec, row: RequestRow): Promise<PartyDepositRequestView> {
  const [edit] = row.writeBackEditId
    ? await db
        .select({ id: partyEdit.id, syncState: partyEdit.syncState, syncError: partyEdit.syncError })
        .from(partyEdit)
        .where(eq(partyEdit.id, row.writeBackEditId))
        .limit(1)
    : [];
  // Where the request line stands with the channel: queued, sent, failed… — so the BEO never says "in the chat" of a line that is not.
  const [line] = row.requestMessageId
    ? await db
        .select({ status: message.providerStatus })
        .from(message)
        .where(and(eq(message.operatorId, row.operatorId), eq(message.id, row.requestMessageId)))
        .limit(1)
    : [];
  const lineStatus = line?.status ?? null;
  return {
    id: row.id,
    eventId: row.otoappEventId,
    conversationId: row.conversationId,
    amountSatang: row.amountSatang,
    currency: row.currency,
    state: row.state,
    paymentLink: row.paymentLink,
    linkExpiresAt: iso(row.linkExpiresAt),
    invoiceNo: row.invoiceNo,
    requestedAt: row.requestedAt.toISOString(),
    remindedAt: iso(row.remindedAt),
    handedOverAt: iso(row.handedOverAt),
    paidAt: iso(row.paidAt),
    closedAt: iso(row.closedAt),
    closeReason: row.closeReason,
    depositBeforeSatang: row.depositBeforeSatang,
    depositAfterSatang: row.depositAfterSatang,
    writeBack: edit ? { editId: edit.id, syncState: edit.syncState, syncError: edit.syncError } : null,
    requestLineStatus:
      lineStatus && (PARTY_LINE_STATUSES as readonly string[]).includes(lineStatus) ? (lineStatus as PartyLineStatus) : null,
  };
}

/** `GET /otoapp/parties/:eventId/deposit-request` — the open request, else the newest; and every one. */
export async function partyDepositOf(db: Db, q: { operatorId: string; eventId: string }): Promise<PartyDepositAnswer> {
  const party = await partyOfOperator(db, q.operatorId, q.eventId);
  const rows = await db
    .select()
    .from(partyDepositRequest)
    .where(and(eq(partyDepositRequest.operatorId, q.operatorId), eq(partyDepositRequest.otoappEventId, party.id)))
    .orderBy(desc(partyDepositRequest.requestedAt), desc(partyDepositRequest.id));
  const history = await Promise.all(rows.map((r) => viewOf(db, r)));
  const current = history.find((r) => r.state === 'requested') ?? history[0] ?? null;
  return {
    eventId: party.id,
    hasConversation: (await conversationOfParty(db, q.operatorId, party.id)) !== null,
    current,
    history,
  };
}

/** The newest request of a party, for the inbox's event chip; null when none. */
export async function latestPartyDepositOf(
  db: Exec,
  q: { operatorId: string; eventId: string },
): Promise<{ id: string; state: PartyDepositRequestState; amountSatang: number } | null> {
  if (!UUID.test(q.eventId)) return null;
  const [row] = await db
    .select({ id: partyDepositRequest.id, state: partyDepositRequest.state, amountSatang: partyDepositRequest.amountSatang })
    .from(partyDepositRequest)
    .where(and(eq(partyDepositRequest.operatorId, q.operatorId), eq(partyDepositRequest.otoappEventId, q.eventId)))
    .orderBy(desc(partyDepositRequest.requestedAt), desc(partyDepositRequest.id))
    .limit(1);
  return row ?? null;
}

// --- The words -----------------------------------------------------------------------------

interface BranchClock {
  id: string;
  name: string;
  timezone: string;
  dayStart: string;
}

async function clockOf(db: Exec, operatorId: string, branchId: string): Promise<BranchClock> {
  const [row] = await db
    .select({ id: branch.id, name: branch.name, timezone: branch.timezone, dayStart: branch.businessDayStart })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Branch not found');
  return row;
}

/** The request line's placeholders, in the family's language. */
function requestVariables(
  row: Pick<RequestRow, 'amountSatang' | 'paymentLink' | 'linkExpiresAt'>,
  party: Pick<SeamEvent, 'startDate'>,
  clock: BranchClock,
  language: string | null,
): Record<string, string> {
  const lang = partyMessageLanguageOf(language);
  return {
    amount: partyAmountWords(row.amountSatang),
    date: partyDateWords(party.startDate, lang),
    link: row.paymentLink ?? '',
    validUntil: row.linkExpiresAt ? partyClockWords(row.linkExpiresAt, clock.timezone, lang) : '',
  };
}

/** What every deposit pill carries: ids and figures, never the link. */
const pillPayload = (row: Pick<RequestRow, 'id' | 'amountSatang' | 'currency' | 'linkExpiresAt' | 'otoappEventId'>) => ({
  requestId: row.id,
  eventId: row.otoappEventId,
  amountSatang: row.amountSatang,
  currency: row.currency,
  linkExpiresAt: iso(row.linkExpiresAt),
});

// --- The request -----------------------------------------------------------------------

export interface PartyDepositRequestInput {
  operatorId: string;
  eventId: string;
  amountSatang: number;
  idempotencyKey: string;
  actorAppUserId: string;
  conversationId?: string | null;
}

/**
 * Where the family's browser comes back to after the gateway's page: this
 * api's own return page. The simulator's page is on this api, so its return
 * is the relative path (as the booking's is); the real gateway needs an
 * absolute address — the origin the webhook address names
 * (`PGW_BACKEND_RETURN_URL`, this api's own by definition), else the one the
 * booking site's return is configured on (`PGW_FRONTEND_RETURN_URL`).
 */
export function partyDepositReturnUrlOf(env: Env, provider: '2c2p' | 'simulator'): string | null {
  if (provider === 'simulator') return SIMULATOR_RETURN_PATH;
  const own = env.PGW_BACKEND_RETURN_URL.trim();
  if (own) {
    try {
      return new URL(PARTY_DEPOSIT_RETURN_PATH, new URL(own).origin).toString();
    } catch {
      /* not an address: the frontend return below */
    }
  }
  const configured = env.PGW_FRONTEND_RETURN_URL.trim();
  if (!configured) return null;
  try {
    return new URL(PARTY_DEPOSIT_RETURN_PATH, configured).toString();
  } catch {
    return null;
  }
}

/**
 * The page's link as the family receives it. The gateway's page is an
 * absolute URL already; the simulator's is this api's own path
 * (`/webhooks/2c2p/hosted/:attemptId`), made absolute on the origin the
 * webhook address names (`PGW_BACKEND_RETURN_URL`), so a demo deployment's
 * chat still carries a link that opens. Left as it is when no origin is known.
 */
export function partyDepositLinkOf(env: Env, webPaymentUrl: string): string {
  if (/^https?:\/\//i.test(webPaymentUrl)) return webPaymentUrl;
  // The webhook's address first; else this api's own public address, so a chat never carries a bare path.
  const base = env.PGW_BACKEND_RETURN_URL.trim() || env.RENDER_EXTERNAL_URL.trim();
  if (!base) return webPaymentUrl;
  try {
    return new URL(webPaymentUrl, new URL(base).origin).toString();
  } catch {
    return webPaymentUrl;
  }
}

/**
 * `POST /otoapp/parties/:eventId/deposit-request` — see the header: three
 * acts, the same press again the same request, one open request per party.
 */
export async function requestPartyDeposit(
  db: Db,
  env: Env,
  log: FastifyBaseLogger,
  ctx: OpContext,
  input: PartyDepositRequestInput,
  now: Date = new Date(),
): Promise<PartyDepositActionAnswer> {
  const requestId = partyDepositRequestId(input.operatorId, input.idempotencyKey);
  const party = await partyOfOperator(db, input.operatorId, input.eventId);
  const replay = async (row: RequestRow): Promise<PartyDepositActionAnswer> => {
    if (row.operatorId !== input.operatorId || row.otoappEventId !== party.id || row.amountSatang !== input.amountSatang) {
      throw errors.conflict('IDEMPOTENCY_MISMATCH', 'Idempotency-Key was already used with a different request');
    }
    // The gateway would not open the page for this press: the same press is
    // the same refusal, never "already asked" over a row nothing was posted for.
    if (row.state === 'cancelled' && row.closeReason === GATEWAY_REFUSED) throw pageNotOpened();
    return { request: await viewOf(db, row), replayed: true };
  };
  const [prior] = await db.select().from(partyDepositRequest).where(eq(partyDepositRequest.id, requestId)).limit(1);
  if (prior) return replay(prior);

  if (party.archived) throw errors.conflict('EVENT_ARCHIVED', 'This party has been archived in the OTO App');
  const provider = gatewayProviderOf(env);
  const returnUrl = partyDepositReturnUrlOf(env, provider);
  if (!returnUrl) throw errors.conflict(PARTY_DEPOSIT_REFUSALS.NOT_CONFIGURED.code, PARTY_DEPOSIT_REFUSALS.NOT_CONFIGURED.message);
  const conv = await conversationOfParty(db, input.operatorId, party.id);
  if (!conv) throw errors.conflict(PARTY_DEPOSIT_REFUSALS.NO_CONVERSATION.code, PARTY_DEPOSIT_REFUSALS.NO_CONVERSATION.message);
  if (input.conversationId && input.conversationId.toLowerCase() !== conv.id.toLowerCase()) {
    throw errors.conflict(PARTY_DEPOSIT_REFUSALS.CONVERSATION_MISMATCH.code, PARTY_DEPOSIT_REFUSALS.CONVERSATION_MISMATCH.message, {
      conversationId: conv.id,
    });
  }
  const clock = await clockOf(db, input.operatorId, party.branchId);
  // Asked before the transaction, so a failed operation's own audit row names them too.
  const actorAccountId = await actorAccountOf(db, input.operatorId, input.actorAppUserId);
  const scope: OpContext = { ...ctx, operatorId: input.operatorId, branchId: party.branchId, actorAccountId, idempotency: undefined };

  // Act 1 — the request and its attempt, committed before the gateway is asked anything.
  const prepared = await withTx(db, scope, 'party_deposit.request', async (tx) => {
    await lockParty(tx, party.id);
    const [again] = await tx.select().from(partyDepositRequest).where(eq(partyDepositRequest.id, requestId)).limit(1);
    if (again) return { row: again, attempt: null as AttemptRow | null, raced: true };
    const [open] = await tx
      .select({ id: partyDepositRequest.id, amountSatang: partyDepositRequest.amountSatang })
      .from(partyDepositRequest)
      .where(and(eq(partyDepositRequest.otoappEventId, party.id), eq(partyDepositRequest.state, 'requested')))
      .limit(1);
    if (open) {
      throw errors.conflict(PARTY_DEPOSIT_REFUSALS.REQUEST_OPEN.code, PARTY_DEPOSIT_REFUSALS.REQUEST_OPEN.message, {
        requestId: open.id,
        amountSatang: open.amountSatang,
      });
    }
    const paidDay = businessDate(now, clock.timezone, parseDayStart(clock.dayStart));
    const invoiceNo = await mintWebInvoiceNo(tx, { businessDate: paidDay, prefix: env.PGW_INVOICE_PREFIX });
    const attempt = await openAttempt(tx, {
      operatorId: input.operatorId,
      branchId: party.branchId,
      saleId: null,
      // Paid from the family's phone: no counter in the path, as a booking's is.
      stationId: null,
      businessDate: paidDay,
      method: 'qr',
      methodCode: 'promptpay',
      provider,
      status: 'created',
      amountSatang: input.amountSatang,
      invoiceNo,
      payload: {
        partyDepositRequestId: requestId,
        partyEventId: party.id,
        channel: 'web',
        // The poller leaves a long-lived link to its own expiry (`isExhausted`).
        longLived: true,
      },
    });
    const [row] = await tx
      .insert(partyDepositRequest)
      .values({
        id: requestId,
        operatorId: input.operatorId,
        branchId: party.branchId,
        otoappEventId: party.id,
        conversationId: conv.id,
        amountSatang: input.amountSatang,
        currency: env.PGW_CURRENCY_CODE,
        state: 'requested',
        paymentAttemptId: attempt.id,
        invoiceNo,
        requestedAt: now,
        accountId: actorAccountId,
        actorAppUserId: input.actorAppUserId,
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await audit.record(tx, {
      actorAccountId,
      operatorId: input.operatorId,
      branchId: party.branchId,
      action: 'party_deposit.request',
      entityType: 'party_deposit_request',
      entityId: requestId,
      actionId: input.idempotencyKey,
      requestId: ctx.requestId ?? null,
      after: {
        eventId: party.id,
        conversationId: conv.id,
        amountSatang: input.amountSatang,
        currency: env.PGW_CURRENCY_CODE,
        invoiceNo,
        paymentAttemptId: attempt.id,
        provider,
        via: 'otoapp_provision_key',
        actorAppUserId: input.actorAppUserId,
      },
    });
    return { row: row!, attempt, raced: false };
  });
  if (prepared.raced || !prepared.attempt) return replay(prepared.row);

  // Act 2 — the gateway's page, outside every transaction. A refusal closes the
  // attempt declined (the gateway's helper) and the request cancelled (here).
  let opened: { webPaymentUrl: string; expiresAt: Date };
  try {
    opened = await requestHostedPayment(db, env, log, scope, {
      attempt: prepared.attempt,
      description: `OTO Park party deposit ${party.startDate}`,
      channels: [env.PGW_QR_CHANNEL_CODE, 'CC'],
      frontendReturnUrl: returnUrl,
      locale: partyMessageLanguageOf(conv.language) === 'th' ? 'th' : 'en',
      expiryMinutes: env.PARTY_DEPOSIT_LINK_VALIDITY_MIN,
      actionId: input.idempotencyKey,
    });
  } catch (err) {
    log.warn({ err, requestId, invoiceNo: prepared.row.invoiceNo }, 'the gateway did not open a party deposit page');
    await withTx(db, scope, 'party_deposit.cancel', async (tx) => {
      await closeRequest(tx, prepared.row, 'cancelled', GATEWAY_REFUSED, ctx.requestId ?? null, actorAccountId, now);
    });
    // The deposit's own words (the gateway helper's are a booking's), and the
    // same answer the same key gets again (`replay`): a press id the app keeps
    // for its retry finds the refusal, not a success.
    throw pageNotOpened();
  }

  // Act 3 — the link on the request, and the assistant's one message.
  const posted = await withTx(db, scope, 'party_deposit.post', async (tx) => {
    const [live] = await tx.select().from(partyDepositRequest).where(eq(partyDepositRequest.id, requestId)).for('update').limit(1);
    if (!live) throw new Error('the deposit request vanished between its acts');
    const [withLink] = await tx
      .update(partyDepositRequest)
      .set({ paymentLink: partyDepositLinkOf(env, opened.webPaymentUrl), linkExpiresAt: opened.expiresAt, updatedAt: now })
      .where(eq(partyDepositRequest.id, requestId))
      .returning();
    if (live.state !== 'requested') return { row: withLink!, messageIds: [] as string[] };
    const line = await postPartyMessage(tx, input.operatorId, {
      messageId: partyMessageId(requestId, 'request'),
      conversationId: conv.id,
      key: 'party_deposit_request',
      variables: requestVariables(withLink!, party, clock, conv.language),
      event: { kind: 'deposit_requested', payload: pillPayload(withLink!) },
      audit: { action: 'party_deposit.post', entityType: 'party_deposit_request', entityId: requestId, detail: { eventId: party.id } },
      actorAccountId,
      requestId: ctx.requestId ?? null,
      now,
    });
    const [row] = await tx
      .update(partyDepositRequest)
      .set({ requestMessageId: line.messageId, updatedAt: now })
      .where(eq(partyDepositRequest.id, requestId))
      .returning();
    return { row: row!, messageIds: line.replayed ? [] : [line.messageId] };
  });
  await sendPartyMessages(db, senderNow(), log, posted.messageIds, { requestId: ctx.requestId ?? null, actorAccountId });
  return { request: await viewOf(db, posted.row), replayed: false };
}

/** Close a request without money, inside the caller's transaction, once. */
async function closeRequest(
  tx: Tx,
  row: RequestRow,
  state: 'expired' | 'cancelled',
  reason: string,
  requestId: string | null,
  actorAccountId: string | null,
  now: Date,
): Promise<RequestRow | null> {
  const [after] = await tx
    .update(partyDepositRequest)
    .set({ state, closedAt: now, closeReason: reason, updatedAt: now })
    .where(and(eq(partyDepositRequest.id, row.id), eq(partyDepositRequest.state, 'requested')))
    .returning();
  if (!after) return null;
  await tx.insert(inboxEvent).values({
    id: deriveId(row.id, `party-deposit:event:${state}:${reason}`),
    operatorId: row.operatorId,
    conversationId: row.conversationId,
    kind: state === 'expired' ? 'deposit_expired' : 'deposit_cancelled',
    actorKind: actorAccountId ? 'account' : 'system',
    actorAccountId,
    payload: { ...pillPayload(row), reason },
    createdAt: now,
  }).onConflictDoNothing();
  await audit.record(tx, {
    actorAccountId,
    operatorId: row.operatorId,
    branchId: row.branchId,
    action: state === 'expired' ? 'party_deposit.expire' : 'party_deposit.cancel',
    entityType: 'party_deposit_request',
    entityId: row.id,
    requestId,
    before: { state: row.state },
    after: { state, reason, eventId: row.otoappEventId, amountSatang: row.amountSatang, paymentAttemptId: row.paymentAttemptId },
  });
  return after;
}

/** A request of the operator, by id, for the party named; 404 for anyone else's. */
async function requestOfParty(db: Exec, operatorId: string, eventId: string, requestId: string): Promise<RequestRow> {
  const [row] = await db
    .select()
    .from(partyDepositRequest)
    .where(and(eq(partyDepositRequest.operatorId, operatorId), eq(partyDepositRequest.id, requestId)))
    .limit(1);
  if (!row || row.otoappEventId.toLowerCase() !== eventId.toLowerCase()) throw errors.notFound('Deposit request not found');
  return row;
}

export interface PartyDepositActionInput {
  operatorId: string;
  eventId: string;
  requestId: string;
  idempotencyKey: string;
  actorAppUserId: string;
}

/**
 * `POST …/deposit-request/:requestId/resend` — the same link posted again, as
 * the assistant, ONE line per press: the press's key names the line, so a
 * retry posts nothing twice. Only an open request with its link; an expired
 * or closed one is answered by name, and "Request deposit" makes a new one.
 */
export async function resendPartyDeposit(
  db: Db,
  log: FastifyBaseLogger,
  ctx: OpContext,
  input: PartyDepositActionInput,
  now: Date = new Date(),
): Promise<PartyDepositActionAnswer> {
  const party = await partyOfOperator(db, input.operatorId, input.eventId);
  const row = await requestOfParty(db, input.operatorId, party.id, input.requestId);
  const clock = await clockOf(db, input.operatorId, row.branchId);
  const actorAccountId = await actorAccountOf(db, input.operatorId, input.actorAppUserId);
  const scope: OpContext = { ...ctx, operatorId: input.operatorId, branchId: row.branchId, actorAccountId, idempotency: undefined };
  const messageId = partyMessageId(row.id, `resend:${input.idempotencyKey}`);
  const done = await withTx(db, scope, 'party_deposit.resend', async (tx) => {
    await lockParty(tx, party.id);
    const [live] = await tx.select().from(partyDepositRequest).where(eq(partyDepositRequest.id, row.id)).for('update').limit(1);
    if (!live) throw errors.notFound('Deposit request not found');
    const conv = await lockedConversation(tx, input.operatorId, live.conversationId);
    if (live.state !== 'requested' || !live.paymentLink) {
      throw errors.conflict(PARTY_DEPOSIT_REFUSALS.NOT_OPEN.code, PARTY_DEPOSIT_REFUSALS.NOT_OPEN.message, { state: live.state });
    }
    if (live.linkExpiresAt && live.linkExpiresAt.getTime() <= now.getTime()) {
      // The link has run out: the gateway's close is on its way. Said now, so staff ask again.
      throw errors.conflict(PARTY_DEPOSIT_REFUSALS.NOT_OPEN.code, 'The payment link has run out. Press Request deposit to send a fresh one.', {
        state: 'expired',
      });
    }
    const line = await postPartyMessage(tx, input.operatorId, {
      messageId,
      conversationId: conv.id,
      key: 'party_deposit_request',
      variables: requestVariables(live, party, clock, conv.language),
      event: { kind: 'deposit_requested', payload: { ...pillPayload(live), resend: true } },
      audit: {
        action: 'party_deposit.resend',
        entityType: 'party_deposit_request',
        entityId: live.id,
        detail: { eventId: party.id, via: 'otoapp_provision_key', actorAppUserId: input.actorAppUserId },
      },
      actorAccountId,
      requestId: ctx.requestId ?? null,
      now,
    });
    return { row: live, line };
  });
  await sendPartyMessages(db, senderNow(), log, done.line.replayed ? [] : [done.line.messageId], {
    requestId: ctx.requestId ?? null,
    actorAccountId,
  });
  return { request: await viewOf(db, done.row), replayed: done.line.replayed };
}

/**
 * `POST …/deposit-request/:requestId/cancel` — staff withdraw the request: it
 * is closed `cancelled`, its attempt closed with it (the gateway told, best
 * effort), a `deposit_cancelled` pill on the thread. Nothing is said to the
 * family: what to tell them is the person's own line. Cancelling twice is
 * the same act.
 */
export async function cancelPartyDeposit(
  db: Db,
  env: Env,
  log: FastifyBaseLogger,
  ctx: OpContext,
  input: PartyDepositActionInput,
  now: Date = new Date(),
): Promise<PartyDepositActionAnswer> {
  const party = await partyOfOperator(db, input.operatorId, input.eventId);
  const row = await requestOfParty(db, input.operatorId, party.id, input.requestId);
  const actorAccountId = await actorAccountOf(db, input.operatorId, input.actorAppUserId);
  const scope: OpContext = { ...ctx, operatorId: input.operatorId, branchId: row.branchId, actorAccountId, idempotency: undefined };
  const done = await withTx(db, scope, 'party_deposit.cancel', async (tx) => {
    await lockParty(tx, party.id);
    const [live] = await tx.select().from(partyDepositRequest).where(eq(partyDepositRequest.id, row.id)).for('update').limit(1);
    if (!live) throw errors.notFound('Deposit request not found');
    if (live.state === 'cancelled') return { row: live, replayed: true, closedAttempt: false };
    if (live.state !== 'requested') {
      throw errors.conflict(PARTY_DEPOSIT_REFUSALS.NOT_OPEN.code, PARTY_DEPOSIT_REFUSALS.NOT_OPEN.message, { state: live.state });
    }
    const [attempt] = await tx.select().from(paymentAttempt).where(eq(paymentAttempt.id, live.paymentAttemptId)).for('update').limit(1);
    let closedAttempt = false;
    if (attempt && (attempt.status === 'created' || attempt.status === 'sent_to_terminal' || attempt.status === 'inquiring')) {
      await failAttempt(tx, attempt.id, {
        status: 'cancelled',
        payload: { ...((attempt.payload as Record<string, unknown> | null) ?? {}), cancelledBy: { accountId: actorAccountId, appUserId: input.actorAppUserId } },
      });
      await audit.record(tx, {
        actorAccountId,
        operatorId: live.operatorId,
        branchId: live.branchId,
        action: 'payment.qr.cancel',
        entityType: 'payment_attempt',
        entityId: attempt.id,
        actionId: input.idempotencyKey,
        requestId: ctx.requestId ?? null,
        before: { status: attempt.status },
        after: { status: 'cancelled', reason: 'party_deposit_cancelled', partyDepositRequestId: live.id },
      });
      closedAttempt = true;
    }
    const after = await closeRequest(tx, live, 'cancelled', 'staff', ctx.requestId ?? null, actorAccountId, now);
    return { row: after ?? live, replayed: false, closedAttempt };
  });
  if (done.closedAttempt) {
    // The gateway's own cancel is best effort (QR support is UNCERTAIN, U4); the row is closed either way.
    try {
      await gatewayFor(env, log).qr.cancel({ invoiceNo: row.invoiceNo });
    } catch (err) {
      log.warn({ err, invoiceNo: row.invoiceNo }, 'the gateway could not be told a deposit link was cancelled');
    }
  }
  return { request: await viewOf(db, done.row), replayed: done.replayed };
}

// --- Paid: inside the gateway's settlement ---------------------------------------------------

export interface PartyDepositPaidOutcome {
  requestId: string;
  operatorId: string;
  branchId: string;
  eventId: string;
  conversationId: string;
  amountSatang: number;
  /** True when this settlement made it paid; false when it already was. */
  confirmed: boolean;
  /** Paid after the request had expired or been cancelled: the money is the family's either way. */
  late: boolean;
  editId: string | null;
  messageIds: string[];
  partyDate: string;
}

/**
 * MARK THE REQUEST PAID, inside the settlement's own transaction (`settleWithin`),
 * reached only on inquiry-agreed facts. Idempotent under the request's row
 * lock: a replayed notification or a poller racing the webhook confirms it
 * once. Null when the attempt is not a deposit's.
 *
 * The party's ONE deposit figure (the app's, SCRUM-813) moves by the amount:
 * read from the app's view as the money lands, the sum written back through
 * a party edit (SCRUM-804's path, `write_back_edit_id`), dated the paid day
 * in the park's calendar. The confirmation is posted here too, so the money
 * and the family's "received" line commit together or not at all; the send
 * and the push run after the commit (`afterPartyDepositPaid`).
 */
export async function confirmPartyDepositPaid(
  tx: Tx,
  input: { attemptId: string; source: string; requestId?: string | null; now?: Date },
): Promise<PartyDepositPaidOutcome | null> {
  const [row] = await tx
    .select()
    .from(partyDepositRequest)
    .where(eq(partyDepositRequest.paymentAttemptId, input.attemptId))
    .for('update')
    .limit(1);
  if (!row) return null;
  const now = input.now ?? new Date();
  const base = {
    requestId: row.id,
    operatorId: row.operatorId,
    branchId: row.branchId,
    eventId: row.otoappEventId,
    conversationId: row.conversationId,
    amountSatang: row.amountSatang,
  };
  if (row.state === 'paid') {
    return { ...base, confirmed: false, late: false, editId: row.writeBackEditId, messageIds: [], partyDate: '' };
  }
  const late = row.state !== 'requested';
  const clock = await clockOf(tx, row.operatorId, row.branchId);
  // The deposit as the app holds it NOW, wherever the party is: a figure that
  // cannot be read is not zero. The throw rolls the whole settlement back —
  // the gateway still holds the money — and the next notification or inquiry
  // settles it once the party reads again (a deleted party: never, and loudly).
  const party = await partyOfRow(tx, row);
  if (!party) {
    throw new AppError(
      503,
      'PARTY_DEPOSIT_PARTY_UNREADABLE',
      'The party could not be read from the OTO App, so its deposit was not settled yet; the next notification or inquiry tries again',
      { requestId: row.id, eventId: row.otoappEventId },
    );
  }
  const before = party.depositSatang ?? 0;
  const after = before + row.amountSatang;
  const paidDay = isoDateInTz(now, clock.timezone);
  const editId = deriveId(row.id, 'party-deposit:write-back');
  // A FACT, not a till's change: the app records it whatever it changed since (`parties.ts` sendPartyEdit).
  const fields: PartyStoredEditFields = { depositSatang: after, depositDate: paidDay, fact: 'gateway_deposit' };
  await tx
    .insert(partyEdit)
    .values({
      id: editId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      otoappEventId: row.otoappEventId,
      fields,
      syncState: 'pending',
      accountId: row.accountId,
      actionId: row.id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const [paid] = await tx
    .update(partyDepositRequest)
    .set({
      state: 'paid',
      paidAt: now,
      depositBeforeSatang: before,
      depositAfterSatang: after,
      writeBackEditId: editId,
      // A late payment closes nothing twice: the close stays on the row as history.
      updatedAt: now,
    })
    .where(eq(partyDepositRequest.id, row.id))
    .returning();
  const lang = partyMessageLanguageOf((await lockedConversation(tx, row.operatorId, row.conversationId)).language);
  const partyDate = party?.startDate ?? '';
  const line = await postPartyMessage(tx, row.operatorId, {
    messageId: partyMessageId(row.id, 'received'),
    conversationId: row.conversationId,
    key: 'party_deposit_received',
    variables: { amount: partyAmountWords(row.amountSatang), date: partyDate ? partyDateWords(partyDate, lang) : '' },
    event: { kind: 'deposit_paid', payload: { ...pillPayload(row), late, source: input.source } },
    audit: {
      action: 'party_deposit.post',
      entityType: 'party_deposit_request',
      entityId: row.id,
      detail: { eventId: row.otoappEventId, line: 'received' },
    },
    actorAccountId: null,
    requestId: input.requestId ?? null,
    now,
  });
  await tx.update(partyDepositRequest).set({ paidMessageId: line.messageId }).where(eq(partyDepositRequest.id, row.id));
  await audit.record(tx, {
    // No person: the gateway said this, confirmed by an inquiry.
    actorAccountId: null,
    operatorId: row.operatorId,
    branchId: row.branchId,
    action: 'party_deposit.paid',
    entityType: 'party_deposit_request',
    entityId: row.id,
    requestId: input.requestId ?? null,
    before: { state: row.state, depositSatang: before },
    after: {
      state: 'paid',
      source: input.source,
      late,
      eventId: row.otoappEventId,
      amountSatang: row.amountSatang,
      depositSatang: after,
      depositDate: paidDay,
      paymentAttemptId: row.paymentAttemptId,
      invoiceNo: row.invoiceNo,
      writeBackEditId: editId,
      messageId: line.messageId,
    },
  });
  return { ...base, confirmed: paid !== undefined, late, editId, messageIds: line.replayed ? [] : [line.messageId], partyDate };
}

/**
 * What follows a paid request, after its transaction committed: the deposit
 * pushed to the OTO App (the edit waits on the Failures page if the app does
 * not answer, as any party edit), the family's line sent, the birthday
 * manager's bell rung. Each best effort; none may undo the payment.
 */
export async function afterPartyDepositPaid(db: Db, log: FastifyBaseLogger, outcome: PartyDepositPaidOutcome): Promise<void> {
  if (!outcome.confirmed) return;
  const directory = directoryNow();
  if (directory && outcome.editId) {
    try {
      await pushPartyEdit({ db, directory, log }, outcome.editId);
    } catch (err) {
      log.error({ err, requestId: outcome.requestId }, 'a paid party deposit could not be written back to the OTO App');
    }
  }
  await sendPartyMessages(db, senderNow(), log, outcome.messageIds);
  await ringBirthdayManager(db, log, directory, {
    requestId: outcome.requestId,
    operatorId: outcome.operatorId,
    branchId: outcome.branchId,
    conversationId: outcome.conversationId,
    name: 'paid',
    title: 'A party deposit was paid',
    body: `A deposit of ${partyAmountWords(outcome.amountSatang)} for a party${outcome.partyDate ? ` on ${outcome.partyDate}` : ''} was paid through the chat. Open the conversation or the BEO to see it.`,
  });
}

/**
 * The birthday manager's bell, through the app's directory (SCRUM-823's
 * door): the park's `birthday_manager_contact`, when it names an app user.
 * The notice's id is derived from the request and the moment, so a retry is
 * a replay in the app. No customer's name or number in it. Recorded as an
 * audit row whatever the app answered; never thrown.
 */
async function ringBirthdayManager(
  db: Db,
  log: FastifyBaseLogger | undefined,
  directory: BellDirectory | null,
  notice: { requestId: string; operatorId: string; branchId: string; conversationId: string; name: string; title: string; body: string },
): Promise<void> {
  const [park] = await db
    .select({ contact: branch.birthdayManagerContact })
    .from(branch)
    .where(and(eq(branch.id, notice.branchId), eq(branch.operatorId, notice.operatorId)))
    .limit(1);
  const contact = contactOf(park?.contact);
  let outcome: Record<string, unknown>;
  if (!contact?.appUserId) outcome = { state: 'skipped', code: 'NO_CONTACT' };
  else if (!directory?.configured || !directory.notify) outcome = { state: 'skipped', code: 'OTOAPP_DIRECTORY_NOT_CONFIGURED' };
  else {
    try {
      const answer = await directory.notify({
        id: deriveId(notice.requestId, `party-deposit:bell:${notice.name}`),
        recipientUserId: contact.appUserId,
        title: notice.title,
        body: notice.body,
        referenceType: 'inbox_conversation',
        referenceId: notice.conversationId,
      });
      outcome = answer.ok ? { state: 'sent', replayed: answer.body.replayed } : { state: 'failed', code: answer.code };
    } catch (err) {
      outcome = { state: 'failed', code: 'SEND_FAILED', error: (err as Error).name };
    }
  }
  try {
    await withTx(db, { operatorId: notice.operatorId, branchId: notice.branchId, actorAccountId: null, ...(log ? { log } : {}) }, 'party_deposit.notify', (tx) =>
      audit.record(tx, {
        actorAccountId: null,
        operatorId: notice.operatorId,
        branchId: notice.branchId,
        action: 'party_deposit.notify',
        entityType: 'party_deposit_request',
        entityId: notice.requestId,
        after: { notice: notice.name, conversationId: notice.conversationId, appUserId: contact?.appUserId ?? null, ...outcome },
      }),
    );
  } catch (err) {
    log?.warn({ err, requestId: notice.requestId }, 'the bell for a party deposit could not be recorded');
  }
}

/**
 * The attempt ended without money — the link ran out, or the gateway closed
 * it — inside the gateway's close of the attempt (`applyNonPaidState`): the
 * request is over, `expired`, with a pill; the next "Request deposit" makes a
 * fresh one. Null when the attempt is not a deposit's or the request is no
 * longer open.
 */
export async function closePartyDepositUnpaid(
  tx: Tx,
  input: { attemptId: string; state: string; requestId?: string | null; now?: Date },
): Promise<RequestRow | null> {
  const [row] = await tx
    .select()
    .from(partyDepositRequest)
    .where(eq(partyDepositRequest.paymentAttemptId, input.attemptId))
    .for('update')
    .limit(1);
  if (!row || row.state !== 'requested') return null;
  return closeRequest(tx, row, 'expired', `gateway_${input.state}`, input.requestId ?? null, null, input.now ?? new Date());
}

// --- The follow-up job -----------------------------------------------------------------------------

/** The bell's needs of the OTO App's directory: whether it is configured, and `notify`. */
export type BellDirectory = Pick<OtoAppDirectory, 'configured' | 'notify'>;

export interface PartyDepositFollowUpDeps {
  sender: PartyMessageSender | null;
  directory: BellDirectory | null;
  log?: FastifyBaseLogger;
}

export interface PartyDepositFollowUpSweep extends Record<string, unknown> {
  remindersDue: number;
  reminded: number;
  handoversDue: number;
  handedOver: number;
  skipped: number;
}

/** The birthdays team, operator-wide: where an overdue deposit's thread is handed. */
async function birthdaysTeamOf(tx: Tx, operatorId: string): Promise<{ id: string; name: string } | null> {
  const [row] = await tx
    .select({ id: team.id, name: team.name })
    .from(team)
    .where(and(eq(team.operatorId, operatorId), eq(team.key, 'birthdays'), isNull(team.branchId)))
    .limit(1);
  return row ?? null;
}

/**
 * `job:party.deposit_follow_up`, every minute: ONE reminder for each open
 * request unpaid `PARTY_DEPOSIT_REMINDER_MIN` after it was made, and ONE
 * hand-over for each still unpaid `PARTY_DEPOSIT_HANDOVER_MIN` after the
 * reminder — each decided again under the party's lock, so two ticks never
 * post twice, and the line's id names the request and the step besides.
 * Counts only in the run's detail.
 */
export async function runPartyDepositFollowUpJob(
  db: Db,
  env: Env,
  deps: PartyDepositFollowUpDeps,
  now: Date = new Date(),
): Promise<PartyDepositFollowUpSweep> {
  const sweep: PartyDepositFollowUpSweep = { remindersDue: 0, reminded: 0, handoversDue: 0, handedOver: 0, skipped: 0 };
  const log = deps.log;

  const remindBy = new Date(now.getTime() - env.PARTY_DEPOSIT_REMINDER_MIN * 60_000);
  const dueReminders = await db
    .select()
    .from(partyDepositRequest)
    .where(
      and(
        eq(partyDepositRequest.state, 'requested'),
        isNull(partyDepositRequest.remindedAt),
        isNotNull(partyDepositRequest.paymentLink),
        lte(partyDepositRequest.requestedAt, remindBy),
      ),
    )
    .orderBy(asc(partyDepositRequest.requestedAt))
    .limit(FOLLOW_UP_BATCH);
  sweep.remindersDue = dueReminders.length;
  for (const due of dueReminders) {
    try {
      const sent = await remindOne(db, env, due, now);
      if (sent) sweep.reminded += 1;
      else sweep.skipped += 1;
      await sendPartyMessages(db, deps.sender, log, sent ? [sent] : []);
    } catch (err) {
      sweep.skipped += 1;
      log?.warn({ err, requestId: due.id }, 'a party deposit reminder could not be posted');
    }
  }

  const handBy = new Date(now.getTime() - env.PARTY_DEPOSIT_HANDOVER_MIN * 60_000);
  const dueHandovers = await db
    .select()
    .from(partyDepositRequest)
    .where(
      and(
        eq(partyDepositRequest.state, 'requested'),
        isNull(partyDepositRequest.handedOverAt),
        isNotNull(partyDepositRequest.remindedAt),
        lte(partyDepositRequest.remindedAt, handBy),
      ),
    )
    .orderBy(asc(partyDepositRequest.remindedAt))
    .limit(FOLLOW_UP_BATCH);
  sweep.handoversDue = dueHandovers.length;
  for (const due of dueHandovers) {
    try {
      const handed = await handOverOne(db, due, now);
      if (!handed) {
        sweep.skipped += 1;
        continue;
      }
      sweep.handedOver += 1;
      await sendPartyMessages(db, deps.sender, log, handed.messageIds);
      await ringBirthdayManager(db, log, deps.directory, {
        requestId: due.id,
        operatorId: due.operatorId,
        branchId: due.branchId,
        conversationId: due.conversationId,
        name: 'overdue',
        title: 'A party deposit is overdue',
        body: `A deposit of ${partyAmountWords(due.amountSatang)} asked for a party${handed.partyDate ? ` on ${handed.partyDate}` : ''} is still unpaid after the reminder. The conversation is waiting for a person.`,
      });
    } catch (err) {
      sweep.skipped += 1;
      log?.warn({ err, requestId: due.id }, 'a party deposit hand-over could not be made');
    }
  }
  return sweep;
}

/** The reminder, once, under the party's lock. The posted line's id, or null when nothing was due after all. */
async function remindOne(db: Db, env: Env, due: RequestRow, now: Date): Promise<string | null> {
  return withTx(db, { operatorId: due.operatorId, branchId: due.branchId, actorAccountId: null }, 'party_deposit.remind', async (tx) => {
    await lockParty(tx, due.otoappEventId);
    const [live] = await tx.select().from(partyDepositRequest).where(eq(partyDepositRequest.id, due.id)).for('update').limit(1);
    if (!live || live.state !== 'requested' || live.remindedAt || !live.paymentLink) return null;
    if (live.linkExpiresAt && live.linkExpiresAt.getTime() <= now.getTime()) return null; // the gateway's close is on its way
    const conv = await lockedConversation(tx, live.operatorId, live.conversationId);
    const party = await partyOfRow(tx, live).catch(() => null);
    const clock = await clockOf(tx, live.operatorId, live.branchId);
    const line = await postPartyMessage(tx, live.operatorId, {
      messageId: partyMessageId(live.id, 'reminder'),
      conversationId: conv.id,
      key: 'party_deposit_reminder',
      variables: requestVariables(live, { startDate: party?.startDate ?? '' }, clock, conv.language),
      event: { kind: 'deposit_reminded', payload: pillPayload(live) },
      audit: { action: 'party_deposit.remind', entityType: 'party_deposit_request', entityId: live.id, detail: { eventId: live.otoappEventId, after: `${env.PARTY_DEPOSIT_REMINDER_MIN} min` } },
      actorAccountId: null,
      now,
    });
    await tx
      .update(partyDepositRequest)
      .set({ remindedAt: now, reminderMessageId: line.messageId, updatedAt: now })
      .where(eq(partyDepositRequest.id, live.id));
    return line.replayed ? null : line.messageId;
  });
}

/**
 * The hand-over, once, under the party's lock: the holding line (the birthday
 * manager's, else the team-neutral one), a `deposit_overdue` pill and an
 * `ai_handover` the assistant stands back on (`aiEligibility` HANDED_OVER),
 * the thread moved to Birthdays & Events where it is not there already.
 */
async function handOverOne(db: Db, due: RequestRow, now: Date): Promise<{ messageIds: string[]; partyDate: string } | null> {
  return withTx(db, { operatorId: due.operatorId, branchId: due.branchId, actorAccountId: null }, 'party_deposit.hand_over', async (tx) => {
    await lockParty(tx, due.otoappEventId);
    const [live] = await tx.select().from(partyDepositRequest).where(eq(partyDepositRequest.id, due.id)).for('update').limit(1);
    if (!live || live.state !== 'requested' || live.handedOverAt) return null;
    const conv = await lockedConversation(tx, live.operatorId, live.conversationId);
    const party = await partyOfRow(tx, live).catch(() => null);
    const dest = await birthdaysTeamOf(tx, live.operatorId);
    const line = await postPartyMessage(tx, live.operatorId, {
      messageId: partyMessageId(live.id, 'handover'),
      conversationId: conv.id,
      key: 'closing_birthday',
      fallbackKeys: ['handover_general'],
      variables: {},
      event: { kind: 'deposit_overdue', payload: { ...pillPayload(live), reroutedTeamId: dest?.id ?? null } },
      audit: { action: 'party_deposit.hand_over', entityType: 'party_deposit_request', entityId: live.id, detail: { eventId: live.otoappEventId, teamId: dest?.id ?? null } },
      actorAccountId: null,
      now,
    });
    // The assistant stands back on the thread from here: the same pill its own hand-over writes.
    await tx.insert(inboxEvent).values({
      id: deriveId(live.id, 'party-deposit:event:ai_handover'),
      operatorId: live.operatorId,
      conversationId: conv.id,
      kind: 'ai_handover',
      actorKind: 'ai',
      payload: {
        reason: 'DEPOSIT_UNPAID',
        intent: 'deposit_unpaid',
        partyDepositRequestId: live.id,
        reroutedTeamId: dest?.id ?? null,
        messageIds: [line.messageId],
      },
      createdAt: new Date(now.getTime() + 1),
    }).onConflictDoNothing();
    if (dest && (conv.category !== 'birthdays' || conv.teamId !== dest.id)) {
      await tx.insert(inboxEvent).values({
        id: deriveId(live.id, 'party-deposit:event:moved_team'),
        operatorId: live.operatorId,
        conversationId: conv.id,
        kind: 'moved_team',
        actorKind: 'ai',
        payload: { fromTeamId: conv.teamId, toTeamId: dest.id, toTeamName: dest.name, fromCategory: conv.category, toCategory: 'birthdays', byAi: true, reason: 'DEPOSIT_UNPAID' },
        createdAt: new Date(now.getTime() + 2),
      }).onConflictDoNothing();
      await routeConversation(tx, {
        operatorId: live.operatorId,
        conversationId: conv.id,
        category: 'birthdays',
        language: conv.language ?? 'en',
        branchId: conv.branchId,
        at: now,
        reroute: { teamId: dest.id, reason: 'move', by: 'ai' },
      });
    }
    await tx.update(partyDepositRequest).set({ handedOverAt: now, updatedAt: now }).where(eq(partyDepositRequest.id, live.id));
    return { messageIds: line.replayed ? [] : [line.messageId], partyDate: party?.startDate ?? '' };
  });
}

// --- The set-menu link and the choices ---------------------------------------------------------

export interface PartyMenuLinkInput {
  operatorId: string;
  eventId: string;
  link: string;
  idempotencyKey: string;
  actorAppUserId: string;
}

/** `POST /otoapp/parties/:eventId/menu-link` — the parent's selection link, posted by the assistant with the right words, once per press. */
export async function postPartyMenuLink(
  db: Db,
  log: FastifyBaseLogger,
  ctx: OpContext,
  input: PartyMenuLinkInput,
  now: Date = new Date(),
): Promise<PartyMessageAnswer> {
  const party = await partyOfOperator(db, input.operatorId, input.eventId);
  const conv = await conversationOfParty(db, input.operatorId, party.id);
  if (!conv) throw errors.conflict(PARTY_DEPOSIT_REFUSALS.NO_CONVERSATION.code, PARTY_DEPOSIT_REFUSALS.NO_CONVERSATION.message);
  const actorAccountId = await actorAccountOf(db, input.operatorId, input.actorAppUserId);
  const scope: OpContext = { ...ctx, operatorId: input.operatorId, branchId: party.branchId, actorAccountId, idempotency: undefined };
  const line = await withTx(db, scope, 'party_menu.link', async (tx) => {
    await lockParty(tx, party.id);
    const locked = await lockedConversation(tx, input.operatorId, conv.id);
    return postPartyMessage(tx, input.operatorId, {
      messageId: partyMessageId(party.id, `menu-link:${input.idempotencyKey}`),
      conversationId: locked.id,
      key: 'party_menu_link',
      variables: { date: partyDateWords(party.startDate, partyMessageLanguageOf(locked.language)), link: input.link },
      event: { kind: 'menu_link_sent', payload: { eventId: party.id } },
      audit: { action: 'party_menu.link', entityType: 'otoapp_event', entityId: party.id, detail: { via: 'otoapp_provision_key', actorAppUserId: input.actorAppUserId } },
      actorAccountId,
      requestId: ctx.requestId ?? null,
      now,
    });
  });
  await sendPartyMessages(db, senderNow(), log, line.replayed ? [] : [line.messageId], { requestId: ctx.requestId ?? null, actorAccountId });
  return { conversationId: line.conversationId, messageId: line.messageId, language: line.language, replayed: line.replayed };
}

export interface PartyMenuReceivedInput {
  operatorId: string;
  eventId: string;
  idempotencyKey: string;
  submittedAt?: string | null;
}

/** `POST /otoapp/parties/:eventId/menu-received` — the parent's choices landed in the app: the assistant confirms, once per submission. */
export async function postPartyMenuReceived(
  db: Db,
  log: FastifyBaseLogger,
  ctx: OpContext,
  input: PartyMenuReceivedInput,
  now: Date = new Date(),
): Promise<PartyMessageAnswer> {
  const party = await partyOfOperator(db, input.operatorId, input.eventId);
  const conv = await conversationOfParty(db, input.operatorId, party.id);
  if (!conv) throw errors.conflict(PARTY_DEPOSIT_REFUSALS.NO_CONVERSATION.code, PARTY_DEPOSIT_REFUSALS.NO_CONVERSATION.message);
  const scope: OpContext = { ...ctx, operatorId: input.operatorId, branchId: party.branchId, actorAccountId: null, idempotency: undefined };
  const line = await withTx(db, scope, 'party_menu.received', async (tx) => {
    await lockParty(tx, party.id);
    const locked = await lockedConversation(tx, input.operatorId, conv.id);
    return postPartyMessage(tx, input.operatorId, {
      messageId: partyMessageId(party.id, `menu-received:${input.idempotencyKey}`),
      conversationId: locked.id,
      key: 'party_menu_received',
      variables: { date: partyDateWords(party.startDate, partyMessageLanguageOf(locked.language)) },
      event: { kind: 'menu_received', payload: { eventId: party.id, submittedAt: input.submittedAt ?? null } },
      audit: { action: 'party_menu.received', entityType: 'otoapp_event', entityId: party.id, detail: { via: 'otoapp_provision_key', submittedAt: input.submittedAt ?? null } },
      actorAccountId: null,
      requestId: ctx.requestId ?? null,
      now,
    });
  });
  await sendPartyMessages(db, senderNow(), log, line.replayed ? [] : [line.messageId], { requestId: ctx.requestId ?? null });
  return { conversationId: line.conversationId, messageId: line.messageId, language: line.language, replayed: line.replayed };
}

