import { z } from 'zod';
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { branch } from '@oto/db';
import { newId } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { branchReach } from '../services/access-control';
import { opCtx, withTx } from '../services/tx';

/** SCRUM-27 — branches (with timezone) under the caller's operator. */
export async function branchRoutes(app: App): Promise<void> {
  app.get(
    '/',
    {
      config: { permission: 'admin:branch:read' },
      schema: {
        description: 'List branches the caller holds (archived hidden unless includeArchived)',
        querystring: z.object({ includeArchived: z.coerce.boolean().default(false) }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      /**
       * SCRUM-249 — the list is what this caller HOLDS, not what the operator
       * owns. This is the picker the console builds its branch switcher from,
       * so an unfiltered list is a manager being offered a branch they cannot
       * work in and the name of a site they have no business knowing about.
       * An operator administrator's reach is every branch and is unchanged.
       */
      const reach = branchReach(await req.effectivePermissions(), 'admin:branch:read', auth.operatorId);
      if (reach.kind === 'branches' && reach.branchIds.length === 0) return { branches: [] };

      const clauses: SQL[] = [eq(branch.operatorId, auth.operatorId)];
      if (!req.query.includeArchived) clauses.push(isNull(branch.archivedAt));
      if (reach.kind === 'branches') clauses.push(inArray(branch.id, reach.branchIds));
      const rows = await app.db
        .select()
        .from(branch)
        .where(and(...clauses))
        .orderBy(asc(branch.createdAt));
      return {
        branches: rows.map((b) => ({
          id: b.id,
          name: b.name,
          code: b.code,
          timezone: b.timezone,
          // When the trading day starts (SCRUM-308): the till prices on it, so the
          // till must know it. "05:00:00" as Postgres renders a time column.
          businessDayStart: b.businessDayStart,
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
      // Everything the operator's estate is judged by hangs off a branch row,
      // so it arrives with the record of who opened it or not at all.
      return withTx(app.db, opCtx(req), 'branch.create', async (tx) => {
        await tx.insert(branch).values({ id, operatorId: auth.operatorId, ...req.body });
        await audit.record(tx, {
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
      });
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
      return withTx(app.db, opCtx(req), 'branch.update', async (tx) => {
        const [after] = await tx.update(branch).set(patch).where(eq(branch.id, req.params.id)).returning();
        await audit.record(tx, {
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
      });
    },
  );
}
