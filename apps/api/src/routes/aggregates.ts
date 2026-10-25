import { z } from 'zod';
import { isCalendarDate } from '@oto/shared';
import type { App } from '../app';
import {
  AGGREGATE_MAX_DAYS, assistantUsageSnapshotOf, bookingsSnapshotOf, fleetSnapshotOf,
  inboxAiUsageSnapshotOf, membersSnapshotOf,
} from '../services/aggregates';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate, 'Use a real calendar date');
const count = z.number().int().nonnegative().safe();
const parkQuery = z.object({ branchId: z.string().uuid().optional() }).strict();
const datedQuery = parkQuery.extend({ from: day, to: day }).superRefine((value, ctx) => {
  const days = (Date.parse(`${value.to}T00:00:00.000Z`) - Date.parse(`${value.from}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (days < 1 || days > AGGREGATE_MAX_DAYS) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose an ordered range of at most 31 days' });
});
const envelope = z.object({
  generatedAt: z.string().datetime(),
  branches: z.array(z.object({
    id: z.string().uuid(), name: z.string(), timezone: z.string(), businessDayStart: z.string(), businessDate: day,
  }).strict()),
  selectedBranchIds: z.array(z.string().uuid()),
}).strict();
const dated = envelope.extend({ period: z.object({ from: day, to: day }).strict() });
const visitMetrics = z.object({ visits: count, draftVisits: count, activeVisits: count, closedVisits: count, visitingMembers: count }).strict();
export const MembersAggregateSchema = dated.extend({
  basis: z.literal('visit-date'), totals: visitMetrics,
  parks: z.array(z.object({ branchId: z.string().uuid(), totals: visitMetrics, rows: z.array(visitMetrics.extend({ date: day })) }).strict()),
});
const bookingMetrics = z.object({ bookings: count, bookedValueSatang: z.number().int().safe(), redeemedBookings: count }).strict();
export const BookingsAggregateSchema = dated.extend({
  basis: z.literal('booking-date'), valueBasis: z.literal('priced-booking-value'), redemptionBasis: z.literal('booking-date-cohort'),
  totals: bookingMetrics,
  parks: z.array(z.object({ branchId: z.string().uuid(), totals: bookingMetrics, rows: z.array(bookingMetrics.extend({ date: day })) }).strict()),
});
const usageMetrics = z.object({ count, inputTokens: count, outputTokens: count, cacheReadTokens: count, totalTokens: count }).strict();
const usage = dated.extend({
  basis: z.literal('created-at-bangkok'), coverage: z.literal('retained-records'), totals: usageMetrics,
  parks: z.array(z.object({ branchId: z.string().uuid(), totals: usageMetrics, rows: z.array(usageMetrics.extend({ date: day })) }).strict()),
  operatorWide: z.object({ totals: usageMetrics, rows: z.array(usageMetrics.extend({ date: day })) }).strict().nullable(),
});
export const AssistantUsageAggregateSchema = usage.extend({ attribution: z.literal('seat-at-ask'), retentionDays: z.literal(90) });
export const InboxAiUsageAggregateSchema = usage.extend({ attribution: z.literal('current-conversation-branch'), retentionDays: z.null() });
const fleetMetrics = z.object({ boxes: count, online: count, offline: count, unclaimed: count, disabled: count }).strict();
export const FleetAggregateSchema = envelope.extend({
  basis: z.literal('current-snapshot'), asOf: z.string().datetime(), totals: fleetMetrics,
  parks: z.array(fleetMetrics.extend({ branchId: z.string().uuid() })),
});

const reach = 'Read-only counts within console:overview:read reach, independent of the session seat and detail-page grants. ' +
  'Only live parks owned by the current operator are eligible. Foreign, absent or archived park:404; owned unreachable park:403. ' +
  'Optional branchId selects one reachable park. No private record identities or message text are returned. ';
const period = 'Explicit real from/to calendar dates, inclusive and ordered, at most31 days. Unknown or repeated query fields are refused. ';

export async function aggregateRoutes(app: App): Promise<void> {
  app.get('/aggregates/members', {
    config: { dynamicPermission: true },
    schema: { description: reach + period + 'Visits use their stored visit_date and retain every native status and walk-in. Visiting members are distinct within each day, park or entire selected period; they are not added as daily distinct counts.',
      querystring: datedQuery, response: { 200: MembersAggregateSchema } },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    return membersSnapshotOf(app.db, { operatorId: auth.operatorId, effective: await req.effectivePermissions(), ...req.query });
  });
  app.get('/aggregates/bookings', {
    config: { dynamicPermission: true },
    schema: { description: reach + period + 'Booking-date cohorts count all ledger states, including archived booking records. Value is the priced booking value, never payment revenue. Redeemed bookings require the authoritative same-operator/same-park redemption row, regardless of its redemption timestamp.',
      querystring: datedQuery, response: { 200: BookingsAggregateSchema } },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    return bookingsSnapshotOf(app.db, { operatorId: auth.operatorId, effective: await req.effectivePermissions(), ...req.query });
  });
  app.get('/aggregates/assistant-usage', {
    config: { dynamicPermission: true },
    schema: { description: reach + period + 'Retained internal assistant records, by created_at Bangkok calendar day and the seat recorded at ask time. Count excludes off/capped; token sums retain all scoped records. The90-day retention means this is not a lifetime billing ledger. The unassigned bucket is included once only with an unfiltered operator-wide Overview grant.',
      querystring: datedQuery, response: { 200: AssistantUsageAggregateSchema } },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    return assistantUsageSnapshotOf(app.db, { operatorId: auth.operatorId, effective: await req.effectivePermissions(), ...req.query });
  });
  app.get('/aggregates/inbox-ai-usage', {
    config: { dynamicPermission: true },
    schema: { description: reach + period + 'Retained Inbox AI records, by created_at Bangkok calendar day and the conversation current park, which may change after a turn. Count requires non-null latency, including failed/shadow/zero-latency turns; token sums retain all scoped records. The unassigned bucket is included once only with an unfiltered operator-wide Overview grant. No channel default or historical park attribution is invented.',
      querystring: datedQuery, response: { 200: InboxAiUsageAggregateSchema } },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    return inboxAiUsageSnapshotOf(app.db, { operatorId: auth.operatorId, effective: await req.effectivePermissions(), ...req.query });
  });
  app.get('/aggregates/fleet', {
    config: { dynamicPermission: true },
    schema: { description: reach + 'Current non-archived boxes, split by their four persisted statuses. Offline is reported offline status; heartbeat age, watchdog thresholds and alerting hours are unchanged. Historical date filters are refused.',
      querystring: parkQuery, response: { 200: FleetAggregateSchema } },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    reply.header('cache-control', 'private, no-store');
    return fleetSnapshotOf(app.db, { operatorId: auth.operatorId, effective: await req.effectivePermissions(), ...req.query });
  });
}
