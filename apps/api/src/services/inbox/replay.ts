import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { schema as s } from '@oto/db';
import type { Permission } from '@oto/shared';
import type { App } from '../../app';
import { errors } from '../../lib/errors';
import { PermissionDeniedError } from '../../plugins/session';
import { assertInboxPolicy } from './access';
import { authorizeActionReplay, type ActionCtx, type InboxReplayAction } from './actions';
import { authorizeContactChange, authorizeContactCreate } from './contacts';
import { holdsAnywhere, loadVisibleConversation, viewerScopeOf } from './read-visibility';
import { loadReplyableConversation, replyViewerOf } from './reply';
import { managesLine } from './test-line';
import { authorizeAiChannel, authorizeAiMessageReplay, authorizeAiPause, loadExample, reachOf } from './ai-settings';
import { authorizeErasureSubject } from './privacy';
import { authorizeSimulatorStatus, simulatorAccount } from './simulator';
import { inboxVisibilityLimits } from './access';

async function current(req: FastifyRequest, permission: Permission): Promise<ActionCtx> {
  const auth = req.requireAuth(), effective = await req.effectivePermissions();
  if (!holdsAnywhere(effective, permission, auth.operatorId)) throw new PermissionDeniedError(permission);
  return { viewer: { accountId: auth.accountId, operatorId: auth.operatorId,
    scope: viewerScopeOf(effective, auth.accountId, auth.operatorId) }, effective, requestId: req.id, now: new Date() };
}
const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
export const inboxReadReplay = (app: App) => async (req: FastifyRequest) => {
  const ctx = await current(req, 'inbox:conversation:read');
  await loadVisibleConversation(app.db, ctx.viewer, idOf(req));
};
export const inboxActionReplay = (app: App, action: InboxReplayAction) => async (req: FastifyRequest) => {
  const permission: Permission = action === 'owner' ? 'inbox:conversation:read' : `inbox:conversation:${action}`;
  const ctx = await current(req, permission);
  await app.db.transaction(tx => authorizeActionReplay(tx, ctx, idOf(req), action));
};
export const inboxReplyReplay = (app: App) => async (req: FastifyRequest) => {
  const ctx = await current(req, 'inbox:conversation:reply');
  await loadReplyableConversation(app.db, { read: ctx.viewer,
    reply: replyViewerOf(ctx.effective, ctx.viewer.accountId, ctx.viewer.operatorId) }, idOf(req));
};
export const inboxContactReplay = (app: App, create = false) => async (req: FastifyRequest) => {
  const ctx = await current(req, 'inbox:conversation:reply');
  if (!create) { await authorizeContactChange(app.db, ctx, idOf(req)); return; }
  const body = req.body as { channelAccountId: string };
  await authorizeContactCreate(app.db, ctx, body.channelAccountId);
};
export const inboxStartOverReplay = (app: App) => async (req: FastifyRequest) => {
  const ctx = await current(req, 'inbox:channel:manage');
  const [conv] = await app.db.select().from(s.conversation)
    .where(and(eq(s.conversation.operatorId, ctx.viewer.operatorId), eq(s.conversation.id, idOf(req)))).limit(1);
  if (!conv) throw errors.notFound('Conversation not found');
  await assertInboxPolicy(app.db, ctx.viewer, conv.category, conv.channelAccountId);
  const [channel] = await app.db.select().from(s.channelAccount)
    .where(and(eq(s.channelAccount.operatorId, ctx.viewer.operatorId), eq(s.channelAccount.id, conv.channelAccountId))).limit(1);
  if (!channel || !managesLine(ctx.effective, ctx.viewer.operatorId, channel)) throw errors.notFound('Conversation not found');
  if (!conv.archivedAt) await loadVisibleConversation(app.db, ctx.viewer, conv.id);
};

export const inboxAiPauseReplay = (app: App) => async (req: FastifyRequest) => {
  const auth = req.requireAuth(), effective = await req.effectivePermissions();
  if (!holdsAnywhere(effective, 'inbox:conversation:reply', auth.operatorId) && !holdsAnywhere(effective, 'inbox:ai:manage', auth.operatorId)) {
    throw new PermissionDeniedError('inbox:conversation:reply');
  }
  await authorizeAiPause(app.db, { read: { accountId: auth.accountId, operatorId: auth.operatorId,
    scope: viewerScopeOf(effective, auth.accountId, auth.operatorId) }, reply: replyViewerOf(effective, auth.accountId, auth.operatorId) }, effective, idOf(req));
};
export const inboxAiChannelReplay = (app: App) => async (req: FastifyRequest) => {
  const ctx = await current(req, 'inbox:ai:manage');
  const reach = await reachOf(app.db, ctx.effective, 'inbox:ai:manage', ctx.viewer.operatorId);
  await authorizeAiChannel(app.db, ctx.viewer, reach, idOf(req));
};
export const inboxAiMessageReplay = (app: App) => async (req: FastifyRequest) => {
  const ctx = await current(req, 'inbox:conversation:reply');
  await authorizeAiMessageReplay(app.db, { read: ctx.viewer,
    reply: replyViewerOf(ctx.effective, ctx.viewer.accountId, ctx.viewer.operatorId) }, (req.body as { messageId: string }).messageId);
};
export const inboxAiExamplesReplay = (app: App, importing = false) => async (req: FastifyRequest) => {
  const ctx = await current(req, 'inbox:kb:manage');
  if (!(await reachOf(app.db, ctx.effective, 'inbox:kb:manage', ctx.viewer.operatorId)).operatorWide) throw new PermissionDeniedError('inbox:kb:manage');
  const ids = importing ? (req.body as { examples: { id: string }[] }).examples.map(row => row.id) : [idOf(req)];
  for (const id of ids) await loadExample(app.db, ctx.viewer, id);
};
export const inboxErasureReplay = (app: App) => async (req: FastifyRequest) => {
  const auth = await req.requirePermission('inbox:contact:erase', { operatorOnly: true });
  await authorizeErasureSubject(app.db, auth.operatorId, idOf(req), auth.accountId);
};
export const inboxSimulatorReplay = (app: App, kind: 'inbound' | 'status' | 'scenario') => async (req: FastifyRequest) => {
  const auth = req.requireAuth();
  if (kind === 'scenario') {
    await req.requirePermission('inbox:channel:manage', { operatorId: auth.operatorId, branchId: undefined });
    const limits = await inboxVisibilityLimits(app.db, auth);
    if (limits.categories !== null || limits.channelAccountIds !== null) throw errors.forbidden('Demo setup requires unrestricted Inbox access.');
    return;
  }
  const body = req.body as { channelAccountId: string; externalMessageId?: string; hint?: { category?: string } };
  const { account } = await simulatorAccount({ db: app.db, channels: app.inboxChannels }, auth.operatorId, body.channelAccountId);
  await req.requirePermission('inbox:channel:manage', account.branchId ? { branchId: account.branchId } : {});
  if (kind === 'inbound') await assertInboxPolicy(app.db, auth, body.hint?.category ?? account.defaultCategory, account.id);
  else await authorizeSimulatorStatus(app.db, auth, account.id, body.externalMessageId ?? null);
};
