import { z } from 'zod';
import { INBOX_CATEGORY_KEYS, INBOX_STATUS_KEYS } from './inbox';

/**
 * THE INBOX'S OWNERSHIP AND STATUS ACTIONS — their shapes (S2-19 I2e,
 * SCRUM-584; plan docs/progress/plans/inbox-build/PLAN.md §3.3, the [B] rows;
 * `docs/features/inbox.md` "Ownership and assignment" and "Status").
 *
 * The refusal codes are the api's and the shell's one vocabulary: the shell
 * reads `CATEGORY_MOVE_UNCONFIRMED` and shows the prototype's confirmation
 * ("Changing primary owner will move this conversation to the new department.
 * Continue?"), then repeats the request with `confirmMove: true`.
 */

const Uuid = z.string().uuid();
const Iso = z.string();

/** The 409 codes the actions answer. */
export const INBOX_ACTION_REFUSALS = [
  'CATEGORY_MOVE_UNCONFIRMED',
  'ALREADY_ON_CONVERSATION',
  'SUPPORT_FULL',
  'DIVERT_NO_BACKUP',
  'ALREADY_IN_TEAM',
  'ALREADY_HANDLED',
  'NOT_HANDLED',
] as const;
export type InboxActionRefusal = (typeof INBOX_ACTION_REFUSALS)[number];

/** `PUT /inbox/conversations/{id}/primary`. */
export const InboxPrimaryBodySchema = z.object({
  /** A person, or a team (the reception phone). */
  assignee: z.object({ kind: z.enum(['account', 'team']), id: Uuid }),
  /** The answer to the move confirmation; required when the new primary's team is not the conversation's. */
  confirmMove: z.boolean().optional(),
});
export type InboxPrimaryBody = z.infer<typeof InboxPrimaryBodySchema>;

/** `POST /inbox/conversations/{id}/support`. */
export const InboxSupportBodySchema = z.object({ accountId: Uuid });

/** Where a conversation can be moved: the four destinations of the team badge (Brief §8). */
export const InboxMoveDestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('birthdays') }),
  z.object({ kind: z.literal('marketing') }),
  z.object({ kind: z.literal('reception'), branchId: Uuid }),
]);

/** `POST /inbox/conversations/{id}/move`. */
export const InboxMoveBodySchema = z.object({ dest: InboxMoveDestSchema });

/** `PATCH /inbox/conversations/{id}/branch` — the branch select; setting a branch confirms it. */
export const InboxBranchBodySchema = z.object({ branchId: Uuid.nullable() });

/** The `{ id }` and the slot ids in the action paths. */
export const InboxSupportParamsSchema = z.object({ id: Uuid, assignmentId: Uuid });

export const InboxActionSlotSchema = z.object({
  assignmentId: Uuid,
  slot: z.enum(['primary', 'support']),
  slotIndex: z.number().int().min(0).max(2),
  assigneeKind: z.enum(['account', 'team', 'ai']),
  accountId: Uuid.nullable(),
  teamId: Uuid.nullable(),
  reason: z.enum(['auto', 'manual', 'divert', 'move', 'reopen']),
  assignedAt: Iso,
});

/** What every action answers: the conversation's state after it, and its active slots. */
export const InboxActionResultSchema = z.object({
  conversation: z.object({
    id: Uuid,
    status: z.enum(INBOX_STATUS_KEYS),
    category: z.enum(INBOX_CATEGORY_KEYS),
    teamId: Uuid.nullable(),
    branchId: Uuid.nullable(),
    handledAt: Iso.nullable(),
    handledByKind: z.enum(['account', 'ai']).nullable(),
    handledByAccountId: Uuid.nullable(),
    reopenedAt: Iso.nullable(),
  }),
  /** Active slots, primary first. */
  assignments: z.array(InboxActionSlotSchema),
  /** The action moved the conversation to another team (a move, or category-follows-primary). */
  moved: z.boolean(),
});
export type InboxActionResult = z.infer<typeof InboxActionResultSchema>;

/**
 * Why the branch step added no host (SCRUM-220 test night, R4): no hosting
 * rule names a person at that branch; the person named is not an active
 * account; they are on the thread already; both support places are taken.
 */
export const INBOX_HOST_SKIP_REASONS = ['no_host', 'host_inactive', 'already_on', 'support_full'] as const;
export type InboxHostSkipReason = (typeof INBOX_HOST_SKIP_REASONS)[number];

/**
 * `PATCH …/branch` also says what the birthday step did: `hostAdded`, and
 * then either `host` (who joined) or `hostSkipped` (the one reason nobody
 * did). Both are null on a thread that is not a birthday.
 */
export const InboxBranchResultSchema = InboxActionResultSchema.extend({
  hostAdded: z.boolean(),
  hostSkipped: z.enum(INBOX_HOST_SKIP_REASONS).nullable(),
  /** The hosting birthday manager who joined as support: their account and their name (null when no employee record). */
  host: z.object({ accountId: Uuid, name: z.string().nullable() }).nullable(),
});
export type InboxBranchResult = z.infer<typeof InboxBranchResultSchema>;

/**
 * The 409 an action answers (SCRUM-220 test night, R8): the platform's error
 * envelope, with `code` one of `INBOX_ACTION_REFUSALS` for the action's own
 * refusals — `SUPPORT_FULL` says "Both support places are taken. Remove
 * someone first." — or an idempotency code. Said here so the shell can show
 * the sentence rather than a generic failure.
 */
export const InboxActionRefusalSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type InboxActionRefusalBody = z.infer<typeof InboxActionRefusalSchema>;
