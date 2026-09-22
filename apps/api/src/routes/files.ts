import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { fileObject } from '@oto/db';
import { newId } from '@oto/shared';
import type { App } from '../app';
import { AppError, errors } from '../lib/errors';
import { audit } from '../services/audit';
import { storageFailureReason } from '../services/files';
import { opCtx, withTx } from '../services/tx';
import type { AuthContext } from '../plugins/session';
import type { FastifyRequest } from 'fastify';

/**
 * SCRUM-16 — permission-bound file access. Upload via presigned PUT, download
 * via presigned GET, both issued only after a permission check on the OWNING
 * entity. Objects are never public.
 */

/**
 * Storage that is not configured is the server's fault, not the caller's, so
 * it answers 503 like any other storage failure rather than 400.
 */
const notConfigured = (): AppError =>
  new AppError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not configured');

/**
 * A storage failure reaches the caller as a clean 503 (services/files.ts);
 * the reason behind it rides on the error and is dropped there, so this is
 * the one place that still has the request id to log it against.
 */
async function withStorageLog<T>(
  req: FastifyRequest,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AppError && err.code === 'STORAGE_UNAVAILABLE') {
      req.log.error(
        { storage: { operation, reason: storageFailureReason(err) }, reqId: req.id },
        'object storage failed',
      );
    }
    throw err;
  }
}

/** Who may see or replace the file, decided on the entity that owns it. */
async function checkOwnerAccess(
  req: FastifyRequest,
  auth: AuthContext,
  ownerEntityType: string,
  ownerEntityId: string,
  mode: 'read' | 'write',
): Promise<void> {
  switch (ownerEntityType) {
    case 'account': {
      // Your own profile photo — or admin access to any account's.
      if (ownerEntityId === auth.accountId) return;
      await req.requirePermission(mode === 'read' ? 'admin:account:read' : 'admin:account:update');
      return;
    }
    case 'member':
    case 'child': {
      await req.requirePermission(mode === 'read' ? 'pos:member:read' : 'pos:member:update');
      return;
    }
    default:
      throw errors.forbidden(`Unsupported file owner ${ownerEntityType}`);
  }
}

export async function fileRoutes(app: App): Promise<void> {
  /**
   * One probe at boot, and nothing on the request path (S2-01d, finding B1).
   *
   * Worth keeping: signing is local arithmetic now, so the upload route
   * never touches storage and can no longer tell anyone that storage is
   * wrong — the browser's own PUT would be the first thing to find out. This
   * probe is what answers "can this deployment store a photo?" before
   * somebody at reception discovers it by failing to upload one, and it costs
   * a single HEAD per start.
   *
   * It is deliberately not awaited, and deliberately not part of `/ready`:
   * the till is the service, and a park must not lose it because a photo
   * bucket is unreachable. The worst a failed probe can do is write a line.
   */
  app.addHook('onReady', async () => {
    const storage = app.fileStorage;
    if (!storage) return;
    void storage.probe().then((result) => {
      const bucket = storage.bucket;
      if (result.state === 'ready') {
        app.log.info({ storage: { bucket } }, 'object storage ready');
      } else if (result.state === 'no-bucket') {
        app.log.warn(
          { storage: { bucket } },
          `object storage: bucket "${bucket}" does not exist — it is created once by hand, and uploads fail until it is`,
        );
      } else {
        app.log.warn(
          { storage: { bucket, reason: result.reason } },
          'object storage did not answer the bucket probe',
        );
      }
    });
  });

  app.post(
    '/',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Register a file and get a presigned upload URL',
        body: z.object({
          contentType: z.string().min(1),
          ownerEntityType: z.enum(['account', 'member', 'child']),
          ownerEntityId: z.string().uuid(),
          filename: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await checkOwnerAccess(req, auth, req.body.ownerEntityType, req.body.ownerEntityId, 'write');
      const storage = app.fileStorage;
      if (!storage) throw notConfigured();
      const id = newId();
      const ext = req.body.filename?.split('.').pop()?.toLowerCase() ?? 'bin';
      const objectKey = `${auth.operatorId}/${req.body.ownerEntityType}/${req.body.ownerEntityId}/${id}.${ext}`;
      const uploadUrl = await withStorageLog(req, 'presign upload', () =>
        storage.presignedPut(objectKey),
      );
      /**
       * SCRUM-296 — the registration and the record of it, together.
       *
       * The plainest of the three writes this ticket carries: two statements
       * on the pool, and a crash between them left a `file_object` row that
       * nothing in the trail accounts for — a photo attached to somebody's
       * account with no answer to who attached it. Signing happens above
       * because it reaches no storage and no database; the transaction holds
       * only the two writes that belong to each other.
       */
      await withTx(app.db, opCtx(req), 'file.create', async (tx) => {
        await tx.insert(fileObject).values({
          id,
          operatorId: auth.operatorId,
          bucket: storage.bucket,
          objectKey,
          contentType: req.body.contentType,
          ownerEntityType: req.body.ownerEntityType,
          ownerEntityId: req.body.ownerEntityId,
          uploadedByAccountId: auth.accountId,
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          action: 'file.create',
          entityType: 'file_object',
          entityId: id,
          after: {
            objectKey,
            ownerEntityType: req.body.ownerEntityType,
            ownerEntityId: req.body.ownerEntityId,
          },
          requestId: req.id,
        });
      });
      return { id, uploadUrl };
    },
  );

  app.get(
    '/:id/url',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Presigned download URL (permission-checked on the owner entity)',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [row] = await app.db.select().from(fileObject).where(eq(fileObject.id, req.params.id)).limit(1);
      if (!row || row.operatorId !== auth.operatorId) throw errors.notFound('File not found');
      await checkOwnerAccess(req, auth, row.ownerEntityType, row.ownerEntityId, 'read');
      const storage = app.fileStorage;
      if (!storage) throw notConfigured();
      const url = await withStorageLog(req, 'presign download', () =>
        storage.presignedGet(row.objectKey),
      );
      return { url, contentType: row.contentType };
    },
  );
}
