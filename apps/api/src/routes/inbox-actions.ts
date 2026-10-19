import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  InboxActionResultSchema,
  InboxBranchBodySchema,
  InboxBranchResultSchema,
  InboxMoveBodySchema,
  InboxPrimaryBodySchema,
  InboxSupportBodySchema,
  InboxSupportParamsSchema,
  type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { PermissionDeniedError } from '../plugins/session';
import { opCtx, withTx } from '../services/tx';
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
        response: { 200: InboxActionResultSchema },
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
        response: { 200: InboxActionResultSchema },
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
        response: { 200: InboxActionResultSchema },
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
        response: { 200: InboxActionResultSchema },
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
        response: { 200: InboxActionResultSchema },
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
        response: { 200: InboxBranchResultSchema },
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
        response: { 200: InboxActionResultSchema },
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
        response: { 200: InboxActionResultSchema },
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
