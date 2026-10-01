import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { account, checkin, child, fileObject, guardian, member, registration, release, type Db } from '@oto/db';
import type { App } from '../app';
import { AppError, errors } from '../lib/errors';
import { audit } from '../services/audit';
import { ClientIdSchema, REPLAY_HEADER, claimClientId } from '../services/client-id';
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
  db: Db,
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
    /**
     * S2-13 — the check-in photos (plan §2.1, OD-C2): the child-and-guardian
     * photo on a registration, an authorised collector's, a pickup's. Staff
     * only, at the park the stay is at, behind `pos:checkin:*`.
     */
    case 'registration':
    case 'guardian':
    case 'release': {
      const branchId = await checkinOwnerBranch(db, auth.operatorId, ownerEntityType, ownerEntityId);
      await req.requirePermission(mode === 'read' ? 'pos:checkin:read' : 'pos:checkin:update', { branchId });
      return;
    }
    default:
      throw errors.forbidden(`Unsupported file owner ${ownerEntityType}`);
  }
}

/**
 * SCRUM-255(b) — AND THE THING IT IS ATTACHED TO HAS TO BE OURS.
 *
 * `checkOwnerAccess` above asks whether the caller may attach photos to
 * members. It does not ask WHOSE member this is, and the answer used to be
 * nobody's business: `POST /files` took an `ownerEntityId` straight from the
 * body, `pos:member:update` was enough to pass, and the row was then written
 * with the CALLER's `operatorId` stamped on it. So a member id belonging to
 * another operator produced a `file_object` in our tenant pointing at their
 * record — a tenancy hole of exactly the shape SCRUM-280/281 closed
 * everywhere else, surviving here because nothing reads `file_object` by owner
 * entity yet. The day a member-photo-by-owner lookup lands, it is live.
 *
 * So the owner is RESOLVED, inside the caller's operator, before anything is
 * written. Not found there — another tenant's, or simply gone — is 404 and not
 * 403, for the reason `loadTargetAccount` gives: the existence of another
 * operator's row is not ours to confirm.
 *
 * A child carries no `operator_id` of its own; its tenancy is its guardian's,
 * so the join is the check.
 */
/**
 * The park a check-in photo's owner belongs to, inside the caller's operator —
 * 404 for anybody else's, for `assertOwnerInOperator`'s reason. A guardian and
 * a release reach their branch through the registration and the stay.
 */
async function checkinOwnerBranch(
  db: Db,
  operatorId: string,
  ownerEntityType: 'registration' | 'guardian' | 'release',
  ownerEntityId: string,
): Promise<string> {
  let row: { branchId: string; operatorId: string } | undefined;
  if (ownerEntityType === 'registration') {
    [row] = await db
      .select({ branchId: registration.branchId, operatorId: registration.operatorId })
      .from(registration)
      .where(eq(registration.id, ownerEntityId))
      .limit(1);
  } else if (ownerEntityType === 'guardian') {
    [row] = await db
      .select({ branchId: registration.branchId, operatorId: registration.operatorId })
      .from(guardian)
      .innerJoin(registration, eq(registration.id, guardian.registrationId))
      .where(eq(guardian.id, ownerEntityId))
      .limit(1);
  } else {
    [row] = await db
      .select({ branchId: checkin.branchId, operatorId: checkin.operatorId })
      .from(release)
      .innerJoin(checkin, eq(checkin.id, release.checkinId))
      .where(eq(release.id, ownerEntityId))
      .limit(1);
  }
  if (!row || row.operatorId !== operatorId) throw errors.notFound(`No such ${ownerEntityType}`);
  return row.branchId;
}

const CHECKIN_OWNERS = new Set(['registration', 'guardian', 'release']);

async function assertOwnerInOperator(
  db: Db,
  operatorId: string,
  ownerEntityType: 'account' | 'member' | 'child' | 'registration' | 'guardian' | 'release',
  ownerEntityId: string,
): Promise<void> {
  const notFound = (): never => {
    throw errors.notFound(`No such ${ownerEntityType}`);
  };
  switch (ownerEntityType) {
    case 'account': {
      const [row] = await db
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.id, ownerEntityId), eq(account.operatorId, operatorId)))
        .limit(1);
      if (!row) notFound();
      return;
    }
    case 'member': {
      const [row] = await db
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.id, ownerEntityId), eq(member.operatorId, operatorId)))
        .limit(1);
      if (!row) notFound();
      return;
    }
    case 'child': {
      const [row] = await db
        .select({ id: child.id })
        .from(child)
        .innerJoin(member, eq(child.memberId, member.id))
        .where(and(eq(child.id, ownerEntityId), eq(member.operatorId, operatorId)))
        .limit(1);
      if (!row) notFound();
      return;
    }
    case 'registration':
    case 'guardian':
    case 'release':
      await checkinOwnerBranch(db, operatorId, ownerEntityType, ownerEntityId);
      return;
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
        description:
          'Register a file and get a presigned upload URL. An optional body id names the file ' +
          '(SCRUM-270): the same id again answers with that file and a fresh upload URL under ' +
          'x-oto-replay; an id naming another record is refused 409 ID_IN_USE.',
        body: z.object({
          /** Optional, client-minted (OD-12). Absent, the platform mints one as before. */
          id: ClientIdSchema.optional(),
          contentType: z.string().min(1),
          ownerEntityType: z.enum(['account', 'member', 'child', 'registration', 'guardian', 'release']),
          ownerEntityId: z.string().uuid(),
          filename: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      await checkOwnerAccess(req, auth, req.body.ownerEntityType, req.body.ownerEntityId, 'write', app.db);
      await assertOwnerInOperator(
        app.db,
        auth.operatorId,
        req.body.ownerEntityType,
        req.body.ownerEntityId,
      );
      const storage = app.fileStorage;
      if (!storage) throw notConfigured();
      // A file belongs to its owner inside the caller's operator, and the write
      // check above was made against THAT owner — so a replay is a file of the
      // same owner, and any other file's id is somebody else's.
      const claim = await claimClientId(
        req.body.id,
        async (id) => (await app.db.select().from(fileObject).where(eq(fileObject.id, id)).limit(1))[0],
        (row) =>
          row.operatorId === auth.operatorId &&
          row.ownerEntityType === req.body.ownerEntityType &&
          row.ownerEntityId === req.body.ownerEntityId,
      );
      if (claim.replay) {
        // Nothing is written; the upload URL is signed afresh for the object
        // the first attempt registered, because a caller retrying through a
        // dropped connection never received the first one. Signing reaches no
        // storage and no database.
        const again = await withStorageLog(req, 'presign upload', () =>
          storage.presignedPut(claim.row.objectKey),
        );
        reply.header(REPLAY_HEADER, 'true');
        return { id: claim.id, uploadUrl: again };
      }
      const id = claim.id;
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
      await checkOwnerAccess(req, auth, row.ownerEntityType, row.ownerEntityId, 'read', app.db);
      const storage = app.fileStorage;
      if (!storage) throw notConfigured();
      const url = await withStorageLog(req, 'presign download', () =>
        storage.presignedGet(row.objectKey),
      );
      /**
       * R-94 — every read of a check-in photo is ACCESS-LOGGED: a child's
       * photo with the guardian is the most sensitive thing the park keeps,
       * and who looked at it, when, is part of the record.
       */
      if (CHECKIN_OWNERS.has(row.ownerEntityType)) {
        await withTx(app.db, opCtx(req), 'file.read', async (tx) => {
          await audit.record(tx, {
            actorAccountId: auth.accountId,
            operatorId: auth.operatorId,
            branchId: auth.branchId,
            action: 'file.read',
            entityType: 'file_object',
            entityId: row.id,
            after: { ownerEntityType: row.ownerEntityType, ownerEntityId: row.ownerEntityId },
            requestId: req.id,
          });
        });
      }
      return { url, contentType: row.contentType };
    },
  );
}
