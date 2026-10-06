import { sql } from 'drizzle-orm';
import { check, date, index, integer, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { analytics, idPk, timestamps } from './helpers';
import { branch, operator } from './tenancy';

/**
 * THE HEAD COUNT, A QUARTER-HOUR AT A TIME (S2-12 round 4) — the platform's
 * first fact table, in the `analytics` schema the helpers reserve for facts.
 *
 * One row per branch per quarter-hour: how many adults and children the live
 * occupancy projection (`apps/api/src/services/occupancy.ts`) counted inside
 * at that quarter-hour. The projection reads the gate's journal
 * (`pos.band_event` entry / exit) and is the only writer's source; nothing
 * here is typed in or estimated.
 *
 * `bucket_start` is the quarter-hour's first instant (UTC, :00/:15/:30/:45);
 * `business_date` is the trading day it falls in at the branch, so a report
 * for "Saturday" reads Saturday's buckets including the ones after midnight.
 *
 * Idempotent by construction: the job upserts on (branch, bucket), so running
 * it twice in one quarter-hour — two instances, a restart — rewrites the same
 * row with the count at that moment rather than adding a second one.
 */
export const factOccupancy15min = analytics.table(
  'fact_occupancy_15min',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    bucketStart: timestamp('bucket_start', { withTimezone: true, mode: 'date' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    adults: integer('adults').notNull(),
    kids: integer('kids').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fact_occupancy_15min_branch_bucket_unique').on(t.branchId, t.bucketStart),
    index('fact_occupancy_15min_operator_idx').on(t.operatorId),
    index('fact_occupancy_15min_branch_date_idx').on(t.branchId, t.businessDate),
    check('fact_occupancy_15min_counts_check', sql`${t.adults} >= 0 and ${t.kids} >= 0`),
  ],
);
