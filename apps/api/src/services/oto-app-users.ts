import { randomBytes } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import { otoappUsers, type OtoAppUserRole } from '@oto/db';
import { newId } from '@oto/shared';
import { AppError } from '../lib/errors';
import type { Exec } from './tx';

/**
 * The one place in this api that reads or writes the OTO App's own schema
 * (S2-17a).
 *
 * Everything else about provisioning a person — the platform account, the
 * role, the grant, the `core.app_identity` row — is the platform's own
 * business and lives in `routes/app-identities.ts`. This file writes
 * `otoapp.users`, and nothing else here may. One file to read when the app's
 * schema moves, one file to change, and a grep for `otoappUsers` that answers
 * "what do we write over there" with a complete list.
 *
 * Why the boundary is drawn as a function call rather than a call to the app.
 * The two run on one database. Provisioning has to be all-or-nothing — an
 * account with no user in the app is a tile that opens onto a refusal, and a
 * user in the app with no account is a person nobody can reach — so it is one
 * transaction, and an HTTP call to the app would be a network call held inside
 * that transaction: the transaction stays open for as long as another service
 * takes to answer, and if the half on the other side has already committed
 * there is nothing here that can take it back. The only other way to keep the
 * two sides in step is the administrator creating the same person twice, in
 * two places, and pasting an id between them — which is the thing this ticket
 * exists to remove.
 *
 * What the app owns and this does not touch: branch access
 * (`otoapp.user_branch_access`), access policies, and the employee record a
 * user is matched to. Those are set inside the OTO App.
 */

/** Read back from every call. Never the password. */
const SELECTION = {
  id: otoappUsers.id,
  email: otoappUsers.email,
  fullName: otoappUsers.fullName,
  role: otoappUsers.role,
  isActive: otoappUsers.isActive,
  phoneE164: otoappUsers.phoneE164,
  platformUserId: otoappUsers.platformUserId,
};

export interface OtoAppUser {
  id: string;
  email: string;
  fullName: string;
  role: OtoAppUserRole;
  isActive: boolean;
  phoneE164: string | null;
  platformUserId: string | null;
}

/** By the app's id for them, or by the platform account they are stamped with. */
export async function findOtoAppUser(
  exec: Exec,
  by: { id?: string; platformUserId?: string },
): Promise<OtoAppUser | null> {
  const where = by.id
    ? eq(otoappUsers.id, by.id)
    : by.platformUserId
      ? eq(otoappUsers.platformUserId, by.platformUserId)
      : null;
  if (!where) throw new Error('findOtoAppUser needs an id or a platformUserId');
  const [row] = await exec.select(SELECTION).from(otoappUsers).where(where).limit(1);
  return row ?? null;
}

/**
 * Stamp an existing OTO App user with the platform account they are — the
 * case where the person already works in that app and is only now being given
 * a platform account.
 *
 * Null when no row was stamped: either there is no such user, or the one
 * named already belongs to somebody else. The caller decides which answer
 * that is; this refuses to overwrite either way, because the stamp is what
 * `platformSignOn.ts` signs a person in by, and moving one would sign the
 * wrong person into that user's record.
 *
 * A row already carrying THIS account matches, so the same request arriving
 * twice is a no-op that still answers with the user.
 */
export async function linkOtoAppUser(
  exec: Exec,
  opts: { userId: string; platformAccountId: string },
): Promise<OtoAppUser | null> {
  const [row] = await exec
    .update(otoappUsers)
    .set({ platformUserId: opts.platformAccountId, updatedAt: new Date() })
    .where(
      and(
        eq(otoappUsers.id, opts.userId),
        or(
          isNull(otoappUsers.platformUserId),
          eq(otoappUsers.platformUserId, opts.platformAccountId),
        ),
      ),
    )
    .returning(SELECTION);
  return row ?? null;
}

/**
 * Take the stamp off again when an account is unlinked from the app.
 *
 * Needed because withdrawing the grant is not always enough: `revokeAppAccess`
 * removes only the role this provisioning made, and somebody who also holds
 * `app:oto_app:access` through their operator-admin bundle keeps the tile. A
 * stamp left behind would still resolve them to this user, so "unlinked" would
 * be a word for something that had not happened.
 *
 * Scoped to the account being unlinked, so it can never clear a stamp that
 * belongs to somebody else. Answers whether there was one.
 */
export async function unlinkOtoAppUser(
  exec: Exec,
  opts: { platformAccountId: string },
): Promise<boolean> {
  const cleared = await exec
    .update(otoappUsers)
    .set({ platformUserId: null, updatedAt: new Date() })
    .where(eq(otoappUsers.platformUserId, opts.platformAccountId))
    .returning({ id: otoappUsers.id });
  return cleared.length > 0;
}

export interface CreateOtoAppUserInput {
  /** `core.account.id`, written straight into `platform_user_id`. */
  platformAccountId: string;
  email: string;
  fullName: string;
  role: OtoAppUserRole;
  /**
   * `otoapp.operators.id`, and null unless the caller knows one. It is a
   * foreign key into the app's own operator table, which is a different table
   * from `core.operator` with different ids, and no correspondence between
   * the two has been established — so passing the platform's operator id here
   * would be a foreign-key violation dressed up as a tenant.
   */
  operatorId?: string | null;
  phoneE164?: string | null;
}

/**
 * Create the OTO App's user for a platform account, stamped with it.
 *
 * Refuses rather than duplicating when the app already has someone on that
 * email or phone: both are unique there, so the alternative is a constraint
 * violation surfacing as a 500, and the honest answer is "that person is
 * already in the OTO App — link them".
 */
export async function createOtoAppUser(
  exec: Exec,
  input: CreateOtoAppUserInput,
): Promise<OtoAppUser> {
  // Lower-cased because the app resolves a user by `email.toLowerCase()` (its
  // local sign-in and the employee match in `getUserWithBranchAccess`), so a
  // capitalised address stored here is one those lookups never find.
  const email = input.email.trim().toLowerCase();
  const phoneE164 = input.phoneE164?.trim() || null;

  const clash = await findClash(exec, email, phoneE164);
  if (clash) {
    throw new AppError(
      409,
      'OTO_APP_USER_EXISTS',
      clash.email === email
        ? `The OTO App already has a user on ${email}. Link that user (${clash.id}) instead of creating a second one.`
        : `The OTO App already has a user on that phone number. Link that user (${clash.id}) instead of creating a second one.`,
      { externalUserId: clash.id },
    );
  }

  const [row] = await exec
    .insert(otoappUsers)
    .values({
      id: newId(),
      email,
      password: unusablePassword(),
      fullName: input.fullName.trim(),
      role: input.role,
      operatorId: input.operatorId ?? null,
      isActive: true,
      /**
       * False on purpose, and the one column here that is not simply copied
       * from the request. The app's default is true and its client sends any
       * authenticated user carrying it to `/change-password`, which asks for
       * the password they hold today — and a person provisioned from the
       * launcher was never given one. Leaving the default would land them on
       * a form they cannot complete, on their first visit, every visit.
       */
      mustChangePassword: false,
      phoneNumber: phoneE164,
      phoneE164,
      platformUserId: input.platformAccountId,
    })
    .returning(SELECTION);
  // The insert names every NOT NULL column and nothing filtered the row out.
  return row!;
}

/** The two columns that are unique in the app's own schema. */
async function findClash(
  exec: Exec,
  email: string,
  phoneE164: string | null,
): Promise<OtoAppUser | null> {
  const [row] = await exec
    .select(SELECTION)
    .from(otoappUsers)
    .where(
      phoneE164
        ? or(eq(otoappUsers.email, email), eq(otoappUsers.phoneE164, phoneE164))
        : eq(otoappUsers.email, email),
    )
    .limit(1);
  return row ?? null;
}

/**
 * A password nothing can ever be, for a person who has none here.
 *
 * `otoapp.users.password` is NOT NULL, and someone provisioned from the
 * launcher signs in through the hand-off rather than through that app's form.
 * The app compares with `comparePasswords` in its `server/auth.ts`: it splits
 * the stored value on "." and `timingSafeEqual`s a 64-byte scrypt output
 * against the first half, so a value that is not 64 bytes of hex and a salt
 * makes the comparison throw instead of answering false. What is stored is
 * therefore well formed and random — no supplied password produces it, and
 * nothing about a restart or a redeploy makes it guessable.
 *
 * This is not a placeholder waiting for a real hash, and nothing should
 * "fix" it by writing one. A local password for these people would be a
 * second way in: one that survives being deactivated on the platform, and
 * that signing out everywhere would never reach. That is the same reason the
 * app's own local login is off (`legacyLoginEnabled`).
 */
function unusablePassword(): string {
  return `${randomBytes(64).toString('hex')}.${randomBytes(16).toString('hex')}`;
}
