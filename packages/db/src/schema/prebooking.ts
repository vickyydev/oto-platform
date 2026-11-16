import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { paymentAttempt } from './sales';

/** A quote/payment draft only. Its id becomes an event id on an explicit staff booking. */
export const prebookingDraft = pos.table(
  'prebooking_draft',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    amountSatang: bigint('amount_satang', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    booking: jsonb('booking').$type<Record<string, unknown>>().notNull(),
    /** Frozen before the cross-service call, so a lost answer cannot book different details. */
    bookingClaim: jsonb('booking_claim').$type<{
      attemptId: string;
      booking: Record<string, unknown>;
    }>(),
    bookedAt: timestamp('booked_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('prebooking_draft_open_conversation_unique')
      .on(t.conversationId)
      .where(sql`${t.bookedAt} is null`),
    index('prebooking_draft_operator_idx').on(t.operatorId, t.conversationId),
    check(
      'prebooking_draft_amount_check',
      sql`${t.amountSatang} > 0 and ${t.amountSatang} % 100 = 0`,
    ),
  ],
);

/** Request retries retain their original attempt/invoice; no second financial ledger. */
export const prebookingDepositRequest = pos.table(
  'prebooking_deposit_request',
  {
    id: idPk(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => prebookingDraft.id, { onDelete: 'restrict' }),
    paymentAttemptId: uuid('payment_attempt_id')
      .notNull()
      .references(() => paymentAttempt.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('prebooking_deposit_attempt_unique').on(t.paymentAttemptId),
    index('prebooking_deposit_draft_idx').on(t.draftId, t.createdAt),
  ],
);
