import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { account, employee, operator, role, roleAssignment } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { isPlatformWide } from '../services/permissions';
import { issueCode } from '../services/auth';

/** SCRUM-27 — platform admin: operators and their administrators. */
export async function operatorRoutes(app: App): Promise<void> {
  // Platform-wide gate: operator management needs a platform-wide assignment.
  const requirePlatform = async (req: import('fastify').FastifyRequest) => {
    const auth = req.requireAuth();
    const effective = await req.effectivePermissions();
    if (!isPlatformWide(effective)) throw errors.forbidden('Platform administrator only');
    return auth;
  };

  app.get(
    '/',
    { config: { platformWide: true }, schema: { description: 'List operators (archived hidden by default)' } },
    async (req) => {
      await requirePlatform(req);
      const rows = await app.db.select().from(operator).where(isNull(operator.archivedAt));
      return { operators: rows.map((o) => ({ id: o.id, name: o.name })) };
    },
  );

  app.post(
    '/',
    {
      config: { platformWide: true },
      schema: { description: 'Create an operator', body: z.object({ name: z.string().min(1) }) },
    },
    async (req) => {
      const auth = await requirePlatform(req);
      const id = newId();
      await app.db.insert(operator).values({ id, name: req.body.name });
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: id,
        action: 'operator.create',
        entityType: 'operator',
        entityId: id,
        after: { name: req.body.name },
        requestId: req.id,
      });
      return { id };
    },
  );

  app.patch(
    '/:id',
    {
      config: { platformWide: true },
      schema: {
        description: 'Rename or archive/unarchive an operator',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ name: z.string().min(1).optional(), archived: z.boolean().optional() }).strict(),
      },
    },
    async (req) => {
      const auth = await requirePlatform(req);
      const [before] = await app.db.select().from(operator).where(eq(operator.id, req.params.id)).limit(1);
      if (!before) throw errors.notFound('Operator not found');
      const patch: Partial<typeof operator.$inferInsert> = {};
      if (req.body.name !== undefined) patch.name = req.body.name;
      if (req.body.archived !== undefined) patch.archivedAt = req.body.archived ? new Date() : null;
      const [after] = await app.db.update(operator).set(patch).where(eq(operator.id, req.params.id)).returning();
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: req.params.id,
        action: 'operator.update',
        entityType: 'operator',
        entityId: req.params.id,
        before,
        after,
        requestId: req.id,
      });
      return { ok: true };
    },
  );

  // Assign an operator administrator: invited account + operator_admin role.
  app.post(
    '/:id/administrators',
    {
      config: { platformWide: true },
      schema: {
        description: 'Create/assign an operator administrator',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ phone: z.string(), name: z.string().min(1) }),
      },
    },
    async (req) => {
      const auth = await requirePlatform(req);
      const phone = normalizePhone(req.body.phone);
      if (!phone) throw errors.badRequest('Invalid phone number');
      const [op] = await app.db.select().from(operator).where(eq(operator.id, req.params.id)).limit(1);
      if (!op || op.archivedAt) throw errors.notFound('Operator not found');

      const employeeId = newId();
      await app.db
        .insert(employee)
        .values({ id: employeeId, operatorId: req.params.id, name: req.body.name, phone });
      const accountId = newId();
      await app.db
        .insert(account)
        .values({ id: accountId, operatorId: req.params.id, employeeId, phone, status: 'invited' });
      // The system role, not an operator's own role of the same name: roles
      // are unique per operator since S2-01b, so the name alone is ambiguous.
      const [adminRole] = await app.db
        .select()
        .from(role)
        .where(and(eq(role.name, 'operator_admin'), isNull(role.operatorId)))
        .limit(1);
      if (!adminRole) throw errors.badRequest('operator_admin role missing — seed the database');
      await app.db.insert(roleAssignment).values({
        id: newId(),
        accountId,
        roleId: adminRole.id,
        scopeType: 'operator',
        scopeId: req.params.id,
      });
      await issueCode(app.db, app.sms, accountId, phone, 'setup', req.id);
      await audit.record(app.db, {
        actorAccountId: auth.accountId,
        operatorId: req.params.id,
        action: 'operator.assign_admin',
        entityType: 'account',
        entityId: accountId,
        after: { phone, name: req.body.name },
        requestId: req.id,
      });
      return { accountId };
    },
  );
}
