import { timestamp, uuid } from 'drizzle-orm/pg-core';

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
