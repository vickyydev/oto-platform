import { sql } from 'drizzle-orm';
import { check, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { core, idPk, timestamps } from './helpers';
import { suiteControlApproval } from './suite-controls';
import { account, operator, session } from './tenancy';

/**
 * SCRUM-648 (S2-23 P5-6): the apps a support administrator may view as
 * another account. The booth is identity-only (it holds no session to view
 * through) and the Console is refused outright: nobody who can be
 * impersonated holds any Console permission.
 */
export const IMPERSONATION_TARGET_APPS = ['pos', 'oto_app', 'radar', 'inbox'] as const;
export type ImpersonationTargetApp = typeof IMPERSONATION_TARGET_APPS[number];
export const IMPERSONATION_MODES = ['read_only', 'write_allowed'] as const;
export type ImpersonationMode = typeof IMPERSONATION_MODES[number];
export const IMPERSONATION_END_REASONS = ['ended', 'actor_signed_out', 'subject_signed_out'] as const;
export type ImpersonationEndReason = typeof IMPERSONATION_END_REASONS[number];

/**
 * One audited, time-boxed "view as" window (S2-23 Support tools).
 *
 * The window IS a session: `session_id` names a session row of the SUBJECT,
 * minted for this window alone, expiring with it, and refused by the session
 * loader the moment the window ends, the actor's own session ends, or the
 * expiry passes — whichever comes first. A row is never deleted; the subject
 * reads their own rows afterwards.
 */
export const impersonationSession = core.table('impersonation_session', {
  id: idPk(),
  /** The subject's operator: whose tenant the window reads. */
  operatorId: uuid('operator_id').notNull().references(() => operator.id),
  actorAccountId: uuid('actor_account_id').notNull().references(() => account.id),
  /** The actor's own Console session; its end ends the window. */
  actorSessionId: uuid('actor_session_id').notNull().references(() => session.id),
  subjectAccountId: uuid('subject_account_id').notNull().references(() => account.id),
  /** The marked session minted for the window. */
  sessionId: uuid('session_id').notNull().references(() => session.id),
  targetApp: text('target_app').$type<ImpersonationTargetApp>().notNull(),
  mode: text('mode').$type<ImpersonationMode>().notNull(),
  reason: text('reason'),
  reference: text('reference'),
  /** The two-administrator approval a `write_allowed` window consumed, when dual control applied. */
  approvalId: uuid('approval_id').references(() => suiteControlApproval.id),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
  endReason: text('end_reason').$type<ImpersonationEndReason>(),
  ...timestamps,
}, t => [
  index('impersonation_session_operator_idx').on(t.operatorId),
  index('impersonation_session_actor_idx').on(t.actorAccountId, t.startedAt),
  index('impersonation_session_actor_session_idx').on(t.actorSessionId),
  index('impersonation_session_subject_idx').on(t.subjectAccountId, t.startedAt),
  uniqueIndex('impersonation_session_session_unique').on(t.sessionId),
  uniqueIndex('impersonation_session_approval_unique').on(t.approvalId),
  check('impersonation_session_target_app_check', sql`${t.targetApp} in ('pos', 'oto_app', 'radar', 'inbox')`),
  check('impersonation_session_mode_check', sql`${t.mode} in ('read_only', 'write_allowed')`),
  check('impersonation_session_not_self_check', sql`${t.actorAccountId} <> ${t.subjectAccountId}`),
  check('impersonation_session_window_check', sql`${t.expiresAt} > ${t.startedAt}`),
  check('impersonation_session_write_reason_check', sql`${t.mode} = 'read_only' or (
    length(btrim(coalesce(${t.reason}, ''))) > 0 and length(btrim(coalesce(${t.reference}, ''))) > 0)`),
  check('impersonation_session_end_check', sql`(${t.endedAt} is null and ${t.endReason} is null) or (
    ${t.endedAt} is not null and ${t.endedAt} >= ${t.startedAt}
    and ${t.endReason} in ('ended', 'actor_signed_out', 'subject_signed_out'))`),
]);
