import { z } from 'zod';
import { AnalyticsSummaryQuerySchema, analyticsSummaryBranchIds } from '@oto/shared';
import type { App } from '../app';
import { nullableResponseEnumTransform } from '../lib/nullable-response-enum';
import { consoleDriftOf } from '../services/console-drift';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ConsoleDriftSchema = z.object({
  generatedAt: z.string().datetime(),
  basis: z.literal('read-only-comparison'),
  branchIds: z.array(z.string().uuid()),
  omitted: z.array(z.string().uuid()),
  comparisons: z.array(z.object({
    key: z.enum(['branch_names', 'employees', 'app_accounts']),
    master: z.enum(['platform', 'oto_app']),
    status: z.enum(['clean', 'drift', 'absent', 'denied', 'ambiguous']),
    reason: z.enum(['seam_absent', 'seam_not_granted', 'permission', 'anchor_ambiguous', 'empty_source']).nullable(),
    requiredPermission: z.string().nullable(),
    compared: count,
    ambiguous: count,
    withheld: count,
    items: z.array(z.object({
      entity: z.enum(['branch', 'employee', 'account']),
      platformId: z.string().uuid().nullable(),
      externalId: z.string().nullable(),
      branchId: z.string().uuid().nullable(),
      kind: z.enum(['changed', 'missing', 'orphan']),
      fields: z.array(z.string()),
    }).strict()),
  }).strict()),
}).strict();

export async function consoleDriftRoutes(app: App): Promise<void> {
  app.get('/console/analytics/drift', {
    config: { dynamicPermission: true, swaggerTransform: nullableResponseEnumTransform('drift') },
    schema: {
      description: 'Read-only drift between platform copies and their masters, for the parks the Analytics read selects (console:analytics:read and analytics:read; named foreign or unknown parks are 404, no readable park is 403). Three comparisons, each behind its own native read door: branch_names (platform is the record, admin:branch:read; app-only rows such as Head Office are intentional and never read), employees (the OTO App masters name, nickname, phone, email, owned branch and the LEFT archival rule, admin:account:read; park groups anchored to two operators are ambiguous) and app_accounts (the provisioning record and its ownership checks, admin:role:read with account dominance: the app user\'s stamp, its switch-off for an inactive account and the mapped role where the app\'s role context resolves). Only changed field names are returned, never values. An absent seam, a denied seam or read door and an ambiguous owner are reported as their own status, never as clean. Nothing is repaired, copied, audited or written.',
      querystring: z.object({ branches: AnalyticsSummaryQuerySchema.shape.branches }).strict(),
      response: { 200: ConsoleDriftSchema },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    const effective = await req.effectivePermissions();
    reply.header('cache-control', 'private, no-store');
    return consoleDriftOf(app.db, {
      operatorId: auth.operatorId, effective, branchIds: analyticsSummaryBranchIds(req.query.branches),
    });
  });
}
