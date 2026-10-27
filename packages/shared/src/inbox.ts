import { z } from 'zod';

/**
 * THE UNIFIED INBOX'S RULES AND READ SHAPES (S2-19 I2b, SCRUM-581).
 *
 * Plan: docs/progress/plans/inbox-build/PLAN.md §3.1 (the shared rules), §3.2
 * (visibility), §3.3 (the read routes). Feature: docs/features/inbox.md
 * "Status, tabs and visibility" and "Conversation record, filters, dashboard".
 *
 * The rules are ported from the park's prototype,
 * `imports/oto-asset-manager/artifacts/oto-org-chart/src/WhatsAppDemo.tsx`,
 * and kept PURE so the api's lists and counts and the shell's tabs are the
 * same code, tested once. The api states each rule a second time as SQL (a
 * list is paged in the database); `apps/api/test/inbox-read.test.ts` pins the
 * two to each other over the demo conversations.
 *
 * THE OWNER-NOTE (plan "What reading the repo changed", "Open matters" 3).
 * The IT Brief says three tabs, the same for everyone, and that Team Inbox is
 * "everything Active for my team that isn't already mine". The prototype's
 * CODE differs on both counts: it hides My Inbox for the owner and both
 * reception views (`tabsForRole`, :705-710), and its Team tab includes the
 * viewer's own conversations (`inTab`, :716-717). Under the standing ruling
 * that prototype code is ported as is, these rules are the CODE's. The
 * difference is with the owner as a note on SCRUM-220; it does not block.
 */

// --- Vocabulary ----------------------------------------------------------------

/** The three categories of the IT Brief (the same list as `@oto/db` INBOX_CATEGORIES, pinned by a test). */
export const INBOX_CATEGORY_KEYS = ['birthdays', 'general', 'marketing'] as const;
export type InboxCategoryKey = (typeof INBOX_CATEGORY_KEYS)[number];

/** IT Brief: Active and Handled only. The prototype stores Active as "new" (:63, :181). */
export const INBOX_STATUS_KEYS = ['active', 'handled'] as const;
export type InboxStatusKey = (typeof INBOX_STATUS_KEYS)[number];

/** A team's kind (`@oto/db` INBOX_TEAM_KEYS). */
export const INBOX_TEAM_KINDS = ['birthdays', 'reception', 'marketing'] as const;
export type InboxTeamKind = (typeof INBOX_TEAM_KINDS)[number];

/** Every channel a contact can be on (`@oto/db` INBOX_CHANNELS). */
export const INBOX_CHANNEL_KEYS = ['whatsapp', 'instagram', 'facebook', 'line', 'telegram', 'webform'] as const;
export type InboxChannelKey = (typeof INBOX_CHANNEL_KEYS)[number];

/** The tabs, in the prototype's order (`TAB_DEFS`, :699-703). */
export const INBOX_TABS = ['mine', 'team', 'handled'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export const INBOX_TAB_LABELS: Record<InboxTab, string> = {
  mine: 'My Inbox',
  team: 'Team Inbox',
  handled: 'Handled',
};

/**
 * The views the prototype switches between (`Role`, :52-57), with its two
 * reception views folded into one: on the platform a reception desk is a
 * team per branch, and both of the prototype's reception views get the same
 * tabs. `staff` is the platform's name for the manual-only people (the
 * entertainment coordinator; `Staff.manualOnly`, :74) — the prototype gives
 * them no view of their own, so `tabsForRole` treats them as its default arm
 * does every non-owner, non-reception view.
 */
export const INBOX_VIEW_ROLES = ['owner', 'events', 'reception', 'marketing', 'staff'] as const;
export type InboxViewRole = (typeof INBOX_VIEW_ROLES)[number];

/**
 * The day the dashboard's "today" and the sampled read audit count in (plan
 * §3.6, "per Bangkok day"). The Inbox is operator-wide, not a branch's, so it
 * takes the parks' zone rather than one branch's row.
 */
export const INBOX_DAY_TIMEZONE = 'Asia/Bangkok';

/** At most this many conversations, or messages, in one page. */
export const INBOX_PAGE_DEFAULT = 50;
export const INBOX_PAGE_MAX = 100;

// --- The rules (ported) ---------------------------------------------------------

/**
 * `tabsForRole` (:705-710), as coded: the owner and reception see Team and
 * Handled; every other view sees all three. NOT the IT Brief's "same shape
 * for everyone" — see the owner-note at the top of this file.
 */
export function tabsForRole(role: InboxViewRole): InboxTab[] {
  if (role === 'owner') return ['team', 'handled'];
  if (role === 'reception') return ['team', 'handled'];
  return ['mine', 'team', 'handled'];
}

/**
 * A platform viewer can stand in more than one of the prototype's views at
 * once (a person in Birthdays & Events who also covers a reception desk).
 * Their tabs are the union, in the prototype's order. Operator-wide reading
 * is the owner's view and wins outright: the prototype's owner is exactly
 * "sees everything" (`inScope`, :663).
 */
export function tabsForRoles(roles: readonly InboxViewRole[]): InboxTab[] {
  if (roles.includes('owner')) return tabsForRole('owner');
  const held = new Set(roles.flatMap((r) => tabsForRole(r)));
  return INBOX_TABS.filter((t) => held.has(t));
}

/** What tab membership reads off a conversation the viewer can already see. */
export interface InboxTabFacts {
  status: InboxStatusKey;
  /** The viewer holds an active primary or support slot on it (`isAssigned`, :658-660). */
  assignedToViewer: boolean;
}

/**
 * `inTab` (:712-721), as coded. Applied AFTER visibility (the prototype
 * filters `inScope` first, :1063-1064), so "team" is every active
 * conversation the viewer can see — their own included, which is the code's
 * behaviour and not the Brief's (the owner-note above).
 */
export function inTab(c: InboxTabFacts, tab: InboxTab): boolean {
  switch (tab) {
    case 'mine':
      return c.assignedToViewer && c.status !== 'handled';
    case 'team':
      return c.status !== 'handled';
    case 'handled':
      return c.status === 'handled';
  }
}

/** The columns `isUnanswered` reads (plan §3.1). */
export interface InboxUnansweredFacts {
  status: InboxStatusKey;
  lastCustomerMessageAt: Date | string | null;
  /** A STAFF message only: AI lines do not count as an answer (:651). */
  lastStaffMessageAt: Date | string | null;
  /** The router's hand-off — the prototype's "Routed to …" pill (:653). */
  lastRoutedAt: Date | string | null;
}

const instant = (v: Date | string | null): number | null => (v === null ? null : new Date(v).getTime());

/**
 * `isUnanswered` (:644-656), restated over the conversation's columns.
 *
 * The prototype walks the thread back from the end: a staff reply first means
 * answered; a customer message, or a "Routed to" hand-off, first means a
 * person still owes an answer; reaching the start means answered. Over the
 * columns that is: active, and a customer message or a routing later than the
 * last staff message (or with no staff message at all). A thread with neither
 * a customer message nor a routing is answered, as the walk that finds
 * nothing returns false. AI messages are not staff messages, so they never
 * answer anything.
 */
export function isUnanswered(c: InboxUnansweredFacts): boolean {
  if (c.status === 'handled') return false;
  const staff = instant(c.lastStaffMessageAt);
  const customer = instant(c.lastCustomerMessageAt);
  const routed = instant(c.lastRoutedAt);
  const after = (t: number | null) => t !== null && (staff === null || t > staff);
  return after(customer) || after(routed);
}

/**
 * Where a conversation sits, as a move destination: `teamDestOf` (:965-969).
 *
 * The prototype has two parks and one rule — a general conversation goes to
 * Chalong's reception if its branch is Chalong, and to Central's otherwise
 * (including "all"). On the platform a park is a branch id, so "otherwise" is
 * the operator's FIRST reception branch (`defaultReceptionBranchId`, the
 * teams' sort order), which is Central for OTO.
 */
export type InboxTeamDest =
  | { kind: 'birthdays' }
  | { kind: 'marketing' }
  | { kind: 'reception'; branchId: string | null };

export function teamDestOf(
  c: { category: InboxCategoryKey; branchId: string | null },
  defaultReceptionBranchId: string | null,
): InboxTeamDest {
  if (c.category === 'birthdays') return { kind: 'birthdays' };
  if (c.category === 'marketing') return { kind: 'marketing' };
  return { kind: 'reception', branchId: c.branchId ?? defaultReceptionBranchId };
}

/** The viewer, as visibility needs them (plan §3.2). */
export interface InboxViewerScope {
  accountId: string;
  /** (a) `inbox:conversation:read` at operator scope. */
  operatorWide: boolean;
  /** (b) the branches they hold it at. */
  branchIds: readonly string[];
  /** (c) the team departments they hold it at — "in the team". */
  departmentIds: readonly string[];
}

/** A conversation, as visibility needs it. */
export interface InboxVisibilityFacts {
  branchId: string | null;
  /** The department of the conversation's team (`inbox.team.department_id`). */
  teamDepartmentId: string | null;
  /** The accounts holding an active slot on it. */
  assignedAccountIds: readonly string[];
}

/**
 * The scope rule (`inScope`, :662-674), on the platform's grants (plan §3.2):
 * (a) operator-wide reading is the owner's "everything"; (b) a branch grant
 * sees that branch's conversations; (c) a team member — a department-scoped
 * grant on the team's department — sees the team's; (d) anyone sees a
 * conversation they hold a slot on, which is all the GM's and the
 * coordinator's view is when they are in no team (the prototype's
 * `isAssigned` arm).
 */
export function isVisibleTo(c: InboxVisibilityFacts, viewer: InboxViewerScope): boolean {
  if (viewer.operatorWide) return true;
  if (c.branchId !== null && viewer.branchIds.includes(c.branchId)) return true;
  if (c.teamDepartmentId !== null && viewer.departmentIds.includes(c.teamDepartmentId)) return true;
  return c.assignedAccountIds.includes(viewer.accountId);
}

/**
 * The branch filter (:1066): a conversation matches its own branch, and one
 * with no branch (operator-wide — the prototype's "all") matches every branch.
 */
export function matchesBranchFilter(c: { branchId: string | null }, branchId: string | null | undefined): boolean {
  if (!branchId) return true;
  return c.branchId === null || c.branchId === branchId;
}

/** The search (:1079-1085): customer, intent and last message, case-insensitive. */
export function matchesSearch(
  c: { contactName: string | null; intent: string | null; preview: string | null },
  q: string | null | undefined,
): boolean {
  const needle = (q ?? '').trim().toLowerCase();
  if (needle === '') return true;
  return `${c.contactName ?? ''} ${c.intent ?? ''} ${c.preview ?? ''}`.toLowerCase().includes(needle);
}

// --- The read routes' shapes (plan §3.3) -----------------------------------------

const Iso = z.string();
const Uuid = z.string().uuid();
const TrueFalse = z.enum(['true', 'false']);

export const InboxTabSchema = z.enum(INBOX_TABS);
export const InboxCategorySchema = z.enum(INBOX_CATEGORY_KEYS);
export const InboxStatusSchema = z.enum(INBOX_STATUS_KEYS);
export const InboxChannelSchema = z.enum(INBOX_CHANNEL_KEYS);
export const InboxViewRoleSchema = z.enum(INBOX_VIEW_ROLES);

/** `GET /inbox/conversations` query. */
export const InboxConversationListQuerySchema = z.object({
  tab: InboxTabSchema.optional(),
  category: InboxCategorySchema.optional(),
  /** The branch filter: that branch's conversations and the operator-wide ones (:1066). */
  branchId: Uuid.optional(),
  status: InboxStatusSchema.optional(),
  language: z.string().min(1).max(16).optional(),
  /** Search across customer, intent and last message. */
  q: z.string().max(200).optional(),
  /** Only the conversations a person still owes an answer (`isUnanswered`). */
  unanswered: TrueFalse.optional(),
  /**
   * SCRUM-648: only the conversations whose contact has this phone, in any
   * format (normalised as every phone is). Visibility is unchanged; an
   * unreadable number matches nothing rather than reading as no filter.
   */
  phone: z.string().trim().min(1).max(40).optional(),
  /** The archive's date range, on `handled_at`, inclusive (ISO instants). */
  handledFrom: z.string().datetime({ offset: true }).optional(),
  handledTo: z.string().datetime({ offset: true }).optional(),
  /** The archive's "resolved by AI or human" (:1071-1078), on `handled_by_kind`. */
  resolvedBy: z.enum(['ai', 'human']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(INBOX_PAGE_MAX).default(INBOX_PAGE_DEFAULT),
});
export type InboxConversationListQuery = z.infer<typeof InboxConversationListQuerySchema>;

export const InboxAssigneeSchema = z.object({
  assignmentId: Uuid,
  slot: z.enum(['primary', 'support']),
  /** 0 = primary; 1 and 2 = the two support places. */
  slotIndex: z.number().int().min(0).max(2),
  assigneeKind: z.enum(['account', 'team', 'ai']),
  accountId: Uuid.nullable(),
  teamId: Uuid.nullable(),
  /** The person's name, or the team's ("Reception · Central"); null for the AI. */
  name: z.string().nullable(),
  reason: z.enum(['auto', 'manual', 'divert', 'move', 'reopen']),
  assignedAt: Iso,
});
export type InboxAssignee = z.infer<typeof InboxAssigneeSchema>;

export const InboxContactSchema = z.object({
  id: Uuid,
  channel: InboxChannelSchema,
  handle: z.string(),
  displayName: z.string().nullable(),
  phone: z.string().nullable(),
  language: z.string().nullable(),
  erased: z.boolean(),
});

export const InboxConversationRowSchema = z.object({
  id: Uuid,
  channel: InboxChannelSchema,
  channelAccountId: Uuid,
  /** False on a check-in notice thread (the console sender): it cannot carry a reply. */
  canReply: z.boolean(),
  contact: InboxContactSchema,
  category: InboxCategorySchema,
  intent: z.string().nullable(),
  language: z.string().nullable(),
  branchId: Uuid.nullable(),
  teamId: Uuid.nullable(),
  status: InboxStatusSchema,
  handledAt: Iso.nullable(),
  handledByKind: z.enum(['account', 'ai']).nullable(),
  lastMessageAt: Iso.nullable(),
  lastMessagePreview: z.string().nullable(),
  unanswered: z.boolean(),
  /** Customer messages after the viewer's last read one (`participant`). */
  unread: z.number().int().min(0),
  /** The viewer holds a slot on it — My Inbox. */
  mine: z.boolean(),
  assignments: z.array(InboxAssigneeSchema),
  createdAt: Iso,
});
export type InboxConversationRow = z.infer<typeof InboxConversationRowSchema>;

export const InboxTabCountsSchema = z.object({
  mine: z.number().int().min(0).optional(),
  team: z.number().int().min(0).optional(),
  handled: z.number().int().min(0).optional(),
});

export const InboxConversationListSchema = z.object({
  conversations: z.array(InboxConversationRowSchema),
  /** Pass back as `cursor` for the next page; null on the last one. */
  nextCursor: z.string().nullable(),
  /** The viewer's tabs, counted over everything they can see, before filters (:1088-1097). */
  tabCounts: InboxTabCountsSchema,
});
export type InboxConversationList = z.infer<typeof InboxConversationListSchema>;

/**
 * The assistant's standing on a thread (SCRUM-590 test night, W4b), computed
 * by the api from the number's mode and the thread's holds; the inbox shell
 * shows these exact words. Order of precedence: `off`, then a hold a person
 * can clear with Resume (`paused`, `person_replied`, `left_for_team`), then
 * `shadow`, then `ready`.
 */
export const INBOX_AI_STATES = ['off', 'shadow', 'ready', 'paused', 'left_for_team', 'person_replied'] as const;
export type InboxAiState = (typeof INBOX_AI_STATES)[number];

export const InboxEventSchema = z.object({
  id: Uuid,
  kind: z.string(),
  actorKind: z.enum(['customer', 'account', 'ai', 'system']),
  actorAccountId: Uuid.nullable(),
  actorName: z.string().nullable(),
  /** Ids, slots, statuses, the team, the branch — never a message body. */
  payload: z.record(z.string(), z.unknown()),
  createdAt: Iso,
});

export const InboxConversationDetailSchema = InboxConversationRowSchema.extend({
  teamName: z.string().nullable(),
  firstResponseAt: Iso.nullable(),
  reopenedAt: Iso.nullable(),
  /** The linked member's name and child count — no allergy text; the POS owns that. */
  member: z.object({ id: Uuid, name: z.string(), childCount: z.number().int().min(0) }).nullable(),
  /** The timeline's grey pills, oldest first. */
  events: z.array(InboxEventSchema),
  /**
   * Who "Divert" would make primary (I3b, SCRUM-588): the routing rule's fixed
   * pair at this conversation, read exactly as `POST …/divert` reads it — so
   * the shell shows Divert only when the press would work. Null when the rule
   * has no backup (reception) or the backup is not an active account: the
   * press would answer `DIVERT_NO_BACKUP`.
   */
  divertTo: z.object({ accountId: Uuid, name: z.string().nullable() }).nullable(),
  /** The thread's number's assistant switch (SCRUM-590): `off`, `shadow` or `live`. */
  aiMode: z.enum(['off', 'shadow', 'live']),
  /**
   * The assistant's standing on this thread (SCRUM-590 test night, W4b), in
   * the words the chip shows: the number's switch is off; it is in shadow
   * (it decides, nobody gets a line); it is `ready` for the next customer
   * message; or a person's act holds it — `paused` (the chip's Pause),
   * `person_replied` (a reply or any action of a person this episode),
   * `left_for_team` (its own hand-over). Resume clears every hold.
   */
  aiState: z.enum(INBOX_AI_STATES),
  /** A person paused the assistant on this thread (`POST …/ai-pause`); `…/ai-resume` clears it. */
  aiPaused: z.boolean(),
  aiPausedAt: Iso.nullable(),
  aiPausedByAccountId: Uuid.nullable(),
});
export type InboxConversationDetail = z.infer<typeof InboxConversationDetailSchema>;

export const InboxMessagesQuerySchema = z.object({
  /** A message id: the page before it (older). Omitted: the newest page. */
  before: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(INBOX_PAGE_MAX).default(INBOX_PAGE_DEFAULT),
});

export const InboxMessageSchema = z.object({
  id: Uuid,
  direction: z.enum(['inbound', 'outbound']),
  authorKind: z.enum(['customer', 'staff', 'ai', 'system']),
  authorAccountId: Uuid.nullable(),
  authorName: z.string().nullable(),
  /** Null once redacted (PDPA erasure). */
  body: z.string().nullable(),
  bodyLanguage: z.string().nullable(),
  translatedBody: z.string().nullable(),
  translatedTo: z.string().nullable(),
  /** File ids; a signed URL comes from the files api after the conversation check. */
  mediaFileIds: z.array(Uuid),
  audioFileId: Uuid.nullable(),
  transcript: z.string().nullable(),
  templateId: Uuid.nullable(),
  /**
   * The delivery state of an outbound message; null on an inbound one.
   * `withdrawn` (SCRUM-590): an AI line a person overtook before it left —
   * never sent, so the customer never saw it; staff see it as held back.
   * `shadow` (SCRUM-590 test night, W5): what the assistant WOULD have said
   * on a number in shadow mode — kept for staff, never sent; its `ai_shadow`
   * pill names it by `messageId` and carries the turn id.
   */
  providerStatus: z.enum(['queued', 'sent', 'delivered', 'read', 'failed', 'withdrawn', 'shadow']).nullable(),
  source: z.enum(['channel', 'checkin.contact', 'booking.confirmation']),
  sentAt: Iso.nullable(),
  deliveredAt: Iso.nullable(),
  readAt: Iso.nullable(),
  redacted: z.boolean(),
  createdAt: Iso,
});
export type InboxMessage = z.infer<typeof InboxMessageSchema>;

export const InboxMessagePageSchema = z.object({
  /** Oldest first within the page. */
  messages: z.array(InboxMessageSchema),
  /** Pass as `before` for the older page; null when this page reaches the start. */
  olderCursor: Uuid.nullable(),
});

export const InboxMarkReadBodySchema = z.object({
  /** Read up to this message; omitted, up to the newest. */
  messageId: Uuid.optional(),
});

export const InboxMarkReadSchema = z.object({
  conversationId: Uuid,
  lastReadMessageId: Uuid.nullable(),
  lastReadAt: Iso.nullable(),
  /** Whether this read wrote the day's audit row (one per account, conversation and Bangkok day). */
  audited: z.boolean(),
});

/**
 * Whose conversations the dashboard's numbers are over (SCRUM-220 test
 * night, R9): the operator's whole inbox, the viewer's teams and parks, or
 * only the threads the viewer holds. Every number on the card, the average
 * response time included, is over this population — two viewers see two
 * averages, and the card can say whose.
 */
export const INBOX_DASHBOARD_SCOPES = ['mine', 'team', 'all'] as const;
export type InboxDashboardScope = (typeof INBOX_DASHBOARD_SCOPES)[number];

/** Which conversations By category counts: the active ones (the Active card's population), or every status. */
export const INBOX_DASHBOARD_POPULATIONS = ['active', 'all'] as const;

export const InboxDashboardSchema = z.object({
  /** Whose conversations every number below is over. */
  scope: z.enum(INBOX_DASHBOARD_SCOPES),
  /** Conversations started today (Bangkok day), within what the viewer can see. */
  newToday: z.number().int().min(0),
  /** Active conversations a person still owes an answer. */
  unanswered: z.number().int().min(0),
  handledToday: z.number().int().min(0),
  active: z.number().int().min(0),
  /** Mean of first staff response less the conversation's start, in seconds; null when nothing was answered. Opening hours are ignored (owner Q25). */
  averageFirstResponseSeconds: z.number().min(0).nullable(),
  /**
   * The population By category counts: `active`, the Active card's (SCRUM-220
   * test night, R3). The prototype counted every scoped conversation whatever
   * its status (:1121-1125), which read as 15 under the categories beside an
   * Active of 12.
   */
  population: z.enum(INBOX_DASHBOARD_POPULATIONS),
  /** Active visible conversations by category; the three add up to `active`. */
  byCategory: z.object({ birthdays: z.number().int(), general: z.number().int(), marketing: z.number().int() }),
  /** The Bangkok day "today" means, `YYYY-MM-DD`. */
  day: z.string(),
});
export type InboxDashboard = z.infer<typeof InboxDashboardSchema>;

export const InboxTeamSchema = z.object({
  id: Uuid,
  kind: z.enum(INBOX_TEAM_KINDS),
  name: z.string(),
  colour: z.string(),
  branchId: Uuid.nullable(),
  /** The viewer is in it (a department-scoped grant on its department). */
  member: z.boolean(),
});

export const InboxPersonSchema = z.object({
  accountId: Uuid,
  name: z.string().nullable(),
  /** The teams they are in. Empty for a manager or a manual-only person. */
  teamIds: z.array(Uuid),
  /** Reads every conversation of the operator (the owner, the GM). */
  operatorWide: z.boolean(),
});

export const InboxMeSchema = z.object({
  accountId: Uuid,
  name: z.string().nullable(),
  /** The prototype views the viewer stands in. */
  roles: z.array(InboxViewRoleSchema),
  /** `tabsForRoles(roles)`: the ported code's tabs. */
  tabs: z.array(InboxTabSchema),
  /** Every team of the operator, the viewer's marked; the move picker's list. */
  teams: z.array(InboxTeamSchema),
  /** Who can hold a slot: the teams' people and the operator-wide readers. */
  people: z.array(InboxPersonSchema),
  /** The reception team of the operator's first park: where `teamDestOf` sends a general conversation with no branch. */
  defaultReceptionBranchId: Uuid.nullable(),
  capabilities: z.object({
    /**
     * The write switch (plan "Write switch"): the write actions are live. On
     * since I2f (reply, templates, sending); a check-in notice thread still
     * cannot carry a reply, which its row's `canReply` says.
     */
    writes: z.boolean(),
    dashboard: z.boolean(),
    assign: z.boolean(),
    move: z.boolean(),
    reopen: z.boolean(),
    /** Holds `inbox:template:manage` somewhere: the template settings page (I3b). */
    templates: z.boolean(),
    /** Holds `inbox:kb:manage` somewhere: the Assistant page's knowledge base and examples queue (SCRUM-590). */
    kb: z.boolean(),
    /** Holds `inbox:ai:manage` somewhere: the per-number assistant switch (SCRUM-590). */
    ai: z.boolean(),
  }),
  /**
   * The simulator panel (I3b): non-null only when this deployment runs the
   * inbox simulator (`INBOX_SIMULATOR=on`, never production) AND the viewer
   * holds `inbox:channel:manage` somewhere — the two things the
   * `/inbox/simulator/*` routes check. Its simulator channel accounts are the
   * ones a pretend customer can write to; none until the demo is played.
   */
  simulator: z
    .object({
      channelAccounts: z.array(
        z.object({
          id: Uuid,
          channel: InboxChannelSchema,
          displayName: z.string(),
          branchId: Uuid.nullable(),
        }),
      ),
    })
    .nullable(),
});
export type InboxMe = z.infer<typeof InboxMeSchema>;

export const InboxTemplatesQuerySchema = z.object({
  language: z.string().min(1).max(16).optional(),
});

export const InboxTemplateSchema = z.object({
  id: Uuid,
  key: z.string(),
  language: z.string(),
  channel: InboxChannelSchema.nullable(),
  branchId: Uuid.nullable(),
  body: z.string(),
  attachmentFileIds: z.array(Uuid),
  approvalStatus: z.enum(['not_required', 'pending', 'approved', 'rejected']),
  /** A RU or TH row still carrying the English source. */
  needsTranslation: z.boolean(),
});

export const InboxTemplateListSchema = z.object({ templates: z.array(InboxTemplateSchema) });

// --- PDPA: the erasure (S2-19 I2g, SCRUM-586; plan §3.6) ---------------------------

/** What an erased contact is called everywhere it is read. */
export const INBOX_ERASED_CONTACT_NAME = 'Erased contact';

/**
 * The word the erasure's second confirmation types. The first is the contact
 * id repeated in the body; both must be present, or the api answers
 * `409 ERASURE_UNCONFIRMED` with what WOULD be erased, and erases nothing.
 */
export const INBOX_ERASE_CONFIRM_WORD = 'ERASE';

export const InboxEraseContactBodySchema = z.object({
  /** Confirmation one: the contact id of the path, repeated. */
  confirmContactId: Uuid.optional(),
  /** Confirmation two: the word `ERASE`. */
  confirm: z.string().max(16).optional(),
});

/** Counts and ids only: the erasure answers nothing it has just removed. */
export const InboxErasureCountsSchema = z.object({
  /** The named contact and every other live contact of the operator with the same phone. */
  contactIds: z.array(Uuid),
  conversations: z.number().int(),
  messages: z.number().int(),
  /** Mirrored check-in and booking notices among the messages. */
  noticeMessages: z.number().int(),
  filesDeleted: z.number().int(),
  filesUnlinked: z.number().int(),
  eventsRedacted: z.number().int(),
  webhookPayloadsPurged: z.number().int(),
  /**
   * The assistant's curated examples (SCRUM-590, plan §D.5): the UNAPPROVED
   * ones (proposed or rejected) whose source links point at the subject's
   * threads, deleted. An approved one already points at nothing.
   */
  examplesDeleted: z.number().int(),
});

export const InboxEraseContactSchema = InboxErasureCountsSchema.extend({
  contactId: Uuid,
  /** True when every contact named was already erased: nothing of theirs was left to remove. */
  alreadyErased: z.boolean(),
  erasedAt: Iso,
});
export type InboxEraseContact = z.infer<typeof InboxEraseContactSchema>;
export type InboxErasureCounts = z.infer<typeof InboxErasureCountsSchema>;
