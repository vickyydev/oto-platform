import {
  ANALYTICS_SUMMARY_MAX_DAYS,
  AnalyticsSummaryQuerySchema,
  AnalyticsSummarySchema,
  analyticsSummaryBranchIds,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { PermissionDeniedError } from '../plugins/session';
import {
  analyticsSummaryOf,
  mayReadAnalytics,
  operatorBranches,
  summaryDayCount,
  type SummaryBranch,
} from '../services/analytics-summary';

/**
 * S2-15b (SCRUM-216) round 3 — the stored day, read (plan
 * docs/progress/plans/analytics/PLAN.md §5, §8 round 3).
 *
 * One route, read-only, answered from the analytics summaries alone. The
 * permission is decided per BRANCH, so it is checked in the handler: a branch
 * is read when the caller holds the Today screen's permission or
 * `analytics:read` there. Branch ids come out of the query string and carry
 * no tenancy (SCRUM-248), so every one is looked up inside the caller's own
 * operator before anything is read: an id that is not the operator's —
 * another operator's branch, or no branch at all — refuses the request with
 * the same 404, saying nothing about which it was.
 */
export async function analyticsRoutes(app: App): Promise<void> {
  app.get(
    '/summary',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "The trading days of one or more branches, from the analytics summaries (never the sales tables): each branch's " +
          'own rows by business date (`group=day`) or for the whole range (`group=total`), the branches added up in ' +
          '`merged`, and for a one-day range the merged day by hour. Formula version 1, the prototype’s Today > ' +
          'Performance rule; a day still in progress at its branch is `provisional`, and each branch says when the ' +
          "rollup last brought it up to date. A branch is read when the caller holds pos:cash:read (the Today screen's " +
          'permission) or analytics:read there. Without `branches`: every live branch the caller may read. A requested ' +
          'branch of the operator the caller may not read is listed in `omitted` and never added in; 403 when none of ' +
          'the requested branches may be read; 404 for an id that is not a branch of the operator.',
        querystring: AnalyticsSummaryQuerySchema,
        response: { 200: AnalyticsSummarySchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const { from, to, group } = req.query;
      if (from > to) throw errors.badRequest('The summary’s start date is after its end date.');
      if (summaryDayCount(from, to) > ANALYTICS_SUMMARY_MAX_DAYS) {
        throw errors.badRequest(`A summary covers at most ${ANALYTICS_SUMMARY_MAX_DAYS} days.`);
      }

      const effective = await req.effectivePermissions();
      const parks = await operatorBranches(app.db, auth.operatorId);
      const may = (b: SummaryBranch) => mayReadAnalytics(effective, auth.operatorId, b.id);
      const readable = parks.filter((b) => b.archivedAt === null && may(b));

      const requested = analyticsSummaryBranchIds(req.query.branches);
      let branches: SummaryBranch[];
      const omitted: string[] = [];
      if (requested.length > 0) {
        branches = [];
        for (const id of requested) {
          const park = parks.find((b) => b.id === id);
          if (!park) throw errors.notFound('Branch not found');
          if (may(park)) branches.push(park);
          else omitted.push(park.id);
        }
      } else {
        branches = readable;
      }
      // Nothing the caller may read: the permission is what is missing, not a
      // branch. Named as the Today screen's, the one every counter role holds.
      if (branches.length === 0) throw new PermissionDeniedError('pos:cash:read');

      return analyticsSummaryOf(app.db, {
        branches,
        readable,
        omitted,
        from,
        to,
        group,
        now: new Date(),
      });
    },
  );
}
