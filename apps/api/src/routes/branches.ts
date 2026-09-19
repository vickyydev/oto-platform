import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { branch } from '@oto/db';
import { newId } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';

/** SCRUM-27 — branches (with timezone) under the caller's operator. */
export async function branchRoutes(app: App): Promise<void> {
  app.get(
    '/',
    {
      config: { permission: 'admin:branch:read' },
      schema: {
        description: 'List branches (archived hidden unless includeArchived)',
        querystring: z.object({ includeArchived: z.coerce.boolean().default(false) }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const where = req.query.includeArchived
        ? eq(branch.operatorId, auth.operatorId)
        : and(eq(branch.operatorId, auth.operatorId), isNull(branch.archivedAt));
      const rows = await app.db.select().from(branch).where(where).orderBy(asc(branch.createdAt));
      return {
        branches: rows.map((b) => ({
          id: b.id,
          name: b.name,
          code: b.code,
          timezone: b.timezone,
          country: b.country,
          archived: b.archivedAt !== null,
        })),
      };
    },
  );

  app.post(
    '/',
    {
      config: { permission: 'admin:branch:create' },
      schema: {
        description: 'Create a branch',
        body: z.object({
          name: z.string().min(1),
          code: z
            .string()
            .min(2)
            .regex(/^[a-z0-9-]+$/, 'lowercase slug'),
          timezone: z.string().default('Asia/Bangkok'),
          country: z.string().optional(),
          address: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const id = newId();
      await app.db.insert(branch).values({ id, operatorId: auth.operatorId, ...req.body });
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        branchId: id,
        action: 'branch.create',
        entityType: 'branch',
        entityId: id,
        after: req.body,
        requestId: req.id,
      });
      return { id };
    },
  );

  app.patch(
    '/:id',
    {
      config: { permission: 'admin:branch:update', target: { branchId: 'params.id' } },
      schema: {
        description: 'Update or archive a branch',
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            name: z.string().min(1).optional(),
            timezone: z.string().optional(),
            country: z.string().optional(),
            address: z.string().optional(),
            archived: z.boolean().optional(),
          })
          .strict(),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [before] = await app.db
        .select()
        .from(branch)
        .where(and(eq(branch.id, req.params.id), eq(branch.operatorId, auth.operatorId)))
        .limit(1);
      if (!before) throw errors.notFound('Branch not found');
      const { archived, ...rest } = req.body;
      const patch: Partial<typeof branch.$inferInsert> = { ...rest };
      if (archived !== undefined) patch.archivedAt = archived ? new Date() : null;
      const [after] = await app.db.update(branch).set(patch).where(eq(branch.id, req.params.id)).returning();
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        branchId: req.params.id,
        action: 'branch.update',
        entityType: 'branch',
        entityId: req.params.id,
        before,
        after,
        requestId: req.id,
      });
      return { ok: true };
    },
  );
}
