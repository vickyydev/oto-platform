import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  InboxActionRefusalSchema,
  InboxActionResultSchema,
  InboxBookDateBodySchema,
  InboxBookDateResultSchema,
  InboxBranchBodySchema,
  InboxBranchResultSchema,
  InboxMoveBodySchema,
  InboxOpenBeoBodySchema,
  InboxOpenBeoResultSchema,
  InboxPrimaryBodySchema,
  InboxSupportBodySchema,
  InboxSupportParamsSchema,
  type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { PermissionDeniedError, SESSION_COOKIE } from '../plugins/session';
import { opCtx, withTx } from '../services/tx';
import { REPLAY_HEADER, wasReplay } from '../services/client-id';
import { handoffConfig } from '../services/handoff';
import { bookConversationDate, openConversationBeo } from '../services/inbox/book-date';
import { holdsAnywhere, viewerScopeOf } from '../services/inbox/read-visibility';
import {
  addSupport,
  divert,
  markHandled,
  moveTeam,
  removeSupport,
  reopenConversation,
  setBranch,
  setPrimary,
  type ActionCtx,
} from '../services/inbox/actions';

/**
 * THE INBOX'S OWNERSHIP AND STATUS ACTIONS (S2-19 I2e, SCRUM-584; plan §3.3,
 * the [B] rows). The rules are in `services/inbox/actions.ts`.
 *
 * Like the reads, every route declares `dynamicPermission`: the inbox grants
 * sit at a team's department, a branch or the operator, which the route guard
 * cannot name before the conversation is loaded. Each handler refuses a
 * caller who holds the route's permission nowhere in their operator; the
 * service then loads the conversation inside `auth.operatorId`, answers 404
 * when the caller cannot see it, and checks the permission AT the
 * conversation. Each runs in one transaction with its audit row and takes an
 * `Idempotency-Key`.
 */

const ConversationParams = z.object({ id: z.string().uuid() });

const REFUSALS =
  'Refusals: 404 when the conversation is not the caller’s to see (or not in their operator); 403 when the ' +
  'permission is not held at this conversation.';

export async function inboxActionRoutes(app: App): Promise<void> {
  /** The caller, refused unless they hold `permission` somewhere in their operator. */
  async function actionCtx(req: FastifyRequest, permission: Permission): Promise<ActionCtx> {
    const auth = req.requireAuth();
    const effective = await req.effectivePermissions();
    if (!holdsAnywhere(effective, permission, auth.operatorId)) throw new PermissionDeniedError(permission);
    return {
      viewer: {
        accountId: auth.accountId,
        operatorId: auth.operatorId,
        scope: viewerScopeOf(effective, auth.accountId, auth.operatorId),
      },
      effective,
      requestId: req.id,
      now: new Date(),
    };
  }

  app.put(
    '/conversations/:id/primary',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Assign or replace the primary owner — a person, or a team (the reception phone). CATEGORY FOLLOWS THE ' +
          "PRIMARY: when the new primary's team is not the conversation's, the conversation moves to that team (its " +
          'category, and for a reception desk its branch), and the server answers 409 CATEGORY_MOVE_UNCONFIRMED, ' +
          'with the destination in `details`, until the request carries `confirmMove: true`. A person in no team ' +
          'keeps the category; the support places stay. One place per person: 409 ALREADY_ON_CONVERSATION. Needs ' +
          'inbox:conversation:assign at the conversation, or the caller is its current primary. ' +
          REFUSALS,
        params: ConversationParams,
        body: InboxPrimaryBodySchema,
        response: { 200: InboxActionResultSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const ctx = await actionCtx(req, 'inbox:conversation:read');
      return withTx(app.db, opCtx(req), 'inbox.conversation_primary', (tx) =>
        setPrimary(tx, ctx, { conversationId: req.params.id, ...req.body }),
      );
    },
  );

  app.post(
    '/conversations/:id/support',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Add a person to the next free support place (two at most: a third answers 409 SUPPORT_FULL; one place ' +
          'per person: 409 ALREADY_ON_CONVERSATION). Support never changes ownership. Needs ' +
          'inbox:conversation:assign at the conversation. ' +
          REFUSALS,
        params: ConversationParams,
        body: InboxSupportBodySchema,
        response: { 200: InboxActionResultSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const ctx = await actionCtx(req, 'inbox:conversation:assign');
      return withTx(app.db, opCtx(req), 'inbox.conversation_support_add', (tx) =>
        addSupport(tx, ctx, { conversationId: req.params.id, accountId: req.body.accountId }),
      );
    },
  );

  app.delete(
    '/conversations/:id/support/:assignmentId',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Remove a support person: the slot is released (`released_at`), never deleted, so the history stays. ' +
          '404 when the id is not an active support place on this conversation. Needs inbox:conversation:assign at ' +
          'the conversation. ' +
          REFUSALS,
        params: InboxSupportParamsSchema,
        response: { 200: InboxActionResultSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const ctx = await actionCtx(req, 'inbox:conversation:assign');
      return withTx(app.db, opCtx(req), 'inbox.conversation_support_remove', (tx) =>
        removeSupport(tx, ctx, { conversationId: req.params.id, assignmentId: req.params.assignmentId }),
      );
    },
  );

  app.post(
    '/conversations/:id/divert',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "Divert: the routing rule's fixed pair swaps — the backup becomes primary (reason divert) and the old " +
          'primary takes the backup’s support place; a second Divert swaps back. 409 DIVERT_NO_BACKUP when the rule ' +
          'has no backup (reception). The current primary may press it; anyone else needs ' +
          'inbox:conversation:assign at the conversation. ' +
          REFUSALS,
        params: ConversationParams,
        response: { 200: InboxActionResultSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const ctx = await actionCtx(req, 'inbox:conversation:read');
      return withTx(app.db, opCtx(req), 'inbox.conversation_divert', (tx) =>
        divert(tx, ctx, { conversationId: req.params.id }),
      );
    },
  );

  app.post(
    '/conversations/:id/move',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Move to another team: Birthdays & Events, Marketing, or a reception desk (which sets the branch too). ' +
          "Clears every slot, re-routes to the new team's default primary and adds its backup as support (the IT " +
          'Brief), and logs a `moved_team` event. 409 ALREADY_IN_TEAM when it is already there. Needs ' +
          'inbox:conversation:move at the conversation. ' +
          REFUSALS,
        params: ConversationParams,
        body: InboxMoveBodySchema,
        response: { 200: InboxActionResultSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const ctx = await actionCtx(req, 'inbox:conversation:move');
      return withTx(app.db, opCtx(req), 'inbox.conversation_move', (tx) =>
        moveTeam(tx, ctx, { conversationId: req.params.id, dest: req.body.dest }),
      );
    },
  );

  app.patch(
    '/conversations/:id/branch',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The branch select: sets (and so confirms) the conversation’s branch. On a birthday conversation, the ' +
          'birthday manager who hosts at that branch (the branch’s hosting rule) then joins as support when a place ' +
          'is free — `hostAdded` says whether. Needs inbox:conversation:assign at the conversation. ' +
          REFUSALS,
        params: ConversationParams,
        body: InboxBranchBodySchema,
        response: { 200: InboxBranchResultSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const ctx = await actionCtx(req, 'inbox:conversation:assign');
      return withTx(app.db, opCtx(req), 'inbox.conversation_branch', (tx) =>
        setBranch(tx, ctx, { conversationId: req.params.id, branchId: req.body.branchId }),
      );
    },
  );

  app.post(
    '/conversations/:id/book-date',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Book Date (SCRUM-775): on a Birthdays & Events conversation, make a TENTATIVE birthday event in the OTO ' +
          "App's Events module from what the person confirmed out of the chat — the park, the date and start time, " +
          'the guests, the contact and the child — and link the two: the conversation keeps the event (its `event` ' +
          'on GET …/{id}, a `date_booked` pill) and the event names the conversation ("From the inbox"). The body ' +
          "`id` is caller-named — the event's own id in the Events module — so the same id again is the same event " +
          '(a replay, `x-oto-replay: true`), never a second; an id another conversation holds is 409 ID_IN_USE. ' +
          'Refusals: 409 NOT_A_BIRTHDAY; 409 EVENT_ALREADY_BOOKED when the conversation has its event already ' +
          '(`details.eventId`; Create BEO opens it at `event.beoPath`); 409 EVENT_BRANCH_NOT_MAPPED when the OTO App ' +
          'has no branch for the park; 503 EVENTS_CALENDAR_UNAVAILABLE when the Events module did not answer ' +
          '(nothing was booked; press again); 502 EVENTS_CALENDAR_REFUSED otherwise. Needs a place in the birthdays ' +
          'team or inbox:conversation:assign at the conversation. ' +
          REFUSALS,
        params: ConversationParams,
        body: InboxBookDateBodySchema,
        response: { 200: InboxBookDateResultSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req, reply) => {
      const ctx = await actionCtx(req, 'inbox:conversation:read');
      const answer = await bookConversationDate(
        { db: app.db, directory: app.otoAppDirectory, log: req.log },
        ctx,
        opCtx(req),
        { conversationId: req.params.id, ...req.body },
      );
      if (wasReplay(answer)) reply.header(REPLAY_HEADER, 'true');
      return answer;
    },
  );

  app.post(
    '/conversations/:id/open-beo',
    {
      // `secretResponse`: the answer carries a one-use hand-off token, so no
      // key is taken and nothing is kept for a replay (as `POST /auth/handoff`).
      config: { dynamicPermission: true, secretResponse: true },
      schema: {
        description:
          "Create BEO (SCRUM-775): open the event Book Date made, at its BEO form in the OTO App's Events module, as " +
          'the signed-in person. Answers a one-use suite hand-off (`launchUrl`, about a minute, its target the BEO ' +
          'form at `beoPath`), minted as `POST /auth/handoff` mints one and recorded as `auth.handoff_issue` naming ' +
          'the conversation and the event (`purpose: inbox.create_beo`). A second call mints a second hand-off; ' +
          'nothing is written to the conversation. With `aiFill: true` (the Create BEO button; SCRUM-660) the BEO ' +
          "form runs its AI Fill on the conversation's confirmation message as it opens (`beoPath` ends " +
          '`&fill=inbox`; the app reads the message itself from GET …/beo-confirmation, never from the hand-off), and ' +
          'the audit row says so; without it (the event chip) the form opens as before. ' +
          'Refusals: 409 NOT_A_BIRTHDAY; 409 NO_EVENT_YET before Book Date; ' +
          '403 without app:oto_app:access; 503 HANDOFF_NOT_CONFIGURED where the suite hand-off is not set up. ' +
          'Whoever can see the conversation may open its BEO; the OTO App decides what they may do there. ' +
          REFUSALS,
        params: ConversationParams,
        // No body at all is the event chip's press: as before.
        body: InboxOpenBeoBodySchema.nullish(),
        response: { 200: InboxOpenBeoResultSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req, reply) => {
      const ctx = await actionCtx(req, 'inbox:conversation:read');
      const auth = req.requireAuth();
      // Present by definition: `requireAuth` resolved the session from it.
      const sessionToken = req.cookies[SESSION_COOKIE];
      if (!sessionToken) throw errors.unauthorized();
      const answer = await openConversationBeo(
        {
          db: app.db,
          handoff: () =>
            handoffConfig({
              signingKey: app.env.HANDOFF_SIGNING_KEY,
              appOrigins: app.env.HANDOFF_APP_ORIGINS,
              ttlSeconds: app.env.HANDOFF_TOKEN_TTL_S,
            }),
        },
        ctx,
        opCtx(req),
        {
          conversationId: req.params.id,
          aiFill: req.body?.aiFill === true,
          session: {
            sessionId: auth.sessionId,
            accountId: auth.accountId,
            operatorId: auth.operatorId,
            branchId: auth.branchId,
            sessionToken,
          },
          requestId: req.id,
        },
      );
      reply.header('cache-control', 'no-store');
      return answer;
    },
  );

  app.post(
    '/conversations/:id/handle',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Mark as Handled for everyone (the shell asks first: "Mark as handled for everyone?"). Sets handled_at ' +
          'and handled_by. 409 ALREADY_HANDLED. Needs inbox:conversation:handle, and the caller holds a place on ' +
          'the conversation or the permission at it (its team). ' +
          REFUSALS,
        params: ConversationParams,
        response: { 200: InboxActionResultSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const ctx = await actionCtx(req, 'inbox:conversation:handle');
      return withTx(app.db, opCtx(req), 'inbox.conversation_handle', (tx) =>
        markHandled(tx, ctx, { conversationId: req.params.id }),
      );
    },
  );

  app.post(
    '/conversations/:id/reopen',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Reopen a handled conversation by hand (the status picker). Writes exactly what the customer’s automatic ' +
          'reopen writes: handled_at and handled_by cleared, reopened_at set, the assignments kept, the previous ' +
          'values on the `reopened` event and the audit row. 409 NOT_HANDLED. Needs inbox:conversation:reopen at ' +
          'the conversation. ' +
          REFUSALS,
        params: ConversationParams,
        response: { 200: InboxActionResultSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const ctx = await actionCtx(req, 'inbox:conversation:reopen');
      return withTx(app.db, opCtx(req), 'inbox.conversation_reopen', (tx) =>
        reopenConversation(tx, ctx, { conversationId: req.params.id }),
      );
    },
  );
}
