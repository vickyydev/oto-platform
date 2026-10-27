import { sql } from 'drizzle-orm';
import { check, date, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { core, idPk, timestamps } from './helpers';
import { account, operator } from './tenancy';

/**
 * The credentials whose lifetime the owner knows, and so can be watched
 * (SCRUM-645, planner ruling Q26). A Meta channel token, a 2C2P maintenance
 * key and the OTO App Directory key each stop working on a date somebody was
 * told when they were issued — and nothing in this platform can ask the
 * provider when, nor should it: the expiry watch reads THIS row and nothing
 * else, and never probes a provider.
 */
export const INTEGRATION_EXPIRY_KEYS = ['meta_channel_token', 'pgw_maintenance_key', 'otoapp_directory_key'] as const;
export type IntegrationExpiryKey = (typeof INTEGRATION_EXPIRY_KEYS)[number];

/**
 * One row per operator and integration: the date the owner says its
 * credential expires. A DATE and who set it — never the credential, never a
 * part of one, and no free-text note somebody could paste a token into.
 * `expires_on` null is a date that was cleared (or never set), which the
 * watch reads as "nothing to warn about" and closes any open warning.
 */
export const integrationCredentialExpiry = core.table(
  'integration_credential_expiry',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    integrationKey: text('integration_key').$type<IntegrationExpiryKey>().notNull(),
    expiresOn: date('expires_on', { mode: 'string' }),
    setByAccountId: uuid('set_by_account_id').references(() => account.id),
    setAt: timestamp('set_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    // Leads with operator_id, so it is also that foreign key's index.
    uniqueIndex('integration_credential_expiry_operator_key_unique').on(t.operatorId, t.integrationKey),
    index('integration_credential_expiry_set_by_idx').on(t.setByAccountId),
    check(
      'integration_credential_expiry_key_check',
      sql`${t.integrationKey} in ('meta_channel_token','pgw_maintenance_key','otoapp_directory_key')`,
    ),
  ],
);
