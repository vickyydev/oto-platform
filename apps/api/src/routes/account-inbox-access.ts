import { z } from 'zod';
import { InboxAccessChangeSchema, InboxAccessPreviewSchema, InboxAccountAccessSchema } from '@oto/shared';
import type { App } from '../app';
import { authorizeInboxAccess, previewInboxAccountAccess, readInboxAccountAccess, saveInboxAccountAccess } from '../services/account-inbox-access';
import { opCtx, withTx } from '../services/tx';

export async function accountInboxAccessRoutes(app: App): Promise<void> {
  const params = z.object({ id: z.string().uuid() });
  app.get('/:id/inbox-access', {
    config: { permission: 'admin:role:read' },
    schema: { description: 'Existing-account permission scope and dominance apply. Reads Inbox category/channel limits; channel names stay within the caller\'s readable branches. No row means existing unrestricted access. Limits never add a role or action grant.', params, response: { 200: InboxAccountAccessSchema } },
  }, req => {
    const auth = req.requireAuth();
    return readInboxAccountAccess(app.db, { accountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id }, req.params.id);
  });
  app.post('/:id/inbox-access/preview', {
    // A preview is a fresh read; cached answers must not survive a permission change.
    config: { permission: 'admin:role:assign', target: { operator: true }, replaysByOwnId: true },
    schema: { description: 'Fresh before/after Inbox access preview under existing operator-wide role assignment and target-account dominance. expectedVersion rejects a stale edit. Null means no extra restriction, an empty list means none. Writes nothing.', params, body: InboxAccessChangeSchema, response: { 200: InboxAccessPreviewSchema } },
  }, async req => {
    const auth = await req.requirePermission('admin:role:assign', { operatorOnly: true });
    return previewInboxAccountAccess(app.db, { accountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id }, req.params.id, req.body);
  });
  app.put('/:id/inbox-access', {
    // The account id + expected version own replay semantics. Authorization is
    // rechecked before any retry answer, rather than replaying a stored response.
    config: { permission: 'admin:role:assign', target: { operator: true }, replaysByOwnId: true },
    schema: { description: 'Save reviewed account Inbox limits with version-CAS. Existing operator-wide role assignment, account reach and dominance are rechecked on every call, including retries. Operator administrators retain management. No initial grants or access rows are changed by deployment.', params, body: InboxAccessChangeSchema, response: { 200: InboxAccountAccessSchema } },
  }, async req => {
    const auth = await req.requirePermission('admin:role:assign', { operatorOnly: true });
    const actor = { accountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id };
    await authorizeInboxAccess(app.db, actor, req.params.id, true);
    return withTx(app.db, opCtx(req), 'inbox.account_access.update', tx => saveInboxAccountAccess(tx, actor, req.params.id, req.body));
  });
}
