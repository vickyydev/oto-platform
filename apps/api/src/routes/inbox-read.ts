import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  InboxActionRefusalSchema,
  InboxBeoConfirmationSchema,
  InboxBookDateProposalSchema,
  InboxConversationDetailSchema,
  InboxConversationListQuerySchema,
  InboxConversationListSchema,
  InboxDashboardSchema,
  InboxMarkReadBodySchema,
  InboxMarkReadSchema,
  InboxMeSchema,
  InboxMessagePageSchema,
  InboxMessagesQuerySchema,
  InboxTemplateListSchema,
  InboxTemplatesQuerySchema,
  type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { PermissionDeniedError } from '../plugins/session';
import { opCtx, withTx } from '../services/tx';
import { bannerOf, impersonationMarksOf } from '../services/impersonation';
import { beoConfirmationOf } from '../services/inbox/beo-confirmation';
import { BOOK_DATE_PROPOSAL_RATE, bookDateProposalOf } from '../services/inbox/book-date-proposal';
import { holdsAnywhere, viewerScopeOf, type InboxViewer } from '../services/inbox/read-visibility';
import {
  conversationDetail,
  conversationMessages,
  inboxDashboard,
  inboxMe,
  inboxTemplates,
  listConversations,
  markConversationRead,
  viewerTabs,
} from '../services/inbox/read';

/**
 * THE INBOX'S READ ROUTES (S2-19 I2b, SCRUM-581; plan §3.3, the [A] rows).
 *
 * Every route here declares `dynamicPermission`: the inbox permissions are
 * held at a TEAM'S DEPARTMENT, a branch or the operator, and a department
 * grant covers no target the route guard could name before the handler runs.
 * So each handler asks first — `inboxCaller` refuses a caller who holds the
 * route's permission nowhere in their operator — and the service then
 * decides, against the database, which conversations that caller can see
 * (`services/inbox/read-visibility.ts`). A conversation addressed by id is
 * loaded inside `auth.operatorId` and then checked; one the caller cannot see
 * answers 404, as one that does not exist.
 */

const ConversationParams = z.object({ id: z.string().uuid() });

export async function inboxReadRoutes(app: App): Promise<void> {
  /** The caller, refused unless they hold `permission` somewhere in their operator. */
  async function inboxCaller(req: FastifyRequest, permission: Permission) {
    const auth = req.requireAuth();
    const effective = await req.effectivePermissions();
    if (!holdsAnywhere(effective, permission, auth.operatorId)) throw new PermissionDeniedError(permission);
    const viewer: InboxViewer = {
      accountId: auth.accountId,
      operatorId: auth.operatorId,
      scope: viewerScopeOf(effective, auth.accountId, auth.operatorId),
    };
    return { viewer, effective };
  }

  app.get(
    '/me',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The signed-in viewer of the Inbox: who they are, the prototype views they stand in (owner, a team, or ' +
          '`staff` for a reader in no team), their tabs (the ported code: the owner and reception get Team and Handled, ' +
          'every other view all three), every team of the operator with theirs marked, the people who can hold a slot, ' +
          'and what they may do (`writes`, on since the reply landed; `templates` for the template settings), and — only ' +
          'where this deployment runs the inbox simulator and the viewer holds inbox:channel:manage — the simulator ' +
          'channel accounts, (SCRUM-648) `impersonation`: the view-as window this session is, for the banner, or null, ' +
          'and (SCRUM-834) `dictation`: whether the composer’s microphone is offered on this deployment (a transcription ' +
          'provider is on) and the ceiling, in seconds, a clip stops at (TRANSCRIPTION_MAX_SECONDS). ' +
          'Needs app:inbox:access.',
        response: { 200: InboxMeSchema },
      },
    },
    async (req) => {
      const { viewer, effective } = await inboxCaller(req, 'app:inbox:access');
      const me = await inboxMe(app.db, viewer, effective, { simulatorEnabled: app.inboxChannels.simulatorEnabled });
      // SCRUM-648 — the Inbox reads no /me of its own, so the view-as mark rides here.
      const marks = await impersonationMarksOf(app.db, req.requireAuth());
      // SCRUM-834 — the composer's microphone: offered only where a provider is on, with the clip ceiling.
      const transcription = app.inboxTranscription;
      return {
        ...me,
        impersonation: marks.impersonation ? bannerOf(marks.impersonation) : null,
        dictation: { available: transcription.adapter !== null, maxSeconds: transcription.maxSeconds },
      };
    },
  );

  app.get(
    '/conversations',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The conversations the caller can see — operator-wide reading sees all; a branch grant that branch; a team ' +
          "member (a department-scoped grant) the team's; anyone the conversations they hold a slot on — newest " +
          'activity first, keyset-paged by `cursor`. `tab` applies the ported rule: mine = active and on it; team = ' +
          'every active one visible (the viewer’s own included); handled = handled. Filters: category, branch (that ' +
          "branch's and the operator-wide ones), status, language, `q` (customer, intent, last message), " +
          '`unanswered=true` (a customer message or a routing after the last staff reply; AI lines do not count), the ' +
          'handled date range, and `resolvedBy` (on the handled tab only). `tabCounts` counts the viewer’s tabs over ' +
          'everything visible, before filters. Needs inbox:conversation:read somewhere in the operator.',
        querystring: InboxConversationListQuerySchema,
        response: { 200: InboxConversationListSchema },
      },
    },
    async (req) => {
      const { viewer, effective } = await inboxCaller(req, 'inbox:conversation:read');
      const tabs = await viewerTabs(app.db, viewer, effective);
      return listConversations(app.db, viewer, tabs, req.query);
    },
  );

  app.get(
    '/conversations/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'One conversation: its header (contact, channel, category, intent, branch, team, language, status), the ' +
          'assignment strip (primary and support), the linked member’s name and child count (no allergy text — the POS ' +
          'owns that), the timeline’s system events (never a message body), and `divertTo`: who Divert would make ' +
          'primary, read as the divert route reads it (null: it would answer DIVERT_NO_BACKUP). Loaded inside the caller’s operator, ' +
          'then checked for visibility: 404 when the caller cannot see it. Needs inbox:conversation:read.',
        params: ConversationParams,
        response: { 200: InboxConversationDetailSchema },
      },
    },
    async (req) => {
      const { viewer } = await inboxCaller(req, 'inbox:conversation:read');
      return conversationDetail(app.db, viewer, req.params.id);
    },
  );

  app.get(
    '/conversations/:id/messages',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'A page of one conversation’s messages, oldest first; `before` (a message id) reads the page older than it. ' +
          'Media are file ids — a signed URL comes from the files api after the conversation check. A redacted ' +
          'message (PDPA erasure) has no body. 404 when the caller cannot see the conversation. Needs ' +
          'inbox:conversation:read.',
        params: ConversationParams,
        querystring: InboxMessagesQuerySchema,
        response: { 200: InboxMessagePageSchema },
      },
    },
    async (req) => {
      const { viewer } = await inboxCaller(req, 'inbox:conversation:read');
      return conversationMessages(app.db, viewer, req.params.id, req.query);
    },
  );

  app.get(
    '/conversations/:id/beo-confirmation',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "The message a birthday's BEO is filled from (SCRUM-660): the newest message a person on the team sent in " +
          'the conversation (outbound, on the channel, not erased, not refused by the channel) that names a date, a ' +
          'time and at least one more party detail — a guest count, food or the programme — in Thai, English or ' +
          "Russian; `message: null` when there is none. `eventId` is the event Book Date made. `transcript` " +
          "(SCRUM-815) is the conversation itself, oldest first: the family's lines and the team's received ones " +
          "(never the assistant's, a system notice, an erased line or one the channel refused), the newest 200 within " +
          "the 60 days before the newest; `transcriptCut` says older lines were left out. The OTO App's BEO form " +
          'asks for it, server to server as the signed-in person, when Create BEO opens it with its AI Fill. A read: ' +
          'nothing is written. 409 NOT_A_BIRTHDAY outside Birthdays & Events; 404 when the caller cannot see the ' +
          'conversation. Needs inbox:conversation:read.',
        params: ConversationParams,
        response: { 200: InboxBeoConfirmationSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const { viewer } = await inboxCaller(req, 'inbox:conversation:read');
      return beoConfirmationOf(app.db, viewer, req.params.id);
    },
  );

  app.get(
    '/conversations/:id/book-date-proposal',
    {
      config: { dynamicPermission: true, rateLimit: { ...BOOK_DATE_PROPOSAL_RATE } },
      schema: {
        description:
          "Book Date's values read from the whole chat by the model (SCRUM-821): the party's date, start time, kids, " +
          "adults, the child's name and age, and the park when the chat names one (`branchHint`), each with the " +
          "chat's own words (`text`), whose line it is (`source`: `family` or `team`; the team's confirmation wins " +
          'where both speak) and the message (`messageId`). The lines are the BEO fill’s transcript (the family’s and ' +
          "the team's received ones, never the assistant's, a system notice or an erased line; the newest 200 within " +
          "60 days), read in Thai, English or Russian with their typos, against the park's today and zone. " +
          "`model: 'unavailable'` with `proposal: null` when no model is configured here or it gave no usable answer: " +
          "the dialog keeps its pattern reading. `patternReading` is the SCRUM-814 reader's date and time over the " +
          'same lines, for comparison. A read: nothing is written or audited; 30 a minute per caller. 409 ' +
          'NOT_A_BIRTHDAY outside Birthdays & Events; 404 when the caller cannot see the conversation. Needs ' +
          'inbox:conversation:read.',
        params: ConversationParams,
        response: { 200: InboxBookDateProposalSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const { viewer } = await inboxCaller(req, 'inbox:conversation:read');
      return bookDateProposalOf(
        { db: app.db, reader: app.inboxAi.bookDateReader ?? null, log: req.log },
        viewer,
        req.params.id,
      );
    },
  );

  app.post(
    '/conversations/:id/read',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Mark the conversation read up to a message (default: the newest) for the caller — the unread counts. The ' +
          'marker only moves forward. Writes the sampled read audit: one `inbox.conversation.read` row per account, ' +
          'conversation and Bangkok day, naming the category, team and branch, never a message body. 404 when the ' +
          'caller cannot see the conversation. Needs inbox:conversation:read.',
        params: ConversationParams,
        body: InboxMarkReadBodySchema,
        response: { 200: InboxMarkReadSchema },
      },
    },
    async (req) => {
      const { viewer } = await inboxCaller(req, 'inbox:conversation:read');
      return withTx(app.db, opCtx(req), 'inbox.conversation_read', (tx) =>
        markConversationRead(tx, viewer, {
          conversationId: req.params.id,
          messageId: req.body.messageId,
          requestId: req.id,
          now: new Date(),
        }),
      );
    },
  );

  app.get(
    '/dashboard',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The metric cards, over the conversations the caller can see: new today and handled today (the Bangkok ' +
          'day), unanswered, active, the average first response (first staff reply less the start; opening hours ' +
          'ignored) and every conversation by category. Needs inbox:dashboard:read somewhere in the operator.',
        response: { 200: InboxDashboardSchema },
      },
    },
    async (req) => {
      const { viewer } = await inboxCaller(req, 'inbox:dashboard:read');
      return inboxDashboard(app.db, viewer, new Date());
    },
  );

  app.get(
    '/templates',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The active templates for the composer — the welcome line, the handover lines and the out-of-hours reply — ' +
          'optionally in one `language`. A RU or TH row still carrying the English source says `needsTranslation`. ' +
          'Needs inbox:conversation:read somewhere in the operator.',
        querystring: InboxTemplatesQuerySchema,
        response: { 200: InboxTemplateListSchema },
      },
    },
    async (req) => {
      const { viewer } = await inboxCaller(req, 'inbox:conversation:read');
      return inboxTemplates(app.db, viewer.operatorId, req.query.language);
    },
  );
}
