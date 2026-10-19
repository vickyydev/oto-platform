import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  InboxManagedTemplateListSchema,
  InboxManagedTemplateSchema,
  InboxReplyBodySchema,
  InboxReplyRefusalSchema,
  InboxReplySchema,
  InboxTemplateCreateSchema,
  InboxTemplateManageQuerySchema,
  InboxTemplatePatchSchema,
  type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { PermissionDeniedError } from '../plugins/session';
import { REPLAY_HEADER, wasReplay } from '../services/client-id';
import { hasPermission } from '../services/permissions';
import { opCtx, withTx } from '../services/tx';
import { holdsAnywhere, viewerScopeOf, type InboxViewer } from '../services/inbox/read-visibility';
import { INBOX_REPLY, messageView, replyToConversation, replyViewerOf, type ReplyResult } from '../services/inbox/reply';
import { sendAfterCommit } from '../services/inbox/send';
import {
  archiveTemplate,
  createTemplate,
  listManagedTemplates,
  loadTemplate,
  updateTemplate,
} from '../services/inbox/templates';

/**
 * THE INBOX'S REPLY AND TEMPLATE ROUTES (S2-19 I2f, SCRUM-585; plan §3.3).
 *
 *   POST  /inbox/conversations/{id}/messages   reply (inbox:conversation:reply)
 *   GET   /inbox/templates/manage              every template, inactive too
 *   POST  /inbox/templates                     create a variant
 *   PATCH /inbox/templates/{id}                edit, approve, deactivate
 *   POST  /inbox/templates/{id}/archive        retire for good
 *
 * Every route declares `dynamicPermission`, as the read routes do: the reply
 * permission sits at a team's department as often as at a branch, which no
 * route guard can name before the handler runs. The template permission is
 * checked against the TEMPLATE's scope — a branch's variant at that branch, an
 * every-branch variant operator-wide — so a branch manager edits their park's
 * brochure line and not the whole operator's welcome.
 */

const IdParams = z.object({ id: z.string().uuid() });
const TEMPLATE_MANAGE: Permission = 'inbox:template:manage';

export async function inboxReplyRoutes(app: App): Promise<void> {
  async function callerHolding(req: FastifyRequest, permission: Permission) {
    const auth = req.requireAuth();
    const effective = await req.effectivePermissions();
    if (!holdsAnywhere(effective, permission, auth.operatorId)) throw new PermissionDeniedError(permission);
    return { auth, effective };
  }

  /** A template's scope: its branch, or the operator itself when it is for every branch. */
  function requireTemplateScope(
    effective: Awaited<ReturnType<FastifyRequest['effectivePermissions']>>,
    operatorId: string,
    branchId: string | null,
  ): void {
    const target = branchId ? { operatorId, branchId } : { operatorId };
    if (!hasPermission(effective, TEMPLATE_MANAGE, target)) throw new PermissionDeniedError(TEMPLATE_MANAGE);
  }

  app.post(
    '/conversations/:id/messages',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Reply in a conversation the caller can see and may reply in. Free text inside the channel’s free-text ' +
          'window (24 hours from the customer’s last message on WhatsApp); outside it only a template — an approved ' +
          'one, or one whose channel needs no approval — and the 409 TEMPLATE_REQUIRED carries the window and the ' +
          'templates that qualify. Refused on a handled thread (CONVERSATION_HANDLED: reopen it to reply) and on a ' +
          'check-in notice thread (CHANNEL_CANNOT_REPLY). The body id is caller-named: the same id again is the same ' +
          'message, never a second send. The message is written queued, sent at once after the commit, and answered ' +
          'as the first attempt left it — a retryable refusal stays queued for the send job. Needs ' +
          'inbox:conversation:reply.',
        params: IdParams,
        body: InboxReplyBodySchema,
        response: { 200: InboxReplySchema, 409: InboxReplyRefusalSchema },
      },
    },
    async (req, reply) => {
      const { auth, effective } = await callerHolding(req, INBOX_REPLY);
      const read: InboxViewer = {
        accountId: auth.accountId,
        operatorId: auth.operatorId,
        scope: viewerScopeOf(effective, auth.accountId, auth.operatorId),
      };
      const viewers = { read, reply: replyViewerOf(effective, auth.accountId, auth.operatorId) };
      // The transaction answers nothing of its own: the stored answer is the
      // message after the send, which only exists once it has committed.
      let written: ReplyResult | undefined;
      await withTx(app.db, opCtx(req), 'inbox.message.reply', async (tx) => {
        written = await replyToConversation(tx, { channels: app.inboxChannels }, viewers, req.params.id, req.body, {
          requestId: req.id,
          now: new Date(),
        });
      });
      const done = written!;
      if (done.replay) {
        reply.header(REPLAY_HEADER, 'true');
      } else {
        // Never throws: a send that cannot even be recorded leaves the
        // message queued, and the send job has it.
        await sendAfterCommit(app.db, { channels: app.inboxChannels, log: req.log }, [done.messageId], {
          requestId: req.id,
          actorAccountId: auth.accountId,
        });
      }
      const view = await messageView(app.db, auth.operatorId, done.messageId);
      return { conversationId: done.conversationId, message: view.message, refusal: view.refusal, window: done.window };
    },
  );

  app.get(
    '/templates/manage',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Every template of the operator for the settings page — inactive ones too, archived ones with ' +
          '`archived=true` — with the placeholders each body names. Filters: key, language. Needs ' +
          'inbox:template:manage somewhere in the operator.',
        querystring: InboxTemplateManageQuerySchema,
        response: { 200: InboxManagedTemplateListSchema },
      },
    },
    async (req) => {
      const { auth } = await callerHolding(req, TEMPLATE_MANAGE);
      return listManagedTemplates(app.db, auth.operatorId, req.query);
    },
  );

  app.post(
    '/templates',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Create a template variant: a key in a language, optionally for one channel and one branch, with its ' +
          '`{{name}}` placeholders, the provider’s template name and its approval status (not_required on a channel ' +
          'with no approvals). One live row per key, language, channel and branch (409 TEMPLATE_EXISTS). The body id ' +
          'is caller-named. Needs inbox:template:manage at the branch, or operator-wide for an every-branch variant.',
        body: InboxTemplateCreateSchema,
        response: { 200: InboxManagedTemplateSchema },
      },
    },
    async (req, reply) => {
      const { auth, effective } = await callerHolding(req, TEMPLATE_MANAGE);
      requireTemplateScope(effective, auth.operatorId, req.body.branchId ?? null);
      const made = await withTx(app.db, opCtx(req), 'inbox.template.create', (tx) =>
        createTemplate(tx, { operatorId: auth.operatorId, accountId: auth.accountId, requestId: req.id, now: new Date() }, req.body),
      );
      if (wasReplay(made)) reply.header(REPLAY_HEADER, 'true');
      return made;
    },
  );

  app.patch(
    '/templates/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Edit a template: its words, language, channel or branch, the provider’s template name, the approval ' +
          'status Meta gave it, or `active` (false deactivates it — the composer stops offering it). Not an archived ' +
          'one. Needs inbox:template:manage over the template as it stands and as it will be.',
        params: IdParams,
        body: InboxTemplatePatchSchema,
        response: { 200: InboxManagedTemplateSchema },
      },
    },
    async (req) => {
      const { auth, effective } = await callerHolding(req, TEMPLATE_MANAGE);
      const before = await loadTemplate(app.db, auth.operatorId, req.params.id);
      requireTemplateScope(effective, auth.operatorId, before.branchId);
      if (req.body.branchId !== undefined) requireTemplateScope(effective, auth.operatorId, req.body.branchId);
      return withTx(app.db, opCtx(req), 'inbox.template.update', async (tx) =>
        updateTemplate(
          tx,
          { operatorId: auth.operatorId, accountId: auth.accountId, requestId: req.id, now: new Date() },
          await loadTemplate(tx, auth.operatorId, before.id),
          req.body,
        ),
      );
    },
  );

  app.post(
    '/templates/:id/archive',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Archive a template: it leaves the composer and the settings list for good, and its variant is free for a ' +
          'new row. Never deleted — the messages sent from it still name it. Needs inbox:template:manage over it.',
        params: IdParams,
        response: { 200: InboxManagedTemplateSchema },
      },
    },
    async (req) => {
      const { auth, effective } = await callerHolding(req, TEMPLATE_MANAGE);
      const before = await loadTemplate(app.db, auth.operatorId, req.params.id);
      requireTemplateScope(effective, auth.operatorId, before.branchId);
      return withTx(app.db, opCtx(req), 'inbox.template.archive', async (tx) =>
        archiveTemplate(
          tx,
          { operatorId: auth.operatorId, accountId: auth.accountId, requestId: req.id, now: new Date() },
          await loadTemplate(tx, auth.operatorId, before.id),
        ),
      );
    },
  );
}
