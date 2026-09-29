import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { DisplayDiagnosticDocument } from '@oto/shared';
import { core, idPk, timestamps } from './helpers';
import { box, deviceCredential, station } from './fleet';
import { branch, operator } from './tenancy';

/** An anonymous screen has no station until a manager claims its short code. */
export const displayPairingRequest = core.table(
  'display_pairing_request',
  {
    id: idPk(),
    tokenHash: text('token_hash').notNull(),
    pairingCodeHash: text('pairing_code_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
    credentialId: uuid('credential_id').references(() => deviceCredential.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('display_pairing_request_token_unique').on(t.tokenHash),
    uniqueIndex('display_pairing_request_code_unique').on(t.pairingCodeHash)
      .where(sql`pairing_code_hash is not null`),
    index('display_pairing_request_credential_idx').on(t.credentialId),
    index('display_pairing_request_expiry_idx').on(t.expiresAt),
    check('display_pairing_request_claim_check', sql`
      (${t.credentialId} is null and ${t.claimedAt} is null)
      or (${t.credentialId} is not null and ${t.claimedAt} is not null and ${t.pairingCodeHash} is null)
    `),
  ],
);

/** Last recorded protected response preparation; revocation retains history. */
export const displayResponseSnapshot = core.table('display_response_snapshot', {
  credentialId: uuid('credential_id').primaryKey().references(() => deviceCredential.id, { onDelete: 'restrict' }),
  operatorId: uuid('operator_id').notNull().references(() => operator.id, { onDelete: 'restrict' }),
  branchId: uuid('branch_id').notNull().references(() => branch.id, { onDelete: 'restrict' }),
  stationId: uuid('station_id').notNull().references(() => station.id, { onDelete: 'restrict' }),
  boxId: uuid('box_id').notNull().references(() => box.id, { onDelete: 'restrict' }),
  journalEpoch: integer('journal_epoch'),
  preparedAt: timestamp('prepared_at', { withTimezone: true, mode: 'date' }).notNull(),
  responseKind: text('response_kind').$type<'session' | 'intent'>().notNull(),
  statusCode: integer('status_code').$type<200 | 403 | 409>().notNull(),
  document: jsonb('document').$type<DisplayDiagnosticDocument>().notNull(),
}, (t) => [
  index('display_response_snapshot_operator_idx').on(t.operatorId),
  index('display_response_snapshot_branch_idx').on(t.branchId),
  index('display_response_snapshot_station_idx').on(t.stationId),
  index('display_response_snapshot_box_idx').on(t.boxId),
  check('display_response_snapshot_kind_check', sql`${t.responseKind} in ('session', 'intent')`),
  check('display_response_snapshot_status_check', sql`${t.statusCode} in (200, 403, 409)`),
  check('display_response_snapshot_epoch_check', sql`${t.journalEpoch} is null or ${t.journalEpoch} > 0`),
  check('display_response_snapshot_document_check', sql`jsonb_typeof(${t.document}) = 'object'`),
]);
