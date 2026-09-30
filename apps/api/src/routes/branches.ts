import { z } from 'zod';
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { branch } from '@oto/db';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { branchReach, outOfBranchScope } from '../services/access-control';
import { ClientIdSchema, REPLAY_HEADER, claimClientId } from '../services/client-id';
import {
  branchAppMappingForReach,
  reconcileBranchesWithApp,
  syncBranchRenameToApp,
  syncNewBranchToApp,
} from '../services/oto-app-branches';
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
        description:
          'Create a branch. An optional body id names it (SCRUM-270): the same id again answers ' +
          'with that branch under x-oto-replay; an id naming another record is refused 409 ID_IN_USE.',
        body: z.object({
          /** Optional, client-minted (OD-12). Absent, the platform mints one as before. */
          id: ClientIdSchema.optional(),
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
    async (req, reply) => {
      const auth = req.requireAuth();
      const { id: sentId, ...fields } = req.body;
      const claim = await claimClientId(
        sentId,
        async (id) => (await app.db.select().from(branch).where(eq(branch.id, id)).limit(1))[0],
        (row) => row.operatorId === auth.operatorId,
      );
      if (claim.replay) {
        // Nothing is written, so there is nothing new to say about the OTO
        // App's row: the answer that opened the branch said it, and
        // `GET /branches/oto-app` reads it at any time.
        reply.header(REPLAY_HEADER, 'true');
        return { id: claim.id, otoApp: null };
      }
      const id = claim.id;
      // Everything the operator's estate is judged by hangs off a branch row,
      // so it arrives with the record of who opened it or not at all.
      return withTx(app.db, opCtx(req), 'branch.create', async (tx) => {
        await tx.insert(branch).values({ id, operatorId: auth.operatorId, ...fields });
        /**
         * The OTO App's own branch list, in the same transaction (SCRUM-268).
         * A park that exists here and not there is a park whose staff open the
         * app onto screens that answer with nothing — and the two lists were
         * only ever kept in step by somebody remembering to do it twice.
         *
         * It cannot fail the branch: when the app is not installed, not
         * anchored in this operator, or carries two rows that could be this
         * park, the reason comes back on the answer and on the audit row
         * instead. Opening a park does not depend on another application.
         */
        const otoApp = await syncNewBranchToApp(
          tx,
          { actorAccountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id },
          {
            branchId: id,
            name: fields.name,
            address: fields.address ?? null,
            timezone: fields.timezone,
          },
        );
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: id,
          action: 'branch.create',
          entityType: 'branch',
          entityId: id,
          after: { ...fields, otoApp },
          requestId: req.id,
        });
        return { id, otoApp };
      });
    },
  );

  app.get(
    '/oto-app',
    {
      config: { permission: 'admin:branch:read' },
      schema: {
        description: "Each branch's row in the OTO App: mapped, app-only, or not mapped and why",
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      // Cut to what this caller holds, for the reason in the service: a
      // manager passes a no-target guard on their own session branch, and the
      // other park's name is exactly what `GET /branches` keeps off their
      // screen.
      const reach = branchReach(await req.effectivePermissions(), 'admin:branch:read', auth.operatorId);
      return branchAppMappingForReach(app.db, auth.operatorId, reach);
    },
  );

  app.post(
    '/oto-app/reconcile',
    {
      config: { permission: 'admin:branch:update' },
      schema: {
        description:
          'Join the OTO App branch rows that already exist to this operator\'s branches (SCRUM-268). Idempotent: a second run writes nothing.',
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      /**
       * `admin:branch:update` is the nearest existing permission — there is no
       * `admin:branch:manage` — and it is the right one: renaming a park is
       * the operator's act, not a branch manager's (they hold none of it), and
       * this writes across every branch at once.
       *
       * The reach is asked as well as the guard, because the guard falls back
       * to the session branch and would pass somebody holding this at ONE
       * branch, who would then sweep the whole estate. An operator-wide act
       * needs operator-wide reach.
       */
      const reach = branchReach(
        await req.effectivePermissions(),
        'admin:branch:update',
        auth.operatorId,
      );
      if (reach.kind !== 'operator') {
        throw outOfBranchScope(
          'Reconciling the OTO App branch list changes every branch of this operator, and you hold admin:branch:update at only some of them',
        );
      }
      return withTx(app.db, opCtx(req), 'branch.oto_app_reconcile', async (tx) =>
        reconcileBranchesWithApp(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          requestId: req.id,
        }),
      );
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
        // The platform's branch is the record, so its app row follows the name
        // (SCRUM-268) — by id, in this transaction, and only when the name
        // actually moved.
        const otoApp =
          rest.name !== undefined && rest.name !== before.name
            ? await syncBranchRenameToApp(
                tx,
                { actorAccountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id },
                { branchId: req.params.id, name: rest.name },
              )
            : null;
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: req.params.id,
          action: 'branch.update',
          entityType: 'branch',
          entityId: req.params.id,
          before,
          after: { ...after, otoApp },
          requestId: req.id,
        });
        return { ok: true, otoApp };
      });
    },
  );
}
