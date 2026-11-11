import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  InboxActionRefusalSchema,
  InboxContactCreateBodySchema,
  InboxContactCreatedSchema,
  InboxContactNameBodySchema,
  InboxContactViewSchema,
  type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { PermissionDeniedError } from '../plugins/session';
import { opCtx, withTx } from '../services/tx';
import { holdsAnywhere, viewerScopeOf } from '../services/inbox/read-visibility';
import {
  INBOX_CONTACT_PERMISSION,
  contactOfConversation,
  createContact,
  renameContact,
  type ContactCtx,
} from '../services/inbox/contacts';

/**
 * THE INBOX'S CONTACT ROUTES (SCRUM-860). The rules are in
 * `services/inbox/contacts.ts`.
 *
 *   GET   /inbox/conversations/{id}/contact   the contact behind a thread, with the channel's profile name
 *   PATCH /inbox/conversations/{id}/contact   set the shown name, or clear it back to the channel's
 *   POST  /inbox/contacts                     a new contact and its thread on one channel account
 *
 * Every route declares `dynamicPermission`, as the inbox's others do: the
 * grants sit at a team's department, a branch or the operator, which the
 * route guard cannot name before the conversation is loaded. A rename needs
 * `inbox:conversation:reply` held somewhere to enter and AT THE CONVERSATION
 * to act (404 when the caller cannot see the thread, 403 when they cannot
 * write in it); a create needs it held somewhere in the operator. Each write
 * runs in one transaction with its audit rows and takes an `Idempotency-Key`.
 */

const ConversationParams = z.object({ id: z.string().uuid() });

const REFUSALS =
  'Refusals: 404 when the conversation is not the caller’s to see (or not in their operator); 403 when the ' +
  'permission is not held at this conversation.';

export async function inboxContactRoutes(app: App): Promise<void> {
  /** The caller, refused unless they hold `permission` somewhere in their operator. */
  async function contactCtx(req: FastifyRequest, permission: Permission): Promise<ContactCtx> {
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

  app.get(
    '/conversations/:id/contact',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The contact behind a conversation, with what the list does not carry: the channel’s own profile name ' +
          '(`profileName`, as last seen) and whether the shown name was set by staff (`nameSetByStaff`, ' +
          '`nameSetAt`). Needs inbox:conversation:read somewhere in the operator; 404 when the conversation is ' +
          'not the caller’s to see.',
        params: ConversationParams,
        response: { 200: InboxContactViewSchema },
      },
    },
    async (req) => {
      const ctx = await contactCtx(req, 'inbox:conversation:read');
      return contactOfConversation(app.db, ctx.viewer, req.params.id);
    },
  );

  app.patch(
    '/conversations/:id/contact',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Set the name the inbox shows for this conversation’s contact — everywhere it is shown: the list, the ' +
          'header, the search — or clear it (`displayName: null` or blank) to show the channel’s profile name ' +
          'again. A name staff set is never overwritten by a later message’s profile name, which is kept beside it ' +
          'as `profileName`. An erased contact answers 409 CONTACT_ERASED. Nothing changes, and no audit row is ' +
          'written, when the name is already as asked. One `inbox.contact.rename` audit row with before and ' +
          'after. Needs inbox:conversation:reply at the conversation. ' +
          REFUSALS,
        params: ConversationParams,
        body: InboxContactNameBodySchema,
        response: { 200: InboxContactViewSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const ctx = await contactCtx(req, INBOX_CONTACT_PERMISSION);
      return withTx(app.db, opCtx(req), 'inbox.contact.rename', (tx) =>
        renameContact(tx, ctx, { conversationId: req.params.id, displayName: req.body.displayName }),
      );
    },
  );

  app.post(
    '/contacts',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'A new contact and its conversation on one channel account (one of `GET /inbox/me`’s `contactChannels`). ' +
          'On WhatsApp `identity` is the phone number in any shape the phone helper reads, stored E.164 so the ' +
          'customer’s first message lands on this contact; elsewhere it is the channel’s own handle. The name is ' +
          'marked staff-set. The conversation is laid as a check-in notice thread is — the account’s park and ' +
          'default category, its reception desk, no owner — and is routed like a new thread when the customer ' +
          'first writes; nothing is sent to the customer and no assistant turn starts. A duplicate (same channel ' +
          'and identity in the operator) answers 409 CONTACT_EXISTS with the existing contact and, when the caller ' +
          'can see one, its conversation in `details`; 400 for a phone number the helper cannot read; 404 for a ' +
          'channel account that is not the operator’s; 409 CHANNEL_CANNOT_CARRY_CONTACT for the console sender. ' +
          'Audit rows `inbox.contact.create` and `inbox.conversation.create`. Needs inbox:conversation:reply ' +
          'somewhere in the operator.',
        body: InboxContactCreateBodySchema,
        response: { 200: InboxContactCreatedSchema, 409: InboxActionRefusalSchema },
      },
    },
    async (req) => {
      const ctx = await contactCtx(req, INBOX_CONTACT_PERMISSION);
      return withTx(app.db, opCtx(req), 'inbox.contact.create', (tx) => createContact(tx, ctx, req.body));
    },
  );
}
