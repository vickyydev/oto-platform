import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  auditLog,
  branch,
  paymentAttempt,
  prebookingDepositRequest,
  prebookingDraft,
  refund,
  type Db,
} from '@oto/db';
import {
  businessDate,
  deriveId,
  InboxBookDateBodySchema,
  isPaymentReversalPending,
  isoDateInTz,
  parseDayStart,
  type InboxBookDateBody,
  type InboxPrebooking,
  type InboxPrebookingRequest,
  type PartyDepositRequestView,
} from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../../env';
import { errors } from '../../lib/errors';
import { PermissionDeniedError } from '../../plugins/session';
import { hasPermission } from '../permissions';
import { audit } from '../audit';
import { openAttempt, type AttemptRow } from '../payments/attempt';
import { gatewayProviderOf, mintWebInvoiceNo, requestHostedPayment } from '../payments/gateway';
import { partyDepositLinkOf, partyDepositReturnUrlOf } from '../party-deposit';
import { withTx, type Exec, type OpContext } from '../tx';
import type { ActionCtx } from './actions';
import { authorizePrebooking, eventStandingOf, isRemovedStanding } from './book-date';
import {
  partyAmountWords,
  partyClockWords,
  partyDateWords,
  partyMessageLanguageOf,
  postPartyMessage,
  sendPartyMessages,
} from './party-messages';
import type { PartyMessageSender } from './party-messages';

type Draft = typeof prebookingDraft.$inferSelect;
const TERMINAL_UNPAID = new Set(['declined', 'cancelled', 'not_found']);
const payloadOf = (attempt: AttemptRow) => (attempt.payload ?? {}) as Record<string, unknown>;

/** Shared by the action and its read-only HTTP replay authorization. */
export function assertPrebookingRequestAuthority(ctx: ActionCtx, branchId: string): void {
  if (!hasPermission(ctx.effective, 'inbox:conversation:assign', { operatorId: ctx.viewer.operatorId, branchId })) throw new PermissionDeniedError('inbox:conversation:assign');
}

/** Only the gateway settlement writer supplies this provenance, after inquiry agreement. */
export function verifiedPrebookingAttempt(
  draft: Pick<Draft, 'id' | 'operatorId' | 'branchId' | 'amountSatang' | 'currency'>,
  attempt: AttemptRow,
): boolean {
  const p = payloadOf(attempt);
  return (
    attempt.operatorId === draft.operatorId &&
    attempt.branchId === draft.branchId &&
    attempt.saleId === null &&
    attempt.stationId === null &&
    attempt.staffConfirmedByAccountId === null &&
    p.staffConfirmation == null &&
    (attempt.provider === '2c2p' || attempt.provider === 'simulator') &&
    attempt.status === 'approved' &&
    attempt.paidAt !== null &&
    attempt.amountSatang === draft.amountSatang &&
    p.prebookingDraftId === draft.id &&
    p.currency === draft.currency &&
    (p.settledBy === 'webhook' || p.settledBy === 'inquiry') &&
    !isPaymentReversalPending(attempt.payload)
  );
}

/** Refund allocations, rather than caller-supplied flags, determine whether money is still available. */
async function eligibleAttempts(
  db: Exec,
  draft: Draft,
  attempts: AttemptRow[],
): Promise<AttemptRow[]> {
  const eligible: AttemptRow[] = [];
  for (const attempt of attempts.filter((a) => verifiedPrebookingAttempt(draft, a))) {
    const [receipt] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.operatorId, draft.operatorId),
          eq(auditLog.entityId, attempt.id),
          eq(auditLog.action, 'payment.settled'),
          sql`${auditLog.after}->>'status' = 'approved'`,
          sql`${auditLog.after}->>'source' in ('webhook','inquiry')`,
        ),
      )
      .limit(1);
    const [returned] = await db
      .select({ id: refund.id })
      .from(refund)
      .where(
        and(
          eq(refund.operatorId, draft.operatorId),
          sql`exists (select 1 from jsonb_array_elements(${refund.tenderAllocation}) allocation where allocation->>'attemptId' = ${attempt.id} and (allocation->>'amountSatang')::numeric > 0)`,
        ),
      )
      .limit(1);
    if (receipt && !returned) eligible.push(attempt);
  }
  return eligible;
}

async function attemptsOf(db: Exec, draftId: string): Promise<AttemptRow[]> {
  const rows = await db
    .select({ attempt: paymentAttempt })
    .from(prebookingDepositRequest)
    .innerJoin(paymentAttempt, eq(paymentAttempt.id, prebookingDepositRequest.paymentAttemptId))
    .where(eq(prebookingDepositRequest.draftId, draftId))
    .orderBy(desc(prebookingDepositRequest.createdAt), desc(prebookingDepositRequest.id));
  return rows.map((r) => r.attempt);
}

/** A booked event's chip reads current receipt eligibility, never the historical pill's money claim. */
export async function prebookingEventDeposit(db: Exec, operatorId: string, eventId: string) {
  const [draft] = await db
    .select()
    .from(prebookingDraft)
    .where(and(eq(prebookingDraft.id, eventId), eq(prebookingDraft.operatorId, operatorId)))
    .limit(1);
  if (!draft) return null;
  const attempts = await attemptsOf(db, draft.id);
  const paid = await eligibleAttempts(db, draft, attempts);
  if (
    paid.length !== 1 ||
    !attempts.every((a) => a.id === paid[0]!.id || TERMINAL_UNPAID.has(a.status))
  )
    return null;
  return {
    requestId: draft.id,
    state: 'paid' as const,
    amountSatang: draft.amountSatang,
    overdue: false,
    simulator: paid[0]!.provider === 'simulator',
  };
}

/** Existing Billing history/floor reads the original receipt; this creates no second ledger row. */
export async function prebookingPartyDepositView(
  db: Exec,
  operatorId: string,
  eventId: string,
): Promise<PartyDepositRequestView | null> {
  const [draft] = await db
    .select()
    .from(prebookingDraft)
    .where(and(eq(prebookingDraft.id, eventId), eq(prebookingDraft.operatorId, operatorId)))
    .limit(1);
  // The app may already have committed while its answer was lost. Its
  // existence is checked by partyDepositOf; protect that receipt during recovery too.
  if (!draft?.bookingClaim) return null;
  const attempts = await attemptsOf(db, draft.id);
  const paid = await eligibleAttempts(db, draft, attempts);
  if (
    paid.length !== 1 ||
    !attempts.every((a) => a.id === paid[0]!.id || TERMINAL_UNPAID.has(a.status))
  )
    return null;
  const receipt = paid[0]!;
  return {
    id: draft.id,
    eventId: draft.id,
    conversationId: draft.conversationId,
    amountSatang: draft.amountSatang,
    currency: draft.currency,
    provider: receipt.provider === 'simulator' ? 'simulator' : '2c2p',
    state: 'paid',
    paymentLink: null,
    linkExpiresAt: receipt.expiresAt?.toISOString() ?? null,
    invoiceNo: receipt.invoiceNo ?? '',
    requestedAt: draft.createdAt.toISOString(),
    remindedAt: null,
    handedOverAt: null,
    paidAt: receipt.paidAt!.toISOString(),
    closedAt: null,
    closeReason: null,
    depositBeforeSatang: 0,
    depositAfterSatang: draft.amountSatang,
    writeBack: null,
    requestLineStatus: null,
  };
}

async function view(db: Exec, draft: Draft): Promise<InboxPrebooking> {
  const attempts = await attemptsOf(db, draft.id);
  const paid = await eligibleAttempts(db, draft, attempts);
  const latest = attempts[0];
  const state = draft.bookedAt
    ? 'booked'
    : paid.length === 1 &&
        attempts.every((a) => a.id === paid[0]!.id || TERMINAL_UNPAID.has(a.status))
      ? 'paid'
      : paid.length > 1 ||
          attempts.some(
            (a) => a.status === 'awaiting_staff_confirmation' || a.status === 'approved',
          )
        ? 'needs_review'
        : latest && TERMINAL_UNPAID.has(latest.status)
          ? payloadOf(latest).expired === true
            ? 'expired'
            : 'failed'
          : latest &&
              latest.status === 'created' &&
              Date.now() - latest.createdAt.getTime() > 60_000
            ? 'needs_review'
            : 'requested';
  const p = latest ? payloadOf(latest) : {};
  return {
    draft: {
      id: draft.id,
      booking: InboxBookDateBodySchema.parse(draft.bookingClaim?.booking ?? draft.booking),
      amountSatang: draft.amountSatang,
      currency: draft.currency,
      simulator: latest?.provider === 'simulator',
      state,
      paymentLink:
        state === 'requested' && typeof (p.prebookingPaymentLink ?? p.webPaymentUrl) === 'string'
          ? String(p.prebookingPaymentLink ?? p.webPaymentUrl)
          : null,
      linkExpiresAt: latest?.expiresAt?.toISOString() ?? null,
      paidAt: paid[0]?.paidAt?.toISOString() ?? null,
    },
  };
}

export async function readPrebooking(
  db: Db,
  ctx: ActionCtx,
  conversationId: string,
): Promise<InboxPrebooking> {
  await authorizePrebooking(db, ctx, conversationId);
  const [draft] = await db
    .select()
    .from(prebookingDraft)
    .where(
      and(
        eq(prebookingDraft.operatorId, ctx.viewer.operatorId),
        eq(prebookingDraft.conversationId, conversationId),
        isNull(prebookingDraft.bookedAt),
      ),
    )
    .limit(1);
  return draft ? view(db, draft) : { draft: null };
}

/** Fails closed before any calendar write; receipt remains the original gateway attempt. */
export async function paidPrebooking(
  db: Exec,
  operatorId: string,
  conversationId: string,
  input: InboxBookDateBody,
) {
  const [draft] = await db
    .select()
    .from(prebookingDraft)
    .where(
      and(
        eq(prebookingDraft.id, input.id),
        eq(prebookingDraft.operatorId, operatorId),
        eq(prebookingDraft.conversationId, conversationId),
      ),
    )
    .limit(1);
  if (!draft || draft.branchId !== input.branchId)
    throw errors.conflict(
      'DEPOSIT_REQUIRED',
      'Request the agreed deposit for this park before creating the booking.',
    );
  const attempts = await attemptsOf(db, draft.id);
  const paid = await eligibleAttempts(db, draft, attempts);
  if (
    paid.length !== 1 ||
    !attempts.every((a) => a.id === paid[0]!.id || TERMINAL_UNPAID.has(a.status))
  )
    throw errors.conflict(
      'DEPOSIT_NOT_VERIFIED',
      'The full requested deposit must be verified by the payment gateway before creating the booking. A slip or a staff receipt cannot unlock it.',
    );
  return { draft, attempt: paid[0]! };
}

/** Durable cross-service claim: every retry uses the same receipt, id and final booking details. */
export async function claimPrebooking(
  db: Db,
  op: OpContext,
  operatorId: string,
  conversationId: string,
  input: InboxBookDateBody,
) {
  return withTx(db, { ...op, idempotency: undefined }, 'inbox.prebooking.claim', async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`prebooking:${conversationId}`}, 0))`,
    );
    const paid = await paidPrebooking(tx, operatorId, conversationId, input);
    const booking = InboxBookDateBodySchema.strip().parse(input);
    const claim = paid.draft.bookingClaim;
    if (
      claim &&
      (claim.attemptId !== paid.attempt.id ||
        JSON.stringify(InboxBookDateBodySchema.parse(claim.booking)) !== JSON.stringify(booking))
    )
      throw errors.conflict(
        'BOOKING_CLAIM_CHANGED',
        'A booking attempt is already in progress with the saved details. Retry those details to recover its result.',
      );
    if (!claim)
      await tx
        .update(prebookingDraft)
        .set({ bookingClaim: { attemptId: paid.attempt.id, booking }, updatedAt: new Date() })
        .where(eq(prebookingDraft.id, paid.draft.id));
    return paid;
  });
}

export async function requestPrebookingDeposit(
  deps: { db: Db; env: Env; log: FastifyBaseLogger; sender: PartyMessageSender | null },
  ctx: ActionCtx,
  op: OpContext,
  conversationId: string,
  input: InboxPrebookingRequest,
): Promise<InboxPrebooking> {
  const { db, env, log } = deps;
  const conv = await authorizePrebooking(db, ctx, conversationId, input.booking.branchId);
  // Match the existing manager-only Billing press using the Inbox's scoped
  // manager authority. A conversation assignment itself grants no money action.
  assertPrebookingRequestAuthority(ctx, input.booking.branchId);
  if (
    conv.eventOrderRef &&
    !isRemovedStanding(await eventStandingOf(db, ctx.viewer.operatorId, conv.eventOrderRef))
  )
    throw errors.conflict(
      'EVENT_ALREADY_BOOKED',
      'This conversation already has its booking. Open its BEO.',
    );
  const [park] = await db
    .select()
    .from(branch)
    .where(
      and(
        eq(branch.id, input.booking.branchId),
        eq(branch.operatorId, ctx.viewer.operatorId),
        isNull(branch.archivedAt),
      ),
    )
    .limit(1);
  if (!park) throw errors.notFound('Branch not found');
  if (input.booking.date < isoDateInTz(ctx.now, park.timezone))
    throw errors.conflict(
      'EVENT_DATE_PASSED',
      'Choose a current or future date before requesting the deposit.',
    );
  const provider = gatewayProviderOf(env);
  const returnUrl = partyDepositReturnUrlOf(env, provider);
  if (!returnUrl)
    throw errors.conflict(
      'DEPOSIT_NOT_CONFIGURED',
      'The deposit payment gateway is not configured. No booking was created.',
    );
  const requestId = deriveId(ctx.viewer.operatorId, `prebooking-request:${input.requestId}`);
  const scope = { ...op, idempotency: undefined };
  const prepared = await withTx(db, scope, 'inbox.prebooking.request', async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`prebooking:${conversationId}`}, 0))`,
    );
    const [priorRequest] = await tx
      .select()
      .from(prebookingDepositRequest)
      .where(eq(prebookingDepositRequest.id, requestId))
      .limit(1);
    const [existing] = await tx
      .select()
      .from(prebookingDraft)
      .where(
        and(
          eq(prebookingDraft.operatorId, ctx.viewer.operatorId),
          eq(prebookingDraft.conversationId, conversationId),
          isNull(prebookingDraft.bookedAt),
        ),
      )
      .limit(1);
    if (priorRequest && (!existing || priorRequest.draftId !== existing.id))
      throw errors.conflict('IDEMPOTENCY_MISMATCH', 'This request id belongs to another deposit.');
    let draft = existing;
    if (
      draft &&
      (draft.id !== input.booking.id ||
        draft.branchId !== park.id ||
        draft.amountSatang !== input.amountSatang ||
        JSON.stringify(InboxBookDateBodySchema.parse(draft.booking)) !==
          JSON.stringify(input.booking))
    )
      throw errors.conflict(
        'DEPOSIT_DRAFT_CHANGED',
        'Use the existing deposit draft and its agreed amount.',
      );
    if (!draft) {
      const [taken] = await tx
        .select({ id: prebookingDraft.id })
        .from(prebookingDraft)
        .where(eq(prebookingDraft.id, input.booking.id))
        .limit(1);
      if (taken)
        throw errors.conflict('ID_IN_USE', 'This draft id already belongs to another booking.');
      [draft] = await tx
        .insert(prebookingDraft)
        .values({
          id: input.booking.id,
          operatorId: ctx.viewer.operatorId,
          branchId: park.id,
          conversationId,
          accountId: ctx.viewer.accountId,
          amountSatang: input.amountSatang,
          currency: env.PGW_CURRENCY_CODE,
          booking: input.booking,
        })
        .returning();
    }
    if (!draft) throw new Error('prebooking draft was not stored');
    const attempts = await attemptsOf(tx, draft.id);
    if (priorRequest || attempts.some((a) => !TERMINAL_UNPAID.has(a.status)))
      return { draft, attempt: null };
    const paidDay = businessDate(ctx.now, park.timezone, parseDayStart(park.businessDayStart));
    const invoiceNo = await mintWebInvoiceNo(tx, {
      businessDate: paidDay,
      prefix: env.PGW_INVOICE_PREFIX,
    });
    const attempt = await openAttempt(tx, {
      operatorId: ctx.viewer.operatorId,
      branchId: park.id,
      stationId: null,
      saleId: null,
      businessDate: paidDay,
      method: 'qr',
      methodCode: 'promptpay',
      provider,
      amountSatang: draft.amountSatang,
      invoiceNo,
      payload: {
        prebookingDraftId: draft.id,
        currency: draft.currency,
        channel: 'web',
        longLived: true,
      },
    });
    // An interrupted opening still has the configured lifetime, so inquiry
    // eventually closes it even when no hosted answer reached this process.
    await tx
      .update(paymentAttempt)
      .set({
        expiresAt: new Date(ctx.now.getTime() + env.PARTY_DEPOSIT_LINK_VALIDITY_MIN * 60_000),
      })
      .where(eq(paymentAttempt.id, attempt.id));
    await tx
      .insert(prebookingDepositRequest)
      .values({ id: requestId, draftId: draft.id, paymentAttemptId: attempt.id });
    await audit.record(tx, {
      operatorId: ctx.viewer.operatorId,
      branchId: park.id,
      actorAccountId: ctx.viewer.accountId,
      action: 'inbox.prebooking.request',
      entityType: 'prebooking_draft',
      entityId: draft.id,
      requestId: ctx.requestId,
      after: { conversationId, amountSatang: draft.amountSatang, paymentAttemptId: attempt.id },
    });
    return { draft, attempt };
  });
  if (prepared.attempt)
    await requestHostedPayment(db, env, log, scope, {
      attempt: prepared.attempt,
      description: `OTO Park birthday deposit ${input.booking.date}`,
      channels: [env.PGW_QR_CHANNEL_CODE, 'CC'],
      frontendReturnUrl: returnUrl,
      locale: conv.language === 'th' ? 'th' : 'en',
      expiryMinutes: env.PARTY_DEPOSIT_LINK_VALIDITY_MIN,
    });
  // The hosted result is on the original attempt before any message is posted.
  // Retry a failed post/send from that result, never open a second gateway page.
  const [active] = await db
    .select({ request: prebookingDepositRequest, attempt: paymentAttempt })
    .from(prebookingDepositRequest)
    .innerJoin(paymentAttempt, eq(paymentAttempt.id, prebookingDepositRequest.paymentAttemptId))
    .where(eq(prebookingDepositRequest.draftId, prepared.draft.id))
    .orderBy(desc(prebookingDepositRequest.createdAt), desc(prebookingDepositRequest.id))
    .limit(1);
  const page = active ? payloadOf(active.attempt).webPaymentUrl : null;
  if (
    !active ||
    active.attempt.status !== 'sent_to_terminal' ||
    typeof page !== 'string' ||
    !active.attempt.expiresAt
  )
    return view(db, prepared.draft);
  const link = partyDepositLinkOf(env, page);
  const storedBooking = InboxBookDateBodySchema.parse(prepared.draft.booking);
  const posted = await withTx(db, scope, 'inbox.prebooking.post', async (tx) => {
    const [live] = await tx.select().from(paymentAttempt).where(eq(paymentAttempt.id, active.attempt.id)).for('update').limit(1);
    if (live?.status !== 'sent_to_terminal') return null;
    await tx.update(paymentAttempt).set({ payload: sql`${paymentAttempt.payload} || jsonb_build_object('prebookingPaymentLink', ${link}::text)` }).where(eq(paymentAttempt.id, active.attempt.id));
    const lang = partyMessageLanguageOf(conv.language);
    const line = await postPartyMessage(tx, ctx.viewer.operatorId, {
      messageId: deriveId(active.request.id, 'request-message'),
      conversationId,
      key: 'party_deposit_request',
      variables: {
        amount: partyAmountWords(prepared.draft.amountSatang),
        date: partyDateWords(storedBooking.date, lang),
        link,
        validUntil: partyClockWords(active.attempt.expiresAt!, park.timezone, lang),
      },
      event: {
        kind: 'deposit_requested',
        payload: {
          requestId: active.request.id,
          draftId: prepared.draft.id,
          amountSatang: prepared.draft.amountSatang,
          currency: prepared.draft.currency,
        },
      },
      audit: {
        action: 'inbox.prebooking.post',
        entityType: 'prebooking_draft',
        entityId: prepared.draft.id,
        detail: {},
      },
      actorAccountId: ctx.viewer.accountId,
      requestId: ctx.requestId,
      now: ctx.now,
    });
    return line;
  });
  if (!posted) return view(db, prepared.draft);
  await sendPartyMessages(db, deps.sender, log, posted.replayed ? [] : [posted.messageId], {
    requestId: ctx.requestId,
    actorAccountId: ctx.viewer.accountId,
  });
  return view(db, prepared.draft);
}
