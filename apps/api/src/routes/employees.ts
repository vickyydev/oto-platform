import { z } from 'zod';
import { ACCOUNT_STATUSES, EMPLOYEE_SOURCES } from '@oto/db';
import type { App } from '../app';
import { listEmployees } from '../services/employees';

const namedRecord = z.object({ id: z.string().uuid(), name: z.string() });
const employeeSummary = z.object({
  id: z.string().uuid(), name: z.string(), nickname: z.string().nullable(),
  source: z.enum(EMPLOYEE_SOURCES), externalId: z.string().nullable(), archivedAt: z.string().datetime().nullable(),
  branch: namedRecord.nullable(), department: namedRecord.nullable(),
  accounts: z.array(z.object({ id: z.string().uuid(), phone: z.string(), status: z.enum(ACCOUNT_STATUSES), lastSignInAt: z.string().datetime().nullable() })),
  lastSignInAt: z.string().datetime().nullable(),
});

export async function employeeRoutes(app: App): Promise<void> {
  app.get('/', {
    config: { permission: 'admin:account:read' },
    schema: {
      description: 'Read-only employee mirror and native records, including archived copies. The existing account-read route gate still checks the seated branch. Once authorized, employee list reach comes from admin:account:read grants rather than the seat or linked account roles; branchless employees need operator-wide reach. Existing core department links are shown only within the same operator and branch reach. Linked logins independently keep the account list scope rules. Last sign-in is the latest successful same-operator auth.sign_in audit for visible logins, including expired or revoked sessions; it is not session activity. Search matches employee names, nicknames and visible login phones.',
      querystring: z.object({ q: z.string().optional() }),
      response: { 200: z.object({ employees: z.array(employeeSummary) }) },
    },
  }, async (req) => {
    const auth = req.requireAuth();
    return listEmployees(app.db, { operatorId: auth.operatorId, effective: await req.effectivePermissions() }, req.query);
  });
}
