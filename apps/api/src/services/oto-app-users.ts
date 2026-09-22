import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  account,
  branch,
  employee,
  findAppBranchForCore,
  mappedAppBranches,
  otoappUserBranchAccess,
  otoappUsers,
  role,
  roleAssignment,
  type OtoAppUserRole,
} from '@oto/db';
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
 * What the app owns and this does not touch: access policies, and the employee
 * record a user is matched to. Those are set inside the OTO App.
 *
 * Branch access (`otoapp.user_branch_access`) used to be on that list, and one
 * row of it no longer is — see `seatInAppBranch` below (SCRUM-268). What is
 * written is the single row that seats a newly provisioned person in the
 * branch they already work at; changing anybody's branch access afterwards is
 * still the app's own screen.
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

/** How the OTO App's branch was found for a person being provisioned. */
export type OtoAppBranchMatch = 'core_branch_id' | 'name';

/**
 * WHICH platform branch was taken as theirs, which is the whole question
 * (SCRUM-268, decision 3). Three candidates, in this order:
 *
 * - `request` — the provisioning named a branch outright. The most explicit
 *   thing in the request wins.
 * - `employee` — their employee record says where they work. This is what the
 *   platform already knows about THIS person, so it beats where the
 *   administrator happens to be standing.
 * - `session` — the branch the provisioning was done at, for somebody the
 *   platform does not place anywhere yet: an account created by this very
 *   request has an employee record with no branch on it. Last, never first: a
 *   session branch is a value the caller sets for themselves (SCRUM-264), so
 *   it must not override what the platform knows.
 * - `operator_wide` — they administer the whole operator, so they are given
 *   every mapped branch rather than one.
 */
export type OtoAppSeatSource = 'request' | 'employee' | 'session' | 'operator_wide';

/**
 * Why they were seated in none. Each is a different thing to fix, so they are
 * separate values rather than one "failed":
 *
 * - `no_platform_branch` — nothing said where this person works: no branch in
 *   the request, none on their employee record, and no branch on the
 *   provisioning session either.
 * - `no_app_branch` — the platform knows the branch and the OTO App has no row
 *   carrying its id and none of that name.
 * - `ambiguous_name` — more than one OTO App branch carries that name, and
 *   guessing between two parks is worse than seating them in neither.
 * - `no_mapped_branch` — they administer the whole operator, and not one of its
 *   branches is joined to a row in the app yet. `POST /branches/oto-app/reconcile`
 *   is what fixes that.
 */
export type OtoAppBranchUnplaced =
  | 'no_platform_branch'
  | 'no_app_branch'
  | 'ambiguous_name'
  | 'no_mapped_branch';

/**
 * Where a provisioned person landed in the OTO App's own branch list — and,
 * when nowhere, why (SCRUM-268).
 *
 * Returned rather than thrown, deliberately. A person who has an account, a
 * tile and a user in the app but no branch is worse off silently than loudly:
 * the app answers every screen with nothing and looks broken. So provisioning
 * still succeeds, and this travels out to the caller so the tile can say the
 * person needs their branch access set inside the OTO App.
 */
export interface OtoAppBranchPlacement {
  /** `otoapp.branches.id` they were seated in — the first, when more than one. */
  branchId: string | null;
  branchName: string | null;
  /** Every app branch written for them. One, or every mapped branch. */
  branchIds: string[];
  matchedBy: OtoAppBranchMatch | null;
  seatedFrom: OtoAppSeatSource | null;
  unplacedReason: OtoAppBranchUnplaced | null;
}

export interface ProvisionedOtoAppUser extends OtoAppUser {
  branch: OtoAppBranchPlacement;
}

/**
 * Seat a newly provisioned person in the OTO App branch they work at
 * (SCRUM-268, decision 3).
 *
 * **The boundary this crosses, deliberately.** `otoapp.user_branch_access` is
 * the app's own record of who may see which park, and the platform used to
 * leave it alone on principle — with the result that everybody provisioned from
 * the launcher landed in NO branch at either park and somebody had to open the
 * OTO App and set it by hand. "Which branch do they land in" has to have an
 * answer, so one row is written here. Changing anybody's branch access
 * afterwards is still the app's own screen.
 *
 * **Which branch is theirs** is the whole question, and `OtoAppSeatSource`
 * above is the order it is answered in: the branch the request named, then
 * their employee record, then the branch the provisioning was done at.
 * Somebody who administers the whole operator is given every mapped branch
 * instead of one.
 *
 * **Which APP row that platform branch is** goes through
 * `findAppBranchForCore`: `core_branch_id` first, which survives a rename on
 * either side, and the trimmed case-folded name for a deployment whose rows
 * have not been reconciled yet. Two rows of that name is `ambiguous_name` and
 * not a coin toss — a person seated in the wrong park's data is invisible
 * afterwards, and one seated nowhere is stated in the answer.
 *
 * **What is still not checked, said plainly.** The app's own tenant is not
 * matched against the platform's operator: `otoapp.operators` is a different
 * table from `core.operator` with different ids and no correspondence between
 * them. What bounds the name step instead is the platform branch, which is
 * loaded inside this account's operator before anything is looked up.
 *
 * Runs inside the provisioning transaction, so a failure anywhere after it
 * takes this row with the user it belongs to.
 */
async function seatInAppBranch(
  exec: Exec,
  opts: {
    userId: string;
    platformAccountId: string;
    /** A branch the provisioning named outright. */
    branchId?: string | null;
    /** The branch the provisioning was done at. Last resort — see `OtoAppSeatSource`. */
    sessionBranchId?: string | null;
  },
): Promise<OtoAppBranchPlacement> {
  const unplaced = (reason: OtoAppBranchUnplaced): OtoAppBranchPlacement => ({
    branchId: null,
    branchName: null,
    branchIds: [],
    matchedBy: null,
    seatedFrom: null,
    unplacedReason: reason,
  });

  const [holder] = await exec
    .select({ operatorId: account.operatorId, employeeBranchId: employee.branchId })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(eq(account.id, opts.platformAccountId))
    .limit(1);
  // Provisioning loaded this account before it got here, so there is one.
  const operatorId = holder!.operatorId;

  /**
   * Somebody who administers the whole operator belongs at every park, and the
   * app has to be told so in rows — its `getUserWithBranchAccess` reads this
   * table and a user with none sees nothing.
   *
   * Asked as "holds an ADMINISTRATOR role operator-wide", never as "holds
   * anything operator-wide". The app-access grant this same provisioning writes
   * is itself operator-scoped, so the looser reading would make every person
   * provisioned into the app an administrator of every park — which is the door
   * the branch isolation register found open at `atBranch`.
   */
  if (await administersWholeOperator(exec, opts.platformAccountId, operatorId)) {
    const mapped = await mappedAppBranches(exec, operatorId);
    if (mapped.length === 0) return unplaced('no_mapped_branch');
    for (const row of mapped) {
      await exec.insert(otoappUserBranchAccess).values({
        id: newId(),
        tenantId: row.tenantId,
        userId: opts.userId,
        branchId: row.id,
        accessScope: 'selected_branches',
      });
    }
    return {
      branchId: mapped[0]!.id,
      branchName: mapped[0]!.name,
      branchIds: mapped.map((r) => r.id),
      matchedBy: 'core_branch_id',
      seatedFrom: 'operator_wide',
      unplacedReason: null,
    };
  }

  /** The platform branch that is theirs, and where that answer came from. */
  const candidates: Array<{ id: string; from: OtoAppSeatSource }> = [
    ...(opts.branchId ? [{ id: opts.branchId, from: 'request' as const }] : []),
    ...(holder!.employeeBranchId ? [{ id: holder!.employeeBranchId, from: 'employee' as const }] : []),
    ...(opts.sessionBranchId ? [{ id: opts.sessionBranchId, from: 'session' as const }] : []),
  ];
  const chosen = candidates[0];
  if (!chosen) return unplaced('no_platform_branch');

  // Inside this operator, always: a branch id in a request carries no tenancy
  // of its own (SCRUM-248), and seating somebody in another operator's park is
  // the one outcome worse than seating them nowhere.
  const [seat] = await exec
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(and(eq(branch.id, chosen.id), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!seat) return unplaced('no_platform_branch');

  const found = await findAppBranchForCore(exec, {
    operatorId,
    coreBranchId: seat.id,
    name: seat.name,
  });
  if (found === 'ambiguous') return unplaced('ambiguous_name');
  if (!found) return unplaced('no_app_branch');

  await exec.insert(otoappUserBranchAccess).values({
    id: newId(),
    // The app requires a tenant on this row and takes the session's tenant
    // from the first one a user has, so it comes off the branch they are being
    // seated in rather than from anywhere on the platform.
    tenantId: found.tenantId,
    userId: opts.userId,
    branchId: found.id,
    accessScope: 'selected_branches',
  });
  return {
    branchId: found.id,
    branchName: found.name,
    branchIds: [found.id],
    matchedBy: found.matchedBy,
    seatedFrom: chosen.from,
    unplacedReason: null,
  };
}

/**
 * Does this account administer the whole operator?
 *
 * The two administrator roles held at operator scope — `platform_admin` carries
 * a null scope id and `operator_admin` carries the operator's. A role held at
 * one branch, and any other role held operator-wide, is not this.
 */
async function administersWholeOperator(
  exec: Exec,
  accountId: string,
  operatorId: string,
): Promise<boolean> {
  const rows = await exec
    .select({ name: role.name })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        eq(roleAssignment.accountId, accountId),
        eq(roleAssignment.scopeType, 'operator'),
        or(isNull(roleAssignment.scopeId), eq(roleAssignment.scopeId, operatorId)),
        inArray(role.name, ['platform_admin', 'operator_admin']),
      ),
    )
    .limit(1);
  return rows.length > 0;
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
  /**
   * The platform branch this person is being provisioned at, when the request
   * named one, and the branch the provisioning session is standing at. Which
   * of the two — and where their employee record comes in between them — is
   * `OtoAppSeatSource`.
   */
  branchId?: string | null;
  sessionBranchId?: string | null;
}

/**
 * Create the OTO App's user for a platform account, stamped with it.
 *
 * Refuses rather than duplicating when the app already has someone on that
 * email or phone: both are unique there, so the alternative is a constraint
 * violation surfacing as a 500, and the honest answer is "that person is
 * already in the OTO App — link them".
 *
 * Seats them in an OTO App branch where one can be resolved, and says on the
 * answer when it could not (SCRUM-268) — `branch`.
 */
export async function createOtoAppUser(
  exec: Exec,
  input: CreateOtoAppUserInput,
): Promise<ProvisionedOtoAppUser> {
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
  const user = row!;
  return {
    ...user,
    branch: await seatInAppBranch(exec, {
      userId: user.id,
      platformAccountId: input.platformAccountId,
      branchId: input.branchId ?? null,
      sessionBranchId: input.sessionBranchId ?? null,
    }),
  };
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
