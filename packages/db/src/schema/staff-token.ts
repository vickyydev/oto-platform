import { sql } from 'drizzle-orm';
import { check, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { core } from './helpers';
import { account, branch, operator, session } from './tenancy';
import { box, station } from './fleet';

// --- The signed staff token (schema `core`) ---------------------------------
//
// S2-06. A file of its own rather than a block in `tenancy.ts`, for a reason
// that is structural and not about size: this table has foreign keys to
// `core.station` and `core.box`, which are declared in `fleet.ts`, and
// `fleet.ts` already imports `operator`, `branch` and `account` from
// `tenancy.ts`. Putting it there would make the two modules circular.
// `session.station_id` solved the same problem by dropping its foreign key;
// here the keys are worth keeping, so the table moves instead.

/**
 * A token minted at station pick, verified on a box that may have been offline
 * for hours.
 *
 * **Why this is not a column on `core.session`.** A session is one sign-in in
 * one browser; a token is one shift at one station, and the two do not move
 * together. Picking a second station mints a second token while the first is
 * still inside its expiry, so a single `jti` column on the session would
 * overwrite the only handle by which the first could ever be revoked — it would
 * stay valid on a box that is offline, and nothing would be able to name it.
 * A row per minted token is what makes each one individually revocable, which
 * is the whole point of a deny-list.
 *
 * **What it is for, in two readers.**
 *
 *  1. **The deny-list.** `select jti … where revoked_at is not null and
 *     expires_at > now()` is the `revokedTokenIds` half of the `deny_list`
 *     cache-bundle scope, which `apps/api/src/services/sync.ts` currently
 *     builds as an empty array with a comment saying S2-06 fills it. The list
 *     is bounded by expiry rather than by history: past its `exp` a box refuses
 *     a token on the timestamp alone, so keeping it on the list would make the
 *     list grow for ever in order to repeat something the token already says
 *     about itself.
 *  2. **"Seen on this box in the last 30 days."** The offline sign-in path lets
 *     somebody the box has seen recently sign in from cold with their password.
 *     That question is `select distinct account_id … where box_id = $1 and
 *     issued_at > now() - 30 days`, on this same row — so the record of who was
 *     recognised and the record of who was revoked cannot disagree, which they
 *     could if they lived in two places.
 *
 * **No sweep.** One row per station pick is a few dozen a day at a branch —
 * on the order of ten thousand a year — and every query above is bounded by
 * `expires_at > now()` or by an indexed `issued_at` window, so age costs
 * nothing. If one is ever wired it goes in `job:housekeeping.retention` with
 * `STAFF_TOKEN_RETENTION_DAYS` from `@oto/shared`, which carries the floor it
 * may not go below and why.
 *
 * **ON DELETE is restrict on every key**, including the session. A session is
 * revoked rather than deleted (S2-01a) and an account is deactivated rather
 * than deleted, so nothing here should ever be reached by a delete; if one is
 * attempted, the credential record is the last thing that should quietly go
 * with it.
 */
export const staffToken = core.table(
  'staff_token',
  {
    /**
     * The token's `jti` claim, and its identity. There is no second id: the
     * value a revocation names and the value the row is found by are the same
     * thing, exactly as on `core.handoff_token`.
     */
    jti: uuid('jti').primaryKey(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    /** The token's audience: it is good at this branch and nowhere else. */
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    /**
     * The sign-in this token came out of.
     *
     * Not nullable: a staff token is derived from somebody signing in, and one
     * with no session behind it is a credential that signing out cannot end.
     * "Sign out everywhere" revokes the sessions and, through this column, the
     * tokens minted from them.
     */
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'restrict' }),
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    /**
     * The box that station sits on, denormalised so the 30-day question above
     * is one index rather than a join through a station that may since have
     * moved to another box.
     *
     * Not nullable, and that has a consequence worth naming: a station with no
     * box — a Sprint 1 row the fleet migration could not answer for — cannot
     * mint a token. That is correct rather than awkward. An offline token is
     * verified by a box, and a station with no box has none to verify it.
     */
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    /**
     * Which signing key signed it — the `kid` in the token header.
     *
     * Text rather than a foreign key to `core.signing_key`: that table is
     * unique on (purpose, kid), so a key here would have to carry the purpose
     * as well, to constrain a value that is already constrained by the
     * signature verifying or not. A token signed by a key that has since been
     * retired is still a fact about what happened.
     */
    kid: text('kid').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    /** One of `STAFF_TOKEN_REVOKE_REASONS` in `@oto/shared`. */
    revokedReason: text('revoked_reason'),
    /** Null when the revocation was automatic — a sign-out, a new station pick. */
    revokedByAccountId: uuid('revoked_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * The deny-list query, and the only index it needs: the revoked tokens
     * still inside their own lifetime. Partial, so it holds what the bundle
     * carries rather than every token ever minted.
     */
    index('staff_token_deny_idx')
      .on(t.expiresAt)
      .where(sql`revoked_at is not null`),
    /** "Which staff has this box seen in the last 30 days?" */
    index('staff_token_box_issued_idx').on(t.boxId, t.issuedAt),
    /** One person's tokens, newest first — the Console's per-account view. */
    index('staff_token_account_issued_idx').on(t.accountId, t.issuedAt),
    /** Revoking every token of a session, which is what signing out does. */
    index('staff_token_session_idx').on(t.sessionId),
    index('staff_token_station_idx').on(t.stationId),
    index('staff_token_operator_idx').on(t.operatorId),
    index('staff_token_branch_idx').on(t.branchId),
    index('staff_token_revoked_by_idx').on(t.revokedByAccountId),
    /** A token that expires before it was issued would be refused by every verifier. */
    check('staff_token_expiry_check', sql`${t.expiresAt} > ${t.issuedAt}`),
    /**
     * A reason or an author without a revocation is a row that reads as revoked
     * and is not — which is the shape of a token somebody believes they ended.
     */
    check(
      'staff_token_revocation_check',
      sql`${t.revokedAt} is not null
          or (${t.revokedReason} is null and ${t.revokedByAccountId} is null)`,
    ),
  ],
);
