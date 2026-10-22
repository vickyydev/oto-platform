import { z } from 'zod';
import type { App } from '../app';
import { listDepartments } from '../services/departments';

export async function departmentRoutes(app: App): Promise<void> {
  app.get('/', {
    config: { permission: 'admin:account:read' },
    schema: {
      description: 'Read-only current core departments, park and visible employee-link count. The existing account-read route gate checks the seated branch; authorized list and member reach come independently from admin:account:read grants. Operator-wide departments and branchless employees need operator-wide reach. Counts include archived employees, as the original department list does, and never widen through linked accounts or roles. Invalid foreign-operator park references are excluded from both departments and counts. Search matches visible department and park names. This read does not query or change the source app, its department mirror or copy job.',
      querystring: z.object({ q: z.string().optional() }),
      response: { 200: z.object({ departments: z.array(z.object({
        id: z.string().uuid(), name: z.string(),
        branch: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
        memberCount: z.number().int().nonnegative(),
      })) }) },
    },
  }, async (req) => {
    const auth = req.requireAuth();
    return listDepartments(app.db, { operatorId: auth.operatorId, effective: await req.effectivePermissions() }, req.query);
  });
}
