import { sql } from 'drizzle-orm';
import { boolean, check, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { core, idPk, timestamps } from './helpers';

/**
 * Platform-owned metadata catalogue, shared by operators. Actual settings stay
 * in their native stores. Catalogue timestamps never stand for a setting edit.
 */
export const settingRegistry = core.table('setting_registry', {
  id: idPk(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  appOwner: text('app_owner').notNull(),
  owningPageUrl: text('owning_page_url'),
  editableHere: boolean('editable_here').notNull().default(false),
  requiredPermission: text('required_permission').notNull(),
  lastChangedAt: timestamp('last_changed_at', { withTimezone: true, mode: 'date' }),
  ...timestamps,
}, table => [
  uniqueIndex('setting_registry_key_unique').on(table.key),
  check('setting_registry_metadata_nonblank_check', sql`
    length(btrim(${table.key})) > 0 and length(btrim(${table.label})) > 0
    and length(btrim(${table.appOwner})) > 0 and length(btrim(${table.requiredPermission})) > 0
  `),
]);
