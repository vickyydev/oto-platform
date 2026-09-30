import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { branch, child, member, visit, visitChild } from '@oto/db';
import { branchToday } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { ClientIdSchema, REPLAY_HEADER, claimClientId } from '../services/client-id';
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
      /**
       * SCRUM-250 — the target is the branch the BODY names.
       *
       * The guard declared the permission with no target, so it fell back to
       * the branch on the caller's session while the handler wrote the visit
       * onto whatever `branchId` arrived in the payload. Reception at one
       * branch opened a visit at another, and the audit row went with it.
       *
       * Declared here the way the sale routes were, and re-checked below once
       * the branch is actually settled — the body may omit it, in which case
       * the fallback to the session's branch is the right answer and the
       * re-check is what proves it.
       */
      config: { permission: 'pos:visit:create', target: { branchId: 'body.branchId' }, stationTrading: true },
      schema: {
        description: 'Create a draft visit with confirmed children',
        body: z.object({
          /**
           * Client-minted UUIDv7 (OD-12): re-sending it returns the visit that
           * exists; an id another operator's visit carries is refused 409
           * ID_IN_USE (SCRUM-270).
           */
          id: ClientIdSchema.optional(),
          memberId: z.string().uuid().nullable().optional(),
          branchId: z.string().uuid().optional(),
          childIds: z.array(z.string().uuid()).default([]),
          visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const claim = await claimClientId(
        req.body.id,
        async (id) => (await app.db.select().from(visit).where(eq(visit.id, id)).limit(1))[0],
        (row) => row.operatorId === auth.operatorId,
      );
      if (claim.replay) {
        const already = claim.row;
        // A replay answers for the branch the visit is ON, not the one the
        // request claims — otherwise the replay path is a way around the
        // check the create path now makes.
        await req.requirePermission('pos:visit:create', { branchId: already.branchId });
        reply.header(REPLAY_HEADER, 'true');
        return { id: already.id, visitDate: already.visitDate, status: already.status };
      }
      const branchId = req.body.branchId ?? auth.branchId;
      if (!branchId) throw errors.badRequest('No active branch on this session');
      const [br] = await app.db.select().from(branch).where(eq(branch.id, branchId)).limit(1);
      if (!br || br.operatorId !== auth.operatorId) throw errors.notFound('Branch not found');
      // The branch is settled and belongs to the operator; now the caller has
      // to hold the permission AT it. Nothing is written before this line.
      await req.requirePermission('pos:visit:create', { branchId });

      // The member is the operator's, checked before the children are read
      // against it: a foreign member id would otherwise have matched its own
      // children and put somebody else's family on this park's visit.
      if (req.body.memberId) {
        const [m] = await app.db
          .select({ id: member.id })
          .from(member)
          .where(and(eq(member.id, req.body.memberId), eq(member.operatorId, auth.operatorId)))
          .limit(1);
        if (!m) throw errors.notFound('Member not found');
      }

      // Children must be on the visit's member's saved list: the member's own,
      // and not archived.
      //
      // SCRUM-356 — the archived half. Since SCRUM-337 a removed child is off
      // the counter's lookup, so the till cannot offer one; a screen that was
      // already open when the guardian asked for the removal still holds the
      // id. A `visit_child` row is the record that this child WAS in the park
      // that day, which is precisely what must not be written for a child the
      // guardian has taken off the list.
      //
      // An archived child is refused by the same predicate, and therefore with
      // the same answer, as an id that is not this member's at all: which of
      // the two it was changes nothing the caller can do — re-read the member
      // and send what the lookup now lists.
      if (req.body.childIds.length > 0) {
        if (!req.body.memberId) throw errors.badRequest('childIds require a memberId');
        const rows = await app.db
          .select({ id: child.id })
          .from(child)
          .where(
            and(
              inArray(child.id, req.body.childIds),
              eq(child.memberId, req.body.memberId),
              isNull(child.archivedAt),
            ),
          );
        if (rows.length !== req.body.childIds.length) {
          throw errors.badRequest('One or more children do not belong to this member');
        }
      }

      const id = claim.id;
      const visitDate = req.body.visitDate ?? branchToday(br.timezone);
      const now = new Date();
      // The visit, who is on it, their re-confirmation stamps and the audit
      // row are one operation: a visit with half its children on it would be
      // a child nobody knows is in the park.
      return withTx(app.db, opCtx(req), 'visit.create', async (tx) => {
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
        return { id, visitDate, status: 'draft' as const };
      });
    },
  );

  app.get(
    '/:id',
    { config: { permission: 'pos:visit:read' }, schema: { description: 'Visit detail', params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const auth = req.requireAuth();
      const [v] = await app.db.select().from(visit).where(eq(visit.id, req.params.id)).limit(1);
      if (!v || v.operatorId !== auth.operatorId) throw errors.notFound('Visit not found');
      // A visit is a branch's own record, and it carries which children were
      // in the park and their allergies. Read at the branch it happened at,
      // the way a sale is — the id in the URL does not name the branch, so the
      // check waits for the row.
      await req.requirePermission('pos:visit:read', { branchId: v.branchId });
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
