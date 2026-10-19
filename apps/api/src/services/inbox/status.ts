import type { conversation } from '@oto/db';

/**
 * THE TWO STATUSES' COLUMN STATES (S2-19 I2e, SCRUM-584; IT Brief: Active and
 * Handled only).
 *
 * A conversation is reopened two ways: automatically, when the customer
 * writes again (the ingest, I2d), and by hand, when a manager picks Active
 * from the status picker (`actions.ts`). Both must leave the row in the SAME
 * state — `inbox-actions.test.ts` drives one of each and compares every
 * column — so the patch and the timeline payload are written once, here, and
 * both paths use them.
 *
 *   - handled → active: `handled_at` and `handled_by_*` cleared, `reopened_at`
 *     set, the assignments untouched; what was cleared is kept on the
 *     `reopened` event's payload and on the audit row's `before`.
 */

type ConversationRow = typeof conversation.$inferSelect;
type ConversationPatch = Partial<typeof conversation.$inferInsert>;

/** The columns a reopen writes, by either path. */
export function reopenPatch(at: Date, now: Date): ConversationPatch {
  return {
    status: 'active',
    reopenedAt: at,
    handledAt: null,
    handledByKind: null,
    handledByAccountId: null,
    updatedAt: now,
  };
}

/** What the `reopened` pill keeps of the handled state it cleared (ids and times only). */
export function reopenedPayload(
  previous: Pick<ConversationRow, 'handledAt' | 'handledByKind' | 'handledByAccountId'>,
  automatic: boolean,
): Record<string, unknown> {
  return {
    automatic,
    previousHandledAt: previous.handledAt?.toISOString() ?? null,
    previousHandledByKind: previous.handledByKind,
    previousHandledByAccountId: previous.handledByAccountId,
  };
}

/** The audit row's `before` for a reopen, by either path. */
export function reopenAuditBefore(
  previous: Pick<ConversationRow, 'handledAt' | 'handledByKind' | 'handledByAccountId'>,
): Record<string, unknown> {
  return {
    status: 'handled',
    handledAt: previous.handledAt?.toISOString() ?? null,
    handledByKind: previous.handledByKind,
    handledByAccountId: previous.handledByAccountId,
  };
}

/** The columns Mark as Handled writes: a person, now. */
export function handledPatch(accountId: string, at: Date): ConversationPatch {
  return {
    status: 'handled',
    handledAt: at,
    handledByKind: 'account',
    handledByAccountId: accountId,
    updatedAt: at,
  };
}
