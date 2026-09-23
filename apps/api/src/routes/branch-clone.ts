import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { branch } from '@oto/db';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { branchReach, branchScopeRefusal, reachCovers } from '../services/access-control';
import {
  branchHasSales,
  branchHasSalesError,
  cloneBranchCatalog,
  previewBranchClone,
} from '../services/catalog-clone';
import { opCtx, withTx } from '../services/tx';

/**
 * SCRUM-204 — "Clone from another branch" (R-03, proposal §6.4).
 *
 * Two routes over `services/catalog-clone.ts`: one that says what a copy would
 * do, and one that does it. What is copied, what is only referenced and what
 * cannot be copied at all is argued in that file; this one is about who may ask
 * and which branch they may ask about.
 *
 * TWO BRANCHES, TWO CHECKS. A clone reads one park's prices and writes another
 * park's catalogue, so a single guard on the URL is half an answer. The route
 * guard covers the TARGET, which is the branch in the path; the SOURCE is
 * checked in the handler against the caller's own grants, because a branch
 * manager at Chalong holding `catalog:package:create` there must not be able to
 * read Central's whole price list by naming it as a source.
 *
 * AND BOTH ARE LOADED FIRST. `loadBranch` is the rule `routes/catalog.ts` sets
 * out at length: an operator-scoped grant matches on the operator alone and
 * says yes to whatever branch id the URL happens to carry, so the only thing
 * that establishes a branch belongs to the caller's operator is reading the row
 * inside it. Another operator's branch — as source or as target — is 404 here,
 * never 403: its existence is not ours to confirm.
 *
 * PERMISSIONS. `catalog:package:read` at the source and
 * `catalog:package:create` at the target. There is no `catalog:clone` and no
 * `admin:branch:manage` in `@oto/shared/permissions`, and adding one would
 * leave every seeded role without it until the roles are re-seeded — the
 * argument `routes/catalog.ts` already makes for the tier writes. Whoever may
 * price a ticket at a park is who may fill that park's catalogue from another.
 */
export async function branchCloneRoutes(app: App): Promise<void> {
  /** The branch row, inside the caller's operator, or 404. */
  async function loadBranch(branchId: string, operatorId: string) {
    const [row] = await app.db
      .select()
      .from(branch)
      .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
      .limit(1);
    if (!row) throw errors.notFound('Branch not found');
    return row;
  }

  /**
   * The source has to be READABLE by this caller, at that branch.
   *
   * Called only after the branch has been loaded inside the caller's operator,
   * so `branchScopeRefusal` may name it: "the permission is yours, this branch
   * is not" is the true sentence for a manager who holds package read at their
   * own park, and "missing permission" is the true one for somebody who holds
   * it nowhere.
   */
  async function assertSourceReadable(
    req: FastifyRequest,
    operatorId: string,
    sourceBranchId: string,
  ) {
    const effective = await req.effectivePermissions();
    const reach = branchReach(effective, 'catalog:package:read', operatorId);
    if (reachCovers(reach, sourceBranchId)) return;
    const refusal = await branchScopeRefusal(
      app.db,
      effective,
      'catalog:package:read',
      operatorId,
      sourceBranchId,
    );
    throw (
      refusal ??
      errors.forbidden(
        'Missing permission catalog:package:read at the branch you are cloning from',
      )
    );
  }

  const Params = z.object({ id: z.string().uuid() });

  app.get(
    '/branches/:id/clone-preview',
    {
      config: { permission: 'catalog:package:read', target: { branchId: 'params.id' } },
      schema: {
        description:
          "What copying another branch's catalogue into this one would create, and what this branch already has (SCRUM-204). Reads only.",
        params: Params,
        querystring: z.object({ from: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const target = await loadBranch(req.params.id, auth.operatorId);
      const source = await loadBranch(req.query.from, auth.operatorId);
      if (source.id === target.id) {
        throw errors.badRequest('A branch cannot be cloned into itself');
      }
      await assertSourceReadable(req, auth.operatorId, source.id);
      return previewBranchClone(
        app.db,
        { operatorId: auth.operatorId, sourceBranchId: source.id, targetBranchId: target.id },
        { source: source.name, target: target.name },
      );
    },
  );

  app.post(
    '/branches/:id/clone',
    {
      config: { permission: 'catalog:package:create', target: { branchId: 'params.id' } },
      schema: {
        description:
          "Copy another branch's catalogue into this one with fresh ids, once, in one transaction (SCRUM-204). Refused once this branch has taken sales.",
        params: Params,
        body: z.object({ sourceBranchId: z.string().uuid() }).strict(),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const target = await loadBranch(req.params.id, auth.operatorId);
      const source = await loadBranch(req.body.sourceBranchId, auth.operatorId);
      if (source.id === target.id) {
        throw errors.badRequest('A branch cannot be cloned into itself');
      }
      await assertSourceReadable(req, auth.operatorId, source.id);
      /**
       * Asked here as well as inside the transaction so the refusal costs one
       * cheap read rather than a full plan of both catalogues. The one that
       * decides is the one inside — see the service.
       */
      if (await branchHasSales(app.db, target.id)) throw branchHasSalesError(target.name);

      return withTx(app.db, opCtx(req), 'catalog.clone', async (tx) =>
        cloneBranchCatalog(
          tx,
          {
            actorAccountId: auth.accountId,
            operatorId: auth.operatorId,
            requestId: req.id,
          },
          { operatorId: auth.operatorId, sourceBranchId: source.id, targetBranchId: target.id },
          { source: source.name, target: target.name },
        ),
      );
    },
  );
}
