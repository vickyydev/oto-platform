import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import { account, appIdentity, employee, type Db } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { ensureAppAccessRole, grantAppAccess } from './app-identity';
import {
  deactivateOtoAppUser, findOtoAppUser, linkOtoAppUser, lockOtoAppLifecycleUser,
  otoAppLifecycleUserIsOperators, otoAppUserIsOperators, readOtoAppLifecycleEvent,
  reconcileOtoAppRole, resolveOtoAppRoleContext, settleOtoAppLifecycleEvent,
} from './oto-app-users';
import { assertNotLastOperatorAdmin } from './access-control';
import { invalidateAllSessions } from './auth';
import { withTx, type OpContext } from './tx';

/**
 * SCRUM-539 — a suite sign-in for somebody who was created INSIDE the OTO
 * App: an advisor, or a user added on its Setup > Users screen.
 *
 * Those people are email-and-password records whose only door, the app's own
 * login form, is closed on the platform. The launcher knows phone accounts,
 * so the fix is a platform account for them — made here, from a phone the
 * app's administrator typed, with a temporary password shown to that
 * administrator ONCE and changed by the person at their first sign-in.
 *
 * **Who calls this, and with what.** The OTO App's server, not a browser, with
 * a key of its own (`OTOAPP_PROVISION_KEY` on the app, the SHA-256 of it in
 * `OTOAPP_PROVISION_KEYS` here, bound to one operator). Not the acting
 * administrator's platform session: the app holds that only sealed, for the
 * liveness back-channel, and an app administrator's authority is the app's
 * own role, which no platform permission mirrors. The administrator is named
 * in the request instead, and only an app user this operator's platform
 * account is already stamped on can be named — so the audit row carries a
 * real platform account as the actor.
 *
 * **What the provisioning endpoint can do, and what it cannot.** It can mint a NEW platform
 * account, holding nothing but the OTO App tile, for an app user of this
 * operator's park groups who has no suite sign-in yet. It cannot touch an
 * account that already exists (a phone already in use is refused, and the
 * POS admin's Link is the way to join the two), cannot re-issue a password,
 * cannot grant anything but `app:oto_app:access`, and cannot reach another
 * operator's park groups. That boundary is the whole security argument for a
 * suite-sign-in endpoint, and `test/s539-suite-sign-in.test.ts` pins every edge
 * of it. The separate lifecycle endpoint can switch off an existing account
 * only through its app-owned, identity-bound event; it cannot choose an account
 * from a request body or grant access.
 */

export interface ProvisionOtoAppUserInput {
  operatorId: string;
  /** Minted by the app per press; the identity row's id, so a retry finds it. */
  actionId: string;
  /** `otoapp.users.id` of the person getting the sign-in. */
  appUserId: string;
  phone: string;
  /** `otoapp.users.id` of the administrator who pressed the button. */
  actorAppUserId: string;
}

export interface ProvisionedSuiteSignIn {
  /** The identity row — the request's own action id. */
  id: string;
  accountId: string;
  /** E.164, as the platform stored it: what they type at the launcher. */
  phone: string;
  externalUserId: string;
  /** Shown once. Null on a replay of the same action: it was never kept. */
  temporaryPassword: string | null;
  replayed: boolean;
  platformManaged: boolean;
}

/** Eight characters, as `POST /accounts/:id/temp-password` issues them. */
function temporaryPassword(): string {
  return randomBytes(6).toString('base64url');
}

/**
 * Provision an EXISTING OTO App user into the suite: a new platform account
 * from their phone with a one-time temporary password (a change forced at
 * first sign-in), the OTO App grant, the identity link and the stamp on their
 * app row — one transaction, one audit row.
 *
 * Advisors are allowed: their branches come from their access policy inside
 * the app, and nothing here writes branch access (the grant is operator-wide,
 * as on the claim path), so `refuseAdvisor` has nothing to guard.
 */
export async function provisionExistingOtoAppUser(
  db: Db,
  ctx: OpContext,
  input: ProvisionOtoAppUserInput,
): Promise<ProvisionedSuiteSignIn> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError(400, 'BAD_REQUEST', 'Invalid phone number');

  // The administrator, as a platform account: an app user of the same park
  // groups, stamped with an active account of this operator. Their app role
  // was the app's own guard; here they must be somebody the platform knows.
  // Asked first: who is asking decides whether anything else is answered.
  const actorUser = await findOtoAppUser(db, { id: input.actorAppUserId });
  const actorAccount =
    actorUser?.platformUserId &&
    actorUser.isActive &&
    (await otoAppUserIsOperators(db, { operatorId: input.operatorId, userId: actorUser.id }))
      ? (
          await db
            .select({ id: account.id, status: account.status })
            .from(account)
            .where(
              and(
                eq(account.id, actorUser.platformUserId),
                eq(account.operatorId, input.operatorId),
              ),
            )
            .limit(1)
        )[0]
      : undefined;
  if (!actorAccount || actorAccount.status !== 'active') {
    throw new AppError(
      403,
      'OTOAPP_PROVISION_ACTOR',
      'Only an administrator who signed in from the launcher can give somebody a suite sign-in',
    );
  }

  // The person, inside this operator's park groups. Another park group's
  // user is answered as not there, as Link answers it.
  const user = await findOtoAppUser(db, { id: input.appUserId });
  if (
    !user ||
    !(await otoAppUserIsOperators(db, { operatorId: input.operatorId, userId: user.id }))
  ) {
    throw new AppError(
      404,
      'NOT_FOUND',
      'The OTO App has no user with that id in a park group of this operator',
    );
  }
  // A completed press remains private to its live actor, owning operator and
  // exact user/phone binding. Replays never issue another password or grant.
  const [prior] = await db.select().from(appIdentity).where(eq(appIdentity.id, input.actionId)).limit(1);
  if (prior) {
    const [acc] = await db.select({ id: account.id, phone: account.phone, operatorId: account.operatorId })
      .from(account).where(eq(account.id, prior.accountId)).limit(1);
    if (prior.app !== 'oto_app' || prior.externalUserId !== user.id || prior.createdBy !== actorAccount.id
      || !acc || acc.operatorId !== input.operatorId || user.platformUserId !== acc.id || acc.phone !== phone) {
      throw new AppError(409, 'ACTION_ID_REUSED', 'That action id was already used for another sign-in request');
    }
    const mapped = await resolveOtoAppRoleContext(db, { operatorId: input.operatorId, accountId: acc.id });
    return { id: prior.id, accountId: acc.id, phone: acc.phone, externalUserId: prior.externalUserId,
      temporaryPassword: null, replayed: true, platformManaged: mapped !== null };
  }
  if (!user.isActive) {
    throw new AppError(
      409,
      'OTO_APP_USER_INACTIVE',
      'That OTO App user is switched off; activate them first',
    );
  }

  const [linked] = await db
    .select({ id: appIdentity.id })
    .from(appIdentity)
    .where(and(eq(appIdentity.app, 'oto_app'), eq(appIdentity.externalUserId, user.id)))
    .limit(1);
  if (user.platformUserId || linked) {
    throw new AppError(
      409,
      'SUITE_SIGNIN_EXISTS',
      'This person already has a suite sign-in. A forgotten password is reset from the launcher ("Forgot password").',
    );
  }

  const [taken] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.operatorId, input.operatorId), eq(account.phone, phone)))
    .limit(1);
  if (taken) {
    throw new AppError(
      409,
      'ACCOUNT_EXISTS',
      'That phone number already has a suite account. Link it to this person from the POS admin (Login Users, Apps) instead.',
    );
  }

  const temp = temporaryPassword();
  const passwordHash = await hash(temp);
  const accountId = newId();
  const employeeId = newId();

  return withTx(
    db,
    { ...ctx, operatorId: input.operatorId, actorAccountId: actorAccount.id },
    'app_identity.provision',
    async (tx) => {
      await tx
        .insert(employee)
        .values({ id: employeeId, operatorId: input.operatorId, name: user.fullName, phone });
      await tx.insert(account).values({
        id: accountId,
        operatorId: input.operatorId,
        employeeId,
        phone,
        passwordHash,
        status: 'active',
        mustChangePassword: true,
        // The administrator typed this number for the person in front of them,
        // as an administrator does when issuing a temporary password (SCRUM-28).
        phoneVerifiedAt: new Date(),
      });
      const stamped = await linkOtoAppUser(tx, { userId: user.id, platformAccountId: accountId });
      if (!stamped) {
        throw new AppError(
          409,
          'SUITE_SIGNIN_EXISTS',
          'This person was given a suite sign-in a moment ago',
        );
      }
      await tx.insert(appIdentity).values({
        id: input.actionId,
        app: 'oto_app',
        accountId,
        externalUserId: user.id,
        createdBy: actorAccount.id,
      });
      const roleId = await ensureAppAccessRole(tx, input.operatorId, 'oto_app');
      const accessGranted = await grantAppAccess(tx, accountId, roleId, input.operatorId, null);
      const mapped = await reconcileOtoAppRole(tx, { operatorId: input.operatorId, accountId,
        actorAccountId: actorAccount.id, requestId: ctx.requestId });
      await audit.record(tx, {
        actorAccountId: actorAccount.id,
        operatorId: input.operatorId,
        action: 'app_identity.provision',
        entityType: 'app_identity',
        entityId: input.actionId,
        actionId: input.actionId,
        after: {
          targetApp: 'oto_app',
          via: 'otoapp_provision_key',
          accountId,
          externalUserId: user.id,
          appUserRole: user.role,
          actorAppUserId: actorUser!.id,
          accountCreated: true,
          temporaryPasswordIssued: true,
          accessGranted,
        },
        requestId: ctx.requestId,
      });
      return {
        id: input.actionId,
        accountId,
        phone,
        externalUserId: user.id,
        temporaryPassword: temp,
        replayed: false,
        platformManaged: mapped !== null,
      };
    },
  );
}

export interface ConsumedLifecycleDeactivation {
  ok: true;
  eventId: string;
  state: 'delivered' | 'superseded';
  replayed: boolean;
}

/**
 * Consume an app-owned switch-off event using its immutable identity targets.
 * The service key names only the owning operator; no caller supplies an account
 * or an acting administrator. The event is the durable replay receipt.
 */
export async function consumeLifecycleDeactivation(
  db: Db,
  ctx: OpContext,
  input: { operatorId: string; eventId: string },
): Promise<ConsumedLifecycleDeactivation> {
  const missing = () => new AppError(404, 'NOT_FOUND', 'That lifecycle event is not available for this operator');
  const snapshot = await readOtoAppLifecycleEvent(db, input.eventId);
  if (!snapshot) throw missing();

  return withTx(db, { ...ctx, operatorId: input.operatorId, actorAccountId: null, branchId: null },
    'app_identity.lifecycle_deactivation', async tx => {
      // Shared with account PATCH and assignment removal. Keep the order:
      // operator, platform account, app user, then its event.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.operatorId}, 633))`);
      // Serialize status changes while allowing an identity insert's FK KEY
      // SHARE lock: linking already holds the app user before that FK check.
      const [target] = await tx.select({ id: account.id, operatorId: account.operatorId, status: account.status })
        .from(account).where(and(eq(account.id, snapshot.platformAccountId), eq(account.operatorId, input.operatorId))).for('no key update');
      if (!target) throw missing();
      const user = await lockOtoAppLifecycleUser(tx, snapshot.userId);
      if (!user) throw missing();
      const event = await readOtoAppLifecycleEvent(tx, input.eventId, { lock: true });
      if (!event || event.userId !== snapshot.userId || event.platformAccountId !== snapshot.platformAccountId) throw missing();
      if (!(await otoAppLifecycleUserIsOperators(tx, { operatorId: input.operatorId, accountId: target.id, user }))) throw missing();

      // Ownership is checked on every replay, but a settled event never changes
      // the current account or user, including after a later reactivation.
      if (event.state !== 'pending') {
        return { ok: true as const, eventId: event.id, state: event.state, replayed: true };
      }
      const superseded = user.isActive || user.platformUserId !== target.id;
      const state = superseded ? 'superseded' as const : 'delivered' as const;
      let otoApp = { userIds: [] as string[], sessionsEnded: 0 };
      if (!superseded) {
        await assertNotLastOperatorAdmin(tx as Db, input.operatorId, { accountId: target.id });
        if (target.status !== 'inactive') {
          await tx.update(account).set({ status: 'inactive' }).where(eq(account.id, target.id));
        }
        await invalidateAllSessions(tx, target.id, 'deactivated');
        otoApp = await deactivateOtoAppUser(tx, { platformAccountId: target.id });
      }
      await settleOtoAppLifecycleEvent(tx, event.id, state);
      await audit.record(tx, {
        actorAccountId: null,
        operatorId: input.operatorId,
        action: 'app_identity.lifecycle_deactivation',
        entityType: 'app_identity',
        entityId: event.id,
        actionId: event.id,
        before: { status: target.status },
        after: { sourceApp: 'oto_app', accountId: target.id, externalUserId: user.id, state,
          accountDeactivated: !superseded && target.status !== 'inactive', otoApp },
        requestId: ctx.requestId,
      });
      return { ok: true as const, eventId: event.id, state, replayed: false };
    });
}
