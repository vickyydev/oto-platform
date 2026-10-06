import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ANALYTICS_MERGE_PERMISSION,
  ANALYTICS_REPORT_MAX_DAYS,
  ANALYTICS_SUMMARY_MAX_DAYS,
  AnalyticsReportQuerySchema,
  AnalyticsSummaryQuerySchema,
  AnalyticsSummarySchema,
  AnalyticsVatQuerySchema,
  BoothReportQuerySchema,
  BoothReportSchema,
  BranchSourceBodySchema,
  BranchSourceSchema,
  BranchSourcesSchema,
  DiscountReportSchema,
  DiscountTransactionsSchema,
  ProfitabilityReportSchema,
  SalesReportSchema,
  TaxReceiptsSchema,
  VatReportSchema,
  analyticsSummaryBranchIds,
  type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { PermissionDeniedError } from '../plugins/session';
import {
  analyticsSummaryOf,
  mayMergeAnalytics,
  mayReadAnalytics,
  operatorBranches,
  summaryDayCount,
  summaryScopeOf,
  type SummaryBranch,
} from '../services/analytics-summary';
import { branchSourceView, branchSourcesOf, switchBranchSource } from '../services/analytics-sources';
import { opCtx, withTx } from '../services/tx';
import {
  discountReportOf,
  discountTransactionsOf,
  profitabilityReportOf,
  salesReportOf,
  taxReceiptsOf,
  vatReportOf,
  type ReportScope,
} from '../services/analytics-reports';
import { boothReportCsv, boothReportOf } from '../services/analytics-booth';
import { hasPermission } from '../services/permissions';

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
 *
 * Rounds 4 and 5 — the Reports panels (Sales, Profitability, Discounts &
 * Comps, Tax & VAT) and the booth report, read the same way: per branch,
 * `analytics:read` only (plan §8, "Permissions"), the requested branches the
 * caller may not read listed as omitted and never added in.
 *
 * Round 6 — the source switch (`/sources`), and the summary's total held to
 * plan §9 question 9's default: the Today screen's permission reads one branch
 * on its own, and a total of several adds up only branches held on
 * `analytics:read`.
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
          "rollup last brought it up to date. A branch is read on its own when the caller holds pos:cash:read (the Today " +
          "screen's permission) or analytics:read there; an answer of more than one branch adds up only the branches " +
          'held on analytics:read (`mergeable`). Without `branches`: every live branch the caller may read. A requested ' +
          'branch of the operator left out is listed in `omitted` and never added in; 403 when none may be read; 404 ' +
          'for an id that is not a branch of the operator. Each branch is answered from the source it reports ' +
          '(`GET /analytics/sources`): a legacy source serves its frozen days.',
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
      const mayMerge = (b: SummaryBranch) => mayMergeAnalytics(effective, auth.operatorId, b.id);
      const readable = parks.filter((b) => b.archivedAt === null && may(b));
      const mergeable = parks.filter((b) => b.archivedAt === null && mayMerge(b));

      const requested = analyticsSummaryBranchIds(req.query.branches);
      const candidates: SummaryBranch[] = [];
      for (const id of requested) {
        const park = parks.find((b) => b.id === id);
        if (!park) throw errors.notFound('Branch not found');
        candidates.push(park);
      }
      // One branch on the Today screen's permission; a total of several only
      // over the branches held on analytics:read (plan §9 question 9).
      const { branches, omitted, denied } = summaryScopeOf({
        candidates: requested.length > 0 ? candidates : readable,
        requested: requested.length > 0,
        mayRead: may,
        mayMerge,
      });
      // Nothing the caller may read: the permission is what is missing, not a
      // branch — the Today screen's (which every counter role holds) when no
      // branch could be read, analytics:read when only a total was refused.
      if (denied) throw new PermissionDeniedError(denied);

      return analyticsSummaryOf(app.db, {
        branches,
        readable,
        mergeable,
        omitted,
        from,
        to,
        group,
        now: new Date(),
      });
    },
  );

  /**
   * Round 6 — which source each branch reports, and Radar's preference (plan
   * §5; S2-18 reads it). Read per branch on analytics:read, as every figure
   * here is; switched per branch on admin:branch:update, as other branch
   * configuration is (a branch manager holds neither the write nor the
   * decision).
   */
  app.get(
    '/sources',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Which source each branch reports in the summary (`oto_pos`, the platform’s own rolled-up days; `pisell` or ' +
          '`papaya`, that legacy system’s frozen days) and Radar’s preference (`oto_pos`, `legacy`, `both`), with when ' +
          'and by whom it was last switched. A branch never switched reports `oto_pos`. ' +
          'Per branch on analytics:read: without `branches`, every live branch the caller may read; a requested branch ' +
          'of the operator the caller may not read is listed in `omitted`; 403 when none may be read; 404 for an id ' +
          'that is not a branch of the operator.',
        querystring: z.object({ branches: AnalyticsSummaryQuerySchema.shape.branches }),
        response: { 200: BranchSourcesSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const effective = await req.effectivePermissions();
      const may = (id: string) => mayMergeAnalytics(effective, auth.operatorId, id);
      const parks = await operatorBranches(app.db, auth.operatorId);
      const requested = analyticsSummaryBranchIds(req.query.branches);
      const branches: SummaryBranch[] = [];
      const omitted: string[] = [];
      if (requested.length > 0) {
        for (const id of requested) {
          const park = parks.find((b) => b.id === id);
          if (!park) throw errors.notFound('Branch not found');
          if (may(park.id)) branches.push(park);
          else omitted.push(park.id);
        }
      } else {
        for (const park of parks) if (park.archivedAt === null && may(park.id)) branches.push(park);
      }
      if (branches.length === 0) throw new PermissionDeniedError(ANALYTICS_MERGE_PERMISSION);
      const stored = await branchSourcesOf(app.db, branches.map((b) => b.id));
      return { branches: branches.map((b) => branchSourceView(b, stored.get(b.id)!)), omitted };
    },
  );

  app.put(
    '/sources/:branchId',
    {
      config: { permission: 'admin:branch:update', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'Switch which source a branch reports in the summary and Radar’s preference for it. Recorded with who ' +
          'switched it and when, and audited with the switch before and after; asking for what the branch already ' +
          'has changes and records nothing. A legacy source serves only its frozen days. admin:branch:update at the ' +
          'branch; 404 for a branch of another operator.',
        params: z.object({ branchId: z.string().uuid() }),
        body: BranchSourceBodySchema,
        response: { 200: BranchSourceSchema.extend({ changed: z.boolean() }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const park = (await operatorBranches(app.db, auth.operatorId)).find((b) => b.id === req.params.branchId);
      if (!park) throw errors.notFound('Branch not found');
      return withTx(app.db, opCtx(req), 'analytics.branch_source.switch', async (tx) => {
        const { changed, stored } = await switchBranchSource(tx, {
          operatorId: auth.operatorId,
          branchId: park.id,
          body: req.body,
          actorAccountId: auth.accountId,
          requestId: req.id,
          now: new Date(),
        });
        return { ...branchSourceView(park, stored), changed };
      });
    },
  );

  /**
   * The branches a report adds up, decided per branch on `analytics:read`:
   * the requested ones the caller may read (the rest are `omitted`), or every
   * live branch the caller may read when none is named. Every requested id is
   * looked up inside the caller's own operator first — one that is not a
   * branch of it is a 404, whatever it is. 403 when nothing may be read.
   */
  const reportScope = async (
    req: FastifyRequest,
    query: { branches?: string; from: string; to: string },
  ): Promise<ReportScope> => {
    const auth = req.requireAuth();
    const { from, to } = query;
    if (from > to) throw errors.badRequest('The report’s start date is after its end date.');
    if (summaryDayCount(from, to) > ANALYTICS_REPORT_MAX_DAYS) {
      throw errors.badRequest(`A report covers at most ${ANALYTICS_REPORT_MAX_DAYS} days.`);
    }
    const effective = await req.effectivePermissions();
    const permission: Permission = 'analytics:read';
    const may = (id: string) => hasPermission(effective, permission, { operatorId: auth.operatorId, branchId: id });
    const parks = await operatorBranches(app.db, auth.operatorId);
    const requested = analyticsSummaryBranchIds(query.branches);
    const branches: Array<{ branchId: string; name: string }> = [];
    const omitted: string[] = [];
    if (requested.length > 0) {
      for (const id of requested) {
        const park = parks.find((b) => b.id === id);
        if (!park) throw errors.notFound('Branch not found');
        if (may(park.id)) branches.push({ branchId: park.id, name: park.name });
        else omitted.push(park.id);
      }
    } else {
      for (const park of parks) {
        if (park.archivedAt === null && may(park.id)) branches.push({ branchId: park.id, name: park.name });
      }
    }
    if (branches.length === 0) throw new PermissionDeniedError(permission);
    return { branches, omitted, from, to };
  };

  const REPORT_SCOPE_WORDS =
    'Per branch on analytics:read: without `branches`, every live branch the caller may read; a requested branch ' +
    'of the operator the caller may not read is listed in `omitted` and never added in; 403 when none may be read; ' +
    '404 for an id that is not a branch of the operator. `from`..`to` are business dates, at most a year and a day.';

  app.get(
    '/reports/sales',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Admin > Reports > Sales, from the daily report rows the rollup writes (never the sales tables): revenue by ' +
          'category, the payment mix, ticket sales by tier, the ticket type breakdown, the weekday / weekend split, ' +
          'drop-off and nanny sessions, and F&B and merch items. ' +
          REPORT_SCOPE_WORDS,
        querystring: AnalyticsReportQuerySchema,
        response: { 200: SalesReportSchema },
      },
    },
    async (req) => salesReportOf(app.db, await reportScope(req, req.query)),
  );

  app.get(
    '/reports/profitability',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Admin > Reports > Profitability, from the daily item rows: each F&B and merch item with its cost of goods ' +
          '(the cost frozen on the stock ledger when it sold, the catalogue cost where nothing moved) and margin; an ' +
          'item with units of no known cost is `costTracked: false`. ' +
          REPORT_SCOPE_WORDS,
        querystring: AnalyticsReportQuerySchema,
        response: { 200: ProfitabilityReportSchema },
      },
    },
    async (req) => profitabilityReportOf(app.db, await reportScope(req, req.query)),
  );

  app.get(
    '/reports/discounts',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Admin > Reports > Discounts & Comps, from the daily discount rows: comps, manual discounts, promo codes and ' +
          'the free-item benefit, promo impact by type, and manual discounts by who applied them. ' +
          REPORT_SCOPE_WORDS,
        querystring: AnalyticsReportQuerySchema,
        response: { 200: DiscountReportSchema },
      },
    },
    async (req) => discountReportOf(app.db, await reportScope(req, req.query)),
  );

  app.get(
    '/reports/discounts/transactions',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The Discounts & Comps panel’s two per-transaction lists — every manual discount and comp, every promo that ' +
          'took something — read from the finalised and refunded sales of the range through a date-bounded query (a ' +
          'list is not a summary). A voucher’s code is shown as its last four. Refused with 400 past 20,000 rows. ' +
          REPORT_SCOPE_WORDS,
        querystring: AnalyticsReportQuerySchema,
        response: { 200: DiscountTransactionsSchema },
      },
    },
    async (req) => discountTransactionsOf(app.db, await reportScope(req, req.query)),
  );

  app.get(
    '/reports/tax/vat',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Admin > Reports > Tax & VAT, the VAT summary: net base, service charge, VAT added and VAT inside the price, ' +
          'and gross, by category, for the whole range (`period=range`) or by business day or month, from the daily ' +
          'category rows. ' +
          REPORT_SCOPE_WORDS,
        querystring: AnalyticsVatQuerySchema,
        response: { 200: VatReportSchema },
      },
    },
    async (req) => vatReportOf(app.db, await reportScope(req, req.query), req.query.period),
  );

  app.get(
    '/reports/tax/receipts',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The bulk tax-receipt export: every finalised and refunded sale of the range with the tax figures its receipt ' +
          'printed, its categories and its tender (`split` when several), newest first, read through a date-bounded ' +
          'query. Refused with 400 past 20,000 rows. ' +
          REPORT_SCOPE_WORDS,
        querystring: AnalyticsReportQuerySchema,
        response: { 200: TaxReceiptsSchema },
      },
    },
    async (req) => taxReceiptsOf(app.db, await reportScope(req, req.query)),
  );

  app.get(
    '/booths',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Console > Booths > Report, from `analytics.fact_booth_daily` (never the spins): per booth, per prize, per ' +
          'staff member and per trading day — spins, prizes won, vouchers issued and redeemed (on the day the voucher ' +
          'was spun), redemption rate, mean issue-to-redemption lag, and the prize cost frozen on each voucher. ' +
          'Simulated spins are never in it. ' +
          REPORT_SCOPE_WORDS,
        querystring: BoothReportQuerySchema,
        response: { 200: BoothReportSchema },
      },
    },
    async (req) => boothReportOf(app.db, await reportScope(req, req.query)),
  );

  app.get(
    '/booths/export',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The booth report as a CSV file: one row per trading day, booth, staff member and prize, amounts in baht, ' +
          'every cell guarded against formula injection. ' +
          REPORT_SCOPE_WORDS,
        querystring: BoothReportQuerySchema,
      },
    },
    async (req, reply) => {
      const { filename, csv } = await boothReportCsv(app.db, await reportScope(req, req.query));
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('cache-control', 'no-store')
        .send(csv);
    },
  );
}
