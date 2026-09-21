import { asc, eq } from 'drizzle-orm';
import { signingKey, type Db, type SigningKeyPurpose } from '@oto/db';

/**
 * Which public keys are still worth verifying against, in one place (S2-06).
 *
 * There were two answers to this question and they disagreed. The config
 * bundle a real box pulls dropped keys that were retired, expired or belonged
 * to another operator; the snapshot the api's own offline-unlock path built
 * filtered on `purpose` and `active` alone. So retiring a key whose private
 * half had leaked — which is the documented response to exactly that — was
 * honoured by every Raspberry Pi in the park and ignored by the path that
 * answers the unlock today, and neither `verifyStaffToken` nor anything after
 * it re-checks: the verifier matches on purpose, kid and algorithm, because
 * "is this key still good" is a question the cloud answers and the box only
 * carries the result of.
 *
 * **`active` is deliberately not one of the tests, and that is the trap.** The
 * column says which key SIGNS — `core.signing_key`'s own note: "a key is
 * retired rather than deleted, and `active` says which one signs". A rotation
 * therefore sets it on the new key while the old one goes on verifying tokens
 * already in people's pockets, so reading it here would have made the first
 * rotation refuse every pocket at the moment the new key went live, which is
 * the opposite of what rotating in two steps is for. It was in this query's
 * WHERE until S2-06 and is not any more. Nothing in the platform writes
 * `active = false` on a signing key — `publishStaffTokenKey` always inserts
 * `true`, the column defaults to `true`, and no other statement sets it — so
 * that removal changes no row that exists today; it changes what a rotation
 * will mean when one happens.
 *
 * The four tests that DO decide, all of them applied below:
 *
 *  - `retired_at` — deliberately ended. The gesture for a compromised key;
 *  - `expires_at` — ended by its own terms;
 *  - `not_before` — not started yet: a key published ahead of a rotation
 *    verifies nothing until it begins. Nothing sets it today, so this is a
 *    rule written down rather than one in use;
 *  - `operator_id` — a platform key (null) or this operator's; never another's.
 */
export interface UsableSigningKey {
  purpose: string;
  kid: string;
  algorithm: string;
  /** SPKI PEM. The public half — the private one never reaches the database. */
  publicKey: string;
}

export async function usableSigningKeys(
  db: Db,
  opts: { operatorId: string; purpose?: SigningKeyPurpose; now?: Date },
): Promise<UsableSigningKey[]> {
  const now = (opts.now ?? new Date()).getTime();
  const rows = await db
    .select({
      purpose: signingKey.purpose,
      kid: signingKey.kid,
      algorithm: signingKey.algorithm,
      publicKey: signingKey.publicKey,
      operatorId: signingKey.operatorId,
      notBefore: signingKey.notBefore,
      expiresAt: signingKey.expiresAt,
      retiredAt: signingKey.retiredAt,
    })
    .from(signingKey)
    .where(opts.purpose ? eq(signingKey.purpose, opts.purpose) : undefined)
    .orderBy(asc(signingKey.purpose), asc(signingKey.kid));

  return rows
    .filter((k) => k.operatorId === null || k.operatorId === opts.operatorId)
    .filter((k) => !k.retiredAt)
    .filter((k) => !k.expiresAt || k.expiresAt.getTime() > now)
    .filter((k) => !k.notBefore || k.notBefore.getTime() <= now)
    .map((k) => ({
      purpose: k.purpose,
      kid: k.kid,
      algorithm: k.algorithm,
      publicKey: k.publicKey,
    }));
}
