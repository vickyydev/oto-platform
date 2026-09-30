import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { account, appIdentity, employee, HANDOFF_AUDIENCES, OTO_APP_USER_ROLES } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { accessErrors, assertDominatesAccount, loadTargetAccount } from '../services/access-control';
import { audit } from '../services/audit';
import { deliverCode, mintCode, type PendingCode } from '../services/auth';
import { ensureAppAccessRole, grantAppAccess, revokeAppAccess } from '../services/app-identity';
import { appAccessPermission, type HandoffApp } from '../services/handoff';
import {
  createOtoAppUser,
  findOtoAppUser,
  linkOtoAppUser,
  unlinkOtoAppUser,
  type OtoAppBranchPlacement,
} from '../services/oto-app-users';
import {
  hasPermission,
  resolveEffectivePermissions,
  type EffectivePermission,
} from '../services/permissions';
import { opCtx, withTx } from '../services/tx';

/**
 * S2-17a — provisioning a person into one of the suite's apps.
 *
 * The apps taken into the suite keep their own user tables, and the platform
 * is where a person is created once. These three routes are the seam: they
 * create or take the platform account, grant the tile, record which user in
 * the app that account is, and — for the OTO App, which lives in a schema of
 * the same database — create that user if it does not exist yet. All of it in
 * one transaction, because every partial outcome is a broken grant: an
 * account with no user in the app is a tile that opens onto a refusal, a user
 * in the app with no account is somebody nobody can reach.
 *
 * The app's own schema is touched only through `services/oto-app-users.ts`,
 * which is where the boundary and its reasons are written down. Apps that are
 * not on this database (and the apps that are this platform) still supply the
 * id they already minted.
 *
 * `admin:role:assign` guards the writes rather than a permission of their
 * own: what these routes change is what an account may reach, which is the
 * question that permission already answers. Creating an account along the
 * way needs `admin:account:create` as well, checked where it happens.
 */
export async function appIdentityRoutes(app: App): Promise<void> {
  const AppParam = z.enum(HANDOFF_AUDIENCES);

  /**
   * You cannot hand out — or take away — access to an app you could not open
   * yourself. The same rule as granting a role, applied to the single
   * permission this grant carries, and checked before anything is written.
   */
  const assertMayGrant = (
    effective: EffectivePermission[],
    operatorId: string,
    target: HandoffApp,
  ): void => {
    const permission = appAccessPermission(target);
    if (!hasPermission(effective, permission, { operatorId })) {
      throw accessErrors.roleNotDominated(permission);
    }
  };

  app.post(
    '/:app/users',
    {
      config: { permission: 'admin:role:assign' },
      schema: {
        description: "Link a platform account to a user in one of the suite's apps",
        params: z.object({ app: AppParam }),
        body: z.object({
          /**
           * The id the app knows the person by — `otoapp.users.id` for
           * `oto_app`. Optional only for the OTO App, and only because that is
           * the app whose user this route can create: leave it out and `otoApp`
           * below says what to create, send it and that user is claimed.
           */
          externalUserId: z.string().min(1).optional(),
          /** An existing account, or the phone of one to find or create. */
          accountId: z.string().uuid().optional(),
          phone: z.string().optional(),
          name: z.string().min(1).optional(),
          /**
           * The branch this person is being provisioned at (SCRUM-268).
           * Optional: without it the seat comes from their employee record, and
           * failing that from the branch this session is standing at — the
           * order in `OtoAppSeatSource`. It decides which branch of the OTO App
           * they land in, and nothing else.
           */
          branchId: z.string().uuid().optional(),
          /**
           * What the OTO App's own user row needs. `role` is from that app's
           * vocabulary, not the platform's — the two describe different jobs.
           * `fullName` falls back to `name`, and then to the employee behind
           * an existing account.
           */
          otoApp: z
            .object({
              email: z.string().email(),
              fullName: z.string().min(1).optional(),
              role: z.enum(OTO_APP_USER_ROLES),
            })
            .optional(),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const target = req.params.app;
      assertMayGrant(await req.effectivePermissions(), auth.operatorId, target);

      /**
       * Only the OTO App's users can be created or stamped from here, because
       * only its tables are on this database. For every other app the id is
       * still something the caller has to have and the link is all this route
       * writes.
       */
      const isOtoApp = target === 'oto_app';
      const externalUserIdGiven = req.body.externalUserId ?? null;
      const otoAppUser = isOtoApp ? (req.body.otoApp ?? null) : null;
      if (!externalUserIdGiven && !isOtoApp) {
        throw errors.badRequest(`Name the ${target} user to link with externalUserId`);
      }
      if (!externalUserIdGiven && !otoAppUser) {
        throw errors.badRequest(
          'Name an existing OTO App user with externalUserId, or send otoApp to create one',
        );
      }

      if ((req.body.accountId && req.body.phone) || (!req.body.accountId && !req.body.phone)) {
        throw errors.badRequest('Name either an existing accountId or a phone to create one');
      }

      let accountId: string;
      let phone: string | null = null;
      let accountCreated = false;
      /** The name to put on a new app user when the request did not carry one. */
      let employeeName: string | null = null;
      if (req.body.accountId) {
        const existing = await loadTargetAccount(app.db, auth.operatorId, req.body.accountId);
        await assertDominatesAccount(
          app.db,
          await req.effectivePermissions(),
          auth.operatorId,
          existing.id,
        );
        accountId = existing.id;
        phone = existing.phone;
        if (existing.employeeId) {
          const [emp] = await app.db
            .select({ name: employee.name })
            .from(employee)
            .where(eq(employee.id, existing.employeeId))
            .limit(1);
          employeeName = emp?.name ?? null;
        }
      } else {
        phone = normalizePhone(req.body.phone!);
        if (!phone) throw errors.badRequest('Invalid phone number');
        const [existing] = await app.db
          .select()
          .from(account)
          .where(and(eq(account.operatorId, auth.operatorId), eq(account.phone, phone)))
          .limit(1);
        if (existing) {
          await assertDominatesAccount(
            app.db,
            await req.effectivePermissions(),
            auth.operatorId,
            existing.id,
          );
          accountId = existing.id;
        } else {
          // A separate act from granting access, so it carries its own
          // permission even though one request does both.
          await req.requirePermission('admin:account:create');
          accountId = newId();
          accountCreated = true;
        }
      }

      // Checked before the write so the answer names which half clashed. The
      // two unique indexes behind it catch the race and still answer 409. The
      // account is asked about first: "this account is already linked" is the
      // more useful answer when both are true.
      const [linkedAlready] = await app.db
        .select()
        .from(appIdentity)
        .where(and(eq(appIdentity.app, target), eq(appIdentity.accountId, accountId)))
        .limit(1);
      if (linkedAlready) {
        throw errors.conflict(
          'APP_IDENTITY_EXISTS',
          `That account is already linked to a user in ${target} — unlink it first`,
        );
      }
      if (externalUserIdGiven) {
        const [taken] = await app.db
          .select()
          .from(appIdentity)
          .where(
            and(eq(appIdentity.app, target), eq(appIdentity.externalUserId, externalUserIdGiven)),
          )
          .limit(1);
        if (taken) {
          throw errors.conflict(
            'APP_USER_TAKEN',
            `That ${target} user is already linked to another account`,
          );
        }
      }

      const identityId = newId();
      // Minted inside the transaction and delivered after it commits: an
      // invited account with no way to finish setup is an account nobody can
      // use, and a provider taking thirty seconds must not hold a
      // transaction open (see `deliverCode`).
      let pending: PendingCode | undefined;
      const linked = await withTx(app.db, opCtx(req), 'app_identity.link', async (tx) => {
        if (accountCreated) {
          let employeeId: string | null = null;
          if (req.body.name) {
            employeeId = newId();
            await tx
              .insert(employee)
              .values({ id: employeeId, operatorId: auth.operatorId, name: req.body.name, phone });
          }
          await tx.insert(account).values({
            id: accountId,
            operatorId: auth.operatorId,
            employeeId,
            phone: phone!,
            status: 'invited',
          });
          // `app.sms` so a twilio_verify anchor stores the marker (SCRUM-455);
          // `deliverCode` below starts the Verify challenge after the commit.
          pending = await mintCode(tx, accountId, phone!, 'setup', app.sms);
        }

        /**
         * The app's own user, inside the same transaction as the account and
         * the grant. Anything that fails after this point — the identity's
         * unique index, the grant, the audit row — takes the `otoapp.users`
         * row with it, which is the only way a failed request cannot leave a
         * user behind in an app that has no account to reach it.
         */
        let externalUserId: string;
        let appUserCreated = false;
        /**
         * Which branch of the OTO App the person was seated in, when this
         * request created their user there (SCRUM-268). Null on the link path,
         * where the user already existed and their branch access is whatever
         * the app already holds — this route does not move it.
         */
        let appBranch: OtoAppBranchPlacement | null = null;
        if (externalUserIdGiven) {
          if (isOtoApp) {
            const stamped = await linkOtoAppUser(tx, {
              userId: externalUserIdGiven,
              platformAccountId: accountId,
            });
            if (!stamped) {
              // Nothing was stamped, and the two reasons deserve different
              // answers: a user that is not there, or one that is already
              // somebody else's. A row carrying this same account matches the
              // update, so a request arriving twice never reaches here.
              const existing = await findOtoAppUser(tx, { id: externalUserIdGiven });
              throw existing
                ? errors.conflict(
                    'APP_USER_CLAIMED',
                    'That OTO App user is already another platform account — unlink that account first',
                  )
                : errors.notFound('The OTO App has no user with that id');
            }
          }
          externalUserId = externalUserIdGiven;
        } else if (otoAppUser) {
          const fullName = otoAppUser.fullName?.trim() || req.body.name?.trim() || employeeName;
          if (!fullName) {
            throw errors.badRequest('The OTO App user needs a name: send otoApp.fullName');
          }
          const created = await createOtoAppUser(tx, {
            platformAccountId: accountId,
            email: otoAppUser.email,
            fullName,
            role: otoAppUser.role,
            phoneE164: phone,
            branchId: req.body.branchId ?? null,
            sessionBranchId: auth.branchId,
          });
          externalUserId = created.id;
          appUserCreated = true;
          appBranch = created.branch;
        } else {
          // Unreachable: both were checked before anything was written.
          throw errors.badRequest('Name the app user to link, or the OTO App user to create');
        }

        // The identity goes in before the grant, so two requests racing the
        // same account collide on `app_identity_account_unique` — a 409 that
        // names this table — rather than on the role assignment's index.
        await tx.insert(appIdentity).values({
          id: identityId,
          app: target,
          accountId,
          externalUserId,
          createdBy: auth.accountId,
        });
        const roleId = await ensureAppAccessRole(tx, auth.operatorId, target);
        const accessGranted = await grantAppAccess(tx, accountId, roleId, auth.operatorId);
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          action: 'app_identity.link',
          entityType: 'app_identity',
          entityId: identityId,
          after: {
            app: target,
            accountId,
            externalUserId,
            accountCreated,
            appUserCreated,
            accessGranted,
            appBranch,
          },
          requestId: req.id,
        });
        return {
          id: identityId,
          app: target,
          accountId,
          externalUserId,
          accountCreated,
          /** Whether the app's own user row was made here, or taken as it was. */
          appUserCreated,
          /**
           * Where they landed in the OTO App's branch list, and when nowhere,
           * why — so the launcher can say "their branch access still has to be
           * set in the OTO App" rather than opening a tile onto an app that
           * answers every screen with nothing.
           */
          appBranch,
        };
      });
      // A replay of the same idempotency key answers with the stored link;
      // `codeSent` describes one attempt at delivery, not the record of it.
      return pending ? { ...linked, ...(await deliverCode(app.sms, pending, req.log)) } : linked;
    },
  );

  app.get(
    '/users/:accountId',
    {
      config: { permission: 'admin:role:read' },
      schema: {
        description: 'The app identities linked to one account',
        params: z.object({ accountId: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadTargetAccount(app.db, auth.operatorId, req.params.accountId);
      // What an account can reach is a permissions read, and those carry the
      // same dominance rule as `GET /accounts/:id/permissions`.
      await assertDominatesAccount(
        app.db,
        await req.effectivePermissions(),
        auth.operatorId,
        req.params.accountId,
      );
      const rows = await app.db
        .select()
        .from(appIdentity)
        .where(eq(appIdentity.accountId, req.params.accountId));
      const effective = await resolveEffectivePermissions(app.db, req.params.accountId);
      return {
        identities: rows.map((r) => ({
          id: r.id,
          app: r.app,
          externalUserId: r.externalUserId,
          createdBy: r.createdBy,
          createdAt: r.createdAt,
          /**
           * Whether the tile actually opens. A link and the grant behind it
           * are separate rows, and an administrator looking at this page
           * needs to see the two disagree rather than infer it.
           */
          hasAccess: hasPermission(effective, appAccessPermission(r.app), {
            operatorId: auth.operatorId,
          }),
        })),
      };
    },
  );

  app.delete(
    '/:app/users/:accountId',
    {
      config: { permission: 'admin:role:assign' },
      schema: {
        description: 'Unlink an account from an app and withdraw its access',
        params: z.object({ app: AppParam, accountId: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const target = req.params.app;
      await loadTargetAccount(app.db, auth.operatorId, req.params.accountId);
      assertMayGrant(await req.effectivePermissions(), auth.operatorId, target);
      await assertDominatesAccount(
        app.db,
        await req.effectivePermissions(),
        auth.operatorId,
        req.params.accountId,
      );
      const [existing] = await app.db
        .select()
        .from(appIdentity)
        .where(
          and(eq(appIdentity.app, target), eq(appIdentity.accountId, req.params.accountId)),
        )
        .limit(1);
      if (!existing) throw errors.notFound('That account is not linked to this app');

      return withTx(app.db, opCtx(req), 'app_identity.unlink', async (tx) => {
        await tx.delete(appIdentity).where(eq(appIdentity.id, existing.id));
        const accessRevoked = await revokeAppAccess(
          tx,
          req.params.accountId,
          auth.operatorId,
          target,
        );
        // The stamp goes with the link. Withdrawing the grant is not enough on
        // its own: someone whose own bundle also carries `app:oto_app:access`
        // keeps the tile, and a stamp left behind would still sign them in as
        // this user. The app's row itself stays — it is that app's record of a
        // person, not ours to delete.
        if (target === 'oto_app') {
          await unlinkOtoAppUser(tx, { platformAccountId: req.params.accountId });
        }
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          action: 'app_identity.unlink',
          entityType: 'app_identity',
          entityId: existing.id,
          before: existing,
          after: { accessRevoked },
          requestId: req.id,
        });
        return { ok: true as const, accessRevoked };
      });
    },
  );
}
