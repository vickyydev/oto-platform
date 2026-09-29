import { sql } from 'drizzle-orm';
import { check, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { core, idPk, timestamps } from './helpers';
import { deviceCredential } from './fleet';

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
