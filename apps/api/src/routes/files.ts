import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { fileObject } from '@oto/db';
import { newId } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import type { AuthContext } from '../plugins/session';
import type { FastifyRequest } from 'fastify';

/**
 * SCRUM-16 — permission-bound file access. Upload via presigned PUT, download
 * via presigned GET, both issued only after a permission check on the OWNING
 * entity. Objects are never public.
 */
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
  app.post(
    '/',
    {
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
      if (!app.fileStorage) throw errors.badRequest('File storage is not configured');
      const id = newId();
      const ext = req.body.filename?.split('.').pop()?.toLowerCase() ?? 'bin';
      const objectKey = `${auth.operatorId}/${req.body.ownerEntityType}/${req.body.ownerEntityId}/${id}.${ext}`;
      await app.fileStorage.ensureBucket();
      const uploadUrl = await app.fileStorage.presignedPut(objectKey);
      await app.db.insert(fileObject).values({
        id,
        operatorId: auth.operatorId,
        bucket: app.fileStorage.bucket,
        objectKey,
        contentType: req.body.contentType,
        ownerEntityType: req.body.ownerEntityType,
        ownerEntityId: req.body.ownerEntityId,
        uploadedByAccountId: auth.accountId,
      });
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        action: 'file.create',
        entityType: 'file_object',
        entityId: id,
        after: { objectKey, ownerEntityType: req.body.ownerEntityType, ownerEntityId: req.body.ownerEntityId },
        requestId: req.id,
      });
      return { id, uploadUrl };
    },
  );

  app.get(
    '/:id/url',
    {
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
      if (!app.fileStorage) throw errors.badRequest('File storage is not configured');
      const url = await app.fileStorage.presignedGet(row.objectKey);
      return { url, contentType: row.contentType };
    },
  );
}
