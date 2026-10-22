import { z } from 'zod';
import { ACCOUNT_STATUSES, EMPLOYEE_SOURCES } from '@oto/db';
import type { App } from '../app';
import { readAccessReview } from '../services/access-review';

const namedEmployee = z.object({ id: z.string().uuid(), name: z.string() });
const reviewAccount = z.object({
  id: z.string().uuid(), phone: z.string(), status: z.enum(ACCOUNT_STATUSES), employee: namedEmployee.nullable(),
  lastSignInAt: z.string().datetime().nullable(), mustChangePassword: z.boolean(),
});
const reviewHolder = reviewAccount.extend({ assignments: z.array(z.object({
  id: z.string().uuid(), roleName: z.string(), scopeId: z.string().uuid().nullable(),
})) });
const reviewEmployee = z.object({
  id: z.string().uuid(), name: z.string(), nickname: z.string().nullable(), source: z.enum(EMPLOYEE_SOURCES),
  archivedAt: z.string().datetime().nullable(), branch: namedEmployee.nullable(),
});

export async function accessReviewRoutes(app: App): Promise<void> {
  app.get('/', {
    config: { permission: 'admin:role:read' },
    schema: {
      description: 'Six read-only current core-data lists. Existing seated role-read authorization and accountScopeFilter apply: branch readers inherit its inactive-account exclusion; operator readers retain all statuses. Employee reach independently follows role-read branch grants, includes archived records and excludes foreign or malformed park references. Actual owned links establish presence even when their projection or account is hidden; foreign links do not. A null employee projection never establishes absence. Wide rows describe actual valid own/system operator-scoped role assignments, including empty roles, at readable and dominated own-operator or platform-null scopes; account tenancy is never widened. Last sign-in is the latest successful same-operator auth.sign_in session audit, independent of live/revoked/expired sessions. Password review reads only mustChangePassword; no credential data is read or returned. No source-app or mutation operation is performed.',
      querystring: z.object({}),
      response: { 200: z.object({
        operatorWideHolders: z.array(reviewHolder), platformWideHolders: z.array(reviewHolder),
        accountsWithoutEmployee: z.array(reviewAccount), employeesWithoutAccount: z.array(reviewEmployee),
        accountsNeverSignedIn: z.array(reviewAccount), temporaryPasswordsOutstanding: z.array(reviewAccount),
      }) },
    },
  }, async (req) => {
    const auth = req.requireAuth();
    return readAccessReview(app.db, { operatorId: auth.operatorId, effective: await req.effectivePermissions() });
  });
}
