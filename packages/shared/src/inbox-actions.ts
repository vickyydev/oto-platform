import { z } from 'zod';
import { isIsoDate } from './dates';
import { INBOX_CATEGORY_KEYS, INBOX_STATUS_KEYS, InboxConversationEventSchema } from './inbox';

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

/**
 * Where a conversation can be moved: the destinations of the team badge
 * (Brief §8), and the GM queue (SCRUM-220 playbook) — operator-wide, like
 * Birthdays & Events and Marketing.
 */
export const InboxMoveDestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('birthdays') }),
  z.object({ kind: z.literal('marketing') }),
  z.object({ kind: z.literal('gm') }),
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

// --- Book Date: a birthday's event in the Events module (SCRUM-775) -----------------
//
// Owner decision, 4 November (closes Inbox owner question Q23): the OTO App's
// Events module is the one home for birthday orders. Book Date on a birthday
// conversation makes a TENTATIVE birthday event there from what a person
// confirmed out of the chat; the conversation keeps the event's id
// (`event_order_ref`) and the event names the conversation. Create BEO then
// opens that event's BEO form in the OTO App through the suite hand-off, at
// `event.beoPath`.

/** The refusal codes Book Date answers besides `ID_IN_USE` and the idempotency codes. */
export const INBOX_BOOK_DATE_REFUSALS = [
  /** 409: the conversation is not in Birthdays & Events. */
  'NOT_A_BIRTHDAY',
  /**
   * 409: the conversation already has its event (`details.eventId`): Create BEO
   * opens it. Not answered for an event the Events module deleted or archived
   * (SCRUM-820): the new date then takes the conversation.
   */
  'EVENT_ALREADY_BOOKED',
  /** 409: the OTO App has no branch for that park, so nothing was made. */
  'EVENT_BRANCH_NOT_MAPPED',
  /** 502: the Events module refused the event for another reason, in its own words. */
  'EVENTS_CALENDAR_REFUSED',
  /** 503: the Events module did not answer (or this deployment has none); nothing was booked here. */
  'EVENTS_CALENDAR_UNAVAILABLE',
  /** 409 (Create BEO, `…/open-beo`): no date is booked yet, so there is no event to open. */
  'NO_EVENT_YET',
  /**
   * 409 (Create BEO, `…/open-beo`; SCRUM-820): the party was deleted or archived
   * in the Events module (`details.eventId`), so there is no BEO to open. Book
   * Date is open again on the conversation.
   */
  'EVENT_REMOVED',
] as const;
export type InboxBookDateRefusal = (typeof INBOX_BOOK_DATE_REFUSALS)[number];

const IsoDate = z.string().refine(isIsoDate, 'Expected a calendar date, YYYY-MM-DD');
const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');
const Text = (max: number) => z.string().trim().max(max);

/**
 * `POST /inbox/conversations/{id}/book-date` — what the person confirmed. `id`
 * is caller-named: the event's own id in the Events module, so a second press
 * (or a retry after a lost answer) under the same id is the same event.
 */
export const InboxBookDateBodySchema = z
  .object({
    id: Uuid,
    /** The park, prefilled from the conversation's branch. */
    branchId: Uuid,
    date: IsoDate,
    /** The party's start; the Events module's own form starts at 14:00. */
    startTime: ClockTime,
    /** How many children are coming (the prototype's "# of kids"). */
    kids: z.number().int().min(0).max(1000).nullable(),
    adults: z.number().int().min(0).max(1000).nullable(),
    /** Who is booking: the contact's name, editable. */
    contactName: Text(200).min(1),
    /** The contact's phone, normalised to E.164 here. */
    phone: Text(50).nullable(),
    childName: Text(200).nullable(),
    /** The age the child is turning, when the chat says it. */
    childAge: z.number().int().min(0).max(30).nullable(),
  })
  .strict();
export type InboxBookDateBody = z.infer<typeof InboxBookDateBodySchema>;

/** What Book Date answers: the conversation's event, and whether this press made it. */
export const InboxBookDateResultSchema = z.object({
  conversationId: Uuid,
  event: InboxConversationEventSchema,
  /** False when the same id was booked before: the answer is the event as booked then. */
  created: z.boolean(),
});
export type InboxBookDateResult = z.infer<typeof InboxBookDateResultSchema>;

/** Whose line a proposed value came from: the family's (the customer) or a person on the team's. */
export const INBOX_BOOK_DATE_SOURCES = ['team', 'family'] as const;
export const InboxBookDateSourceSchema = z.enum(INBOX_BOOK_DATE_SOURCES);
export type InboxBookDateSource = z.infer<typeof InboxBookDateSourceSchema>;

/** One value the model read from the chat: the value, the chat's own words for it, and the line they are in. */
function proposed<T extends z.ZodTypeAny>(value: T) {
  return z
    .object({
      value,
      /** The line's own words for it, as written ("12 kds", "sat 21 novmber"). */
      text: z.string(),
      source: InboxBookDateSourceSchema,
      /** The message the words are in. */
      messageId: Uuid,
    })
    .nullable();
}

/**
 * `GET /inbox/conversations/{id}/book-date-proposal` (SCRUM-821) — Book
 * Date's values read from the whole chat by the model: the party's date,
 * start time, kids, adults, the child's name and age, and the park when the
 * chat names one, each with the chat's words and its line (the team's
 * confirmation winning where the family's line and the team's both speak).
 * `model: 'unavailable'` (the model is not configured here, or did not give a
 * usable answer) comes with `proposal: null`, and the dialog keeps the
 * pattern reading. `patternReading` is the SCRUM-814 reader's date and time
 * over the same lines, for comparison. A read: nothing is written.
 */
export const InboxBookDateProposalSchema = z.object({
  conversationId: Uuid,
  model: z.enum(['ai', 'unavailable']),
  proposal: z
    .object({
      date: proposed(IsoDate),
      startTime: proposed(ClockTime),
      kids: proposed(z.number().int().min(0).max(1000)),
      adults: proposed(z.number().int().min(0).max(1000)),
      childName: proposed(z.string().min(1).max(80)),
      childAge: proposed(z.number().int().min(0).max(30)),
      /** The park the chat names: one of the operator's branches, or null when it names one that is not. */
      branchHint: proposed(Uuid.nullable()),
    })
    .nullable(),
  patternReading: z.object({
    date: IsoDate.nullable(),
    /** The chat's words for the date; empty when it names none. */
    dateText: z.string(),
    source: InboxBookDateSourceSchema.nullable(),
    startTime: ClockTime.nullable(),
    timeText: z.string(),
  }),
});
export type InboxBookDateProposal = z.infer<typeof InboxBookDateProposalSchema>;


/**
 * `POST /inbox/conversations/{id}/open-beo` — Create BEO on a conversation
 * whose date is booked: a one-use suite hand-off into the OTO App, landing on
 * the event's BEO form (`launchUrl` already carries `beoPath` as its target).
 * The mint is recorded as `auth.handoff_issue` naming the conversation and the
 * event (`purpose: inbox.create_beo`). The answer IS a credential: it is never
 * kept for a replay, and a second press mints a second one-use hand-off.
 * Refused 409 `NO_EVENT_YET` before Book Date has made the event, and 409
 * `EVENT_REMOVED` once the Events module deleted or archived it (SCRUM-820).
 */
export const InboxOpenBeoResultSchema = z.object({
  conversationId: Uuid,
  eventId: Uuid,
  beoPath: z.string(),
  /** The OTO App's hand-off address, with the BEO form as its target. One use, about a minute. */
  launchUrl: z.string(),
  expiresAt: z.string().datetime(),
});
export type InboxOpenBeoResult = z.infer<typeof InboxOpenBeoResultSchema>;

/**
 * Create BEO's optional body (SCRUM-660). `aiFill: true` — what the Create BEO
 * button sends — lands on the BEO form with its AI Fill run on the
 * conversation's confirmation message (`beoPathOf(id, { aiFill: true })`);
 * without it (the event chip) the form opens as before. The message itself
 * never rides the hand-off: the OTO App asks for it server-side
 * (`GET /inbox/conversations/{id}/beo-confirmation`).
 */
export const InboxOpenBeoBodySchema = z.object({ aiFill: z.boolean().optional() }).strict();
export type InboxOpenBeoBody = z.infer<typeof InboxOpenBeoBodySchema>;

/**
 * One line of the conversation a BEO is filled from (SCRUM-815): who wrote it
 * (`customer` — the family; `staff` — a person on the team), when, and its
 * text as written. The assistant's lines, system notices, erased lines and
 * lines the channel refused are never in it.
 */
export const InboxBeoTranscriptLineSchema = z.object({
  id: Uuid,
  author: z.enum(['customer', 'staff']),
  /** When it was sent (or, before that is known, written). */
  at: Iso,
  text: z.string(),
});
export type InboxBeoTranscriptLine = z.infer<typeof InboxBeoTranscriptLineSchema>;

/**
 * `GET /inbox/conversations/{id}/beo-confirmation` (SCRUM-660) — the message
 * a birthday's BEO is filled from: the newest message a person on the team
 * sent in the conversation that names a date, a time and at least one more
 * party detail (guests, food or the programme). `message` is null when there
 * is none. `eventId` is the event Book Date made, so the reader can check the
 * conversation is still the one its event names.
 *
 * SCRUM-815: `transcript` is the conversation itself, oldest first — the
 * family's lines and the team's — so the fill reads the whole agreement, the
 * ruling message (`message`) named among them. Bounded: the newest 200 lines
 * within the 60 days before the newest one; `transcriptCut` says older lines
 * were left out.
 */
export const InboxBeoConfirmationSchema = z.object({
  conversationId: Uuid,
  eventId: Uuid.nullable(),
  message: z
    .object({
      id: Uuid,
      body: z.string(),
      bodyLanguage: z.string().nullable(),
      authorName: z.string().nullable(),
      sentAt: Iso.nullable(),
      createdAt: Iso,
    })
    .nullable(),
  /** How many of the team's newest messages were looked at to choose it. */
  scanned: z.number().int().min(0),
  /** The conversation, oldest first (SCRUM-815). */
  transcript: z.array(InboxBeoTranscriptLineSchema),
  /** Older lines were left out by the bounds. */
  transcriptCut: z.boolean(),
});
export type InboxBeoConfirmation = z.infer<typeof InboxBeoConfirmationSchema>;
