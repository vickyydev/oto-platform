import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, desc, eq, or, type SQL } from 'drizzle-orm';
import { account, employee, role, roleAssignment, session } from '@oto/db';
import { newId, normalizePhone, type Permission } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { atBranch } from '../lib/staff-scope';
import { audit } from '../services/audit';
import { ClientIdSchema, REPLAY_HEADER, claimClientId } from '../services/client-id';
import { opCtx, withTx } from '../services/tx';
import { deliverCode, invalidateAllSessions, mintCode, type PendingCode } from '../services/auth';
import { resolveEffectivePermissions, type EffectivePermission } from '../services/permissions';
import {
  assertDominatesAccount,
  assertNotLastOperatorAdmin,
  assertRoleDominated,
  assertScopeOwned,
  branchReach,
  loadRoleForOperator,
  loadTargetAccount,
  outOfBranchScope,
} from '../services/access-control';

const RoleAssignmentInput = z.object({
  roleName: z.string(),
  scopeType: z.enum(['operator', 'branch', 'department', 'record']),
  scopeId: z.string().uuid().nullable(),
});

/**
 * SCRUM-249 — WHICH PEOPLE ARE THIS CALLER'S TO LOOK AT.
 *
 * An account has no branch column, so "who works at this branch" has no single
 * answer in the schema. Rather than invent a second one here, this reuses
 * `atBranch` — the same predicate the fleet's station picker and the box's
 * offline password cache already use: somebody whose employee record says they
 * work here, somebody granted a role scoped here, or somebody who administers
 * the whole operator.
 *
 * A null `filter` with `empty` false means no filter at all — an operator
 * administrator goes on seeing every account. `empty` means the caller holds
 * the permission at no branch, so the answer is nothing rather than everything.
 *
 * SCRUM-266 takes the permission as an argument rather than assuming
 * `admin:account:read`. Reading a colleague's list and taking their account
 * over are different grants, and the reach has to be the reach of the one the
 * route is actually exercising: an account may be read at a branch where it
 * may not be rewritten.
 */
function accountScopeFilter(
  effective: EffectivePermission[],
  operatorId: string,
  permission: Permission,
): { filter: SQL | null; empty: boolean } {
  const reach = branchReach(effective, permission, operatorId);
  if (reach.kind === 'operator') return { filter: null, empty: false };
  if (reach.branchIds.length === 0) return { filter: null, empty: true };
  // `or` over one clause returns that clause, so the single-branch manager —
  // which is every branch manager today — gets exactly `atBranch(theirs)`.
  return { filter: or(...reach.branchIds.map((id) => atBranch(id)))!, empty: false };
}

export async function accountRoutes(app: App): Promise<void> {
  /**
   * The same question asked about ONE account, for the routes that take an id.
   * The join is the one `atBranch` reads `employee.branch_id` through; without
   * it the predicate is a SQL error rather than a quietly wrong answer.
   *
   * **SCRUM-266 — why this is on the write surface and not only on the reads.**
   *
   * Every by-id route here was fenced by `assertDominatesAccount` alone, which
   * walks the roles the TARGET holds and refuses if the caller does not hold
   * each of them at a covering scope. Against a colleague with a role it is a
   * strong check. Against a new hire who has an account and no role yet it
   * walks an empty list and returns — there is nothing to fail on — so a
   * manager at one park could issue that hire a working temporary password at
   * the other, change their phone, deactivate them, end their sessions and
   * then grant them a role at their own branch. Dominance answers "is the
   * target above you"; it was never asked "is the target yours", and for a
   * roleless target those are not the same question.
   *
   * So both, in this order: the branch tie first, because it is the one that
   * holds when the target has no roles, then dominance, because it is the one
   * that holds when the target has too many.
   */
  const assertAccountInScope = async (
    effective: EffectivePermission[],
    operatorId: string,
    accountId: string,
    permission: Permission,
  ): Promise<void> => {
    const { filter, empty } = accountScopeFilter(effective, operatorId, permission);
    if (!filter && !empty) return;
    const rows = empty
      ? []
      : await app.db
          .select({ id: account.id })
          .from(account)
          .leftJoin(employee, eq(account.employeeId, employee.id))
          .where(and(eq(account.id, accountId), eq(account.operatorId, operatorId), filter!))
          .limit(1);
    if (rows.length === 0) {
      throw outOfBranchScope('That account is not at a branch you manage');
    }
  };

  // SCRUM-28 — search/list login users.
  app.get(
    '/',
    {
      config: { permission: 'admin:account:read' },
      schema: {
        description: 'List/search accounts the caller may see (branch-scoped unless operator-wide)',
        querystring: z.object({ q: z.string().optional() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      // SCRUM-249 — this used to filter by operator and nothing else, so a
      // manager of one branch read every colleague in the operator, phone
      // numbers included, by opening the Login Users panel.
      const { filter, empty } = accountScopeFilter(
        await req.effectivePermissions(),
        auth.operatorId,
        'admin:account:read',
      );
      if (empty) return { accounts: [] };
      const filters: SQL[] = [eq(account.operatorId, auth.operatorId)];
      if (filter) filters.push(filter);
      const rows = await app.db
        .select({ a: account, e: employee })
        .from(account)
        .leftJoin(employee, eq(account.employeeId, employee.id))
        .where(and(...filters));
      const q = req.query.q?.toLowerCase();
      const list = rows
        .filter(
          (r) =>
            !q ||
            r.a.phone.toLowerCase().includes(q) ||
            (r.e?.name ?? '').toLowerCase().includes(q) ||
            (r.e?.nickname ?? '').toLowerCase().includes(q),
        )
        .map((r) => ({
          id: r.a.id,
          phone: r.a.phone,
          status: r.a.status,
          mustChangePassword: r.a.mustChangePassword,
          employee: r.e ? { id: r.e.id, name: r.e.name } : null,
        }));
      return { accounts: list };
    },
  );

  // SCRUM-21 — create an account (optionally linked to / creating an employee),
  // assign scoped roles, and issue the setup invitation code via the SMS adapter.
  app.post(
    '/',
    {
      config: { permission: 'admin:account:create' },
      schema: {
        description:
          'Create a staff account and assign scoped roles. An optional body id names the account ' +
          '(SCRUM-270): the same id again answers with that account under x-oto-replay; an id ' +
          'already naming another record is refused 409 ID_IN_USE.',
        body: z.object({
          /** Optional, client-minted (OD-12). Absent, the platform mints one as before. */
          id: ClientIdSchema.optional(),
          phone: z.string(),
          employeeId: z.string().uuid().optional(),
          employeeName: z.string().min(1).optional(),
          roles: z.array(RoleAssignmentInput).default([]),
        }),
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const phone = normalizePhone(req.body.phone);
      if (!phone) throw errors.badRequest('Invalid phone number');

      // Before the phone check: a replay's phone is its own account's, and the
      // phone check would otherwise refuse the account for existing.
      const claim = await claimClientId(
        req.body.id,
        async (id) => (await app.db.select().from(account).where(eq(account.id, id)).limit(1))[0],
        (row) => row.operatorId === auth.operatorId,
      );
      if (claim.replay) {
        // Answered only to a caller who may see that account (SCRUM-249), and
        // with what the stored answer of the first attempt carries: the id and
        // the status, never the setup code.
        await assertAccountInScope(
          await req.effectivePermissions(),
          auth.operatorId,
          claim.id,
          'admin:account:create',
        );
        reply.header(REPLAY_HEADER, 'true');
        return { id: claim.row.id, status: claim.row.status };
      }

      const [existing] = await app.db
        .select()
        .from(account)
        .where(and(eq(account.operatorId, auth.operatorId), eq(account.phone, phone)))
        .limit(1);
      // Same code the unique-violation mapper produces on the racing path.
      if (existing) {
        throw errors.conflict('ACCOUNT_PHONE_EXISTS', 'An account with this phone already exists');
      }

      // Every requested role is checked BEFORE anything is written, so a
      // refused grant cannot leave a half-created account behind.
      const callerEffective = await req.effectivePermissions();
      const resolved: { roleId: string; scopeType: (typeof req.body.roles)[number]['scopeType']; scopeId: string | null }[] = [];
      for (const r of req.body.roles) {
        const roleRow = await loadRoleForOperator(app.db, auth.operatorId, r.roleName);
        const scope = { scopeType: r.scopeType, scopeId: r.scopeId };
        await assertScopeOwned(app.db, callerEffective, auth.operatorId, scope);
        await assertRoleDominated(app.db, callerEffective, auth.operatorId, roleRow.id, scope);
        resolved.push({ roleId: roleRow.id, ...scope });
      }

      // Employee, account, role assignments, the setup code and the audit row
      // are one operation: a failure at any point leaves no trace of it. The
      // SMS is not part of it — see below.
      const id = claim.id;
      // Assigned inside the transaction; the code it carries deliberately
      // never joins the value that transaction returns, because `withTx`
      // stores that value in `idempotency_key.response_body`.
      let pending!: PendingCode;
      const created = await withTx(app.db, opCtx(req), 'account.create', async (tx) => {
        let employeeId = req.body.employeeId ?? null;
        if (!employeeId && req.body.employeeName) {
          employeeId = newId();
          await tx.insert(employee).values({
            id: employeeId,
            operatorId: auth.operatorId,
            name: req.body.employeeName,
            phone,
          });
        }
        await tx.insert(account).values({ id, operatorId: auth.operatorId, employeeId, phone, status: 'invited' });
        for (const r of resolved) {
          await tx.insert(roleAssignment).values({
            id: newId(),
            accountId: id,
            roleId: r.roleId,
            scopeType: r.scopeType,
            scopeId: r.scopeId,
          });
        }
        // `app.sms` so a twilio_verify anchor stores the marker (SCRUM-455);
        // `deliverCode` below starts the Verify challenge after the commit.
        pending = await mintCode(tx, id, phone, 'setup', app.sms);
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          action: 'account.create',
          entityType: 'account',
          entityId: id,
          after: { phone, employeeId, roles: req.body.roles },
          requestId: req.id,
        });
        return { id, status: 'invited' as const };
      });
      // Committed first, sent second. The account is real whatever the
      // provider does next, so a failed send is reported in the answer
      // instead of thrown — `deliverCode` explains why a 5xx would be the
      // wrong one. A replay of the same idempotency key answers with the
      // stored `{ id, status }`: the warning belongs to the attempt that did
      // the work, not to the record of it.
      return { ...created, ...(await deliverCode(app.sms, pending, req.log)) };
    },
  );

  // SCRUM-22 — an account's assignments + the resulting effective permissions.
  app.get(
    '/:id/permissions',
    { config: { permission: 'admin:role:read' }, schema: { description: 'Roles and effective permissions', params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const auth = req.requireAuth();
      await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      // SCRUM-266 — an account's roles and effective permissions say where in
      // the estate that person can act, which is not a manager's to read about
      // somebody at another park.
      const callerEffective = await req.effectivePermissions();
      await assertAccountInScope(callerEffective, auth.operatorId, req.params.id, 'admin:role:read');
      await assertDominatesAccount(app.db, callerEffective, auth.operatorId, req.params.id);
      const assignments = await app.db
        .select({ ra: roleAssignment, roleName: role.name })
        .from(roleAssignment)
        .innerJoin(role, eq(roleAssignment.roleId, role.id))
        .where(eq(roleAssignment.accountId, req.params.id));
      const effective = await resolveEffectivePermissions(app.db, req.params.id);
      return {
        assignments: assignments.map((a) => ({
          id: a.ra.id,
          roleName: a.roleName,
          scopeType: a.ra.scopeType,
          scopeId: a.ra.scopeId,
        })),
        effective,
      };
    },
  );

  // SCRUM-22 — add / remove role assignments.
  app.post(
    '/:id/role-assignments',
    {
      config: { permission: 'admin:role:assign' },
      schema: {
        description:
          'Assign a role with a scope. An optional body id names the assignment (SCRUM-270): the ' +
          'same id again answers with it under x-oto-replay; an id naming another record is ' +
          'refused 409 ID_IN_USE.',
        params: z.object({ id: z.string().uuid() }),
        body: RoleAssignmentInput.extend({
          /** Optional, client-minted (OD-12). Absent, the platform mints one as before. */
          id: ClientIdSchema.optional(),
        }),
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      const roleRow = await loadRoleForOperator(app.db, auth.operatorId, req.body.roleName);
      const scope = { scopeType: req.body.scopeType, scopeId: req.body.scopeId };
      const callerEffective = await req.effectivePermissions();
      /**
       * SCRUM-266 — WHO, before WHAT.
       *
       * The two checks below fence the grant: `assertScopeOwned` that the
       * scope belongs to this operator, `assertRoleDominated` that the caller
       * holds everything the role carries there. Both are about the role. A
       * manager granting `reception` at their OWN branch passes both — and the
       * register's reproduction did exactly that, to a roleless hire who works
       * at the other park, which is how somebody at one park acquires a login
       * at another. The person has to be the caller's before the grant is
       * considered.
       */
      await assertAccountInScope(callerEffective, auth.operatorId, req.params.id, 'admin:role:assign');
      await assertScopeOwned(app.db, callerEffective, auth.operatorId, scope);
      await assertRoleDominated(app.db, callerEffective, auth.operatorId, roleRow.id, scope);
      // After every check above, so a replay is answered only to a caller who
      // could have made this grant. An assignment belongs to its account, which
      // `loadTargetAccount` placed inside the caller's operator.
      const claim = await claimClientId(
        req.body.id,
        async (id) =>
          (await app.db.select().from(roleAssignment).where(eq(roleAssignment.id, id)).limit(1))[0],
        (row) => row.accountId === req.params.id,
      );
      if (claim.replay) {
        reply.header(REPLAY_HEADER, 'true');
        return { id: claim.id };
      }
      const id = claim.id;
      const grant = {
        roleName: req.body.roleName,
        scopeType: req.body.scopeType,
        scopeId: req.body.scopeId,
      };
      return withTx(app.db, opCtx(req), 'role_assignment.create', async (tx) => {
        await tx.insert(roleAssignment).values({
          id,
          accountId: req.params.id,
          roleId: roleRow.id,
          scopeType: req.body.scopeType,
          scopeId: req.body.scopeId,
        });
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          action: 'role_assignment.create',
          entityType: 'role_assignment',
          entityId: id,
          after: { accountId: req.params.id, ...grant },
          requestId: req.id,
        });
        return { id };
      });
    },
  );

  app.delete(
    '/:id/role-assignments/:assignmentId',
    {
      config: { permission: 'admin:role:assign' },
      schema: {
        description: 'Remove a role assignment',
        params: z.object({ id: z.string().uuid(), assignmentId: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      const [before] = await app.db
        .select()
        .from(roleAssignment)
        .where(eq(roleAssignment.id, req.params.assignmentId))
        .limit(1);
      if (!before || before.accountId !== req.params.id) throw errors.notFound('Assignment not found');
      // Removing a role is as privileged as granting it: you cannot strip a
      // role you could not have handed out, and (SCRUM-266) you cannot strip
      // one from somebody who is not yours to administer. Taking a colleague
      // at another park off their own till is as much a takeover as granting.
      const effective = await req.effectivePermissions();
      await assertAccountInScope(effective, auth.operatorId, req.params.id, 'admin:role:assign');
      await assertRoleDominated(app.db, effective, auth.operatorId, before.roleId, {
        scopeType: before.scopeType,
        scopeId: before.scopeId,
      });
      // And it must not be the grant the operator's remaining access hangs
      // off — removing a role is the half of SCRUM-239 that already worked,
      // and it worked all the way to a locked-out operator.
      await assertNotLastOperatorAdmin(app.db, auth.operatorId, {
        accountId: req.params.id,
        assignmentId: req.params.assignmentId,
      });
      return withTx(app.db, opCtx(req), 'role_assignment.delete', async (tx) => {
        await tx.delete(roleAssignment).where(eq(roleAssignment.id, req.params.assignmentId));
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          action: 'role_assignment.delete',
          entityType: 'role_assignment',
          entityId: req.params.assignmentId,
          before,
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  // SCRUM-28 — activate / deactivate; edit phone.
  app.patch(
    '/:id',
    {
      config: { permission: 'admin:account:update' },
      schema: {
        description: 'Update an account (activate/deactivate, phone)',
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({ status: z.enum(['active', 'inactive']).optional(), phone: z.string().optional() })
          .strict(),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const before = await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      // SCRUM-266 — a phone number is how somebody signs in and where their
      // reset codes land; `inactive` is the end of their working day. Both are
      // refused for anybody who is not at a branch this caller manages.
      const effective = await req.effectivePermissions();
      await assertAccountInScope(effective, auth.operatorId, req.params.id, 'admin:account:update');
      await assertDominatesAccount(app.db, effective, auth.operatorId, req.params.id);
      // Deactivation takes every grant the account holds with it, so it can
      // empty the operator's administrator set exactly as a removal can.
      if (req.body.status === 'inactive') {
        await assertNotLastOperatorAdmin(app.db, auth.operatorId, { accountId: req.params.id });
      }
      const patch: Partial<typeof account.$inferInsert> = {};
      if (req.body.status) patch.status = req.body.status;
      if (req.body.phone) {
        const p = normalizePhone(req.body.phone);
        if (!p) throw errors.badRequest('Invalid phone number');
        patch.phone = p;
      }
      // Deactivating also ends every session: the change and the eviction
      // must not be able to come apart.
      return withTx(app.db, opCtx(req), 'account.update', async (tx) => {
        const [after] = await tx.update(account).set(patch).where(eq(account.id, req.params.id)).returning();
        if (req.body.status === 'inactive') await invalidateAllSessions(tx, req.params.id, 'deactivated');
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          action: 'account.update',
          entityType: 'account',
          entityId: req.params.id,
          before: { status: before.status, phone: before.phone },
          after: { status: after?.status, phone: after?.phone },
          requestId: req.id,
        });
        return { ok: true as const };
      });
    },
  );

  // SCRUM-28 — temporary password forcing a change at next sign-in.
  app.post(
    '/:id/temp-password',
    {
      // The answer is a working password for somebody else's account, so it
      // never enters the replay store — it was being kept there for a day.
      config: { permission: 'admin:account:update', secretResponse: true },
      schema: { description: 'Issue a temporary password', params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const auth = req.requireAuth();
      const acc = await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      /**
       * A temporary password is a full takeover of that account, so both gates
       * apply: the account must be at a branch this caller manages
       * (SCRUM-266 — dominance alone let a manager at one park mint a working
       * password for a roleless new hire at the other), and the caller must
       * dominate every role it holds.
       */
      const effective = await req.effectivePermissions();
      await assertAccountInScope(effective, auth.operatorId, req.params.id, 'admin:account:update');
      await assertDominatesAccount(app.db, effective, auth.operatorId, req.params.id);
      const temp = randomBytes(6).toString('base64url'); // 8 chars
      const passwordHash = await hash(temp);
      // The new password, the forced change and the eviction of every live
      // session are one act of taking the account over.
      return withTx(app.db, opCtx(req), 'account.temp_password', async (tx) => {
        await tx
          .update(account)
          .set({
            passwordHash,
            mustChangePassword: true,
            status: acc.status === 'invited' ? 'active' : acc.status,
            phoneVerifiedAt: acc.phoneVerifiedAt ?? new Date(),
          })
          .where(eq(account.id, req.params.id));
        await invalidateAllSessions(tx, req.params.id, 'temp_password');
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          action: 'account.temp_password',
          entityType: 'account',
          entityId: req.params.id,
          requestId: req.id,
        });
        return { temporaryPassword: temp };
      });
    },
  );

  // S2-01a — the sessions an account currently holds, for the Login Users panel.
  app.get(
    '/:id/sessions',
    { config: { permission: 'admin:account:read' }, schema: { description: 'Sessions held by an account', params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const auth = req.requireAuth();
      await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      /**
       * SCRUM-249 — the branch scope, and the dominance check every sibling
       * route had and this one was written without.
       *
       * A session row says which branch and which station somebody is signed
       * in at and when they were last seen there, which is a colleague's
       * working day. Scope first, then dominance: dominance alone passes
       * vacuously for an account that holds no roles at all.
       */
      const effective = await req.effectivePermissions();
      await assertAccountInScope(effective, auth.operatorId, req.params.id, 'admin:account:read');
      await assertDominatesAccount(app.db, effective, auth.operatorId, req.params.id);
      const rows = await app.db
        .select()
        .from(session)
        .where(eq(session.accountId, req.params.id))
        .orderBy(desc(session.lastSeenAt));
      return {
        sessions: rows.map((s) => ({
          id: s.id,
          branchId: s.branchId,
          stationId: s.stationId,
          lockedAt: s.lockedAt,
          lastSeenAt: s.lastSeenAt,
          expiresAt: s.expiresAt,
          createdAt: s.createdAt,
        })),
      };
    },
  );

  // S2-01a — "Sign out everywhere": end every session this account holds.
  // Deliberately separate from deactivation: a manager may need to evict a
  // forgotten till without disabling the person's account.
  app.post(
    '/:id/sessions/revoke',
    {
      config: { permission: 'admin:account:update' },
      schema: {
        description: 'Force sign-out: end every session this account holds',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      // SCRUM-266 — ending somebody's sessions puts them off the till they are
      // standing at. A manager may do that at their own park only.
      const effective = await req.effectivePermissions();
      await assertAccountInScope(effective, auth.operatorId, req.params.id, 'admin:account:update');
      await assertDominatesAccount(app.db, effective, auth.operatorId, req.params.id);
      // Revoked, not deleted: "who was evicted, when and by whom" has to
      // survive for audit, and loadAuth refuses a revoked session anyway.
      return withTx(app.db, opCtx(req), 'session.force_sign_out', async (tx) => {
        const ended = await invalidateAllSessions(tx, req.params.id, 'force_sign_out');
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          action: 'session.force_sign_out',
          entityType: 'account',
          entityId: req.params.id,
          after: { sessionsEnded: ended },
          requestId: req.id,
        });
        return { sessionsEnded: ended };
      });
    },
  );
}
