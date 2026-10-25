import { z } from 'zod';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { SESSION_COOKIE } from '../plugins/session';
import { handoffConfig, type HandoffConfig } from '../services/handoff';
import { staffSummaryOf } from '../services/console-staff';
import { opCtx } from '../services/tx';

const timestamp = z.string().datetime();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const metric = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), count: z.number().int().nonnegative(), asOf: timestamp.nullable() }).strict(),
  z.object({ status: z.enum(['forbidden', 'unavailable']), count: z.null(), asOf: z.null() }).strict(),
]);
const company = z.object({
  id: z.string().uuid(), name: z.string(), version: z.number().int().positive().nullable(),
  status: z.enum(['not-started', 'draft', 'gm-confirmed', 'locked', 'paid', 'superseded']),
}).strict();
const payroll = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), entities: z.array(company) }).strict(),
  z.object({ status: z.enum(['forbidden', 'unavailable']), month: z.null(), entities: z.array(company).max(0) }).strict(),
]);
export const StaffSummarySchema = z.object({
  generatedAt: timestamp,
  branches: z.array(z.object({ id: z.string().uuid(), name: z.string(), timezone: z.string() }).strict()),
  selectedBranchId: z.string().uuid().nullable(), date: day.nullable(),
  source: z.enum(['ready', 'not-configured', 'not-provisioned', 'unavailable', 'unmapped-branch']),
  working: metric, attendance: metric, leave: metric, payroll,
}).strict();

export async function consoleStaffRoutes(app: App): Promise<void> {
  app.get('/staff/summary', {
    config: { dynamicPermission: true },
    schema: {
      description: 'Read-only Staff and HR headlines through the OTO App as the current caller. ' +
        'Both app:oto_app:access and admin:account:read must cover the selected live owned park; ' +
        'the existing own-department app-access handoff rule remains, and every app API retains its own access checks. ' +
        'Omitting branchId selects the reachable session park, else the first reachable park in name/id order. ' +
        'Foreign, absent and archived parks return404; an own unreachable park returns403. ' +
        'The selected core park must map unambiguously to an accessible app park in the acting user tenant. ' +
        'Working and attendance counts reuse the native app definitions; leave counts existing overlapping entries. ' +
        'Payroll is the app current company month, not a selected-park total, and requires the app salary/advisor gates. ' +
        'A refusal or missing source stays distinct from zero. No HR/payroll tables are read by the platform. ' +
        'One audited handoff and temporary app session are used, with app-only logout before an answer is returned; ' +
        'credentials and upstream personal/financial payloads are never returned.',
      querystring: z.object({ branchId: z.string().uuid().optional() }).strict(),
      response: { 200: StaffSummarySchema },
    },
  }, async (req, reply) => {
    const auth = req.requireAuth();
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw errors.unauthorized();
    let handoff: HandoffConfig | undefined;
    try {
      handoff = handoffConfig({ signingKey: app.env.HANDOFF_SIGNING_KEY,
        appOrigins: app.env.HANDOFF_APP_ORIGINS, ttlSeconds: app.env.HANDOFF_TOKEN_TTL_S });
    } catch { /* An absent or invalid app configuration is an unavailable source, after authorization. */ }
    reply.header('cache-control', 'private, no-store');
    return staffSummaryOf(app.db, {
      auth, effective: await req.effectivePermissions(), ctx: opCtx(req), token, requestId: req.id,
      timeoutMs: app.env.OTOAPP_DIRECTORY_TIMEOUT_MS,
      ...(handoff ? { handoff } : {}), ...(req.query.branchId ? { branchId: req.query.branchId } : {}),
    });
  });
}
