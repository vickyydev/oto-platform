import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, desc, eq } from 'drizzle-orm';
import { account, employee, role, roleAssignment, session } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { invalidateAllSessions, issueCode } from '../services/auth';
import { resolveEffectivePermissions } from '../services/permissions';
import {
  assertDominatesAccount,
  assertRoleDominated,
  assertScopeOwned,
  loadRoleForOperator,
  loadTargetAccount,
} from '../services/access-control';

const RoleAssignmentInput = z.object({
  roleName: z.string(),
  scopeType: z.enum(['operator', 'branch', 'department', 'record']),
  scopeId: z.string().uuid().nullable(),
});

export async function accountRoutes(app: App): Promise<void> {
  // SCRUM-28 — search/list login users.
  app.get(
    '/',
    {
      schema: {
        description: 'List/search accounts',
        querystring: z.object({ q: z.string().optional() }),
      },
    },
    async (req) => {
      const auth = await req.requirePermission('admin:account:read');
      const filters = [eq(account.operatorId, auth.operatorId)];
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
      schema: {
        description: 'Create a staff account and assign scoped roles',
        body: z.object({
          phone: z.string(),
          employeeId: z.string().uuid().optional(),
          employeeName: z.string().min(1).optional(),
          roles: z.array(RoleAssignmentInput).default([]),
        }),
      },
    },
    async (req) => {
      const auth = await req.requirePermission('admin:account:create');
      const phone = normalizePhone(req.body.phone);
      if (!phone) throw errors.badRequest('Invalid phone number');

      const [existing] = await app.db
        .select()
        .from(account)
        .where(and(eq(account.operatorId, auth.operatorId), eq(account.phone, phone)))
        .limit(1);
      if (existing) throw errors.conflict('ACCOUNT_EXISTS', 'An account with this phone already exists');

      let employeeId = req.body.employeeId ?? null;
      if (!employeeId && req.body.employeeName) {
        employeeId = newId();
        await app.db.insert(employee).values({
          id: employeeId,
          operatorId: auth.operatorId,
          name: req.body.employeeName,
          phone,
        });
      }

      // Every requested role is checked BEFORE the account exists, so a
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

      const id = newId();
      await app.db.insert(account).values({ id, operatorId: auth.operatorId, employeeId, phone, status: 'invited' });

      for (const r of resolved) {
        await app.db.insert(roleAssignment).values({
          id: newId(),
          accountId: id,
          roleId: r.roleId,
          scopeType: r.scopeType,
          scopeId: r.scopeId,
        });
      }

      await issueCode(app.db, app.sms, id, phone, 'setup', req.id);
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        action: 'account.create',
        entityType: 'account',
        entityId: id,
        after: { phone, employeeId, roles: req.body.roles },
        requestId: req.id,
      });
      return { id, status: 'invited' };
    },
  );

  // SCRUM-22 — an account's assignments + the resulting effective permissions.
  app.get(
    '/:id/permissions',
    { schema: { description: 'Roles and effective permissions', params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const auth = await req.requirePermission('admin:role:read');
      await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      await assertDominatesAccount(
        app.db,
        await req.effectivePermissions(),
        auth.operatorId,
        req.params.id,
      );
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
      schema: {
        description: 'Assign a role with a scope',
        params: z.object({ id: z.string().uuid() }),
        body: RoleAssignmentInput,
      },
    },
    async (req) => {
      const auth = await req.requirePermission('admin:role:assign');
      await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      const roleRow = await loadRoleForOperator(app.db, auth.operatorId, req.body.roleName);
      const scope = { scopeType: req.body.scopeType, scopeId: req.body.scopeId };
      const callerEffective = await req.effectivePermissions();
      await assertScopeOwned(app.db, callerEffective, auth.operatorId, scope);
      await assertRoleDominated(app.db, callerEffective, auth.operatorId, roleRow.id, scope);
      const id = newId();
      await app.db.insert(roleAssignment).values({
        id,
        accountId: req.params.id,
        roleId: roleRow.id,
        scopeType: req.body.scopeType,
        scopeId: req.body.scopeId,
      });
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        action: 'role_assignment.create',
        entityType: 'role_assignment',
        entityId: id,
        after: { accountId: req.params.id, ...req.body },
        requestId: req.id,
      });
      return { id };
    },
  );

  app.delete(
    '/:id/role-assignments/:assignmentId',
    {
      schema: {
        description: 'Remove a role assignment',
        params: z.object({ id: z.string().uuid(), assignmentId: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = await req.requirePermission('admin:role:assign');
      await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      const [before] = await app.db
        .select()
        .from(roleAssignment)
        .where(eq(roleAssignment.id, req.params.assignmentId))
        .limit(1);
      if (!before || before.accountId !== req.params.id) throw errors.notFound('Assignment not found');
      // Removing a role is as privileged as granting it: you cannot strip a
      // role you could not have handed out.
      await assertRoleDominated(
        app.db,
        await req.effectivePermissions(),
        auth.operatorId,
        before.roleId,
        { scopeType: before.scopeType, scopeId: before.scopeId },
      );
      await app.db.delete(roleAssignment).where(eq(roleAssignment.id, req.params.assignmentId));
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        action: 'role_assignment.delete',
        entityType: 'role_assignment',
        entityId: req.params.assignmentId,
        before,
        requestId: req.id,
      });
      return { ok: true };
    },
  );

  // SCRUM-28 — activate / deactivate; edit phone.
  app.patch(
    '/:id',
    {
      schema: {
        description: 'Update an account (activate/deactivate, phone)',
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({ status: z.enum(['active', 'inactive']).optional(), phone: z.string().optional() })
          .strict(),
      },
    },
    async (req) => {
      const auth = await req.requirePermission('admin:account:update');
      const before = await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      await assertDominatesAccount(
        app.db,
        await req.effectivePermissions(),
        auth.operatorId,
        req.params.id,
      );
      const patch: Partial<typeof account.$inferInsert> = {};
      if (req.body.status) patch.status = req.body.status;
      if (req.body.phone) {
        const p = normalizePhone(req.body.phone);
        if (!p) throw errors.badRequest('Invalid phone number');
        patch.phone = p;
      }
      const [after] = await app.db.update(account).set(patch).where(eq(account.id, req.params.id)).returning();
      if (req.body.status === 'inactive') await invalidateAllSessions(app.db, req.params.id);
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        action: 'account.update',
        entityType: 'account',
        entityId: req.params.id,
        before: { status: before.status, phone: before.phone },
        after: { status: after?.status, phone: after?.phone },
        requestId: req.id,
      });
      return { ok: true };
    },
  );

  // SCRUM-28 — temporary password forcing a change at next sign-in.
  app.post(
    '/:id/temp-password',
    { schema: { description: 'Issue a temporary password', params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const auth = await req.requirePermission('admin:account:update');
      const acc = await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      // A temporary password is a full takeover of that account: the caller
      // must dominate every role it holds.
      await assertDominatesAccount(
        app.db,
        await req.effectivePermissions(),
        auth.operatorId,
        req.params.id,
      );
      const temp = randomBytes(6).toString('base64url'); // 8 chars
      await app.db
        .update(account)
        .set({
          passwordHash: await hash(temp),
          mustChangePassword: true,
          status: acc.status === 'invited' ? 'active' : acc.status,
          phoneVerifiedAt: acc.phoneVerifiedAt ?? new Date(),
        })
        .where(eq(account.id, req.params.id));
      await invalidateAllSessions(app.db, req.params.id);
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        action: 'account.temp_password',
        entityType: 'account',
        entityId: req.params.id,
        requestId: req.id,
      });
      return { temporaryPassword: temp };
    },
  );

  // S2-01a — the sessions an account currently holds, for the Login Users panel.
  app.get(
    '/:id/sessions',
    { schema: { description: 'Sessions held by an account', params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const auth = await req.requirePermission('admin:account:read');
      await loadTargetAccount(app.db, auth.operatorId, req.params.id);
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
      schema: {
        description: 'Force sign-out: end every session this account holds',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = await req.requirePermission('admin:account:update');
      await loadTargetAccount(app.db, auth.operatorId, req.params.id);
      await assertDominatesAccount(
        app.db,
        await req.effectivePermissions(),
        auth.operatorId,
        req.params.id,
      );
      const ended = await app.db
        .delete(session)
        .where(eq(session.accountId, req.params.id))
        .returning({ id: session.id });
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: auth.operatorId,
        action: 'session.force_sign_out',
        entityType: 'account',
        entityId: req.params.id,
        after: { sessionsEnded: ended.length },
        requestId: req.id,
      });
      return { sessionsEnded: ended.length };
    },
  );
}
