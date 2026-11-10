import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { fileObject, message, schema as s, type Db } from '@oto/db';
import { ChannelError, type MediaRef, type MessagingChannel } from '@oto/messaging';
import { newId } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, errors } from '../../lib/errors';
import { PermissionDeniedError } from '../../plugins/session';
import { audit } from '../audit';
import type { FileStorage } from '../files';
import { recordRun } from '../ops';
import type { EffectivePermission } from '../permissions';
import { withTx } from '../tx';
import { INBOX_READ, holdsAnywhere, loadVisibleConversation, viewerScopeOf } from './read-visibility';

/**
 * THE CUSTOMER'S MEDIA (S2-19 I2f, SCRUM-585; plan
 * `docs/progress/plans/inbox-build/PLAN.md` §3.6 "Files").
 *
 * An inbound image, voice note or document arrives as a provider-held
 * `MediaRef`. After the delivery's transaction commits, the ingest hands its
 * refs here: each is fetched through the channel's own `fetchMedia` (the
 * WhatsApp two-step download, the simulator's fixture), checked against the
 * provider's digest when it sent one, put in the private bucket, and only
 * THEN recorded — a `core.file_object` owned by `inbox.message` and the
 * message's `media_file_ids` (or `audio_file_id` for a voice note) in one
 * transaction with its audit row. A row therefore always has bytes behind it.
 *
 * Objects are never public. A signed URL comes from the existing
 * `GET /files/{id}/url`, whose owner check for `inbox.message` is
 * `inboxMediaAccess` below: the caller must read the Inbox, and must be able
 * to see the message's CONVERSATION under the Inbox's own visibility rule — a
 * conversation they cannot see answers 404, as the thread itself does. Every
 * signed URL issued is access-logged (`file.read`).
 *
 * A fetch or store that fails is an `ops_run` (`adapter:inbox.media`, ids and
 * the reason's word only) on the Failures page; the message stays, with its
 * caption and without the file. Fetching again later is not built: the
 * provider's media id is on the delivery's receipt for a person to replay.
 *
 * A VOICE NOTE (SCRUM-824) is `pending` its transcript from the ingest on
 * while a transcription provider is configured (`off` at once when none is,
 * and nothing here changes that); stored, it waits for `job:inbox.transcribe`
 * (`voice-notes.ts`), claimable at once. A pending one whose audio cannot be
 * stored is settled here at once — `too_long` over the size limit, `failed`
 * otherwise — so the assistant stops waiting and a person takes it.
 */

/** One media object of a new inbound message, waiting for the commit. */
export interface PendingMedia {
  messageId: string;
  operatorId: string;
  conversationId: string;
  branchId: string | null;
  ref: MediaRef;
}

/** WhatsApp's own ceiling for a document; anything larger is refused rather than stored. */
export const INBOX_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
};

function extensionOf(contentType: string): string {
  return EXTENSIONS[contentType.split(';', 1)[0]!.trim().toLowerCase()] ?? 'bin';
}

/** The provider's digest is base64 (WhatsApp) or hex; either matches. */
function digestMatches(bytes: Uint8Array, expected: string): boolean {
  const digest = createHash('sha256').update(bytes).digest();
  return expected === digest.toString('base64') || expected.toLowerCase() === digest.toString('hex');
}

export async function storeInboundMedia(
  db: Db,
  deps: { storage: FileStorage | null; log?: FastifyBaseLogger },
  channel: MessagingChannel,
  pending: readonly PendingMedia[],
  ctx: { requestId?: string | null } = {},
): Promise<{ stored: string[]; failed: number }> {
  const stored: string[] = [];
  let failed = 0;
  for (const p of pending) {
    const startedAt = new Date();
    const fail = async (reason: string) => {
      failed += 1;
      // SCRUM-824: a voice note with no audio behind it can never be transcribed.
      if (p.ref.kind === 'audio') await settleUnstoredVoice(db, p, reason, ctx, deps.log);
      try {
        await recordRun(db, {
          kind: 'adapter',
          name: 'adapter:inbox.media',
          outcome: 'failed',
          startedAt,
          requestId: ctx.requestId ?? null,
          operatorId: p.operatorId,
          branchId: p.branchId,
          detail: { messageId: p.messageId, conversationId: p.conversationId, kind: p.ref.kind, reason },
          error: new Error(`inbox media ${reason}`),
        });
      } catch (err) {
        deps.log?.error({ err, messageId: p.messageId }, 'an inbox media failure could not be recorded');
      }
    };
    try {
      if (!deps.storage) {
        await fail('STORAGE_NOT_CONFIGURED');
        continue;
      }
      let fetched;
      try {
        fetched = await channel.fetchMedia(p.ref);
      } catch (err) {
        await fail(err instanceof ChannelError ? err.code : 'MEDIA_FETCH_FAILED');
        continue;
      }
      if (fetched.bytes.length === 0 || fetched.bytes.length > INBOX_MEDIA_MAX_BYTES) {
        await fail(fetched.bytes.length === 0 ? 'MEDIA_EMPTY' : 'MEDIA_TOO_LARGE');
        continue;
      }
      if (p.ref.sha256 && !digestMatches(fetched.bytes, p.ref.sha256)) {
        await fail('MEDIA_DIGEST_MISMATCH');
        continue;
      }
      const contentType = fetched.contentType || p.ref.mimeType || 'application/octet-stream';
      const fileId = newId();
      const objectKey = `${p.operatorId}/inbox.message/${p.messageId}/${fileId}.${extensionOf(contentType)}`;
      const storage = deps.storage;
      await storage.put(objectKey, Buffer.from(fetched.bytes), contentType);
      const voice = p.ref.kind === 'audio';
      await withTx(
        db,
        { requestId: ctx.requestId ?? undefined, operatorId: p.operatorId, branchId: p.branchId, ...(deps.log ? { log: deps.log } : {}) },
        'inbox.message.media',
        async (tx) => {
          await tx.insert(fileObject).values({
            id: fileId,
            operatorId: p.operatorId,
            bucket: storage.bucket,
            objectKey,
            contentType,
            size: fetched.bytes.length,
            ownerEntityType: 'inbox.message',
            ownerEntityId: p.messageId,
            uploadedByAccountId: null,
          });
          // A voice note is THE audio of its message; anything else is one of its media.
          const [audioFree] = voice
            ? await tx
                .select({ id: message.id })
                .from(message)
                .where(and(eq(message.id, p.messageId), isNull(message.audioFileId)))
                .limit(1)
            : [undefined];
          await tx
            .update(message)
            .set(
              audioFree
                ? {
                    audioFileId: fileId,
                    // SCRUM-824: the voice note waits for `job:inbox.transcribe` (the ingest already said so),
                    // claimable now: the deadline the ingest set for its audio is met.
                    transcriptStatus: sql`coalesce(${message.transcriptStatus}, 'pending')`,
                    transcriptNextAttemptAt: null,
                    updatedAt: new Date(),
                  }
                : { mediaFileIds: sql`array_append(${message.mediaFileIds}, ${fileId}::uuid)`, updatedAt: new Date() },
            )
            .where(and(eq(message.operatorId, p.operatorId), eq(message.id, p.messageId)));
          await audit.record(tx, {
            actorAccountId: null,
            action: 'inbox.message.media',
            entityType: 'inbox.message',
            entityId: p.messageId,
            operatorId: p.operatorId,
            branchId: p.branchId,
            requestId: ctx.requestId ?? null,
            after: {
              messageId: p.messageId,
              conversationId: p.conversationId,
              fileId,
              kind: p.ref.kind,
              contentType,
              size: fetched.bytes.length,
            },
          });
        },
      );
      await recordRun(db, {
        kind: 'adapter',
        name: 'adapter:inbox.media',
        outcome: 'ok',
        startedAt,
        requestId: ctx.requestId ?? null,
        operatorId: p.operatorId,
        branchId: p.branchId,
        detail: { messageId: p.messageId, conversationId: p.conversationId, fileId, kind: p.ref.kind, size: fetched.bytes.length },
      });
      stored.push(fileId);
    } catch (err) {
      deps.log?.error({ err, messageId: p.messageId }, 'an inbox media object could not be stored');
      await fail('MEDIA_STORE_FAILED');
    }
  }
  return { stored, failed };
}

/**
 * SCRUM-824: a voice note whose audio could not be stored is settled at once —
 * `too_long` when it was over the inbox's size limit, `failed` (could not be
 * read) otherwise — so the assistant stops waiting for it and a person takes
 * it. Only a note still `pending` with no audio is touched. Never throws: the
 * media failure is already on the Failures page.
 */
async function settleUnstoredVoice(
  db: Db,
  p: PendingMedia,
  reason: string,
  ctx: { requestId?: string | null },
  log: FastifyBaseLogger | undefined,
): Promise<void> {
  const status = reason === 'MEDIA_TOO_LARGE' ? ('too_long' as const) : ('failed' as const);
  try {
    await withTx(
      db,
      { requestId: ctx.requestId ?? undefined, operatorId: p.operatorId, branchId: p.branchId, ...(log ? { log } : {}) },
      'inbox.message.transcribe',
      async (tx) => {
        const settled = await tx
          .update(message)
          .set({ transcriptStatus: status, transcriptNextAttemptAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(message.operatorId, p.operatorId),
              eq(message.id, p.messageId),
              eq(message.transcriptStatus, 'pending'),
              isNull(message.audioFileId),
            ),
          )
          .returning({ id: message.id });
        if (settled.length === 0) return;
        await audit.record(tx, {
          actorAccountId: null,
          action: 'inbox.message.transcribe',
          entityType: 'inbox.message',
          entityId: p.messageId,
          operatorId: p.operatorId,
          branchId: p.branchId,
          requestId: ctx.requestId ?? null,
          before: { transcriptStatus: 'pending' },
          after: { messageId: p.messageId, conversationId: p.conversationId, transcriptStatus: status, reason },
        });
      },
    );
  } catch (err) {
    log?.error({ err, messageId: p.messageId }, 'an unstored voice note could not be settled');
  }
}

/**
 * The owner check `GET /files/{id}/url` makes for a file owned by
 * `inbox.message`: the caller reads the Inbox somewhere in their operator,
 * and can see the message's conversation. Answers the conversation's branch,
 * where the access-log row is filed. Inbox media are the customer's: there is
 * no write through the files api.
 */
export async function inboxMediaAccess(
  db: Db,
  auth: { accountId: string; operatorId: string },
  effective: EffectivePermission[],
  messageId: string,
  mode: 'read' | 'write',
): Promise<string | null> {
  if (mode === 'write') throw errors.forbidden('Inbox media arrive from the channel and cannot be replaced');
  if (!holdsAnywhere(effective, INBOX_READ, auth.operatorId)) throw new PermissionDeniedError(INBOX_READ);
  const [row] = await db
    .select({ conversationId: s.message.conversationId })
    .from(s.message)
    .where(and(eq(s.message.operatorId, auth.operatorId), eq(s.message.id, messageId)))
    .limit(1);
  if (!row) throw errors.notFound('File not found');
  const viewer = {
    accountId: auth.accountId,
    operatorId: auth.operatorId,
    scope: viewerScopeOf(effective, auth.accountId, auth.operatorId),
  };
  try {
    const conv = await loadVisibleConversation(db, viewer, row.conversationId);
    return conv.branchId;
  } catch (err) {
    // The conversation is not the caller's to see: neither is its file.
    if (err instanceof AppError && err.statusCode === 404) throw errors.notFound('File not found');
    throw err;
  }
}
