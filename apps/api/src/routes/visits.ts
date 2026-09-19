import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { branch, child, visit, visitChild } from '@oto/db';
import { branchToday, newId } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { opCtx, withTx } from '../services/tx';

/**
 * SCRUM-32 — select & reconfirm children for a visit. A draft `visit` is
 * created with `visit_child` rows; each selected child's last_confirmed_at is
 * stamped (the prototype's re-confirm rule: saved details are OFFERED and
 * confirmed, never silently applied).
 */
export async function visitRoutes(app: App): Promise<void> {
  app.post(
    '/',
    {
      config: { permission: 'pos:visit:create' },
      schema: {
        description: 'Create a draft visit with confirmed children',
        body: z.object({
          memberId: z.string().uuid().nullable().optional(),
          branchId: z.string().uuid().optional(),
          childIds: z.array(z.string().uuid()).default([]),
          visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const branchId = req.body.branchId ?? auth.branchId;
      if (!branchId) throw errors.badRequest('No active branch on this session');
      const [br] = await app.db.select().from(branch).where(eq(branch.id, branchId)).limit(1);
      if (!br || br.operatorId !== auth.operatorId) throw errors.notFound('Branch not found');

      // Children must belong to the visit's member.
      if (req.body.childIds.length > 0) {
        if (!req.body.memberId) throw errors.badRequest('childIds require a memberId');
        const rows = await app.db
          .select({ id: child.id })
          .from(child)
          .where(and(inArray(child.id, req.body.childIds), eq(child.memberId, req.body.memberId)));
        if (rows.length !== req.body.childIds.length) {
          throw errors.badRequest('One or more children do not belong to this member');
        }
      }

      const id = newId();
      const visitDate = req.body.visitDate ?? branchToday(br.timezone);
      const now = new Date();
      // The visit, who is on it, their re-confirmation stamps and the audit
      // row are one operation: a visit with half its children on it would be
      // a child nobody knows is in the park.
      await withTx(app.db, opCtx(req), 'visit.create', async (tx) => {
        await tx.insert(visit).values({
          id,
          operatorId: auth.operatorId,
          branchId,
          memberId: req.body.memberId ?? null,
          visitDate,
          status: 'draft',
          createdByAccountId: auth.accountId,
        });
        for (const childId of req.body.childIds) {
          await tx.insert(visitChild).values({ visitId: id, childId, confirmedAt: now });
        }
        if (req.body.childIds.length > 0) {
          await tx
            .update(child)
            .set({ lastConfirmedAt: now })
            .where(inArray(child.id, req.body.childIds));
        }
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId,
          action: 'visit.create',
          entityType: 'visit',
          entityId: id,
          after: { memberId: req.body.memberId ?? null, childIds: req.body.childIds, visitDate },
          requestId: req.id,
        });
      });
      return { id, visitDate, status: 'draft' };
    },
  );

  app.get(
    '/:id',
    { config: { permission: 'pos:visit:read' }, schema: { description: 'Visit detail', params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const auth = req.requireAuth();
      const [v] = await app.db.select().from(visit).where(eq(visit.id, req.params.id)).limit(1);
      if (!v || v.operatorId !== auth.operatorId) throw errors.notFound('Visit not found');
      const children = await app.db
        .select({ vc: visitChild, c: child })
        .from(visitChild)
        .innerJoin(child, eq(visitChild.childId, child.id))
        .where(eq(visitChild.visitId, v.id));
      return {
        visit: {
          id: v.id,
          branchId: v.branchId,
          memberId: v.memberId,
          visitDate: v.visitDate,
          status: v.status,
          children: children.map((r) => ({
            id: r.c.id,
            name: r.c.name,
            allergies: r.c.allergies,
            confirmedAt: r.vc.confirmedAt.toISOString(),
          })),
        },
      };
    },
  );
}
