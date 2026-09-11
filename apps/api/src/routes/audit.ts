import { z } from 'zod';
import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { auditLog } from '@oto/db';
import type { App } from '../app';

/** SCRUM-14 — filtered, permission-guarded audit read. */
export async function auditRoutes(app: App): Promise<void> {
  app.get(
    '/',
    {
      schema: {
        description: 'Query the audit log',
        querystring: z.object({
          entityType: z.string().optional(),
          entityId: z.string().optional(),
          actorAccountId: z.string().uuid().optional(),
          branchId: z.string().uuid().optional(),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req) => {
      const auth = await req.requirePermission('admin:audit:read');
      const clauses: SQL[] = [eq(auditLog.operatorId, auth.operatorId)];
      const q = req.query;
      if (q.entityType) clauses.push(eq(auditLog.entityType, q.entityType));
      if (q.entityId) clauses.push(eq(auditLog.entityId, q.entityId));
      if (q.actorAccountId) clauses.push(eq(auditLog.actorAccountId, q.actorAccountId));
      if (q.branchId) clauses.push(eq(auditLog.branchId, q.branchId));
      if (q.from) clauses.push(gte(auditLog.createdAt, new Date(q.from)));
      if (q.to) clauses.push(lte(auditLog.createdAt, new Date(q.to)));
      const rows = await app.db
        .select()
        .from(auditLog)
        .where(and(...clauses))
        .orderBy(desc(auditLog.createdAt))
        .limit(q.limit);
      return {
        entries: rows.map((r) => ({
          id: r.id,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          actorAccountId: r.actorAccountId,
          branchId: r.branchId,
          requestId: r.requestId,
          before: r.before,
          after: r.after,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  );
}
