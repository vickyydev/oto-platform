import { z } from 'zod';
import { TIER_PROOF_TYPES } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { recordTierClaim } from '../services/sale-tier';
import { opCtx, withTx } from '../services/tx';

/**
 * SCRUM-307 — the counter's document check, recorded before it prices
 * anything.
 *
 * The till calls this when staff confirm a passport or a residence
 * certificate for a visitor who is not a member yet. What comes back is a
 * claim the cart can NAME; what prices the cart is the row written here. The
 * service says why it exists and what it deliberately does not do.
 *
 * WHAT THE CALLER MAY NOT SEND: who checked the document, which branch it was
 * checked at, or a price. The first two are stamped from the session, and the
 * third does not exist on this route — the tier names a rate in the
 * catalogue, and the catalogue is the platform's.
 *
 * WHAT IT DELIBERATELY DOES NOT TAKE is a free-text note or a document
 * number. The body is `.strict()`, so there is nowhere to put one, and the
 * claim row therefore cannot carry an identity document's number into a table
 * that is never swept. The durable evidence record — with its note — is
 * written against the MEMBER by `POST /members/:id/tier-verification` once the
 * visitor gives their details.
 */

const ClaimBody = z
  .object({
    /**
     * `x-oto-action-id` of the tap that confirmed the document. The cart names
     * this, so it is the claim's identity rather than a correlation extra.
     */
    actionId: z.string().min(1).max(200),
    /**
     * The branch the claim belongs to. Optional: the till's session already
     * names one, and when the body omits it the session's is used. Declared
     * because the guard's target reads it — see the config below.
     */
    branchId: z.string().uuid().optional(),
    toTier: z.string().min(1).max(40),
    /**
     * The KIND of document, never its number — and only the four kinds the
     * till offers, so a free-text field cannot become the place a passport
     * number lands in a table that is never swept.
     */
    evidenceType: z.enum(TIER_PROOF_TYPES),
    evidenceExpiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export async function saleTierRoutes(app: App): Promise<void> {
  app.post(
    '/tier-claims',
    {
      /**
       * `pos:member:update` — the same permission that records a verification
       * against a member, because this is the same act one step earlier.
       *
       * The target is the branch the BODY names; when it names none the guard
       * falls back to the session's, which is also what the handler writes, so
       * the handler re-checks the branch it settled on before anything is
       * written. That re-check is the lesson of SCRUM-297: a declared
       * permission with an empty target says yes to whatever branch the
       * request turns out to be for.
       */
      config: { permission: 'pos:member:update', target: { branchId: 'body.branchId' } },
      schema: {
        description:
          'Record a checked tier proof for a visitor who is not a member yet, so the ' +
          'cart can be priced at that tier. The verifier and the branch are stamped ' +
          'from the session; the tier is never taken from a cart.',
        body: ClaimBody,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const branchId = req.body.branchId ?? auth.branchId;
      if (!branchId) {
        throw errors.badRequest(
          'This session has no branch, so a document check has nowhere to belong',
        );
      }
      await req.requirePermission('pos:member:update', { branchId });

      const claim = await withTx(app.db, opCtx(req), 'sale_tier_claim.create', (tx) =>
        recordTierClaim(
          tx,
          {
            accountId: auth.accountId,
            operatorId: auth.operatorId,
            branchId,
            requestId: req.id,
          },
          {
            actionId: req.body.actionId,
            toTier: req.body.toTier,
            evidenceType: req.body.evidenceType,
            evidenceExpiresAt: req.body.evidenceExpiresAt,
          },
        ),
      );
      return { claim };
    },
  );
}
