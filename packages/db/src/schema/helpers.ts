import { pgSchema, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Named schemas (S2-01b). One database holds the whole suite, and the
 * boundary between its parts is a Postgres schema rather than a naming
 * convention — so a grant, a dump or a search_path can address one area, and
 * a lifted foreign app (otoapp, radar, inbox) can keep its own tables beside
 * ours without a single name collision.
 *
 * Placement is by OWNER, not by lifecycle:
 *   core      tenancy and fleet — operator, branch, department, employee,
 *             account, roles, session, station, and the platform's own
 *             records (audit, idempotency, files, throttle)
 *   crm       the customer: tiers, members, children, visits
 *   pos       what the till sells and the money it takes: catalogue,
 *             bookings, sales, payments, bands, wallets, stock
 *   promo     vouchers, redemptions, campaigns (S2-10, S2-14)
 *   booth     the Lucky Wheel (S2-07)
 *   analytics summaries and facts Radar reads (S2-15, S2-18)
 *   edge      box-owned state and the sync ledger (S2-05)
 *
 * `pgboss` is the job runner's own managed schema: outside Drizzle, created
 * by its own migrator in the deploy step, and deliberately excluded from
 * `schemaFilter` so a Drizzle diff never proposes to drop it.
 */
export const core = pgSchema('core');
export const crm = pgSchema('crm');
export const pos = pgSchema('pos');
export const promo = pgSchema('promo');
export const booth = pgSchema('booth');
export const analytics = pgSchema('analytics');
export const edge = pgSchema('edge');

/** Every schema this package owns — the list `schemaFilter` is built from. */
export const OWNED_SCHEMAS = ['core', 'crm', 'pos', 'promo', 'booth', 'analytics', 'edge'] as const;

/** Every table: created_at / updated_at (CLAUDE.md §8). */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Soft deletion (CLAUDE.md §3): no hard deletes of business records. */
export const archivedAt = {
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
};

/** UUIDv7 primary key, generated in the application (packages/shared newId). */
export const idPk = () => uuid('id').primaryKey();
