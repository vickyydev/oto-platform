import { z } from 'zod';
import { ACCOUNT_STATUSES, SCOPE_TYPES } from '@oto/db';
import { PERMISSIONS } from '@oto/shared/permissions';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { permissionHolders, previewRoleChange, roleCatalogue } from '../services/roles';

const uuid = z.string().uuid();
const inputUuid = uuid.transform((id) => id.toLowerCase());
const permissionWords = z.object({ permission: z.string(), words: z.string() });
const effectivePermission = permissionWords.extend({ scopeType: z.enum(SCOPE_TYPES), scopeId: uuid.nullable() });
const previewQuery = z.object({
  accountId: inputUuid, operation: z.enum(['grant', 'remove']), roleName: z.string().optional(),
  scopeType: z.enum(SCOPE_TYPES).optional(), scopeId: inputUuid.optional(), assignmentId: inputUuid.optional(),
});

export async function roleRoutes(app: App): Promise<void> {
  app.get('/', {
    config: { permission: 'admin:role:read' },
    schema: {
      description: 'System roles and this operator’s role catalogue, with permission sentences. Read-only; no role editor.',
      querystring: z.object({}),
      response: { 200: z.object({
        roles: z.array(z.object({ id: uuid, name: z.string(), description: z.string().nullable(), system: z.boolean(), permissions: z.array(permissionWords) })),
        permissions: z.array(permissionWords),
      }) },
    },
  }, async (req) => {
    const auth = req.requireAuth();
    return roleCatalogue(app.db, auth.operatorId);
  });

  app.get('/holders', {
    config: { permission: 'admin:role:read' },
    schema: {
      description: 'Who holds one permission, within this operator, the caller’s readable account reach and readable/dominated assignment scopes. Unsupported record scopes are omitted because no owned record target exists.',
      querystring: z.object({ permission: z.enum(PERMISSIONS) }),
      response: { 200: permissionWords.extend({ holders: z.array(z.object({
        accountId: uuid, phone: z.string(), status: z.enum(ACCOUNT_STATUSES),
        employee: z.object({ id: uuid, name: z.string() }).nullable(),
        assignments: z.array(z.object({ id: uuid, roleName: z.string(), scopeType: z.enum(SCOPE_TYPES), scopeId: uuid.nullable(), scopeName: z.string() })),
      })) }) },
    },
  }, async (req) => {
    const auth = req.requireAuth();
    return permissionHolders(app.db, { operatorId: auth.operatorId, effective: await req.effectivePermissions() }, req.query.permission);
  });

  app.get('/preview', {
    config: { permission: 'admin:role:read' },
    schema: {
      description: 'Read-only effective-permission before-save preview. Requires the existing permission-read and assignment-write checks, including last-admin protection. Grant needs roleName and scopeType (omit scopeId only for whole-platform operator scope); remove needs assignmentId. Before/after omit redundant narrower grants. Added/removed compare effective coverage, preserving access provided by another role or wider grant; unchanged lists resulting grants already covered before. The actual write rechecks everything.',
      querystring: previewQuery,
      response: { 200: z.object({
        accountId: uuid, operation: z.enum(['grant', 'remove']),
        before: z.array(effectivePermission), after: z.array(effectivePermission), added: z.array(effectivePermission),
        removed: z.array(effectivePermission), unchanged: z.array(effectivePermission),
      }) },
    },
  }, async (req) => {
    const auth = await req.requirePermission('admin:role:assign');
    const q = req.query;
    const reader = { operatorId: auth.operatorId, effective: await req.effectivePermissions() };
    if (q.operation === 'grant') {
      if (!q.roleName || !q.scopeType || (q.scopeType !== 'operator' && !q.scopeId) || q.assignmentId) {
        throw errors.badRequest('A grant preview needs roleName, scopeType and its scopeId');
      }
      return previewRoleChange(app.db, reader, {
        accountId: q.accountId, operation: 'grant', roleName: q.roleName, scopeType: q.scopeType, scopeId: q.scopeId ?? null,
      });
    }
    if (!q.assignmentId || q.roleName !== undefined || q.scopeType !== undefined || q.scopeId !== undefined) {
      throw errors.badRequest('A removal preview needs only accountId, operation and assignmentId');
    }
    return previewRoleChange(app.db, reader, { accountId: q.accountId, operation: 'remove', assignmentId: q.assignmentId });
  });
}
