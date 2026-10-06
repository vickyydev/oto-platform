import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { idPk, pos, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';
import { band, sale } from './sales';

export type ExtensionSelection = { mode: 'bands'; bandIds: string[] } | { mode: 'count'; braceletCount: number };

/** Extra play is paid on its own sale; the original admission stays frozen. */
export const saleExtension = pos.table('sale_extension', {
  id: idPk(),
  operatorId: uuid('operator_id').notNull().references(() => operator.id, { onDelete: 'restrict' }),
  branchId: uuid('branch_id').notNull().references(() => branch.id, { onDelete: 'restrict' }),
  sourceSaleId: uuid('source_sale_id').notNull().references(() => sale.id, { onDelete: 'restrict' }),
  chargeSaleId: uuid('charge_sale_id').notNull().references(() => sale.id, { onDelete: 'restrict' }),
  actionId: text('action_id').notNull(),
  optionId: text('option_id').notNull(),
  label: text('label').notNull(),
  minutesAdded: integer('minutes_added').notNull(),
  braceletCount: integer('bracelet_count').notNull(),
  amountSatang: bigint('amount_satang', { mode: 'number' }).notNull(),
  selection: jsonb('selection').$type<ExtensionSelection>().notNull(),
  status: text('status').$type<'pending' | 'applied' | 'voided'>().notNull().default('pending'),
  ...timestamps,
  createdByAccountId: uuid('created_by_account_id').notNull().references(() => account.id, { onDelete: 'restrict' }),
  createdByName: text('created_by_name'),
  appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }),
  voidedAt: timestamp('voided_at', { withTimezone: true, mode: 'date' }),
}, (t) => [
  uniqueIndex('sale_extension_action_unique').on(t.operatorId, t.actionId),
  uniqueIndex('sale_extension_charge_unique').on(t.chargeSaleId),
  uniqueIndex('sale_extension_pending_unique').on(t.sourceSaleId).where(sql`${t.status} = 'pending'`),
  index('sale_extension_source_idx').on(t.sourceSaleId),
  index('sale_extension_branch_idx').on(t.branchId),
  index('sale_extension_created_by_idx').on(t.createdByAccountId),
  check('sale_extension_status_check', sql`${t.status} in ('pending','applied','voided')`),
  check('sale_extension_positive_check', sql`${t.minutesAdded} > 0 and ${t.braceletCount} > 0 and ${t.amountSatang} > 0`),
  check('sale_extension_distinct_sales_check', sql`${t.sourceSaleId} <> ${t.chargeSaleId}`),
]);

/** Selected-band paid minutes, retained after refund; no inferred gate expiry. */
export const saleExtensionBand = pos.table('sale_extension_band', {
  id: idPk(),
  extensionId: uuid('extension_id').notNull().references(() => saleExtension.id, { onDelete: 'restrict' }),
  bandId: uuid('band_id').notNull().references(() => band.id, { onDelete: 'restrict' }),
  minutesAdded: integer('minutes_added').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  ...timestamps,
}, (t) => [
  uniqueIndex('sale_extension_band_unique').on(t.extensionId, t.bandId),
  index('sale_extension_band_band_idx').on(t.bandId),
  check('sale_extension_band_minutes_check', sql`${t.minutesAdded} > 0`),
]);
